import assert from 'node:assert/strict';
import test from 'node:test';

import { CreateManagedNetworkRequestSchema } from '@plus-fabric/shared';

import {
  ManagedPortPlanError,
  ManagedPortPlanner,
  type HostPortProbe,
} from './managed-port-planner.js';

const request = CreateManagedNetworkRequestSchema.parse({
  id: 'managed-network',
  displayName: 'Managed Network',
  domain: 'managed.test',
  ordererCount: 2,
  peerOrganizations: [
    { name: 'alpha', mspId: 'AlphaMSP', peerCount: 2 },
    { name: 'beta', mspId: 'BetaMSP', peerCount: 1 },
  ],
  channels: [{ name: 'shared', memberOrganizations: ['alpha', 'beta'] }],
  preferredPortStart: 30_000,
});

test('managed port planner allocates one unique contiguous range for the complete topology', async () => {
  const probe: HostPortProbe = { async isAvailable() { return true; } };
  const plan = await new ManagedPortPlanner(probe).plan(request, new Set());

  assert.equal(plan.start, 30_000);
  assert.equal(plan.end, 30_017);
  assert.equal(plan.orderers.length, 2);
  assert.equal(plan.peers.alpha?.length, 2);
  assert.equal(plan.peers.beta?.length, 1);
  assert.equal(new Set(plan.reservedPorts).size, plan.reservedPorts.length);
  assert(plan.publishedPorts.every((port) => plan.reservedPorts.includes(port)));
});

test('managed port planner reserves one published CouchDB port for every peer', async () => {
  const probe: HostPortProbe = { async isAvailable() { return true; } };
  const couchdbRequest = CreateManagedNetworkRequestSchema.parse({
    ...request,
    stateDatabase: 'couchdb',
  });
  const plan = await new ManagedPortPlanner(probe).plan(couchdbRequest, new Set());

  assert.equal(plan.start, 30_000);
  assert.equal(plan.end, 30_020);
  assert.deepEqual(
    [...plan.peers.alpha!, ...plan.peers.beta!].map((peer) => peer.couchdb),
    [30_012, 30_016, 30_020],
  );
  assert(
    [...plan.peers.alpha!, ...plan.peers.beta!].every(
      (peer) => peer.couchdb !== null && plan.publishedPorts.includes(peer.couchdb),
    ),
  );
});

test('managed port planner rejects registered and host port conflicts', async () => {
  const availableProbe: HostPortProbe = { async isAvailable() { return true; } };
  await assert.rejects(
    new ManagedPortPlanner(availableProbe).plan(request, new Set([30_004])),
    (error: unknown) =>
      error instanceof ManagedPortPlanError &&
      error.code === 'managed_port_conflict' &&
      error.port === 30_004,
  );

  const occupiedProbe: HostPortProbe = {
    async isAvailable(port) {
      return port !== 30_011;
    },
  };
  await assert.rejects(
    new ManagedPortPlanner(occupiedProbe).plan(request, new Set()),
    (error: unknown) =>
      error instanceof ManagedPortPlanError &&
      error.code === 'managed_port_conflict' &&
      error.port === 30_011,
  );
});
