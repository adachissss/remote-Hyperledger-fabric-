import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CliUsageError } from './arguments.js';
import { loadConfigurationFile } from './configuration-file.js';

test('loads YAML and JSON objects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pfctl-config-'));
  try {
    const yamlPath = path.join(root, 'network.yaml');
    const jsonPath = path.join(root, 'network.json');
    await writeFile(yamlPath, 'id: test-network\nordererCount: 3\n', 'utf8');
    await writeFile(jsonPath, JSON.stringify({ id: 'test-network' }), 'utf8');
    assert.deepEqual(await loadConfigurationFile(yamlPath), {
      id: 'test-network',
      ordererCount: 3,
    });
    assert.deepEqual(await loadConfigurationFile(jsonPath), { id: 'test-network' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects scalar configuration files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pfctl-config-'));
  try {
    const filePath = path.join(root, 'invalid.yaml');
    await writeFile(filePath, 'invalid', 'utf8');
    await assert.rejects(() => loadConfigurationFile(filePath), CliUsageError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
