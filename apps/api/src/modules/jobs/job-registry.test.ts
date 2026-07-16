import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ActiveNetworkJobError, createJobRegistry } from './job-registry.js';

test('job registry persists lifecycle state and locks one active job per network', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'plus-fabric-jobs-'));
  const databasePath = path.join(temporaryRoot, 'control-plane.sqlite');
  const registry = createJobRegistry(databasePath);
  const createdAt = new Date().toISOString();
  const first = {
    id: randomUUID(),
    stepId: randomUUID(),
    networkId: 'network-a',
    action: 'restart' as const,
    actor: 'local-user',
    createdAt,
  };

  try {
    const created = await registry.createNetworkLifecycleJob(first);
    assert.equal(created.job.status, 'queued');
    assert.equal(created.job.steps[0]?.name, 'network.sh restart');
    assert.equal(created.events[0]?.message, '作业已进入等待队列。');

    await assert.rejects(
      registry.createNetworkLifecycleJob({
        ...first,
        id: randomUUID(),
        stepId: randomUUID(),
      }),
      ActiveNetworkJobError,
    );

    const startedAt = new Date(Date.now() + 1).toISOString();
    await registry.markRunning(first.id, startedAt);
    await registry.appendLog(
      first.id,
      first.stepId,
      'stdout',
      'network restarted',
      new Date(Date.now() + 2).toISOString(),
    );
    await registry.markFinished(
      first.id,
      'succeeded',
      0,
      null,
      new Date(Date.now() + 3).toISOString(),
    );

    const finished = await registry.get(first.id);
    assert.equal(finished?.status, 'succeeded');
    assert.equal(finished?.exitCode, 0);
    assert.equal(finished?.steps[0]?.status, 'succeeded');
    assert.equal((await registry.listEvents(first.id)).length, 6);

    const next = await registry.createNetworkLifecycleJob({
      ...first,
      id: randomUUID(),
      stepId: randomUUID(),
      action: 'stop',
      createdAt: new Date(Date.now() + 4).toISOString(),
    });
    assert.equal(next.job.status, 'queued');
  } finally {
    await registry.close();
  }

  const reopened = createJobRegistry(databasePath);
  try {
    const persisted = await reopened.get(first.id);
    assert.equal(persisted?.status, 'succeeded');
    assert.equal((await reopened.list('network-a')).length, 2);
    const recoveryEvents = await reopened.recoverInterrupted(new Date().toISOString());
    assert.equal(recoveryEvents.length, 2);
    const recovered = await reopened.get(
      (await reopened.list('network-a')).find((job) => job.status === 'failed')!.id,
    );
    assert.equal(recovered?.errorMessage, '控制平面进程在作业完成前退出。');

    const afterRecovery = await reopened.createNetworkLifecycleJob({
      ...first,
      id: randomUUID(),
      stepId: randomUUID(),
      action: 'restart',
      createdAt: new Date(Date.now() + 5).toISOString(),
    });
    assert.equal(afterRecovery.job.status, 'queued');
  } finally {
    await reopened.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
