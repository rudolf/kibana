/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyntheticHost } from '../scripts/lib/client';

test('SyntheticHost exposes only search on its prototype and enforces budget/revocation', async () => {
  const names = Object.getOwnPropertyNames(SyntheticHost.prototype).sort();
  assert.deepEqual(names, ['constructor', 'search']);
  const host = new SyntheticHost(async () => ({ total: 41, records: [] }));
  assert.equal((await host.search({ index: 'kbn-apps-prototype-alerts', size: 1 })).total, 41);
  await assert.rejects(host.search({ index: 'kbn-apps-prototype-alerts', size: 1 }), /budget/);
  SyntheticHost.revoke(host);
  await assert.rejects(host.search({ index: 'kbn-apps-prototype-alerts', size: 1 }), /revoked/);
});
