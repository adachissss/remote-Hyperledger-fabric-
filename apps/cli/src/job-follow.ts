import type { Job, JobEvent, JobStatus } from '@plus-fabric/shared';

import { ControlPlaneClient } from './api-client.js';

export type JobFollowerOptions = {
  pollIntervalMs?: number;
  pollRetryAttempts?: number;
  pollRetryDelayMs?: number;
  reconnectDelayMs?: number;
  signal?: AbortSignal;
  onEvent(event: JobEvent): void;
};

const TERMINAL_JOB_STATUSES = new Set<JobStatus>(['succeeded', 'failed', 'cancelled']);

export async function followJob(
  client: ControlPlaneClient,
  jobId: string,
  options: JobFollowerOptions,
): Promise<Job> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    abortFromParent();
  } else {
    options.signal?.addEventListener('abort', abortFromParent, { once: true });
  }
  let cursor = 0;
  let streamPromise: Promise<void> | null = null;
  const pollRetryAttempts = Math.max(1, Math.floor(options.pollRetryAttempts ?? 3));
  const pollRetryDelayMs = Math.max(0, options.pollRetryDelayMs ?? 500);

  const emit = (event: JobEvent) => {
    if (event.id <= cursor) return;
    cursor = event.id;
    options.onEvent(event);
  };

  const startStream = () => {
    if (streamPromise || controller.signal.aborted) return;
    streamPromise = streamWithReconnect(
      client,
      jobId,
      () => cursor,
      emit,
      controller.signal,
      options.reconnectDelayMs ?? 500,
    ).finally(() => {
      streamPromise = null;
    });
  };

  try {
    for (;;) {
      if (controller.signal.aborted) throw abortError(controller.signal.reason);
      startStream();

      const backlog = await retryControlPlaneRead(
        () => client.getJobEvents(jobId, cursor),
        pollRetryAttempts,
        pollRetryDelayMs,
        controller.signal,
      );
      for (const event of backlog.items) emit(event);

      const job = await retryControlPlaneRead(
        () => client.getJob(jobId),
        pollRetryAttempts,
        pollRetryDelayMs,
        controller.signal,
      );
      if (TERMINAL_JOB_STATUSES.has(job.status)) {
        const finalBacklog = await retryControlPlaneRead(
          () => client.getJobEvents(jobId, cursor),
          pollRetryAttempts,
          pollRetryDelayMs,
          controller.signal,
        );
        for (const event of finalBacklog.items) emit(event);
        controller.abort();
        return job;
      }

      await delay(options.pollIntervalMs ?? 750, controller.signal);
    }
  } finally {
    controller.abort();
    options.signal?.removeEventListener('abort', abortFromParent);
  }
}

async function retryControlPlaneRead<T>(
  operation: () => Promise<T>,
  attempts: number,
  retryDelayMs: number,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    if (signal.aborted) throw abortError(signal.reason);
    try {
      return await operation();
    } catch (error) {
      if (signal.aborted) throw abortError(signal.reason);
      if (attempt >= attempts) throw error;
      await delay(retryDelayMs, signal);
    }
  }
}

export function jobExitCode(job: Job): number {
  if (job.status === 'succeeded') return 0;
  if (job.status === 'cancelled') return 2;
  return 1;
}

async function streamWithReconnect(
  client: ControlPlaneClient,
  jobId: string,
  getCursor: () => number,
  onEvent: (event: JobEvent) => void,
  signal: AbortSignal,
  reconnectDelayMs: number,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await client.streamJobEvents(jobId, getCursor(), onEvent, signal);
    } catch {
      // JSON history polling remains the source of truth when SSE is unavailable.
    }
    if (!signal.aborted) {
      try {
        await delay(reconnectDelayMs, signal);
      } catch {
        if (!signal.aborted) throw new Error('作业日志流重连等待失败。');
      }
    }
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      reject(abortError(signal.reason));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('作业跟随已中断。');
}
