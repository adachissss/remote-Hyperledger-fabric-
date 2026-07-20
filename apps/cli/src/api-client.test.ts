import assert from 'node:assert/strict';
import test from 'node:test';

import { ControlPlaneClient, ControlPlaneClientError } from './api-client.js';

test('validates health responses through the shared schema', async () => {
  const client = new ControlPlaneClient('http://127.0.0.1:4100/', async () =>
    new Response(
      JSON.stringify({
        status: 'ok',
        service: 'plus-fabric-control-plane',
        version: '0.1.0',
        timestamp: '2026-07-20T00:00:00.000Z',
        uptimeSeconds: 12,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  assert.equal((await client.getHealth()).status, 'ok');
  assert.equal(client.baseUrl, 'http://127.0.0.1:4100');
});

test('preserves API error code and message', async () => {
  const client = new ControlPlaneClient('http://127.0.0.1:4100', async () =>
    new Response(JSON.stringify({ error: 'network_not_found', message: 'missing' }), {
      status: 404,
    }),
  );

  await assert.rejects(
    () => client.getNetworks(),
    (error: unknown) =>
      error instanceof ControlPlaneClientError &&
      error.status === 404 &&
      error.code === 'network_not_found' &&
      error.message === 'missing',
  );
});

test('creates lifecycle jobs through the existing network action route', async () => {
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  const client = new ControlPlaneClient('http://127.0.0.1:4100', async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(
      JSON.stringify({
        id: '00000000-0000-4000-8000-000000000001',
        kind: 'network-lifecycle',
        networkId: 'test-network',
        action: 'down',
        context: {},
        status: 'queued',
        createdAt: '2026-07-20T00:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        actor: 'local-user',
        exitCode: null,
        errorMessage: null,
        steps: [],
      }),
      { status: 202 },
    );
  });

  const job = await client.createNetworkAction('test-network', 'down', 'test-network');
  assert.equal(job.action, 'down');
  assert.equal(requestedUrl, 'http://127.0.0.1:4100/api/v1/networks/test-network/actions/down');
  assert.equal(requestedInit?.method, 'POST');
  assert.equal(requestedInit?.body, JSON.stringify({ confirmation: 'test-network' }));
});
