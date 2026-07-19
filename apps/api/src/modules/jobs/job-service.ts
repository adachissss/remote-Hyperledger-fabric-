import { constants } from 'node:fs';
import { access, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  Job,
  JobEvent,
  JobStatus,
  JobSummary,
  NetworkLifecycleAction,
  NetworkScriptAction,
  CreateChaincodeDeploymentRequest,
} from '@plus-fabric/shared';

import type { NetworkRegistry } from '../networks/network-registry.js';
import {
  ActiveNetworkJobError,
  type JobRegistry,
} from './job-registry.js';
import type { ProcessRunner } from './process-runner.js';

type JobEventListener = (event: JobEvent) => void;

type JobProcessSpec = {
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  timeoutMs: number;
  failureMessage: string;
  onSuccess?: (
    log: (message: string) => Promise<void>,
    signal: AbortSignal,
  ) => Promise<void>;
};

export class JobServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'JobServiceError';
  }
}

export class JobService {
  readonly #listeners = new Map<string, Set<JobEventListener>>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #tasks = new Map<string, Promise<void>>();

  constructor(
    private readonly jobRegistry: JobRegistry,
    private readonly networkRegistry: NetworkRegistry,
    private readonly processRunner: ProcessRunner,
    private readonly managedNetworkRoot: string,
    private readonly driverTemplateRoot: string,
  ) {}

  async initialize(): Promise<void> {
    this.#emit(await this.jobRegistry.recoverInterrupted(new Date().toISOString()));
  }

  async list(networkId?: string): Promise<JobSummary[]> {
    return this.jobRegistry.list(networkId);
  }

  async get(jobId: string): Promise<Job> {
    const job = await this.jobRegistry.get(jobId);
    if (!job) {
      throw new JobServiceError('job_not_found', `Job "${jobId}" does not exist.`, 404);
    }
    return job;
  }

  async getEvents(jobId: string, afterId = 0): Promise<JobEvent[]> {
    await this.get(jobId);
    return this.jobRegistry.listEvents(jobId, afterId);
  }

  async createNetworkAction(
    networkId: string,
    action: NetworkScriptAction,
    confirmation?: string,
  ): Promise<Job> {
    const network = await this.networkRegistry.get(networkId);
    if (!network) {
      throw new JobServiceError(
        'network_not_found',
        `Network "${networkId}" is not registered.`,
        404,
      );
    }
    return this.#createNetworkJob(network, action, action, confirmation);
  }

  async createNetworkDeletion(networkId: string, confirmation?: string): Promise<Job> {
    const network = await this.networkRegistry.get(networkId);
    if (!network) {
      throw new JobServiceError(
        'network_not_found',
        `Network "${networkId}" is not registered.`,
        404,
      );
    }
    return this.#createNetworkJob(network, 'delete', 'down', confirmation);
  }

