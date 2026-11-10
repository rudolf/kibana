/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppKeyInvalidationError, invalidateAppKeys } from '../scripts/lib/app_keys';
import { readConsent, setAppEnabled, writeConsent } from '../scripts/lib/approval';
import type { HttpResult } from '../scripts/lib/http';

const ES = 'http://es.invalid';
const ok = (status: number, body: unknown): HttpResult => ({
  status,
  body,
  headers: new Headers(),
  ms: 0,
});
const responding = (status: number, body: unknown) => async () => ok(status, body);
const unreachable = async (): Promise<HttpResult> => {
  throw new TypeError('fetch failed');
};

const ORIGINAL = 'OriginalGenerationTok0';
const consentFile = (generation = ORIGINAL) => {
  const path = join(mkdtempSync(join(tmpdir(), 'app-keys-')), 'consent.json');
  writeConsent(
    {
      appId: 'alert-digest',
      enabled: true,
      approvedReleaseDigest: 'a'.repeat(64),
      approvedVersion: '2.0.0',
      approvedBy: 'elastic',
      installerGrantDigest: 'b'.repeat(64),
      generation,
    },
    path
  );
  return path;
};

test('invalidation: HTTP 200 with error_count > 0, HTTP errors and transport errors all reject', async () => {
  for (const http of [
    responding(200, { invalidated_api_keys: ['k1'], error_count: 1, error_details: [{}] }),
    responding(401, { error: 'unauthorized' }),
    responding(500, {}),
    unreachable,
  ]) {
    await assert.rejects(
      invalidateAppKeys({ esUrl: ES, appId: 'alert-digest', http }),
      AppKeyInvalidationError
    );
  }
  assert.deepEqual(
    await invalidateAppKeys({
      esUrl: ES,
      appId: 'alert-digest',
      http: responding(200, { invalidated_api_keys: ['k1', 'k2'], error_count: 0 }),
    }),
    { name: 'app:alert-digest@*', invalidated: 2, errors: 0 }
  );
});

test('disable with a partial invalidation: reports failure, stays disabled with a new generation; enable keeps it', async () => {
  const path = consentFile();
  await assert.rejects(
    setAppEnabled(false, {
      consentPath: path,
      esUrl: ES,
      http: responding(200, { invalidated_api_keys: [], error_count: 1 }),
    }),
    AppKeyInvalidationError
  );
  const disabled = readConsent(path);
  assert.equal(disabled?.enabled, false);
  assert.match(disabled?.generation ?? '', /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(disabled?.generation, ORIGINAL);
  // Re-enable is not blocked, and it does not restore the pre-disable generation.
  await setAppEnabled(true, { consentPath: path, esUrl: ES, http: unreachable });
  const enabled = readConsent(path);
  assert.equal(enabled?.enabled, true);
  assert.equal(enabled?.generation, disabled?.generation);
});

test('disable with an unreachable cluster: still replaces the generation, then reports failure', async () => {
  const path = consentFile();
  await assert.rejects(
    setAppEnabled(false, { consentPath: path, esUrl: ES, http: unreachable }),
    AppKeyInvalidationError
  );
  assert.notEqual(readConsent(path)?.generation, ORIGINAL);
});
