/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Server-authority suites, mostly bypassing the parent with direct API probes (basic auth, which is
// fine for direct API callers; browser checks use cookie sessions): T7 bypass/CSRF/binding,
// T11 never-delegable corpus (S8), T12 installer/approval/scope map, T13 uniform errors.
// The viewer ∩ app matrix and the app session key itself are K1–K6 (k_session.ts).

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { ApprovalError, approveRelease, readConsent, CONSENT_FILE } from '../approval';
import { http as defaultHttp } from '../http';
import { LOCAL_DIR } from '../secrets';
import { buildUiRelease, releaseUiPackage } from '../ui_release';
import type { UiUser, waitForChild } from '../ui_harness';
import { pollFrame, sleep } from '../ui_harness';
import { UI_SECURITY_PROFILE } from '../../../../common/ui_contract';
import { kfetch, release, type KibanaResponse, type SuiteContext } from './context';
import { appSurfaceProblems } from './t1_shell';

const HTTP = 'http';

export const WRANGLER_LOG = join(LOCAL_DIR, 'logs', 'wrangler.log');
export const dispatcherConnections = (): number =>
  existsSync(WRANGLER_LOG)
    ? (readFileSync(WRANGLER_LOG, 'utf8').match(/GET \/rpc 101/g) ?? []).length
    : -1;

export const apiHeaders = (ctx: SuiteContext): Record<string, string> => ({
  origin: ctx.kibana,
  'kbn-xsrf': 'ui-security',
  'x-elastic-internal-origin': 'Kibana',
});

export interface TestSession {
  readonly user: UiUser;
  readonly handle: string;
}

/** `POST /internal/app_host/ui/session` as `user` (basic auth): mints one app session key. */
export const createSession = async (
  ctx: SuiteContext,
  user: UiUser,
  {
    space,
    headers = {},
    releaseDigest,
  }: { space?: string; headers?: Record<string, string>; releaseDigest?: string } = {}
): Promise<{ response: KibanaResponse; session?: TestSession }> => {
  const response = await kfetch(ctx, `${space ? `/s/${space}` : ''}/internal/app_host/ui/session`, {
    user,
    method: 'POST',
    headers: { ...apiHeaders(ctx), ...headers },
    body: { appId: 'alert-digest', releaseDigest: releaseDigest ?? ctx.current?.releaseDigest },
  });
  const { handle } = (response.json ?? {}) as { handle?: string };
  return response.status === 200 && handle ? { response, session: { user, handle } } : { response };
};

/** `POST /internal/app_host/ui/execute` with `{handle, ...operation}` (the operation is sent raw). */
export const execute = (
  ctx: SuiteContext,
  held: TestSession,
  operation: unknown,
  {
    user = held.user,
    space,
    headers = {},
    handle = held.handle,
  }: { user?: UiUser; space?: string; headers?: Record<string, string>; handle?: string } = {}
) =>
  kfetch(ctx, `${space ? `/s/${space}` : ''}/internal/app_host/ui/execute`, {
    user,
    method: 'POST',
    headers: { ...apiHeaders(ctx), ...headers },
    body: { handle, ...(operation as object) },
  });

export const codeOf = (response: KibanaResponse): string => {
  const body = response.json as
    | { ok?: boolean; code?: string; attributes?: { code?: string } }
    | undefined;
  if (body?.ok === true) return 'ok';
  return body?.code ?? body?.attributes?.code ?? `http_${response.status}`;
};

const SUMMARY = { op: 'app.summary' };
const SEARCH = { op: 'es.search', params: { index: 'kbn-apps-prototype-alerts', size: 100 } };
const dashboardOp = (ctx: SuiteContext, id = ctx.seed.dashboardId) => ({
  op: 'kibana.dashboard.read',
  params: { id },
});

/** Only `{message, attributes:{code}}` (or `{ok:false,code}`) may come back; never native text. */
const errorShapeOk = (response: KibanaResponse) => {
  if (response.status === 200) return true;
  const body = response.json as Record<string, unknown> | undefined;
  if (!body) return false;
  const keys = Object.keys(body).sort().join(',');
  return (
    keys === 'attributes,error,message,statusCode' &&
    Object.keys(body.attributes as object).join(',') === 'code'
  );
};

interface PanelText {
  version?: string;
  summary?: string;
  records?: string;
  dashboard?: string;
  ready?: string | null;
}

export const readPanels = (frame: Awaited<ReturnType<typeof waitForChild>>) =>
  pollFrame(frame, () =>
    document.body.getAttribute('data-ready') === 'true'
      ? ({
          version: document.getElementById('ui-version')?.textContent ?? undefined,
          summary: document.querySelector('#panel-summary .body')?.textContent ?? undefined,
          records: document.querySelector('#panel-records .body')?.textContent ?? undefined,
          dashboard: document.querySelector('#panel-dashboard .body')?.textContent ?? undefined,
          imgs: document.querySelectorAll('img').length,
        } as PanelText & { imgs: number })
      : undefined
  );

export const HTTP_DEBUG_LOG = join(LOCAL_DIR, 'logs', 'http_debug.ndjson');
/** Byte offset marker: the http.server.response debug log grows by hundreds of MB per run. */
export const httpDebugMark = (): number =>
  existsSync(HTTP_DEBUG_LOG) ? statSync(HTTP_DEBUG_LOG).size : 0;

/** Lines appended to the debug log since `mark` (read by byte offset, never the whole file). */
export const httpDebugSince = (mark: number): string[] => {
  if (!existsSync(HTTP_DEBUG_LOG)) return [];
  const fd = openSync(HTTP_DEBUG_LOG, 'r');
  try {
    const length = Math.max(0, fstatSync(fd).size - mark);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, mark);
    return buffer.toString('utf8').split('\n');
  } finally {
    closeSync(fd);
  }
};

