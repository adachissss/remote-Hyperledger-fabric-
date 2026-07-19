import { mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  JobEventSchema,
  JobSchema,
  JobSummarySchema,
  type Job,
  type JobAction,
  type JobContext,
  type JobEvent,
  type JobKind,
  type JobLogStream,
  type JobStatus,
  type JobSummary,
  type NetworkLifecycleAction,
} from '@plus-fabric/shared';
import Database from 'better-sqlite3';

type JobRow = {
  id: string;
  kind: JobKind;
  network_id: string;
  action: JobAction;
  context_json: string;
  status: JobStatus;
  actor: string;
  exit_code: number | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type JobStepRow = {
  id: string;
  job_id: string;
  sequence: number;
  name: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
};

type JobEventRow = {
  id: number;
  job_id: string;
  step_id: string | null;
  type: 'status' | 'step' | 'log';
  stream: JobLogStream | null;
  message: string;
  created_at: string;
};

export type CreateNetworkLifecycleJob = {
  id: string;
  stepId: string;
  networkId: string;
  action: NetworkLifecycleAction;
  actor: string;
  createdAt: string;
};

export type CreateChaincodeDeploymentJob = {
  id: string;
  stepId: string;
  networkId: string;
  actor: string;
  createdAt: string;
  context: JobContext;
};

export class ActiveNetworkJobError extends Error {
  constructor(readonly networkId: string) {
    super(`Network "${networkId}" already has an active mutation job.`);
    this.name = 'ActiveNetworkJobError';
  }
}

export class JobStateConflictError extends Error {
  constructor(readonly jobId: string) {
    super(`Job "${jobId}" is not in the expected state.`);
    this.name = 'JobStateConflictError';
  }
}

export interface JobRegistry {
  list(networkId?: string): Promise<JobSummary[]>;
  get(jobId: string): Promise<Job | null>;
  createNetworkLifecycleJob(input: CreateNetworkLifecycleJob): Promise<{
    job: Job;
    events: JobEvent[];
  }>;
  createChaincodeDeploymentJob(input: CreateChaincodeDeploymentJob): Promise<{
    job: Job;
    events: JobEvent[];
  }>;
  markRunning(jobId: string, startedAt: string): Promise<JobEvent[]>;
  appendLog(
    jobId: string,
    stepId: string,
    stream: JobLogStream,
    message: string,
    createdAt: string,
  ): Promise<JobEvent>;
  markFinished(
    jobId: string,
    status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>,
    exitCode: number | null,
    errorMessage: string | null,
    finishedAt: string,
  ): Promise<JobEvent[]>;
  recoverInterrupted(finishedAt: string): Promise<JobEvent[]>;
  listEvents(jobId: string, afterId?: number): Promise<JobEvent[]>;
  close(): Promise<void>;
}

class SqliteJobRegistry implements JobRegistry {
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }

    this.#database = new Database(databasePath);
    this.#database.pragma('journal_mode = WAL');
    this.#database.pragma('foreign_keys = ON');
    this.#database.pragma('busy_timeout = 5000');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        network_id TEXT NOT NULL,
        action TEXT NOT NULL,
        context_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        actor TEXT NOT NULL,
        exit_code INTEGER,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS job_steps (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        exit_code INTEGER,
        UNIQUE(job_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        step_id TEXT REFERENCES job_steps(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        stream TEXT,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_network_created
        ON jobs(network_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_job_events_job_id
        ON job_events(job_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_network_lifecycle
        ON jobs(network_id)
        WHERE kind = 'network-lifecycle' AND status IN ('queued', 'running');
    `);
    const jobColumns = this.#database.pragma('table_info(jobs)') as Array<{ name: string }>;
    if (!jobColumns.some((column) => column.name === 'context_json')) {
      this.#database.exec("ALTER TABLE jobs ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}'");
    }
    this.#database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_network_mutation
        ON jobs(network_id)
        WHERE status IN ('queued', 'running');
    `);
  }

  async list(networkId?: string): Promise<JobSummary[]> {
    const rows = (networkId
      ? this.#database
          .prepare('SELECT * FROM jobs WHERE network_id = ? ORDER BY created_at DESC, id DESC')
          .all(networkId)
      : this.#database.prepare('SELECT * FROM jobs ORDER BY created_at DESC, id DESC').all()) as JobRow[];
    return rows.map(toJobSummary);
  }

  async get(jobId: string): Promise<Job | null> {
    const row = this.#database.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as
      | JobRow
      | undefined;
    if (!row) return null;

    const steps = this.#database
      .prepare('SELECT * FROM job_steps WHERE job_id = ? ORDER BY sequence')
      .all(jobId) as JobStepRow[];
    return toJob(row, steps);
  }

  async createNetworkLifecycleJob(input: CreateNetworkLifecycleJob): Promise<{
    job: Job;
    events: JobEvent[];
  }> {
    return this.#createJob({
      id: input.id,
      stepId: input.stepId,
      networkId: input.networkId,
      kind: 'network-lifecycle',
      action: input.action,
      actor: input.actor,
      createdAt: input.createdAt,
      context: {},
      stepName:
        input.action === 'delete'
          ? 'network.sh down + 删除网络注册'
          : `network.sh ${input.action}`,
    });
  }

  async createChaincodeDeploymentJob(input: CreateChaincodeDeploymentJob): Promise<{
    job: Job;
    events: JobEvent[];
  }> {
    return this.#createJob({
      ...input,
      kind: 'chaincode-deployment',
      action: 'deploy',
      stepName: `upgrade_chaincode.sh ${input.context.name ?? ''}`.trim(),
    });
  }

  async #createJob(input: {
    id: string;
    stepId: string;
    networkId: string;
    kind: JobKind;
    action: JobAction;
    actor: string;
    createdAt: string;
    context: JobContext;
    stepName: string;
  }): Promise<{ job: Job; events: JobEvent[] }> {
    const create = this.#database.transaction(() => {
      this.#database
        .prepare(`
          INSERT INTO jobs (
            id, kind, network_id, action, context_json, status, actor, exit_code, error_message,
            created_at, started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, NULL, NULL)
        `)
        .run(
          input.id,
          input.kind,
          input.networkId,
          input.action,
          JSON.stringify(input.context),
          input.actor,
          input.createdAt,
        );
      this.#database
        .prepare(`
          INSERT INTO job_steps (
            id, job_id, sequence, name, status, started_at, finished_at, exit_code
          ) VALUES (?, ?, 1, ?, 'pending', NULL, NULL, NULL)
        `)
        .run(input.stepId, input.id, input.stepName);
      return this.#insertEvent(
        input.id,
        null,
        'status',
        'system',
        '作业已进入等待队列。',
        input.createdAt,
      );
    });

    let event: JobEvent;
    try {
      event = create();
    } catch (error) {
      if (isSqliteConstraint(error)) throw new ActiveNetworkJobError(input.networkId);
      throw error;
    }

    const job = await this.get(input.id);
    if (!job) throw new Error(`Created job "${input.id}" could not be read back.`);
    return { job, events: [event] };
  }

  async markRunning(jobId: string, startedAt: string): Promise<JobEvent[]> {
    return this.#database.transaction(() => {
      const jobResult = this.#database
        .prepare(`
          UPDATE jobs SET status = 'running', started_at = ?
          WHERE id = ? AND status = 'queued'
        `)
        .run(startedAt, jobId);
      if (jobResult.changes !== 1) throw new JobStateConflictError(jobId);

      const step = this.#database
        .prepare(`
          UPDATE job_steps SET status = 'running', started_at = ?
          WHERE job_id = ? AND sequence = 1 AND status = 'pending'
          RETURNING id
        `)
        .get(startedAt, jobId) as { id: string } | undefined;
      if (!step) throw new JobStateConflictError(jobId);

      return [
        this.#insertEvent(jobId, null, 'status', 'system', '作业开始执行。', startedAt),
        this.#insertEvent(jobId, step.id, 'step', 'system', '开始执行作业脚本。', startedAt),
      ];
    })();
  }

  async appendLog(
    jobId: string,
    stepId: string,
    stream: JobLogStream,
    message: string,
    createdAt: string,
  ): Promise<JobEvent> {
    return this.#insertEvent(jobId, stepId, 'log', stream, message, createdAt);
  }

  async markFinished(
    jobId: string,
    status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>,
    exitCode: number | null,
    errorMessage: string | null,
    finishedAt: string,
  ): Promise<JobEvent[]> {
    return this.#database.transaction(() => {
      const jobResult = this.#database
        .prepare(`
          UPDATE jobs
          SET status = ?, exit_code = ?, error_message = ?, finished_at = ?
          WHERE id = ? AND status IN ('queued', 'running')
        `)
        .run(status, exitCode, errorMessage, finishedAt, jobId);
      if (jobResult.changes !== 1) throw new JobStateConflictError(jobId);

      const stepStatus = status === 'succeeded' ? 'succeeded' : status;
      const step = this.#database
        .prepare(`
          UPDATE job_steps
          SET status = ?, exit_code = ?, finished_at = ?
          WHERE job_id = ? AND sequence = 1 AND status IN ('pending', 'running')
          RETURNING id
        `)
        .get(stepStatus, exitCode, finishedAt, jobId) as { id: string } | undefined;
      if (!step) throw new JobStateConflictError(jobId);

      const statusMessage =
        status === 'succeeded'
          ? '作业执行成功。'
          : status === 'cancelled'
            ? '作业已取消。'
            : `作业执行失败${errorMessage ? `：${errorMessage}` : '。'}`;
      return [
        this.#insertEvent(jobId, step.id, 'step', 'system', statusMessage, finishedAt),
        this.#insertEvent(jobId, null, 'status', 'system', statusMessage, finishedAt),
      ];
    })();
  }

  async listEvents(jobId: string, afterId = 0): Promise<JobEvent[]> {
    const rows = this.#database
      .prepare('SELECT * FROM job_events WHERE job_id = ? AND id > ? ORDER BY id')
      .all(jobId, afterId) as JobEventRow[];
    return rows.map(toJobEvent);
  }

  async recoverInterrupted(finishedAt: string): Promise<JobEvent[]> {
    return this.#database.transaction(() => {
      const activeJobs = this.#database
        .prepare("SELECT id FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at")
        .all() as Array<{ id: string }>;
      const events: JobEvent[] = [];

      for (const { id } of activeJobs) {
        this.#database
          .prepare(`
            UPDATE jobs
            SET status = 'failed', exit_code = NULL,
                error_message = '控制平面进程在作业完成前退出。', finished_at = ?
            WHERE id = ? AND status IN ('queued', 'running')
          `)
          .run(finishedAt, id);
        const step = this.#database
          .prepare(`
            UPDATE job_steps
            SET status = 'failed', exit_code = NULL, finished_at = ?
            WHERE job_id = ? AND status IN ('pending', 'running')
            RETURNING id
          `)
          .get(finishedAt, id) as { id: string } | undefined;
        if (step) {
          events.push(
            this.#insertEvent(
              id,
              step.id,
              'step',
              'system',
              '控制平面重启，未完成的脚本步骤已标记为失败。',
              finishedAt,
            ),
          );
        }
        events.push(
          this.#insertEvent(
            id,
            null,
            'status',
            'system',
            '控制平面重启，未完成的作业已标记为失败。',
            finishedAt,
          ),
        );
      }
      return events;
    })();
  }

  async close(): Promise<void> {
    this.#database.close();
  }

  #insertEvent(
    jobId: string,
    stepId: string | null,
    type: JobEventRow['type'],
    stream: JobLogStream | null,
    message: string,
    createdAt: string,
  ): JobEvent {
    const result = this.#database
      .prepare(`
        INSERT INTO job_events (job_id, step_id, type, stream, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(jobId, stepId, type, stream, message, createdAt);
    return JobEventSchema.parse({
      id: Number(result.lastInsertRowid),
      jobId,
      stepId,
      type,
      stream,
      message,
      createdAt,
    });
  }
}

function isSqliteConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  );
}

function toJobSummary(row: JobRow): JobSummary {
  return JobSummarySchema.parse({
    id: row.id,
    kind: row.kind,
    networkId: row.network_id,
    action: row.action,
    context: parseJobContext(row.context_json),
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
}

function parseJobContext(value: string): JobContext {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

function toJob(row: JobRow, steps: JobStepRow[]): Job {
  return JobSchema.parse({
    ...toJobSummary(row),
    actor: row.actor,
    exitCode: row.exit_code,
    errorMessage: row.error_message,
    steps: steps.map((step) => ({
      id: step.id,
      sequence: step.sequence,
      name: step.name,
      status: step.status,
      startedAt: step.started_at,
      finishedAt: step.finished_at,
      exitCode: step.exit_code,
    })),
  });
}

function toJobEvent(row: JobEventRow): JobEvent {
  return JobEventSchema.parse({
    id: row.id,
    jobId: row.job_id,
    stepId: row.step_id,
    type: row.type,
    stream: row.stream,
    message: row.message,
    createdAt: row.created_at,
  });
}

export function createJobRegistry(databasePath: string): JobRegistry {
  return new SqliteJobRegistry(databasePath);
}
