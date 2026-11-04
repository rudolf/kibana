/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Seeds the synthetic index (exactly three documents: high, high, low; no aliases) and local test
// roles/users. Passwords are generated into the git-ignored .local/users.json and never printed.
// Env: ES_URL, ES_AUTH (local admin user:pass), KB_URL, KB_AUTH (defaults to ES_AUTH).

import { http, requireEnv } from './lib/http';
import { readOrCreateUsers } from './lib/secrets';

const INDEX = 'kbn-apps-prototype-alerts';
const esUrl = requireEnv('ES_URL').replace(/\/$/, '');
const esAuth = requireEnv('ES_AUTH');
const kbUrl = requireEnv('KB_URL').replace(/\/$/, '');
const kbAuth = process.env.KB_AUTH ?? esAuth;

const check = (what: string, status: number, ok: number[]) => {
  if (!ok.includes(status)) throw new Error(`${what} failed with HTTP ${status}`);
};

const es = (path: string, method = 'GET', body?: unknown) =>
  http(`${esUrl}${path}`, { method, auth: esAuth, body });

const deleted = await es(`/${INDEX}`, 'DELETE');
check('delete index', deleted.status, [200, 404]);
check(
  'create index',
  (
    await es(`/${INDEX}`, 'PUT', {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: {
        dynamic: 'strict',
        properties: {
          '@timestamp': { type: 'date' },
          severity: { type: 'keyword' },
          rule: { type: 'keyword' },
        },
      },
    })
  ).status,
  [200]
);
const now = Date.now();
const docs = [
  { severity: 'high', rule: 'synthetic-rule-a' },
  { severity: 'high', rule: 'synthetic-rule-b' },
  { severity: 'low', rule: 'synthetic-rule-c' },
];
const bulk = docs
  .flatMap((doc, i) => [
    JSON.stringify({ index: { _index: INDEX, _id: `synthetic-${i + 1}` } }),
    JSON.stringify({ '@timestamp': new Date(now - i * 60_000).toISOString(), ...doc }),
  ])
  .join('\n');
const bulkResult = await http(`${esUrl}/_bulk?refresh=wait_for`, {
  method: 'POST',
  auth: esAuth,
  body: `${bulk}\n`,
  headers: { 'content-type': 'application/x-ndjson' },
});
check('bulk', bulkResult.status, [200]);
const count = await es(`/${INDEX}/_count`);
const aliases = await es(`/_alias/${INDEX}`);

const kibanaRole = async (name: string, elasticsearch: unknown, feature: boolean) => {
  const result = await http(`${kbUrl}/api/security/role/${name}`, {
    method: 'PUT',
    auth: kbAuth,
    headers: { 'kbn-xsrf': 'app-host-seed' },
    body: {
      elasticsearch,
      kibana: feature ? [{ base: [], feature: { appHost: ['read'] }, spaces: ['default'] }] : [],
    },
  });
  check(`role ${name}`, result.status, [204]);
};

const indexRead = { cluster: [], indices: [{ names: [INDEX], privileges: ['read'] }] };
const noIndex = { cluster: [], indices: [] };
await kibanaRole('app_host_reader', indexRead, true);
await kibanaRole('app_host_no_index', noIndex, true);
await kibanaRole('app_host_no_feature', indexRead, false);

const users = readOrCreateUsers();
const roleFor = {
  reader: 'app_host_reader',
  noIndex: 'app_host_no_index',
  noFeature: 'app_host_no_feature',
} as const;
for (const key of ['reader', 'noIndex', 'noFeature'] as const) {
  const { username, password } = users[key];
  const result = await es(`/_security/user/${username}`, 'PUT', {
    password,
    roles: [roleFor[key]],
    full_name: `App Host prototype ${key}`,
  });
  check(`user ${username}`, result.status, [200]);
}

process.stdout.write(
  `${JSON.stringify({
    index: INDEX,
    documents: (count.body as { count?: number }).count,
    severities: { high: 2, low: 1 },
    aliasesOnIndexName: aliases.status === 404 ? 0 : 'present',
    roles: Object.values(roleFor),
    users: Object.values(users).map(({ username }) => username),
    passwords: '.local/users.json (git-ignored, not printed)',
  })}\n`
);
