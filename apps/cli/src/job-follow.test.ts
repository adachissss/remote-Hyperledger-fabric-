import assert from 'node:assert/strict';
import test from 'node:test';

import type { Job, JobEvent } from '@plus-fabric/shared';

import { consumeEventStream, ControlPlaneClient } from './api-client.js';
import { followJob, jobExitCode } from './job-follow.js';

const event: JobEvent = {
  id: 1,
  jobId: '00000000-0000-4000-8000-000000000001',
  stepId: null,
  type: 'log',
  stream: 'stdout',
  message: 'network started',
  createdAt: '2026-07-20T00:00:00.000Z',
};

test('parses SSE frames and ignores duplicate event ids', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`retry: 2000\n\nid: 1\ndata: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode(`id: 1\ndata: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
  const events: JobEvent[] = [];
  const cursor = await consumeEventStream(stream, 0, (received) => events.push(received));
  assert.equal(cursor, 1);
  assert.deepEqual(events, [event]);
});

test('follows history polling to a terminal job when SSE is unavailable', async () => {
  const terminalJob = createJob('succeeded');
  const client = {
    getJobEvents: async () => ({ items: [event], total: 1 }),
    getJob: async () => terminalJob,
    streamJobEvents: async () => {
      throw new Error('SSE unavailable');
    },
  } as unknown as ControlPlaneClient;
  const events: JobEvent[] = [];

  const result = await followJob(client, terminalJob.id, {
    pollIntervalMs: 1,
    reconnectDelayMs: 1,
    onEvent: (received) => events.push(received),
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(events, [event]);
});

test('maps terminal job states to CLI exit codes', () => {
  assert.equal(jobExitCode(createJob('succeeded')), 0);
  assert.equal(jobExitCode(createJob('failed')), 1);
  assert.equal(jobExitCode(createJob('cancelled')), 2);
});

function createJob(status: Job['status']): Job {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'network-lifecycle',
    networkId: 'test-network',
    action: 'up',
    context: {},
    status,
    createdAt: '2026-07-20T00:00:00.000Z',
    startedAt: status === 'queued' ? null : '2026-07-20T00:00:01.000Z',
    finishedAt: ['succeeded', 'failed', 'cancelled'].includes(status)
      ? '2026-07-20T00:00:02.000Z'
      : null,
    actor: 'local-user',
    exitCode: status === 'succeeded' ? 0 : status === 'queued' || status === 'running' ? null : 1,
    errorMessage: status === 'failed' ? 'failed' : null,
    steps: [],
  };
}