const adminUser = (ctx: SuiteContext): UiUser => {
  const [username, ...rest] = ctx.adminAuth.split(':');
  return { username, password: rest.join(':') };
};

export const runT7 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'T7';
  if (ctx.currentEntry !== 'ui/src/main.ts') await release(ctx);
  const held = (await createSession(ctx, users.superuser)).session as TestSession;
  const cases: Array<[string, Promise<KibanaResponse>, string]> = [
    [
      'wrong principal (other user, valid handle)',
      execute(ctx, held, SUMMARY, { user: users.viewer }),
      'app_denied',
    ],
    [
      'wrong space (empty synthetic space)',
      execute(ctx, held, SUMMARY, { space: ctx.seed.emptySpaceId }),
      'app_denied',
    ],
    ['garbage handle', execute(ctx, held, SUMMARY, { handle: 'x'.repeat(43) }), 'app_denied'],
    [
      'missing handle',
      kfetch(ctx, '/internal/app_host/ui/execute', {
        user: users.superuser,
        method: 'POST',
        headers: apiHeaders(ctx),
        body: SUMMARY,
      }),
      'http_400',
    ],
    ['null Origin', execute(ctx, held, SUMMARY, { headers: { origin: 'null' } }), 'app_denied'],
    [
      'cross Origin',
      execute(ctx, held, SUMMARY, { headers: { origin: 'http://127.0.0.1:5698' } }),
      'app_denied',
    ],
    [
      'missing XSRF',
      kfetch(ctx, '/internal/app_host/ui/execute', {
        user: users.superuser,
        method: 'POST',
        headers: { origin: ctx.kibana },
        body: { handle: held.handle, ...SUMMARY },
      }),
      'http_400',
    ],
    [
      'run_as header',
      execute(ctx, held, SUMMARY, { headers: { 'es-security-runas-user': 'elastic' } }),
      'app_denied',
    ],
    ['unknown method/op', execute(ctx, held, { op: 'admin' }), 'bridge_invalid_request'],
    [
      'undeclared index',
      execute(ctx, held, { op: 'es.search', params: { index: 'other-index', size: 1 } }),
      'app_denied',
    ],
    [
      'app id in operation (another app route): refused by the body schema',
      execute(ctx, held, { op: 'app.summary', appId: 'other-app' }),
      'http_400',
    ],
    [
      'path tricks in operation: refused by the body schema',
      execute(ctx, held, { op: 'app.summary', path: '/../admin' }),
      'http_400',
    ],
    [
      'extra params on app.summary',
      execute(ctx, held, { op: 'app.summary', params: { path: '/../admin' } }),
      'bridge_invalid_request',
    ],
  ];
  const statuses = new Map<number, KibanaResponse>();
  for (const [name, promise, expected] of cases) {
    const response = await promise;
    statuses.set(response.status, response);
    report.expect(T, name, HTTP, codeOf(response) === expected, {
      status: response.status,
      code: codeOf(response),
    });
  }
  statuses.set(
    404,
    await kfetch(ctx, '/internal/app_host/ui/no-such-route', {
      user: users.viewer,
      headers: apiHeaders(ctx),
    })
  );
  const problems = [...statuses.entries()].map(
    ([status, response]) =>
      [status, appSurfaceProblems(response, UI_SECURITY_PROFILE.jsonCsp)] as const
  );
  report.expect(
    T,
    'S1: execute/session error responses (400/403/404/413) carry the composed JSON policy and post-Core headers',
    HTTP,
    problems.every(([, p]) => p.length === 0) &&
      statuses.has(400) &&
      statuses.has(403) &&
      statuses.has(404),
    Object.fromEntries(problems)
  );
  const forged = await execute(ctx, held, SUMMARY, { headers: { 'x-kbn-app-id': 'other-app' } });
  report.expect(
    T,
    'forged x-kbn-app-id carries no authority (served as the handle app)',
    HTTP,
    codeOf(forged) === 'ok' &&
      (forged.json as { result: { appId: string } }).result.appId === 'alert-digest'
  );
  const crossLease = await createSession(ctx, users.viewer, { headers: { origin: 'null' } });
  const spaceLease = await createSession(ctx, users.superuser, { space: ctx.seed.emptySpaceId });
  report.expect(
    T,
    'session creation refuses null Origin and non-default space (superuser)',
    HTTP,
    codeOf(crossLease.response) === 'app_denied' && codeOf(spaceLease.response) === 'app_denied',
    [codeOf(crossLease.response), codeOf(spaceLease.response)]
  );
  const unknown = await kfetch(ctx, '/internal/app_host/ui/apps/other-app', {
    user: users.viewer,
    headers: apiHeaders(ctx),
  });
  report.expect(T, 'unknown app metadata → 404', HTTP, unknown.status === 404);
  // Stale release: the handle's release is replaced by an approved new one (after the 2 s cache).
  const staleLease = (await createSession(ctx, users.viewer)).session as TestSession;
  await release(ctx, { label: 'Digest T7 replacement' });
  await sleep(2100);
  const stale = await execute(ctx, staleLease, SUMMARY);
  report.expect(
    T,
    'handle for the previous release → app_stale after a new approved release',
    HTTP,
    codeOf(stale) === 'app_stale',
    codeOf(stale)
  );
};

