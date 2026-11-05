/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialNeedles, encodedPrefixNeedle, scanSurfaces } from '../scripts/lib/leak_scan';

const key = { id: 'AbCdEfGhIjKlMnOpQrSt', secret: 'fake-secret-for-scanner-test' };
const needles = credentialNeedles(key);
const encoded = Buffer.from(`${key.id}:${key.secret}`).toString('base64');

test('K4 scanner catches the bare secret, id:secret, base64/base64url and an ApiKey header', () => {
  for (const leak of [
    `{"message":"x ${key.secret} y"}`,
    `${key.id}:${key.secret}`,
    `authorization: ApiKey ${encoded}`,
    Buffer.from(`${key.id}:${key.secret}`).toString('base64url'),
    'ApiKey QUJDREVGR0hJSktMTU5PUFFSU1Q6eHl6',
  ]) {
    const result = scanSurfaces(
      [
        { where: 'clean', text: 'authorization: [REDACTED]' },
        { where: 'leaky', text: leak },
      ],
      needles
    );
    assert.equal(result.status, 'FAIL');
    assert.deepEqual(result.hits, ['leaky']);
  }
});

test('K4 scanner: a key id alone is not a leak; the encoded-prefix needle catches any encoding', () => {
  assert.equal(
    scanSurfaces([{ where: 'audit', text: `"api_key":{"id":"${key.id}"}` }], needles).status,
    'PASS'
  );
  const prefix = encodedPrefixNeedle(key.id);
  assert.ok(encoded.startsWith(prefix));
  assert.equal(scanSurfaces([{ where: 'x', text: encoded }], [prefix]).status, 'FAIL');
});

test('K4 scanner: a missing observer or no surfaces is NOT_VERIFIED, never PASS', () => {
  assert.equal(
    scanSurfaces(
      [
        { where: 'es_query_debug.ndjson', text: undefined },
        { where: 'ok', text: '' },
      ],
      needles
    ).status,
    'NOT_VERIFIED'
  );
  assert.equal(scanSurfaces([], needles).status, 'NOT_VERIFIED');
});

test('T10 handle needles: ciphertext-only and full-handle leaks are caught; the generation alone is not a leak', () => {
  const handle = `${'a'.repeat(64)}.GenerationTokenAbc012.${'C'.repeat(60)}`;
  const [, generation, sealed] = handle.split('.');
  const handleNeedles = [handle, sealed];
  assert.equal(
    scanSurfaces([{ where: 'log', text: `x ${sealed} y` }], handleNeedles).status,
    'FAIL'
  );
  assert.equal(
    scanSurfaces([{ where: 'log', text: `x ${handle} y` }], handleNeedles).status,
    'FAIL'
  );
  assert.equal(
    scanSurfaces([{ where: 'log', text: `gen=${generation}` }], handleNeedles).status,
    'PASS'
  );
});