  async #createNetworkJob(
    network: NonNullable<Awaited<ReturnType<NetworkRegistry['get']>>>,
    action: NetworkLifecycleAction,
    scriptAction: NetworkScriptAction,
    confirmation?: string,
  ): Promise<Job> {
    if ((action === 'down' || action === 'delete') && confirmation !== network.id) {
      throw new JobServiceError(
        'network_confirmation_required',
        'The network id confirmation does not match.',
        400,
      );
    }

    const executable = path.join(network.workspaceRoot, 'network.sh');
    try {
      await access(executable, constants.X_OK);
    } catch {
      throw new JobServiceError(
        'network_script_unavailable',
        `The registered workspace does not contain an executable network.sh.`,
        409,
      );
    }

    const createdAt = new Date().toISOString();
    let created;
    try {
      created = await this.jobRegistry.createNetworkLifecycleJob({
        id: randomUUID(),
        stepId: randomUUID(),
        networkId: network.id,
        action,
        actor: 'local-user',
        createdAt,
      });
    } catch (error) {
      if (error instanceof ActiveNetworkJobError) {
        throw new JobServiceError('network_job_active', error.message, 409);
      }
      throw error;
    }

    this.#emit(created.events);
    const controller = new AbortController();
    this.#controllers.set(created.job.id, controller);
    const task = this.#execute(
      created.job,
      {
        executable,
        args: [scriptAction],
        cwd: network.workspaceRoot,
        environment: {
          CONFIG_FILE: network.configPath,
          COMPOSE_PROJECT_NAME: network.composeProject,
          ...(action === 'delete' ? { REMOVE_CHAINCODE_IMAGES_ON_DOWN: 'true' } : {}),
        },
        timeoutMs: timeoutFor(action),
        failureMessage: '原网络脚本',
        ...(action === 'delete'
          ? { onSuccess: async (
              log: (message: string) => Promise<void>,
              signal: AbortSignal,
            ) => this.#finalizeNetworkDeletion(network, log, signal) }
          : {}),
      },
      controller,
    ).finally(() => {
      this.#controllers.delete(created.job.id);
      this.#tasks.delete(created.job.id);
    });
    this.#tasks.set(created.job.id, task);
    return created.job;
  }

  async createChaincodeDeployment(
    networkId: string,
    request: CreateChaincodeDeploymentRequest,
  ): Promise<Job> {
    const network = await this.networkRegistry.get(networkId);
    if (!network) {
      throw new JobServiceError(
        'network_not_found',
        `Network "${networkId}" is not registered.`,
        404,
      );
    }

    const executable = path.join(network.workspaceRoot, 'upgrade_chaincode.sh');
    try {
      await access(executable, constants.X_OK);
    } catch {
      throw new JobServiceError(
        'chaincode_deployment_script_unavailable',
        'The registered workspace does not contain an executable upgrade_chaincode.sh.',
        409,
      );
    }

    const sourcePath = await resolveWorkspaceEntry(
      network.workspaceRoot,
      request.sourcePath,
      'directory',
      'chaincode_source_not_found',
    );
    const collectionsConfigPath = request.collectionsConfigPath
      ? await resolveWorkspaceEntry(
          network.workspaceRoot,
          request.collectionsConfigPath,
          'file',
          'collections_config_not_found',
        )
      : null;
    const args = [
      '--name',
      request.name,
      '--version',
      request.version,
      '--sequence',
      String(request.sequence),
      '--channel',
      request.channelName,
      '--path',
      sourcePath,
      '--lang',
      request.language,
    ];
    if (collectionsConfigPath) {
      args.push('--collections-config', collectionsConfigPath);
    }
    if (request.signaturePolicy) {
      args.push('--signature-policy', request.signaturePolicy);
    }

    const createdAt = new Date().toISOString();
    let created;
    try {
      created = await this.jobRegistry.createChaincodeDeploymentJob({
        id: randomUUID(),
        stepId: randomUUID(),
        networkId,
        actor: 'local-user',
        createdAt,
        context: {
          channelName: request.channelName,
          name: request.name,
          version: request.version,
          sequence: String(request.sequence),
          language: request.language,
          sourcePath: request.sourcePath,
          ...(request.collectionsConfigPath
            ? { collectionsConfigPath: request.collectionsConfigPath }
            : {}),
        },
      });
    } catch (error) {
      if (error instanceof ActiveNetworkJobError) {
        throw new JobServiceError('network_job_active', error.message, 409);
      }
      throw error;
    }

    this.#emit(created.events);
    const controller = new AbortController();
    this.#controllers.set(created.job.id, controller);
    const task = this.#execute(
      created.job,
      {
        executable,
        args,
        cwd: network.workspaceRoot,
        environment: {
          PROJECT_ROOT: network.workspaceRoot,
          CONFIG_FILE: network.configPath,
          COMPOSE_PROJECT_NAME: network.composeProject,
        },
        timeoutMs: 60 * 60_000,
        failureMessage: '链码生命周期脚本',
      },
      controller,
    ).finally(() => {
      this.#controllers.delete(created.job.id);
      this.#tasks.delete(created.job.id);
    });
    this.#tasks.set(created.job.id, task);
    return created.job;
  }

  async cancel(jobId: string): Promise<Job> {
    const job = await this.get(jobId);
    if (isTerminal(job.status)) {
      throw new JobServiceError('job_not_active', 'The job is already finished.', 409);
    }

    const controller = this.#controllers.get(jobId);
    if (!controller) {
      throw new JobServiceError('job_not_active', 'The job is not running in this process.', 409);
    }
    controller.abort();
    return this.get(jobId);
  }

  subscribe(jobId: string, listener: JobEventListener): () => void {
    const listeners = this.#listeners.get(jobId) ?? new Set<JobEventListener>();
    listeners.add(listener);
    this.#listeners.set(jobId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(jobId);
    };
  }

  async close(): Promise<void> {
    for (const controller of this.#controllers.values()) controller.abort();
    await Promise.allSettled(this.#tasks.values());
    this.#listeners.clear();
  }

  async #execute(
    job: Job,
    spec: JobProcessSpec,
    controller: AbortController,
  ): Promise<void> {
    const step = job.steps[0];
    if (!step) throw new Error(`Job "${job.id}" does not contain an executable step.`);
    const logSystem = async (message: string): Promise<void> => {
      const event = await this.jobRegistry.appendLog(
        job.id,
        step.id,
        'system',
        message,
        new Date().toISOString(),
      );
      this.#emit([event]);
    };

    try {
      this.#emit(await this.jobRegistry.markRunning(job.id, new Date().toISOString()));
      const result = await this.processRunner.run({
        executable: spec.executable,
        args: spec.args,
        cwd: spec.cwd,
        environment: spec.environment,
        timeoutMs: spec.timeoutMs,
        signal: controller.signal,
        onLine: async ({ stream, message }) => {
          const event = await this.jobRegistry.appendLog(
            job.id,
            step.id,
            stream,
            message,
            new Date().toISOString(),
          );
          this.#emit([event]);
        },
      });

      if (result.timedOut) {
        await this.#finish(job.id, 'failed', result.exitCode, '执行超时。');
      } else if (result.cancelled) {
        await this.#finish(job.id, 'cancelled', result.exitCode, null);
      } else if (result.exitCode === 0) {
        await spec.onSuccess?.(logSystem, controller.signal);
        await this.#finish(job.id, 'succeeded', 0, null);
      } else {
        await this.#finish(
          job.id,
          'failed',
          result.exitCode,
          `${spec.failureMessage}退出码为 ${result.exitCode ?? '未知'}。`,
        );
      }
    } catch (error) {
      await this.#finish(
        job.id,
        controller.signal.aborted ? 'cancelled' : 'failed',
        null,
        error instanceof Error ? error.message : '执行作业脚本时发生未知错误。',
      ).catch(() => undefined);
    }
  }

  async #finalizeNetworkDeletion(
    network: NonNullable<Awaited<ReturnType<NetworkRegistry['get']>>>,
    log: (message: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    await log('原网络脚本执行完成，正在核验目标 Docker 资源。');
    const cleanupResult = await this.processRunner.run({
      executable: path.join(this.driverTemplateRoot, 'network.sh'),
      args: ['cleanup-docker'],
      cwd: this.driverTemplateRoot,
      environment: {
        CONFIG_FILE: network.configPath,
        ALLOW_EXTERNAL_CONFIG_FILE: 'true',
        COMPOSE_PROJECT_NAME: network.composeProject,
        REMOVE_DOCKER_NETWORK_ON_DOWN: 'true',
        REMOVE_CHAINCODE_IMAGES_ON_DOWN: 'true',
      },
      timeoutMs: 5 * 60_000,
      signal,
      onLine: ({ message }) => log(message),
    });
    if (cleanupResult.timedOut) throw new Error('目标 Docker 资源核验清理超时。');
    if (cleanupResult.cancelled) throw new Error('目标 Docker 资源核验清理已取消。');
    if (cleanupResult.exitCode !== 0) {
      throw new Error(`目标 Docker 资源核验清理失败，退出码 ${cleanupResult.exitCode ?? '未知'}。`);
    }

    await log('目标 Docker 资源已确认清理，正在从控制平面删除网络。');
    if (network.managementMode === 'managed') {
      await removeManagedWorkspace(this.managedNetworkRoot, network.id, network.workspaceRoot);
      await log('托管网络工作区已删除。');
    } else {
      await log('导入网络的外部工作区已保留。');
    }

    if (!(await this.networkRegistry.delete(network.id))) {
      throw new Error(`网络 "${network.id}" 的注册记录已不存在。`);
    }
    await log('网络注册记录与保留端口已释放。');
  }

  async #finish(
    jobId: string,
    status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>,
    exitCode: number | null,
    errorMessage: string | null,
  ): Promise<void> {
    this.#emit(
      await this.jobRegistry.markFinished(
        jobId,
        status,
        exitCode,
        errorMessage,
        new Date().toISOString(),
      ),
    );
  }

  #emit(events: JobEvent[]): void {
    for (const event of events) {
      for (const listener of this.#listeners.get(event.jobId) ?? []) listener(event);
    }
  }
}

