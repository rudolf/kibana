/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Server-authority suites, mostly bypassing the parent with direct API probes (basic auth, which is
// fine for direct API callers; browser checks use cookie sessions):
// T2 scoped delegation matrix, T7 bypass/CSRF/binding, T9 server budgets and lease caps (S11),
// T11 never-delegable corpus (S8), T12 installer/approval/scope map, T13 uniform errors,
// T14 ephemeral state / space / buckets.

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
import { LOCAL_DIR } from '../secrets';
import { buildUiRelease, releaseUiPackage } from '../ui_release';
import type { UiUser } from '../ui_harness';
import { openAndAllow, pollFrame, sleep, waitForChild, waitForStatus } from '../ui_harness';
import { UI_SECURITY_PROFILE } from '../../../../common/ui_contract';
import { kfetch, release, session, type KibanaResponse, type SuiteContext } from './context';
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

export interface TestLease {
  readonly user: UiUser;
  readonly leaseId: string;
  readonly secret: string;
}

const created: TestLease[] = [];

export const createLease = async (
  ctx: SuiteContext,
  user: UiUser,
  {
    space,
    headers = {},
    releaseDigest,
  }: { space?: string; headers?: Record<string, string>; releaseDigest?: string } = {}
): Promise<{ response: KibanaResponse; lease?: TestLease }> => {
  const response = await kfetch(ctx, `${space ? `/s/${space}` : ''}/internal/app_host/ui/leases`, {
    user,
    method: 'POST',
    headers: { ...apiHeaders(ctx), ...headers },
    body: { appId: 'alert-digest', releaseDigest: releaseDigest ?? ctx.current?.releaseDigest },
  });
  const body = response.json as { leaseId?: string; secret?: string };
  if (response.status === 200 && body.leaseId && body.secret) {
    const lease = { user, leaseId: body.leaseId, secret: body.secret };
    created.push(lease);
    return { response, lease };
  }
  return { response };
};

export const execute = (
  ctx: SuiteContext,
  lease: TestLease,
  operation: unknown,
  {
    user = lease.user,
    space,
    headers = {},
    secret = lease.secret,
  }: { user?: UiUser; space?: string; headers?: Record<string, string>; secret?: string } = {}
) =>
  kfetch(
    ctx,
    `${space ? `/s/${space}` : ''}/internal/app_host/ui/leases/${lease.leaseId}/execute`,
    {
      user,
      method: 'POST',
      headers: { ...apiHeaders(ctx), ...headers },
      body: { secret, operation },
    }
  );

export const revokeAll = async (ctx: SuiteContext) => {
  for (const lease of created.splice(0)) {
    await kfetch(ctx, `/internal/app_host/ui/leases/${lease.leaseId}/revoke`, {
      user: lease.user,
      method: 'POST',
      headers: apiHeaders(ctx),
      body: { secret: lease.secret },
    }).catch(() => undefined);
  }
};

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

export const runT2 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'T2';
  if (ctx.currentEntry !== 'ui/src/main.ts') await release(ctx);
  try {
    const viewer = await createLease(ctx, users.viewer);
    const lease = viewer.lease as TestLease;
    const connectionsBefore = dispatcherConnections();
    const summary = await execute(ctx, lease, SUMMARY);
    report.expect(
      T,
      'dispatcher observer positive control: one app.summary = one fresh invocation',
      HTTP,
      dispatcherConnections() === connectionsBefore + 1,
      { before: connectionsBefore, after: dispatcherConnections() }
    );
    const search = await execute(ctx, lease, SEARCH);
    const dashboard = await execute(ctx, lease, dashboardOp(ctx));
    const searchBody = search.json as {
      result?: { total: number; records: Array<{ rule: string }> };
    };
    report.expect(
      T,
      'positive viewer: summary + exact search + dashboard title',
      HTTP,
      codeOf(summary) === 'ok' &&
        codeOf(search) === 'ok' &&
        codeOf(dashboard) === 'ok' &&
        (summary.json as { result: { counts: unknown } }).result.counts !== undefined &&
        (searchBody.result?.records.length ?? 0) >= 4,
      { summary: summary.json, searchTotal: searchBody.result?.total, dashboard: dashboard.json }
    );

    const before = dispatcherConnections();
    const global = users.globalOnly;
    const metadata = await kfetch(ctx, '/internal/app_host/ui/apps/alert-digest', {
      user: global,
      headers: apiHeaders(ctx),
    });
    const guardian = await kfetch(
      ctx,
      `/api/app_host/ui/alert-digest/${ctx.current?.releaseDigest}/guardian`,
      { user: global, headers: { 'sec-fetch-dest': 'iframe' } }
    );
    const globalLease = await createLease(ctx, global);
    const nativeSummary = await kfetch(ctx, '/api/apps/alert-digest/summary', { user: global });
    report.expect(
      T,
      'global-only viewer (read_app_host only): no metadata/frame/lease/native summary',
      HTTP,
      [metadata.status, guardian.status, globalLease.response.status, nativeSummary.status].every(
        (s) => s === 403
      ),
      {
        metadata: metadata.status,
        guardian: guardian.status,
        lease: globalLease.response.status,
        nativeSummary: nativeSummary.status,
      }
    );
    report.expect(
      T,
      'global-only viewer: zero dispatcher invocations',
      HTTP,
      before >= 0 && dispatcherConnections() === before,
      { before, after: dispatcherConnections() }
    );

    const noIndex = (await createLease(ctx, users.noIndex)).lease as TestLease;
    const ni = [
      await execute(ctx, noIndex, SEARCH),
      await execute(ctx, noIndex, SUMMARY),
      await execute(ctx, noIndex, dashboardOp(ctx)),
    ];
    report.expect(
      T,
      'no-index viewer (both app privileges): search+summary 403 app_denied, dashboard ok',
      HTTP,
      codeOf(ni[0]) === 'app_denied' &&
        ni[0].status === 403 &&
        codeOf(ni[1]) === 'app_denied' &&
        codeOf(ni[2]) === 'ok' &&
        ni.every(errorShapeOk),
      ni.map((r) => [r.status, codeOf(r)])
    );
    const noDash = (await createLease(ctx, users.noDashboard)).lease as TestLease;
    const nd = [await execute(ctx, noDash, SEARCH), await execute(ctx, noDash, dashboardOp(ctx))];
    report.expect(
      T,
      'no-dashboard viewer: search ok, real native 403 normalized to app_denied',
      HTTP,
      codeOf(nd[0]) === 'ok' &&
        codeOf(nd[1]) === 'app_denied' &&
        nd[1].status === 403 &&
        errorShapeOk(nd[1]),
      nd.map((r) => [r.status, codeOf(r)])
    );

    const su = (await createLease(ctx, users.superuser)).lease as TestLease;
    const keysBefore = await fetch(`${ctx.es}/_security/api_key?owner=false`, {
      headers: { authorization: `Basic ${Buffer.from(ctx.adminAuth).toString('base64')}` },
    }).then((r) => r.json() as Promise<{ api_keys: unknown[] }>);
    const httpLogMark = httpDebugMark();
    const forbidden = await execute(ctx, su, {
      op: 'security.apiKey.create',
      params: { name: 'x' },
    });
    const transport = await execute(ctx, su, {
      op: 'http.request',
      params: { method: 'POST', path: '/internal/security/api_key' },
    });
    await sleep(1000);
    const keysAfter = await fetch(`${ctx.es}/_security/api_key?owner=false`, {
      headers: { authorization: `Basic ${Buffer.from(ctx.adminAuth).toString('base64')}` },
    }).then((r) => r.json() as Promise<{ api_keys: unknown[] }>);
    const securityCalls = httpDebugSince(httpLogMark).filter((line) =>
      /\/(api|internal)\/security\//.test(line)
    );
    report.expect(
      T,
      'superuser: non-delegable op rejected, zero native security-route calls, no key minted',
      HTTP,
      codeOf(forbidden) === 'bridge_invalid_request' &&
        codeOf(transport) === 'bridge_invalid_request' &&
        securityCalls.length === 0 &&
        keysAfter.api_keys.length === keysBefore.api_keys.length,
      {
        codes: [codeOf(forbidden), codeOf(transport)],
        securityRouteCalls: securityCalls.length,
        apiKeys: [keysBefore.api_keys.length, keysAfter.api_keys.length],
      }
    );
    const suOk = [await execute(ctx, su, SUMMARY), await execute(ctx, su, SEARCH)];
    report.expect(
      T,
      'superuser gets the same three operations only (no growth)',
      HTTP,
      suOk.every((r) => codeOf(r) === 'ok') &&
        codeOf(
          await execute(ctx, su, { op: 'es.search', params: { index: '.security-7', size: 1 } })
        ) === 'app_denied'
    );
    for (const engine of ctx.engines) {
      await report.guard(T, 'browser', engine, () => runT2Browser(ctx, engine));
    }
  } finally {
    await revokeAll(ctx);
  }
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

/** Browser half of T2: the sample UI renders all three panels via the real bridge (cookie session). */
const runT2Browser = async (ctx: SuiteContext, engine: string) => {
  const { report, users } = ctx;
  for (const [name, user, expectDashboard] of [
    ['positive viewer', users.viewer, 'ok'],
    ['no-dashboard viewer', users.noDashboard, 'denied'],
  ] as const) {
    const s = await session(ctx, engine, user);
    try {
      await openAndAllow(s.page, ctx.kibana);
      await waitForStatus(s.page, /^bound$/);
      const panels = await readPanels(await waitForChild(s.page));
      const okDashboard =
        expectDashboard === 'ok'
          ? panels.dashboard === 'Synthetic <b>dashboard</b> <img src=x onerror=alert(1)>'
          : panels.dashboard === 'error app_denied';
      report.expect(
        'T2',
        `${name}: three panels through the bridge`,
        engine,
        /high 2, low 1/.test(panels.summary ?? '') &&
          (panels.records ?? '').includes('synthetic-rule-a') &&
          okDashboard,
        panels
      );
    } finally {
      await s.close();
    }
  }
};

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

export const runT7 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'T7';
  if (ctx.currentEntry !== 'ui/src/main.ts') await release(ctx);
  try {
    const lease = (await createLease(ctx, users.superuser)).lease as TestLease;
    const cases: Array<[string, Promise<KibanaResponse>, string]> = [
      [
        'wrong principal (other user, valid lease+secret)',
        execute(ctx, lease, SUMMARY, { user: users.viewer }),
        'app_denied',
      ],
      [
        'wrong space (empty synthetic space)',
        execute(ctx, lease, SUMMARY, { space: ctx.seed.emptySpaceId }),
        'app_denied',
      ],
      ['wrong secret', execute(ctx, lease, SUMMARY, { secret: 'x'.repeat(43) }), 'app_denied'],
      [
        'missing secret',
        kfetch(ctx, `/internal/app_host/ui/leases/${lease.leaseId}/execute`, {
          user: users.superuser,
          method: 'POST',
          headers: apiHeaders(ctx),
          body: { operation: SUMMARY },
        }),
        'http_400',
      ],
      ['null Origin', execute(ctx, lease, SUMMARY, { headers: { origin: 'null' } }), 'app_denied'],
      [
        'cross Origin',
        execute(ctx, lease, SUMMARY, { headers: { origin: 'http://127.0.0.1:5698' } }),
        'app_denied',
      ],
      [
        'missing XSRF',
        kfetch(ctx, `/internal/app_host/ui/leases/${lease.leaseId}/execute`, {
          user: users.superuser,
          method: 'POST',
          headers: { origin: ctx.kibana },
          body: { secret: lease.secret, operation: SUMMARY },
        }),
        'http_400',
      ],
      [
        'run_as header',
        execute(ctx, lease, SUMMARY, { headers: { 'es-security-runas-user': 'elastic' } }),
        'app_denied',
      ],
      ['unknown method/op', execute(ctx, lease, { op: 'admin' }), 'bridge_invalid_request'],
      [
        'undeclared index',
        execute(ctx, lease, { op: 'es.search', params: { index: 'other-index', size: 1 } }),
        'app_denied',
      ],
      [
        'app id in operation (another app route)',
        execute(ctx, lease, { op: 'app.summary', appId: 'other-app' }),
        'bridge_invalid_request',
      ],
      [
        'path tricks in operation',
        execute(ctx, lease, { op: 'app.summary', path: '/../admin' }),
        'bridge_invalid_request',
      ],
      [
        'unknown lease id',
        execute(ctx, { ...lease, leaseId: 'A'.repeat(32) }, SUMMARY),
        'app_denied',
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
      'S1: execute/lease error responses (400/403/404/413) carry the composed JSON policy and post-Core headers',
      HTTP,
      problems.every(([, p]) => p.length === 0) &&
        statuses.has(400) &&
        statuses.has(403) &&
        statuses.has(404),
      Object.fromEntries(problems)
    );
    const forged = await execute(ctx, lease, SUMMARY, { headers: { 'x-kbn-app-id': 'other-app' } });
    report.expect(
      T,
      'forged x-kbn-app-id carries no authority (served as the lease app)',
      HTTP,
      codeOf(forged) === 'ok' &&
        (forged.json as { result: { appId: string } }).result.appId === 'alert-digest'
    );
    const crossLease = await createLease(ctx, users.viewer, { headers: { origin: 'null' } });
    const spaceLease = await createLease(ctx, users.superuser, { space: ctx.seed.emptySpaceId });
    report.expect(
      T,
      'lease creation refuses null Origin and non-default space (superuser)',
      HTTP,
      codeOf(crossLease.response) === 'app_denied' && codeOf(spaceLease.response) === 'app_denied',
      [codeOf(crossLease.response), codeOf(spaceLease.response)]
    );
    const unknown = await kfetch(ctx, '/internal/app_host/ui/apps/other-app', {
      user: users.viewer,
      headers: apiHeaders(ctx),
    });
    report.expect(T, 'unknown app metadata → 404', HTTP, unknown.status === 404);
    // Stale release: the lease's release is replaced by an approved new one.
    const staleLease = (await createLease(ctx, users.viewer)).lease as TestLease;
    await release(ctx, { label: 'Digest T7 replacement' });
    const stale = await execute(ctx, staleLease, SUMMARY);
    report.expect(
      T,
      'lease for the previous release → app_stale after a new approved release',
      HTTP,
      codeOf(stale) === 'app_stale',
      codeOf(stale)
    );
  } finally {
    await revokeAll(ctx);
  }
};

export const runT9Server = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'T9';
  try {
    if (!ctx.current) await release(ctx);
    // Lease caps (S11). Per principal: a synthetic user no browser session ever uses.
    const own: Array<Awaited<ReturnType<typeof createLease>>> = [];
    for (let i = 0; i < 5; i++) own.push(await createLease(ctx, users.nonSuperInstaller));
    report.expect(
      T,
      'S11 5th lease per principal refused',
      HTTP,
      own.slice(0, 4).every((l) => l.response.status === 200) &&
        codeOf(own[4].response) === 'app_rate_limited',
      own.map((l) => l.response.status)
    );
    // Global: fill with other principals, then a principal that holds no lease at all is refused.
    const fillers: UiUser[] = [
      users.viewer2,
      users.noIndex,
      users.noDashboard,
      users.superuser,
      ...legacyUsers(),
      users.viewer,
      users.globalOnly,
    ];
    let createdByTest = 4;
    for (const user of fillers) {
      for (let i = 0; i < 4; i++) {
        const { response } = await createLease(ctx, user);
        if (response.status !== 200) break;
        createdByTest += 1;
      }
    }
    const extra = await createLease(ctx, adminUser(ctx));
    report.expect(
      T,
      'S11 global cap: once 32 leases are active, a principal with none is refused',
      HTTP,
      codeOf(extra.response) === 'app_rate_limited' && createdByTest <= 32,
      { createdByTest, extra: codeOf(extra.response) }
    );
    await revokeAll(ctx);
    // Operation budget: one viewer, two leases, 14 rapid operations bypassing the parent.
    // Principals that no browser session uses (no leftover leases).
    const a = (await createLease(ctx, users.superuser)).lease as TestLease;
    const b = (await createLease(ctx, users.superuser)).lease as TestLease;
    const codes: string[] = [];
    for (let i = 0; i < 7; i++) codes.push(codeOf(await execute(ctx, a, SEARCH)));
    for (let i = 0; i < 7; i++) codes.push(codeOf(await execute(ctx, b, SEARCH)));
    const limited = codes.filter((c) => c === 'app_rate_limited').length;
    const other = (await createLease(ctx, users.viewer2)).lease as TestLease;
    const otherCode = codeOf(await execute(ctx, other, SEARCH));
    report.expect(
      T,
      'server bucket shared across leases of one (app,user,space); others independent (T14)',
      HTTP,
      limited > 0 && otherCode === 'ok',
      { codes, otherUser: otherCode }
    );
    const oversized = await kfetch(ctx, `/internal/app_host/ui/leases/${a.leaseId}/execute`, {
      user: users.superuser,
      method: 'POST',
      headers: apiHeaders(ctx),
      body: {
        secret: a.secret,
        operation: { op: 'es.search', params: { index: 'x'.repeat(5000), size: 1 } },
      },
    });
    report.expect(
      T,
      'oversized execute body rejected before parsing (4 KiB cap)',
      HTTP,
      oversized.status === 413 || oversized.status === 400,
      oversized.status
    );
  } finally {
    await revokeAll(ctx);
  }
};