export const runT11 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'T11';
  if (ctx.currentEntry !== 'ui/src/main.ts') await release(ctx);
  const su = (await createSession(ctx, users.superuser)).session as TestSession;
  const before = dispatcherConnections();
  const corpus: Array<[string, unknown]> = [
    ['rule create', { op: 'alerting.rule.create', params: {} }],
    ['task schedule', { op: 'task_manager.schedule' }],
    ['transform', { op: 'transform.put' }],
    ['report', { op: 'reporting.generate' }],
    ['workflow', { op: 'workflows.run' }],
    ['connector execute', { op: 'actions.execute', params: { id: 'x' } }],
    ['inference', { op: 'inference.completion' }],
    ['executable SO write', { op: 'saved_objects.create', params: { type: 'visualization' } }],
    ['raw transport', { op: 'es.transport', params: { path: '/_security/user' } }],
    ['raw HTTP', { op: 'http.request', params: { path: '/api/security/role' } }],
    ...[
      'FROM .security* | LIMIT 1',
      'FROM a | LOOKUP JOIN b ON x',
      'FROM a | ENRICH p',
      'FROM a | FORK (LIMIT 1)',
      'FROM a | FUSE',
      'PROMQL up',
      'TS m',
      'FROM remote:i',
      'FROM a | COMPLETION x',
      'FROM a | RERANK q ON f',
      'FROM v | INLINESTATS c=COUNT(*)',
      'FROM a METADATA _index | WHERE x IN (FROM b)',
    ].map((esql): [string, unknown] => [
      `ES|QL ${esql.slice(0, 18)}`,
      { op: 'es.search', params: { esql } },
    ]),
    ...[
      'query',
      'lookup',
      'more_like_this',
      'percolate',
      'indexed_shape',
      'pit',
      'scroll',
      'search_after',
      'async',
      'template',
      'script_fields',
      'runtime_mappings',
      'knn',
      'retriever',
      'inference',
      'run_as',
      'headers',
    ].map((field): [string, unknown] => [
      `DSL ${field}`,
      { op: 'es.search', params: { index: 'kbn-apps-prototype-alerts', size: 1, [field]: {} } },
    ]),
  ];
  const results = [];
  for (const [name, operation] of corpus)
    results.push([name, codeOf(await execute(ctx, su, operation))]);
  report.expect(
    T,
    'superuser: never-delegable APIs and query/handle corpus unsupported before I/O',
    HTTP,
    results.every(([, code]) => code === 'bridge_invalid_request') &&
      dispatcherConnections() === before,
    {
      unsupported: results.length,
      nonConforming: results.filter(([, c]) => c !== 'bridge_invalid_request'),
      dispatcherDelta: dispatcherConnections() - before,
    }
  );
  const indices = [
    '.security-7',
    '.security',
    '.kibana',
    '.kibana_task_manager',
    '.fleet-agents',
    '.ds-logs-kibana.audit-default-2026.11.04-000001',
    'logs-kibana.audit-default',
    'logs-*',
    'kbn-*',
    '*',
    'kbn-apps-prototype-alerts,other',
    'remote:kbn-apps-prototype-alerts',
    '_all',
    'kbn-apps-prototype-alerts*',
  ];
  const idx = [];
  for (const index of indices)
    idx.push([
      index,
      codeOf(await execute(ctx, su, { op: 'es.search', params: { index, size: 1 } })),
    ]);
  report.expect(
    T,
    'S8: system/hidden/audit/pattern/CCS indices rejected before I/O as superuser',
    HTTP,
    idx.every(([, c]) => c === 'app_denied'),
    idx
  );
};