async function resolveWorkspaceEntry(
  workspaceRoot: string,
  requestedPath: string,
  expectedType: 'file' | 'directory',
  errorCode: string,
): Promise<string> {
  try {
    const resolved = await realpath(path.resolve(workspaceRoot, requestedPath));
    const relative = path.relative(workspaceRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside workspace');
    const entry = await stat(resolved);
    if (expectedType === 'file' ? !entry.isFile() : !entry.isDirectory()) {
      throw new Error('unexpected entry type');
    }
    return resolved;
  } catch {
    throw new JobServiceError(
      errorCode,
      `The requested ${expectedType} does not exist inside the registered workspace.`,
      400,
    );
  }
}

async function removeManagedWorkspace(
  managedNetworkRoot: string,
  networkId: string,
  workspaceRoot: string,
): Promise<void> {
  const expectedWorkspace = path.resolve(managedNetworkRoot, networkId);
  if (path.resolve(workspaceRoot) !== expectedWorkspace) {
    throw new Error('托管网络工作区与配置的 managed root 不一致，拒绝删除。');
  }

  let resolvedWorkspace: string;
  try {
    resolvedWorkspace = await realpath(expectedWorkspace);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  const resolvedManagedRoot = await realpath(managedNetworkRoot);
  if (path.relative(resolvedManagedRoot, resolvedWorkspace) !== networkId) {
    throw new Error('托管网络工作区解析到 managed root 之外，拒绝删除。');
  }
  await rm(resolvedWorkspace, { recursive: true, force: false });
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function timeoutFor(action: NetworkLifecycleAction): number {
  switch (action) {
    case 'up':
      return 60 * 60_000;
    case 'down':
    case 'delete':
      return 15 * 60_000;
    case 'stop':
    case 'restart':
      return 10 * 60_000;
  }
}

function isTerminal(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