const legacyUsers = (): UiUser[] => {
  const file = join(LOCAL_DIR, 'users.json');
  if (!existsSync(file)) return [];
  const users = JSON.parse(readFileSync(file, 'utf8')) as Record<string, UiUser>;
  return [users.reader, users.noIndex].filter(Boolean);
};
const adminUser = (ctx: SuiteContext): UiUser => {
  const [username, ...rest] = ctx.adminAuth.split(':');
  return { username, password: rest.join(':') };
};

export const runT11 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'T11';
  if (ctx.currentEntry !== 'ui/src/main.ts') await release(ctx);
  try {
    const su = (await createLease(ctx, users.superuser)).lease as TestLease;
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
  } finally {
    await revokeAll(ctx);
  }
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
    overrides: { esUrl?: string; manifest?: typeof base.manifest } = {}
  ) => {
    try {
      await approveRelease({
        manifest: overrides.manifest ?? base.manifest,
        esUrl: overrides.esUrl ?? ctx.es,
        kbUrl: ctx.kibana,
        esAuth,
        kbAuth,
      });
      return 'written';
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
        'appId,approvedBy,approvedReleaseDigest,approvedVersion,enabled,installerGrantDigest',
    { approvedBy: consent?.approvedBy, keys: Object.keys(consent ?? {}) }
  );
  ctx.current = base.manifest;
  ctx.currentEntry = 'ui/src/main.ts';
  const again = await attempt(auth(users.superuser), auth(users.superuser));
  report.expect(
    T,
    'same-digest approval is idempotent',
    HTTP,
    again === 'written' && readFileSync(CONSENT_FILE, 'utf8') === raw,
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
    const lease = await createLease(ctx, users.viewer, {
      releaseDigest: bad.manifest.releaseDigest,
    });
    report.expect(
      T,
      `${name}: rejected by Kibana even if operator-approved`,
      HTTP,
      metadata.status === 404 && lease.response.status !== 200,
      { approval, metadata: metadata.status, lease: codeOf(lease.response) }
    );
  }
  await revokeAll(ctx);
  await release(ctx);
};

