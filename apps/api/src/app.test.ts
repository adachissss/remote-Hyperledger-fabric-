import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HealthResponseSchema, NetworkListResponseSchema } from '@plus-fabric/shared';

import { buildApp } from './app.js';
import { loadConfig, type AppConfig } from './config.js';

function createTestConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    CONTROL_PLANE_LOG_LEVEL: 'silent',
    CONTROL_PLANE_DATABASE_PATH: ':memory:',
    ...overrides,
  });
}

test('health endpoint exposes a valid control-plane heartbeat', async () => {
  const app = await buildApp(createTestConfig());

  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/system/health' });
    assert.equal(response.statusCode, 200);

    const payload = HealthResponseSchema.parse(response.json());
    assert.equal(payload.status, 'ok');
    assert.equal(payload.service, 'plus-fabric-control-plane');
  } finally {
    await app.close();
  }
});

test('network registry starts empty and never infers a local instance', async () => {
  const app = await buildApp(createTestConfig());

  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/networks' });
    assert.equal(response.statusCode, 200);

    const payload = NetworkListResponseSchema.parse(response.json());
    assert.deepEqual(payload, { items: [], total: 0 });
  } finally {
    await app.close();
  }
});

test('unknown routes return a stable JSON error', async () => {
  const app = await buildApp(createTestConfig());

  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/unknown' });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      error: 'not_found',
      message: 'The requested control-plane resource does not exist.',
    });
  } finally {
    await app.close();
  }
});

test('invalid environment configuration fails before the server starts', () => {
  assert.throws(() => loadConfig({ CONTROL_PLANE_PORT: 'not-a-port' }));
});

test('network import is disabled until an administrator allows workspace roots', async () => {
  const app = await buildApp(createTestConfig());

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/networks/import',
      payload: {
        id: 'network-a',
        displayName: 'Network A',
        driver: 'fabric-compose',
        workspaceRoot: '/tmp/network-a',
        configPath: 'config/orgs.yaml',
        composeProject: 'network_a',
      },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'network_import_disabled');
  } finally {
    await app.close();
  }
});

test('an allowed Fabric workspace can be imported and read back without secrets', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'plus-fabric-registry-'));
  const workspaceRoot = path.join(temporaryRoot, 'network-a');
  const configDirectory = path.join(workspaceRoot, 'config');
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    path.join(configDirectory, 'orgs.yaml'),
    `
network:
  name: network-a-docker
  domain: network-a.test
  tls_enabled: true
ordererOrg:
  admin_password: never-return-this
  nodes:
    - name: orderer1
      host: orderer1.network-a.test
      port: 7050
peerOrgs:
  - name: org1
    mspid: Org1MSP
    domain: org1.network-a.test
    admin_password: never-return-this-either
    peer_count: 1
    anchor_peers:
      - name: peer0
        host: peer0.org1.network-a.test
        port: 7051
channels:
  - name: channel-a
    profile: ApplicationChannel
    memberOrgs: [org1]
`,
  );

  const config = createTestConfig({
    CONTROL_PLANE_ALLOWED_NETWORK_ROOTS: temporaryRoot,
    CONTROL_PLANE_DATABASE_PATH: path.join(temporaryRoot, 'control-plane.sqlite'),
  });

  try {
    const app = await buildApp(config);
    try {
      const importResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/networks/import',
        payload: {
          id: 'network-a',
          displayName: 'Network A',
          driver: 'fabric-compose',
          workspaceRoot,
          configPath: 'config/orgs.yaml',
          composeProject: 'network_a',
          fabricVersion: '3.1.4',
          fabricCaVersion: '1.5.19',
        },
      });

      assert.equal(importResponse.statusCode, 201);
      assert.deepEqual(importResponse.json(), {
        id: 'network-a',
        displayName: 'Network A',
        driver: 'fabric-compose',
        managementMode: 'imported',
        status: 'unknown',
        fabricVersion: '3.1.4',
        organizationCount: 1,
        channelCount: 1,
        nodeCount: 2,
        updatedAt: importResponse.json().updatedAt,
      });

      const listResponse = await app.inject({ method: 'GET', url: '/api/v1/networks' });
      assert.equal(listResponse.statusCode, 200);
      assert.equal(listResponse.json().total, 1);

      const configResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/networks/network-a/config',
      });
      assert.equal(configResponse.statusCode, 200);
      assert.equal(configResponse.json().networkName, 'network-a-docker');
      assert.equal(configResponse.json().channels[0].name, 'channel-a');
      assert.doesNotMatch(configResponse.body, /never-return-this/);

      const duplicateResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/networks/import',
        payload: {
          id: 'network-a',
          displayName: 'Network A duplicate',
          driver: 'fabric-compose',
          workspaceRoot,
          configPath: 'config/orgs.yaml',
          composeProject: 'network_a_duplicate',
        },
      });
      assert.equal(duplicateResponse.statusCode, 409);

      const concurrentPayload = {
        id: 'network-b',
        displayName: 'Network B',
        driver: 'fabric-compose',
        workspaceRoot,
        configPath: 'config/orgs.yaml',
        composeProject: 'network_b',
      };
      const concurrentResponses = await Promise.all([
        app.inject({ method: 'POST', url: '/api/v1/networks/import', payload: concurrentPayload }),
        app.inject({ method: 'POST', url: '/api/v1/networks/import', payload: concurrentPayload }),
      ]);
      assert.deepEqual(
        concurrentResponses.map((response) => response.statusCode).sort(),
        [201, 409],
      );
      assert.equal(
        concurrentResponses.find((response) => response.statusCode === 409)?.json().error,
        'network_exists',
      );
    } finally {
      await app.close();
    }

    const restartedApp = await buildApp(config);
    try {
      const persistedResponse = await restartedApp.inject({
        method: 'GET',
        url: '/api/v1/networks',
      });
      assert.equal(persistedResponse.statusCode, 200);
      assert.equal(persistedResponse.json().total, 2);
      assert.deepEqual(
        persistedResponse.json().items.map((network: { id: string }) => network.id).sort(),
        ['network-a', 'network-b'],
      );
    } finally {
      await restartedApp.close();
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
