import assert from 'node:assert/strict';
import test from 'node:test';

import { CliUsageError, parseGlobalOptions } from './arguments.js';

test('parses global options without consuming command arguments', () => {
  assert.deepEqual(
    parseGlobalOptions(
      ['--api', 'http://localhost:4200', 'network', 'list', '--json'],
      {},
    ),
    {
      apiUrl: 'http://localhost:4200',
      output: 'json',
      help: false,
      version: false,
      command: ['network', 'list'],
    },
  );
});

test('uses API URL from environment', () => {
  assert.equal(
    parseGlobalOptions(['health'], { PLUS_FABRIC_API_URL: 'http://api.internal:4100' }).apiUrl,
    'http://api.internal:4100',
  );
});

test('rejects unsupported output mode', () => {
  assert.throws(() => parseGlobalOptions(['--output', 'yaml', 'health'], {}), CliUsageError);
});
