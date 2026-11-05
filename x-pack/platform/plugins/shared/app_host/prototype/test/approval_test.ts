/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalError, approveRelease } from '../scripts/lib/approval';
import type { HttpResult } from '../scripts/lib/http';
import { buildUiRelease } from '../scripts/lib/ui_release';

const DASHBOARD = '78a07dab-f7e4-4bdf-b155-da929711312c';
const ES = 'http://es.invalid';
const KB = 'http://kb.invalid';

const result = (status: number, body: unknown): HttpResult => ({
  status,
  body,
  headers: new Headers(),
  ms: 0,
});

/** Fake ES/Kibana: the same username, with configurable authentication realms. */
const fakeHttp =
  (esRealm: unknown, kbRealm: unknown) =>
  async (url: string): Promise<HttpResult> => {
    if (url === `${ES}/_security/_authenticate`) {
      return result(200, {
        username: 'admin',
        roles: ['superuser'],
        authentication_realm: esRealm,
      });
    }
    if (url === `${KB}/internal/security/me`) {
      return result(200, { username: 'admin', authentication_realm: kbRealm });
    }
    if (url === `${ES}/_security/user/_has_privileges`) {
      return result(200, { username: 'admin', has_all_requested: true });
    }
    if (url === `${KB}/api/dashboards/${DASHBOARD}`) return result(200, { id: DASHBOARD });
    return result(404, {});
  };

const attempt = async (esRealm: unknown, kbRealm: unknown) => {
  const { manifest } = await buildUiRelease({
    version: '2.0.0',
    label: 'x',
    dashboardId: DASHBOARD,
  });
  const consentPath = join(mkdtempSync(join(tmpdir(), 'approval-')), 'consent.json');
  try {
    await approveRelease({
      manifest,
      esUrl: ES,
      kbUrl: KB,
      esAuth: 'admin:x',
      kbAuth: 'admin:x',
      consentPath,
      http: fakeHttp(esRealm, kbRealm) as never,
    });
    return { outcome: 'written', wrote: existsSync(consentPath) };
  } catch (error) {
    return {
      outcome: error instanceof ApprovalError ? error.code : String(error),
      wrote: existsSync(consentPath),
    };
  }
};

test('F5: same username in two realms is two principals (mixed_identities, nothing written)', async () => {
  const native = { type: 'native', name: 'native1' };
  for (const kbRealm of [
    { type: 'native', name: 'native2' },
    { type: 'file', name: 'native1' },
    { type: '_es_api_key', name: '_es_api_key' },
    undefined,
  ]) {
    assert.deepEqual(await attempt(native, kbRealm), { outcome: 'mixed_identities', wrote: false });
  }
  assert.deepEqual(await attempt(undefined, undefined), {
    outcome: 'mixed_identities',
    wrote: false,
  });
});

test('F5 positive control: same username and realm passes the identity check', async () => {
  const realm = { type: 'reserved', name: 'reserved' };
  assert.deepEqual(await attempt(realm, { ...realm }), { outcome: 'written', wrote: true });
});