export const runT12 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'T12';
  const consentBefore = existsSync(CONSENT_FILE) ? readFileSync(CONSENT_FILE, 'utf8') : undefined;
  const base = await buildUiRelease({
    version: ctx.nextVersion(),
    label: 'T12',
    dashboardId: ctx.seed.dashboardId,
  });
  const attempt = async (
    esAuth: string,
    kbAuth: string,
    overrides: { esUrl?: string; manifest?: typeof base.manifest; http?: typeof defaultHttp } = {}
  ) => {
    try {
      const result = await approveRelease({
        manifest: overrides.manifest ?? base.manifest,
        esUrl: overrides.esUrl ?? ctx.es,
        kbUrl: ctx.kibana,
        esAuth,
        kbAuth,
        http: overrides.http,
      });
      return result.idempotent ? 'idempotent' : 'written';
    } catch (error) {
      return error instanceof ApprovalError ? error.code : String(error).slice(0, 80);
    }
  };
  const auth = (user: UiUser) => `${user.username}:${user.password}`;
  const unchanged = () =>
    (existsSync(CONSENT_FILE) ? readFileSync(CONSENT_FILE, 'utf8') : undefined) === consentBefore;
  const nonSuper = await attempt(auth(users.nonSuperInstaller), auth(users.nonSuperInstaller));
  report.expect(
    T,
    'non-superuser installer refused, nothing written',
    HTTP,
    nonSuper === 'not_superuser' && unchanged(),
    nonSuper
  );
  const mixed = await attempt(ctx.adminAuth, auth(users.superuser));
  report.expect(
    T,
    'mixed ES/Kibana identities refused',
    HTTP,
    mixed === 'mixed_identities' && unchanged(),
    mixed
  );
  // F5: the same username through two realms (ES: the admin's basic login; Kibana: an API key the
  // admin owns, realm `_es_api_key`) is two principals. The key is local, short-lived, never printed
  // and invalidated afterwards.
  const apiKey = await defaultHttp(`${ctx.es}/_security/api_key`, {
    method: 'POST',
    auth: ctx.adminAuth,
    body: { name: 'app-host-t12-realm', expiration: '10m', role_descriptors: {} },
  });
  const { id: keyId, encoded } = apiKey.body as { id?: string; encoded?: string };
  try {
    const viaApiKey: typeof defaultHttp = (url, options = {}) =>
      url.startsWith(ctx.kibana)
        ? defaultHttp(url, {
            ...options,
            auth: undefined,
            headers: { ...options.headers, authorization: `ApiKey ${encoded}` },
          })
        : defaultHttp(url, options);
    const me = await viaApiKey(`${ctx.kibana}/internal/security/me`, {
      headers: { 'x-elastic-internal-origin': 'app-host-approval' },
    });
    const meBody = me.body as { username?: string; authentication_realm?: { type?: string } };
    const realm = await attempt(ctx.adminAuth, ctx.adminAuth, { http: viaApiKey });
    report.expect(
      T,
      'F5: same username in two realms (ES basic vs Kibana API key) refused as mixed identities',
      HTTP,
      apiKey.status === 200 &&
        me.status === 200 &&
        meBody.username === adminUser(ctx).username &&
        meBody.authentication_realm?.type === '_es_api_key' &&
        realm === 'mixed_identities' &&
        unchanged(),
      {
        realm,
        kibanaUser: meBody.username === adminUser(ctx).username,
        kibanaRealm: meBody.authentication_realm?.type,
      }
    );
  } finally {
    if (keyId) {
      await defaultHttp(`${ctx.es}/_security/api_key`, {
        method: 'DELETE',
        auth: ctx.adminAuth,
        body: { ids: [keyId] },
      });
    }
  }
  const unavailable = await attempt(ctx.adminAuth, ctx.adminAuth, { esUrl: 'http://127.0.0.1:9' });
  report.expect(
    T,
    'unavailable privilege check fails closed',
    HTTP,
    unavailable === 'es_unavailable' && unchanged(),
    unavailable
  );
  const missingDashboard = await buildUiRelease({
    version: ctx.nextVersion(),
    label: 'T12b',
    dashboardId: '00000000-0000-4000-8000-000000000000',
  });
  const dash = await attempt(ctx.adminAuth, ctx.adminAuth, { manifest: missingDashboard.manifest });
  report.expect(
    T,
    'negative native dashboard check fails closed',
    HTTP,
    dash === 'dashboard_unreadable' && unchanged(),
    dash
  );
  // Positive: superuser approves; record holds approver + grant fingerprint and no credentials.
  await releaseUiPackage(ctx.packageDir, base);
  const positive = await attempt(auth(users.superuser), auth(users.superuser));
  const consent = readConsent();
  const raw = existsSync(CONSENT_FILE) ? readFileSync(CONSENT_FILE, 'utf8') : '';
  report.expect(
    T,
    'positive superuser approval records approver + checked-grant fingerprint, no credentials',
    HTTP,
    positive === 'written' &&
      consent?.approvedBy === users.superuser.username &&
      /^[0-9a-f]{64}$/.test(consent?.installerGrantDigest ?? '') &&
      !raw.includes(users.superuser.password) &&
      Object.keys(consent ?? {})
        .sort()
        .join(',') ===
        'appId,approvedBy,approvedReleaseDigest,approvedVersion,enabled,generation,installerGrantDigest',
    { approvedBy: consent?.approvedBy, keys: Object.keys(consent ?? {}) }
  );
  ctx.current = base.manifest;
  ctx.currentEntry = 'ui/src/main.ts';
  const again = await attempt(auth(users.superuser), auth(users.superuser));
  report.expect(
    T,
    'same-digest approval is idempotent (reported idempotent, file unchanged)',
    HTTP,
    again === 'idempotent' && readFileSync(CONSENT_FILE, 'utf8') === raw,
    again
  );
  const older = await buildUiRelease({
    version: '0.9.0',
    label: 'old',
    dashboardId: ctx.seed.dashboardId,
  });
  const downgrade = await attempt(ctx.adminAuth, ctx.adminAuth, { manifest: older.manifest });
  report.expect(
    T,
    'downgrade below the approved version rejected',
    HTTP,
    downgrade === 'downgrade_rejected',
    downgrade
  );
  // Modified scope map / egress / CSP profile / resources → not served even when "approved".
  for (const [name, mutate] of [
    [
      'wrong scope-map digest',
      (m: Record<string, unknown>) => {
        (m.ui as Record<string, unknown>).scopeMapDigest = 'f'.repeat(64);
      },
    ],
    [
      'non-empty egress',
      (m: Record<string, unknown>) => {
        (m.ui as Record<string, unknown>).egress = { client: ['https://example.com'], server: [] };
      },
    ],
    [
      'extra non-delegable scope',
      (m: Record<string, unknown>) => {
        (m.ui as Record<string, unknown>).scopes = [
          'app.summary',
          'es.search',
          'security.apiKey.create',
        ];
      },
    ],
    [
      'other concrete index',
      (m: Record<string, unknown>) => {
        (m.permissions as Record<string, unknown>).indices = ['other-index'];
      },
    ],
  ] as const) {
    const bad = await buildUiRelease({
      version: ctx.nextVersion(),
      label: name,
      dashboardId: ctx.seed.dashboardId,
      mutate,
    });
    await releaseUiPackage(ctx.packageDir, bad);
    const approval = await attempt(ctx.adminAuth, ctx.adminAuth, { manifest: bad.manifest });
    const metadata = await kfetch(ctx, '/internal/app_host/ui/apps/alert-digest', {
      user: users.viewer,
      headers: apiHeaders(ctx),
    });
    const held = await createSession(ctx, users.viewer, {
      releaseDigest: bad.manifest.releaseDigest,
    });
    report.expect(
      T,
      `${name}: rejected by Kibana even if operator-approved`,
      HTTP,
      metadata.status === 404 && held.response.status !== 200,
      { approval, metadata: metadata.status, session: codeOf(held.response) }
    );
  }
  await release(ctx);
};