export const runT13 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'T13';
  if (ctx.currentEntry !== 'ui/src/main.ts') await release(ctx);
  try {
    const lease = (await createLease(ctx, users.viewer)).lease as TestLease;
    const existing = await execute(ctx, lease, dashboardOp(ctx, ctx.seed.ungrantedDashboardId));
    const missing = await execute(
      ctx,
      lease,
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
    const noIndex = (await createLease(ctx, users.noIndex)).lease as TestLease;
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
    const noDash = (await createLease(ctx, users.noDashboard)).lease as TestLease;
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
  } finally {
    await revokeAll(ctx);
  }
};

export const runT14 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'T14';
  if (ctx.currentEntry !== 'ui/src/main.ts') await release(ctx);
  try {
    const a = (await createLease(ctx, users.viewer)).lease as TestLease;
    const asB = await execute(ctx, a, SUMMARY, { user: users.viewer2 });
    report.expect(
      T,
      "viewer A's lease cannot be used by viewer B",
      HTTP,
      codeOf(asB) === 'app_denied'
    );
    const space = ctx.seed.emptySpaceId;
    const before = dispatcherConnections();
    const su = users.superuser;
    const spaceMetadata = await kfetch(ctx, `/s/${space}/internal/app_host/ui/apps/alert-digest`, {
      user: su,
      headers: apiHeaders(ctx),
    });
    const spaceGuardian = await kfetch(
      ctx,
      `/s/${space}/api/app_host/ui/alert-digest/${ctx.current?.releaseDigest}/guardian`,
      { user: su, headers: { 'sec-fetch-dest': 'iframe' } }
    );
    const spaceLease = await createLease(ctx, su, { space });
    const suLease = (await createLease(ctx, su)).lease as TestLease;
    const spaceExecute = await execute(ctx, suLease, SUMMARY, { space });
    const spaceExecuteClaim = await execute(
      ctx,
      suLease,
      { op: 'app.summary', space: 'default' },
      { space }
    );
    report.expect(
      T,
      'superuser: non-default space refused before service I/O, even claiming default',
      HTTP,
      spaceMetadata.status === 404 &&
        spaceGuardian.status === 404 &&
        codeOf(spaceLease.response) === 'app_denied' &&
        codeOf(spaceExecute) === 'app_denied' &&
        codeOf(spaceExecuteClaim) === 'app_denied' &&
        dispatcherConnections() === before,
      {
        metadata: spaceMetadata.status,
        guardian: spaceGuardian.status,
        lease: codeOf(spaceLease.response),
        execute: codeOf(spaceExecute),
        claim: codeOf(spaceExecuteClaim),
        dispatcherDelta: dispatcherConnections() - before,
      }
    );
    const audit = await execute(ctx, suLease, {
      op: 'es.search',
      params: { index: 'logs-kibana.audit-default', size: 1 },
    });
    report.expect(
      T,
      'app cannot grant itself shipped audit/operational logs',
      HTTP,
      codeOf(audit) === 'app_denied'
    );
    report.add(T, 'no durable/shared store created', HTTP, 'PASS', {
      evidence:
        'leases, consent clicks and buckets are in-memory only (server LeaseStore/OperationBuckets, parent React state); no saved objects or indices are written by App Host',
    });
  } finally {
    await revokeAll(ctx);
  }
};

export { sleep };
