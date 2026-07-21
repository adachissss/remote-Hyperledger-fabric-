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

test('reads local network discoveries through the shared response schema', async () => {
  const client = new ControlPlaneClient('http://127.0.0.1:4100', async () =>
    new Response(
      JSON.stringify({
        items: [
          {
            manifest: {
              schemaVersion: 1,
              networkId: 'cli-network',
              displayName: 'CLI Network',
              source: 'script',
              status: 'running',
              workspaceRoot: '/srv/fabric/cli-network',
              configPath: '/srv/fabric/cli-network/config/orgs.yaml',
              composeProject: 'cli_network',
              dockerNetwork: 'cli-network-docker',
              fabricVersion: '2.4.1',
              fabricCaVersion: '1.5.3',
              summary: {
                peerOrganizationCount: 1,
                peerCount: 2,
                ordererCount: 3,
                channelCount: 1,
              },
              updatedAt: '2026-07-21T00:00:00.000Z',
            },
            registrationStatus: 'unregistered',
            registeredNetworkId: null,
            workspaceAvailable: true,
            configAvailable: true,
          },
        ],
        total: 1,
        invalidManifestCount: 0,
      }),
      { status: 200 },
    ),
  );

  const response = await client.getNetworkDiscoveries();
  assert.equal(response.items[0]?.manifest.networkId, 'cli-network');
  assert.equal(response.items[0]?.registrationStatus, 'unregistered');
});
