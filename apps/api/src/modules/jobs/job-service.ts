import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  Job,
  JobEvent,
  JobStatus,
  JobSummary,
  NetworkLifecycleAction,
} from '@plus-fabric/shared';

import type { RegisteredNetwork } from '../networks/network-driver.js';
import type { NetworkRegistry } from '../networks/network-registry.js';
import {
  ActiveNetworkJobError,
  type JobRegistry,
} from './job-registry.js';
import type { LifecycleProcessRunner } from './process-runner.js';

type JobEventListener = (event: JobEvent) => void;

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
    private readonly processRunner: LifecycleProcessRunner,
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
    action: NetworkLifecycleAction,
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
    if (action === 'down' && confirmation !== networkId) {
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
        networkId,
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
    const task = this.#execute(created.job, network, executable, controller).finally(() => {
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
    network: RegisteredNetwork,
    executable: string,
    controller: AbortController,
  ): Promise<void> {
    const step = job.steps[0];
    if (!step) throw new Error(`Job "${job.id}" does not contain an executable step.`);

    try {
      this.#emit(await this.jobRegistry.markRunning(job.id, new Date().toISOString()));
      const result = await this.processRunner.run({
        executable,
        action: job.action,
        cwd: network.workspaceRoot,
        configPath: network.configPath,
        composeProject: network.composeProject,
        timeoutMs: timeoutFor(job.action),
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
        await this.#finish(job.id, 'succeeded', 0, null);
      } else {
        await this.#finish(
          job.id,
          'failed',
          result.exitCode,
          `原网络脚本退出码为 ${result.exitCode ?? '未知'}。`,
        );
      }
    } catch (error) {
      await this.#finish(
        job.id,
        controller.signal.aborted ? 'cancelled' : 'failed',
        null,
        error instanceof Error ? error.message : '执行网络脚本时发生未知错误。',
      ).catch(() => undefined);
    }
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

function timeoutFor(action: NetworkLifecycleAction): number {
  switch (action) {
    case 'up':
      return 60 * 60_000;
    case 'down':
      return 15 * 60_000;
    case 'stop':
    case 'restart':
      return 10 * 60_000;
  }
}

function isTerminal(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
