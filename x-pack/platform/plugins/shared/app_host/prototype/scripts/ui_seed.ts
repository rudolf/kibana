/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Seeds the UI cut's synthetic state on top of `npm run seed`: one hostile synthetic record (severity
// `medium`, so the summary counts stay high 2 / low 1), one synthetic dashboard created through its
// public API (title contains markup), a second empty synthetic space, and the UI viewer matrix.
// Passwords go to the git-ignored .local/ui_users.json and are never printed.
// Env: ES_URL, ES_AUTH (local admin), KB_URL, KB_AUTH (defaults to ES_AUTH).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { http, requireEnv } from './lib/http';
import { LOCAL_DIR } from './lib/secrets';
import { DASHBOARD_TITLE, HOSTILE_RULE, UI_SEED_FILE, writeUiSeed } from './lib/ui_seed_state';

const INDEX = 'kbn-apps-prototype-alerts';
const EMPTY_SPACE = 'app-host-empty';

const esUrl = requireEnv('ES_URL').replace(/\/$/, '');
const esAuth = requireEnv('ES_AUTH');
const kbUrl = requireEnv('KB_URL').replace(/\/$/, '');
const kbAuth = process.env.KB_AUTH ?? esAuth;

const check = (what: string, status: number, ok: number[]) => {
  if (!ok.includes(status)) throw new Error(`${what} failed with HTTP ${status}`);
};
const kb = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
  http(`${kbUrl}${path}`, {
    method,
    auth: kbAuth,
    body,
    headers: { 'kbn-xsrf': 'ui-seed', ...headers },
  });

// 1. Hostile synthetic record (fixed id, idempotent).
check(
  'hostile record',
  (
    await http(`${esUrl}/${INDEX}/_doc/synthetic-hostile?refresh=wait_for`, {
      method: 'PUT',
      auth: esAuth,
      body: { '@timestamp': new Date().toISOString(), severity: 'medium', rule: HOSTILE_RULE },
    })
  ).status,
  [200, 201]
);

// 2. Synthetic dashboard via the public create API (reuse an existing one from a previous seed).
const previous = existsSync(UI_SEED_FILE)
  ? (JSON.parse(readFileSync(UI_SEED_FILE, 'utf8')) as { dashboardId?: string })
  : {};
let dashboardId = previous.dashboardId;
if (dashboardId) {
  const existing = await kb(`/api/dashboards/${dashboardId}`, 'GET', undefined, {
    'elastic-api-version': '2023-10-31',
  });
  if (existing.status !== 200) dashboardId = undefined;
}
if (!dashboardId) {
  const created = await kb(
    '/api/dashboards',
    'POST',
    { title: DASHBOARD_TITLE },
    {
      'elastic-api-version': '2023-10-31',
    }
  );
  check('create dashboard', created.status, [200, 201]);
  dashboardId = (created.body as { id: string }).id;
}

// 2b. A second synthetic dashboard that no release ever grants.
const previousUngranted = (previous as { ungrantedDashboardId?: string }).ungrantedDashboardId;
let ungrantedDashboardId = previousUngranted;
if (ungrantedDashboardId) {
  const existing = await kb(`/api/dashboards/${ungrantedDashboardId}`, 'GET', undefined, {
    'elastic-api-version': '2023-10-31',
  });
  if (existing.status !== 200) ungrantedDashboardId = undefined;
}
if (!ungrantedDashboardId) {
  const created = await kb(
    '/api/dashboards',
    'POST',
    { title: 'Synthetic ungranted dashboard' },
    { 'elastic-api-version': '2023-10-31' }
  );
  check('create ungranted dashboard', created.status, [200, 201]);
  ungrantedDashboardId = (created.body as { id: string }).id;
}

// 3. Second, empty synthetic space for the superuser non-default-space denial controls.
const space = await kb(`/api/spaces/space/${EMPTY_SPACE}`);
if (space.status === 404) {
  check(
    'create space',
    (
      await kb('/api/spaces/space', 'POST', {
        id: EMPTY_SPACE,
        name: 'App Host empty synthetic space',
      })
    ).status,
    [200]
  );
}

// 4. Roles and users.
type Features = Record<string, string[]>;
const role = async (name: string, indices: boolean, feature: Features) => {
  const result = await kb(`/api/security/role/${name}`, 'PUT', {
    elasticsearch: {
      cluster: [],
      indices: indices ? [{ names: [INDEX], privileges: ['read'] }] : [],
    },
    kibana: Object.keys(feature).length
      ? [{ base: [], feature, spaces: ['default', EMPTY_SPACE] }]
      : [],
  });
  check(`role ${name}`, result.status, [204]);
};
const app = { appHost: ['read'], appHostAlertDigest: ['read'] };
await role('app_host_ui_viewer', true, { ...app, dashboard_v2: ['read'] });
await role('app_host_ui_no_index', false, { ...app, dashboard_v2: ['read'] });
await role('app_host_ui_no_dashboard', true, app);
await role('app_host_ui_global_only', true, { appHost: ['read'], dashboard_v2: ['read'] });

const USERS_FILE = join(LOCAL_DIR, 'ui_users.json');
const roles = {
  viewer: ['app_host_ui_viewer'],
  viewer2: ['app_host_ui_viewer'],
  noIndex: ['app_host_ui_no_index'],
  noDashboard: ['app_host_ui_no_dashboard'],
  globalOnly: ['app_host_ui_global_only'],
  superuser: ['superuser'],
  nonSuperInstaller: ['app_host_ui_viewer'],
} as const;
type UserKey = keyof typeof roles;
const users: Record<string, { username: string; password: string }> = existsSync(USERS_FILE)
  ? JSON.parse(readFileSync(USERS_FILE, 'utf8'))
  : {};
for (const key of Object.keys(roles) as UserKey[]) {
  users[key] ??= {
    username: `app_host_ui_${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`,
    password: randomBytes(18).toString('base64url'),
  };
  const { username, password } = users[key];
  const result = await http(`${esUrl}/_security/user/${username}`, {
    method: 'PUT',
    auth: esAuth,
    body: { password, roles: roles[key], full_name: `App Host UI synthetic ${key}` },
  });
  check(`user ${username}`, result.status, [200]);
}
writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
writeUiSeed({ dashboardId, ungrantedDashboardId, emptySpaceId: EMPTY_SPACE });

process.stdout.write(
  `${JSON.stringify({
    hostileRecord: 'synthetic-hostile (severity medium)',
    dashboardId,
    ungrantedDashboardId,
    emptySpace: EMPTY_SPACE,
    users: Object.values(users).map(({ username }) => username),
    passwords: '.local/ui_users.json (git-ignored, not printed)',
  })}\n`
);