export const runT13 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'T13';
  if (ctx.currentEntry !== 'ui/src/main.ts') await release(ctx);
  const held = (await createSession(ctx, users.viewer)).session as TestSession;
  const existing = await execute(ctx, held, dashboardOp(ctx, ctx.seed.ungrantedDashboardId));
  const missing = await execute(
    ctx,
    held,
    dashboardOp(ctx, '00000000-0000-4000-8000-000000000000')
  );
  report.expect(
    T,
    'existing vs missing ungranted dashboard: identical denial before lookup',
    HTTP,
    existing.status === missing.status &&
      existing.text === missing.text &&
      codeOf(existing) === 'app_denied',
    { existing: [existing.status, codeOf(existing)], missing: [missing.status, codeOf(missing)] }
  );
  const noIndex = (await createSession(ctx, users.noIndex)).session as TestSession;
  const denied = await execute(ctx, noIndex, SEARCH);
  const leaks = [
    users.noIndex.username,
    'app_host_ui_no_index',
    'kbn-apps-prototype-alerts',
    'indices:data/read',
    'security_exception',
    'role',
    'stack',
  ].filter((canary) => denied.text.includes(canary));
  report.expect(
    T,
    'real ES 403: only the fixed code; no user/role/index/action/stack/WWW-Authenticate',
    HTTP,
    codeOf(denied) === 'app_denied' &&
      leaks.length === 0 &&
      !('www-authenticate' in denied.headers) &&
      errorShapeOk(denied),
    { body: denied.json, leaks }
  );
  const noDash = (await createSession(ctx, users.noDashboard)).session as TestSession;
  const dash = await execute(ctx, noDash, dashboardOp(ctx));
  report.expect(
    T,
    'real Kibana 403 (no dashboard privilege): fixed code, no native body',
    HTTP,
    codeOf(dash) === 'app_denied' &&
      !/forbidden|privilege|saved_object|dashboard/i.test(
        String((dash.json as { message?: string }).message)
      ) &&
      errorShapeOk(dash),
    dash.json
  );
};
