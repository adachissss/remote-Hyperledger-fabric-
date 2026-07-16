import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NodeLifecycleProcessRunner } from './process-runner.js';

test('process runner executes network scripts without a shell command string and sanitizes logs', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'plus-fabric-runner-'));
  const executable = path.join(temporaryRoot, 'network.sh');
  writeFileSync(
    executable,
    `#!/usr/bin/env bash
printf 'action=%s\\n' "$1"
printf 'Admin password: super-secret\\n'
printf 'https://admin:url-secret@example.test\\n'
printf '\\033[32mready\\033[0m\\n'
printf '%s\\n' '-----BEGIN PRIVATE KEY-----' 'private-material' '-----END PRIVATE KEY-----'
`,
  );
  chmodSync(executable, 0o755);
  const lines: string[] = [];

  try {
    const result = await new NodeLifecycleProcessRunner().run({
      executable,
      action: 'restart',
      cwd: temporaryRoot,
      configPath: path.join(temporaryRoot, 'config.yaml'),
      composeProject: 'network-a',
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      onLine: ({ stream, message }) => {
        lines.push(`${stream}:${message}`);
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.cancelled, false);
    assert(lines.includes('stdout:action=restart'));
    assert(lines.includes('stdout:Admin password: [已隐藏]'));
    assert(lines.includes('stdout:https://admin:[已隐藏]@example.test'));
    assert(lines.includes('stdout:ready'));
    assert(lines.includes('stdout:[已隐藏私钥内容]'));
    assert.doesNotMatch(lines.join('\n'), /super-secret|url-secret|private-material/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('process runner terminates and rejects when log persistence fails', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'plus-fabric-runner-error-'));
  const executable = path.join(temporaryRoot, 'network.sh');
  writeFileSync(
    executable,
    `#!/usr/bin/env bash
printf 'first line\\n'
sleep 30
`,
  );
  chmodSync(executable, 0o755);

  try {
    await assert.rejects(
      new NodeLifecycleProcessRunner().run({
        executable,
        action: 'restart',
        cwd: temporaryRoot,
        configPath: path.join(temporaryRoot, 'config.yaml'),
        composeProject: 'network-a',
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        onLine: () => {
          throw new Error('log storage unavailable');
        },
      }),
      /log storage unavailable/,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
