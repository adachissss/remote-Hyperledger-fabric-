import assert from 'node:assert/strict';
import test from 'node:test';

import { HealthResponseSchema, NetworkListResponseSchema } from '@plus-fabric/shared';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

test('health endpoint exposes a valid control-plane heartbeat', async () => {
  const app = await buildApp(loadConfig({ CONTROL_PLANE_LOG_LEVEL: 'silent' }));

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
  const app = await buildApp(loadConfig({ CONTROL_PLANE_LOG_LEVEL: 'silent' }));

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
  const app = await buildApp(loadConfig({ CONTROL_PLANE_LOG_LEVEL: 'silent' }));

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
