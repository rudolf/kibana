/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// K1–K6: the restricted API key as the app session (kibana-apps-key-session-spec.md).
// K1 needs Kibana started with the dev-only fault injection (`-c .local/kibana.app_host.k1.yml`,
// `xpack.app_host.testOnlySkipInputSchema: true`); without it K1 proves the bypass is off by
// default and reports the ES-side checks as NOT_VERIFIED. Everything else runs on the default config.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { approveRelease, setAppEnabled } from '../approval';
import { appKeyName } from '../app_keys';
import { http } from '../http';
import { LOCAL_DIR, kibanaSystemAuth } from '../secrets';
import type { UiUser } from '../ui_harness';
import { sleep } from '../ui_harness';
import { jestEvidence, kfetch, release, session, type SuiteContext } from './context';
import { POST_RECORDER, openBound } from './u3_adversarial';
import { apiHeaders, codeOf, createSession, execute, type TestSession } from './u2_authority';

const HTTP = 'http';
const LOGS = join(LOCAL_DIR, 'logs');
const AUDIT_LOG = join(LOGS, 'app_host_audit.ndjson');
const VIEWER_ONLY_INDEX = 'kbn-apps-prototype-viewer-only';
const SYNTHETIC_INDEX = 'kbn-apps-prototype-alerts';
/** Longer than the server's 2 s enablement/approval cache. */
const STATE_CACHE_WAIT_MS = 2_100;

const SUMMARY = { op: 'app.summary' };
const search = (index: string) => ({ op: 'es.search', params: { index, size: 1 } });
const dashboard = (ctx: SuiteContext) => ({
  op: 'kibana.dashboard.read',
  params: { id: ctx.seed.dashboardId },
});

const readLines = (file: string): string[] =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
/** Byte size now; logs (http_debug) grow by hundreds of MB, so they are read by offset. */
const sizeOf = (file: string): number => (existsSync(file) ? statSync(file).size : 0);
const readSince = (file: string, offset: number): string => {
  if (!existsSync(file)) return '';
  const fd = openSync(file, 'r');
  try {
    const length = Math.max(0, statSync(file).size - offset);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
};

const auditSince = (from: number) =>
  readLines(AUDIT_LOG)
    .slice(from)
    .map((line) => JSON.parse(line) as Record<string, any>);

/** The newest bridge record for `user` and `capability` after `from`. */
const lastRecord = (from: number, user: UiUser, capability: string) =>
  auditSince(from)
    .filter((r) => r.user?.name === user.username && r.app?.capability === capability)
    .pop();

const esAdmin = (ctx: SuiteContext, path: string, method = 'GET', body?: unknown) =>
  http(`${ctx.es}${path}`, { method, auth: ctx.adminAuth, body });

interface KeyInfo {
  readonly id: string;
  readonly name: string;
  readonly invalidated: boolean;
  readonly role_descriptors?: Record<string, Record<string, unknown>>;
  readonly limited_by?: unknown[];
  readonly metadata?: Record<string, unknown>;
}

const keysByName = async (ctx: SuiteContext, name: string): Promise<KeyInfo[]> =>
  (
    (await esAdmin(ctx, `/_security/api_key?name=${encodeURIComponent(name)}`)).body as {
      api_keys?: KeyInfo[];
    }
  ).api_keys ?? [];

const keyById = async (ctx: SuiteContext, id: string): Promise<KeyInfo | undefined> =>
  (
    (await esAdmin(ctx, `/_security/api_key?id=${encodeURIComponent(id)}&with_limited_by=true`))
      .body as { api_keys?: KeyInfo[] }
  ).api_keys?.[0];

const appKeyCount = async (ctx: SuiteContext): Promise<number> =>
  (
    (
      await esAdmin(ctx, '/_security/_query/api_key', 'POST', {
        size: 0,
        query: { bool: { filter: [{ term: { 'metadata.app': 'alert-digest' } }] } },
      })
    ).body as { total?: number }
  ).total ?? -1;

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
};

const mint = async (ctx: SuiteContext, user: UiUser): Promise<TestSession> => {
  const { response, session: created } = await createSession(ctx, user);
  if (!created) throw new Error(`session for ${user.username}: ${codeOf(response)}`);
  return created;
};

/** Mint as `user`, run `operation`, and return the code plus the bridge audit reason and key id. */
const probe = async (ctx: SuiteContext, user: UiUser, operation: { op: string }) => {
  const from = readLines(AUDIT_LOG).length;
  const held = await mint(ctx, user);
  const response = await execute(ctx, held, operation);
  await sleep(300);
  const record = lastRecord(from, user, operation.op);
  return {
    code: codeOf(response),
    status: response.status,
    reason: record?.event?.reason as string | undefined,
    keyId: record?.api_key?.id as string | undefined,
  };
};

const ensureMain = async (ctx: SuiteContext) => {
  if (
    ctx.currentEntry !== 'ui/src/main.ts' ||
    !ctx.current?.ui.scopes.includes('kibana.dashboard.read')
  ) {
    await release(ctx);
  }
};

const withoutDashboardScope = (manifest: Record<string, unknown>) => {
  const ui = manifest.ui as { scopes: string[] };
  ui.scopes = ui.scopes.filter((scope) => scope !== 'kibana.dashboard.read');
};

// ---------------------------------------------------------------- K1
export const runK1 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'K1';
  await ensureMain(ctx);
  const security = await probe(ctx, users.superuser, search('.security'));
  const bypass = security.reason === 'native_denied';
  if (!bypass) {
    report.expect(
      T,
      'default config: the input schema refuses .security before any I/O (bypass not reachable)',
      HTTP,
      security.code === 'app_denied' && security.reason === 'resource_not_granted',
      security
    );
    report.add(T, 'ES-enforced denials with the input schema bypassed', HTTP, 'NOT_VERIFIED', {
      note: 'Start Kibana with -c .local/kibana.app_host.k1.yml (dev-only) and run --suites k1',
    });
    return;
  }
  report.expect(
    T,
    'bypass on: superuser viewer, .security → 403 from ES (native_denied), not the input schema',
    HTTP,
    security.code === 'app_denied' && security.status === 403,
    security
  );
  const securityKey = security.keyId ? await keyById(ctx, security.keyId) : undefined;
  report.expect(
    T,
    'the superuser key grants only the synthetic index (no restricted indices, cluster or run_as)',
    HTTP,
    JSON.stringify(securityKey?.role_descriptors?.app?.indices) ===
      JSON.stringify([
        {
          names: [SYNTHETIC_INDEX],
          privileges: ['read'],
          allow_restricted_indices: false,
        },
      ]) &&
      JSON.stringify(securityKey?.role_descriptors?.app?.cluster) === '[]' &&
      JSON.stringify(securityKey?.role_descriptors?.app?.run_as) === '[]',
    securityKey?.role_descriptors
  );
  const viewerCan = await http(`${ctx.es}/${VIEWER_ONLY_INDEX}/_search?size=0`, {
    auth: `${users.viewer.username}:${users.viewer.password}`,
  });
  const viewerOnly = await probe(ctx, users.viewer, search(VIEWER_ONLY_INDEX));
  report.expect(
    T,
    'bypass on: an index the viewer can read but the app cannot → 403 from ES',
    HTTP,
    viewerCan.status === 200 &&
      viewerOnly.code === 'app_denied' &&
      viewerOnly.reason === 'native_denied',
    { viewerDirectStatus: viewerCan.status, ...viewerOnly }
  );
  const superViewerOnly = await probe(ctx, users.superuser, search(VIEWER_ONLY_INDEX));
  report.expect(
    T,
    'bypass on: the same index for a superuser viewer → 403 from ES',
    HTTP,
    superViewerOnly.code === 'app_denied' && superViewerOnly.reason === 'native_denied',
    superViewerOnly
  );
  for (const index of ['.security-7', '.kibana', 'kbn-apps-prototype-*']) {
    const result = await probe(ctx, users.superuser, search(index));
    report.expect(
      T,
      `bypass on: superuser, ${index} → denied by ES (or no data)`,
      HTTP,
      result.code === 'app_denied' || (result.code === 'ok' && index === 'kbn-apps-prototype-*'),
      result
    );
  }
  const control = await probe(ctx, users.viewer, search(SYNTHETIC_INDEX));
  report.expect(T, 'control: the granted index still works', HTTP, control.code === 'ok', control);
  // K2 under the bypass: the scope check is skipped, so Kibana's native feature authz decides.
  await release(ctx, { mutate: withoutDashboardScope });
  const noScope = await probe(ctx, users.superuser, dashboard(ctx));
  report.expect(
    T,
    'bypass on: scope absent from the manifest, superuser → Dashboard read denied natively by Kibana',
    HTTP,
    noScope.code === 'app_denied' && noScope.reason === 'native_denied',
    noScope
  );
  await release(ctx);
};

// ---------------------------------------------------------------- K2
export const runK2 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'K2';
  await ensureMain(ctx);
  const noIndex = await probe(ctx, users.noIndex, search(SYNTHETIC_INDEX));
  const noIndexKey = noIndex.keyId ? await keyById(ctx, noIndex.keyId) : undefined;
  report.expect(
    T,
    'viewer without index read: ES denies even though the key grants the index',
    HTTP,
    noIndex.code === 'app_denied' &&
      noIndex.reason === 'native_denied' &&
      JSON.stringify(noIndexKey?.role_descriptors?.app?.indices ?? []).includes(SYNTHETIC_INDEX),
    { ...noIndex, keyIndices: noIndexKey?.role_descriptors?.app?.indices }
  );
  const noIndexSummary = await probe(ctx, users.noIndex, SUMMARY);
  report.expect(
    T,
    'viewer without index read: the Worker HostEs callback runs as the key and ES denies',
    HTTP,
    noIndexSummary.code === 'app_denied',
    noIndexSummary
  );
  const noDashboard = await probe(ctx, users.noDashboard, dashboard(ctx));
  const noDashboardKey = noDashboard.keyId ? await keyById(ctx, noDashboard.keyId) : undefined;
  report.expect(
    T,
    'viewer without the dashboard feature: denied by Kibana native feature authz',
    HTTP,
    noDashboard.code === 'app_denied' &&
      noDashboard.reason === 'native_denied' &&
      JSON.stringify(noDashboardKey?.role_descriptors?.app?.applications ?? []).includes(
        'feature_dashboard_v2.read'
      ),
    { ...noDashboard, keyApplications: noDashboardKey?.role_descriptors?.app?.applications }
  );
  const viewer = await probe(ctx, users.viewer, dashboard(ctx));
  report.expect(
    T,
    'control: viewer with both reads the dashboard',
    HTTP,
    viewer.code === 'ok',
    viewer
  );
  const viewerKey = viewer.keyId ? await keyById(ctx, viewer.keyId) : undefined;
  report.expect(
    T,
    'key = role descriptor from the manifest, limited_by = the viewer',
    HTTP,
    JSON.stringify(viewerKey?.role_descriptors) ===
      JSON.stringify({
        app: {
          cluster: [],
          indices: [
            { names: [SYNTHETIC_INDEX], privileges: ['read'], allow_restricted_indices: false },
          ],
          applications: [
            {
              application: 'kibana-.kibana',
              privileges: ['feature_dashboard_v2.read'],
              resources: ['space:default'],
            },
          ],
          run_as: [],
          metadata: {},
          transient_metadata: { enabled: true },
        },
      }) && Array.isArray(viewerKey?.limited_by),
    { roleDescriptors: viewerKey?.role_descriptors, metadata: viewerKey?.metadata }
  );
  await release(ctx, { mutate: withoutDashboardScope });
  const noScope = await probe(ctx, users.superuser, dashboard(ctx));
  const lastKeys = await keysByName(
    ctx,
    appKeyName('alert-digest', ctx.current?.releaseDigest ?? '')
  );
  report.expect(
    T,
    'scope absent from the manifest: superuser denied the dashboard; the key has no Kibana privileges',
    HTTP,
    noScope.code === 'app_denied' &&
      lastKeys.length > 0 &&
      lastKeys.every(
        (key) => JSON.stringify(key.role_descriptors?.app?.applications ?? []) === '[]'
      ),
    { ...noScope, keys: lastKeys.length }
  );
  await release(ctx);
};

// ---------------------------------------------------------------- K3
const handleFromPage = (page: Page) => {
  const handles: string[] = [];
  page.on('response', async (response) => {
    if (!/\/internal\/app_host\/ui\/session$/.test(response.url())) return;
    const body = (await response.json().catch(() => undefined)) as { handle?: string } | undefined;
    if (body?.handle) handles.push(body.handle);
  });
  return handles;
};

export const runK3 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'K3';
  await ensureMain(ctx);
  const held = await mint(ctx, users.viewer);
  const [prefix, sealed] = held.handle.split('.');
  const flipped = `${sealed.slice(0, 30)}${sealed[30] === 'A' ? 'B' : 'A'}${sealed.slice(31)}`;
  const cases: Array<[string, Promise<Awaited<ReturnType<typeof execute>>>, string]> = [
    [
      'tampered ciphertext',
      execute(ctx, held, SUMMARY, { handle: `${prefix}.${flipped}` }),
      'app_denied',
    ],
    [
      'swapped release prefix',
      execute(ctx, held, SUMMARY, { handle: `${'0'.repeat(64)}.${sealed}` }),
      'app_denied',
    ],
    [
      "another user's handle with their own credentials",
      execute(ctx, held, SUMMARY, { user: users.viewer2 }),
      'app_denied',
    ],
    ['another space', execute(ctx, held, SUMMARY, { space: ctx.seed.emptySpaceId }), 'app_denied'],
    ['control: own handle', execute(ctx, held, SUMMARY), 'ok'],
  ];
  for (const [name, pending, expected] of cases) {
    const response = await pending;
    report.expect(T, name, HTTP, codeOf(response) === expected, {
      status: response.status,
      code: codeOf(response),
    });
  }
  const anonymous = await kfetch(ctx, '/internal/app_host/ui/execute', {
    method: 'POST',
    headers: apiHeaders(ctx),
    body: { handle: held.handle, ...SUMMARY },
  });
  report.expect(T, 'handle without any credentials → 401', HTTP, anonymous.status === 401, {
    status: anonymous.status,
  });
  for (const engine of ctx.engines) {
    await report.guard(T, 'browser', engine, async () => {
      const own = await session(ctx, engine, users.viewer);
      const other = await session(ctx, engine, users.viewer2);
      try {
        const handles = handleFromPage(own.page);
        await openBound(own.page, ctx);
        await sleep(500);
        const [handle] = handles;
        const post = (s: typeof own, body: unknown) =>
          s.context.request.post(`${ctx.kibana}/internal/app_host/ui/execute`, {
            headers: { ...apiHeaders(ctx), 'content-type': 'application/json' },
            data: body,
          });
        const mine = await post(own, { handle, ...SUMMARY });
        const theirs = await post(other, { handle, ...SUMMARY });
        const noCookie = await fetch(`${ctx.kibana}/internal/app_host/ui/execute`, {
          method: 'POST',
          headers: { ...apiHeaders(ctx), 'content-type': 'application/json' },
          body: JSON.stringify({ handle, ...SUMMARY }),
        });
        report.expect(
          T,
          "cookie session: own handle ok; another user's handle with their own cookie → app_denied; no cookie → 401",
          engine,
          Boolean(handle) &&
            mine.status() === 200 &&
            theirs.status() === 403 &&
            ((await theirs.json()) as { attributes?: { code?: string } }).attributes?.code ===
              'app_denied' &&
            noCookie.status === 401,
          { mine: mine.status(), theirs: theirs.status(), noCookie: noCookie.status }
        );
      } finally {
        await own.close();
        await other.close();
      }
    });
  }
  await jestEvidence(
    ctx,
    T,
    ['server/ui/bridge_service.test.ts', 'public/ui_host/session_client.test.ts'],
    [
      [
        'tampered/other-principal/other-space/expired handles (fake clock: app_expired)',
        'K3: tampered, other-principal, other-space and expired handles are refused',
      ],
      [
        'expired handle: the parent re-mints once (consent given on this page) and retries',
        'K3: an expired handle is re-minted once on this consented page, then the call is retried',
      ],
      [
        'expired handle after teardown: no re-mint',
        'never re-mints after the frame was torn down (aborted signal)',
      ],
    ]
  );
};

// ---------------------------------------------------------------- K4
const LOG_FILES = [
  'app_host_audit.ndjson',
  'kibana_audit.ndjson',
  'http_debug.ndjson',
  'kibana_debug.ndjson',
  'kibana-key.log',
  'wrangler.log',
];

export const runK4 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'K4';
  await ensureMain(ctx);
  const sizes = Object.fromEntries(LOG_FILES.map((file) => [file, sizeOf(join(LOGS, file))]));
  const auditFrom = readLines(AUDIT_LOG).length;
  const observed: Array<{ where: string; text: string }> = [];
  const handles: string[] = [];
  for (const engine of ctx.engines) {
    await report.guard(T, 'browser', engine, async () => {
      const s = await session(ctx, engine, users.viewer, POST_RECORDER);
      try {
        s.page.on('response', async (response) => {
          if (!/\/internal\/app_host\//.test(response.url())) return;
          const text = await response.text().catch(() => '');
          observed.push({ where: `${engine} response ${new URL(response.url()).pathname}`, text });
          const handle = (JSON.parse(text || '{}') as { handle?: string }).handle;
          if (handle) handles.push(handle);
        });
        const child = await openBound(s.page, ctx);
        await child
          .waitForFunction(() => document.body.innerText.includes('high'), undefined, {
            timeout: 30_000,
          })
          .catch(() => undefined);
        await sleep(1000);
        for (const frame of s.page.frames()) {
          const posted = (await frame
            .evaluate(() => (window as unknown as { __posted?: string[] }).__posted ?? [])
            .catch(() => [])) as string[];
          observed.push({ where: `${engine} posted ${frame.url()}`, text: posted.join('\n') });
          observed.push({
            where: `${engine} dom ${frame.url()}`,
            text: await frame.content().catch(() => ''),
          });
          observed.push({
            where: `${engine} storage ${frame.url()}`,
            text: String(
              await frame
                .evaluate(() => {
                  try {
                    return JSON.stringify([
                      { ...localStorage },
                      { ...sessionStorage },
                      window.name,
                    ]);
                  } catch {
                    return '';
                  }
                })
                .catch(() => '')
            ),
          });
        }
      } finally {
        await s.close();
      }
    });
  }
  await sleep(1500);
  const keyIds = [
    ...new Set(
      auditSince(auditFrom)
        .map((r) => r.api_key?.id as string | undefined)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  // Any encoding of the credential (`ApiKey base64(id:key)`) starts with base64(`${id}:`) cut to
  // whole 3-byte groups, which is fully determined by the public id.
  const encodedPrefixes = keyIds.map((id) => {
    const prefix = Buffer.from(`${id}:`);
    return prefix.subarray(0, prefix.length - (prefix.length % 3)).toString('base64');
  });
  const logText = LOG_FILES.map((file) => ({
    where: file,
    text: readSince(join(LOGS, file), sizes[file]),
  }));
  const surfaces = [...observed, ...logText];
  const credentialHits = surfaces.filter(
    ({ text }) =>
      encodedPrefixes.some((prefix) => text.includes(prefix)) ||
      /ApiKey [A-Za-z0-9+/=]{20,}/.test(text)
  );
  report.expect(
    T,
    'no encoding of any session API key in responses, window/port messages, frame DOM, storage or logs',
    'all',
    keyIds.length >= ctx.engines.length && observed.length > 0 && credentialHits.length === 0,
    { keys: keyIds.length, surfaces: surfaces.length, hits: credentialHits.map((h) => h.where) }
  );
  const handleHits = surfaces.filter(
    ({ where, text }) =>
      !/response \/internal\/app_host\/ui\/session$/.test(where) &&
      handles.some((handle) => text.includes(handle) || text.includes(handle.split('.')[1]))
  );
  report.expect(
    T,
    'the handle appears only in the session response to the parent: never in window/port messages, frames or logs',
    'all',
    handles.length >= ctx.engines.length && handleHits.length === 0,
    { handles: handles.length, hits: handleHits.map((h) => h.where) }
  );
  const idOnlyInAudit = logText
    .filter(({ where }) => where !== 'app_host_audit.ndjson')
    .filter(({ text }) => keyIds.some((id) => text.includes(id)));
  report.add(
    T,
    'key id outside the app_host audit (attribution only; ids are not credentials)',
    'all',
    idOnlyInAudit.length === 0 ? 'PASS' : 'DIAGNOSTIC',
    { files: idOnlyInAudit.map((h) => h.where) }
  );
  await jestEvidence(
    ctx,
    T,
    ['server/ui/bridge_service.test.ts'],
    [
      [
        'known raw key absent from responses, audit and logs; present only in the key-scoped clients',
        'K4: the raw key never leaves the server; it reaches only the key-scoped clients',
      ],
    ]
  );
};

// ---------------------------------------------------------------- K5
export const runK5 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'K5';
  await ensureMain(ctx);
  const ks = kibanaSystemAuth();
  // Which revocation API is available to Kibana's internal user?
  const ksGet = await http(`${ctx.es}/_security/api_key?name=app:alert-digest@*`, { auth: ks });
  const ksQuery = await http(`${ctx.es}/_security/_query/api_key`, {
    method: 'POST',
    auth: ks,
    body: { size: 0, query: { term: { 'metadata.app': 'alert-digest' } } },
  });
  const adminTotal = await appKeyCount(ctx);
  report.add(T, 'kibana_system: list by name / query by metadata', HTTP, 'DIAGNOSTIC', {
    getByNameStatus: ksGet.status,
    queryByMetadataStatus: ksQuery.status,
    queryByMetadataTotal: (ksQuery.body as { total?: number }).total,
    adminVisibleTotal: adminTotal,
    note: 'kibana_system only sees its own keys; invalidation by name is what works',
  });
  // Disable.
  const before = await mint(ctx, users.viewer);
  const ok = await execute(ctx, before, SUMMARY);
  const revoked = await setAppEnabled(false, { esUrl: ctx.es });
  const name = appKeyName('alert-digest', ctx.current?.releaseDigest ?? '');
  const afterDisable = await keysByName(ctx, name);
  await sleep(STATE_CACHE_WAIT_MS);
  const denied = await execute(ctx, before, SUMMARY);
  const mintDisabled = await createSession(ctx, users.viewer);
  report.expect(
    T,
    'disable: state flipped, then all app keys invalidated by name as kibana_system; next call app_disabled',
    HTTP,
    codeOf(ok) === 'ok' &&
      (revoked?.invalidated ?? 0) >= 1 &&
      (revoked?.errors ?? 1) === 0 &&
      afterDisable.length > 0 &&
      afterDisable.every((key) => key.invalidated) &&
      codeOf(denied) === 'app_disabled' &&
      codeOf(mintDisabled.response) === 'app_disabled',
    {
      invalidated: revoked?.invalidated,
      keysWithName: afterDisable.length,
      allInvalidated: afterDisable.every((key) => key.invalidated),
      next: codeOf(denied),
      mint: codeOf(mintDisabled.response),
    }
  );
  await setAppEnabled(true, { esUrl: ctx.es });
  await sleep(STATE_CACHE_WAIT_MS);
  const stillDead = await execute(ctx, before, SUMMARY);
  report.expect(
    T,
    're-enable does not resurrect an invalidated key (ES denies the old handle)',
    HTTP,
    codeOf(stillDead) === 'app_denied',
    codeOf(stillDead)
  );
  // Release change: a new approved release invalidates the previous release's keys.
  const v1 = await mint(ctx, users.viewer);
  const v1Name = appKeyName('alert-digest', ctx.current?.releaseDigest ?? '');
  await release(ctx, { label: 'Digest K5 replacement', approve: false });
  const approval = await approveRelease({
    manifest: ctx.current as never,
    esUrl: ctx.es,
    kbUrl: ctx.kibana,
    esAuth: ctx.adminAuth,
    kbAuth: ctx.adminAuth,
  });
  const afterChange = await keysByName(ctx, v1Name);
  await sleep(STATE_CACHE_WAIT_MS);
  const stale = await execute(ctx, v1, SUMMARY);
  report.expect(
    T,
    'release change: previous release keys invalidated by name; next call app_stale',
    HTTP,
    (approval.revoked?.invalidated ?? 0) >= 1 &&
      afterChange.length > 0 &&
      afterChange.every((key) => key.invalidated) &&
      codeOf(stale) === 'app_stale',
    {
      invalidated: approval.revoked?.invalidated,
      keysWithName: afterChange.length,
      next: codeOf(stale),
    }
  );
  const fresh = await mint(ctx, users.viewer);
  report.expect(
    T,
    'control: a new consent mints a working key for the new release',
    HTTP,
    codeOf(await execute(ctx, fresh, SUMMARY)) === 'ok'
  );
};

// ---------------------------------------------------------------- K6
export const runK6 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'K6';
  await ensureMain(ctx);
  const before = await appKeyCount(ctx);
  const held = await mint(ctx, users.viewer);
  const codes: string[] = [];
  for (let i = 0; i < 30; i++) {
    codes.push(codeOf(await execute(ctx, held, i % 3 === 0 ? SUMMARY : search(SYNTHETIC_INDEX))));
  }
  await sleep(1500);
  const after = await appKeyCount(ctx);
  report.expect(
    T,
    'one mint per consent: 30 calls on one handle → exactly 1 new key',
    HTTP,
    codes.every((c) => c === 'ok') && after - before === 1,
    {
      before,
      after,
      calls: codes.length,
    }
  );
  const timings: number[] = [];
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    const { session: created } = await createSession(ctx, users.viewer);
    timings.push(performance.now() - started);
    if (!created) throw new Error('mint failed');
  }
  report.add(
    T,
    'mint latency via POST /internal/app_host/ui/session (20 mints)',
    HTTP,
    'DIAGNOSTIC',
    {
      p50: percentile(timings, 50),
      p95: percentile(timings, 95),
      min: Math.round(Math.min(...timings)),
      max: Math.round(Math.max(...timings)),
    }
  );
  // Where the time goes: the same grant directly against ES as kibana_system, ES default refresh
  // (wait_for) versus refresh=false. Throwaway keys, invalidated afterwards.
  const grant = async (refresh?: string) => {
    const started = performance.now();
    const result = await http(
      `${ctx.es}/_security/api_key/grant${refresh ? `?refresh=${refresh}` : ''}`,
      {
        method: 'POST',
        auth: kibanaSystemAuth(),
        body: {
          grant_type: 'password',
          username: users.viewer.username,
          password: users.viewer.password,
          api_key: {
            name: 'app:k6-probe@latency',
            expiration: '5m',
            role_descriptors: { app: { cluster: [], indices: [], run_as: [] } },
          },
        },
      }
    );
    if (result.status !== 200) throw new Error(`grant ${result.status}`);
    return performance.now() - started;
  };
  const direct: Record<string, number[]> = { default: [], false: [] };
  for (let i = 0; i < 20; i++) {
    direct.default.push(await grant());
    direct.false.push(await grant('false'));
  }
  await http(`${ctx.es}/_security/api_key`, {
    method: 'DELETE',
    auth: kibanaSystemAuth(),
    body: { name: 'app:k6-probe@*' },
  });
  report.add(T, 'direct ES grant latency as kibana_system (20 each)', HTTP, 'DIAGNOSTIC', {
    defaultRefresh: { p50: percentile(direct.default, 50), p95: percentile(direct.default, 95) },
    refreshFalse: { p50: percentile(direct.false, 50), p95: percentile(direct.false, 95) },
  });
  await jestEvidence(
    ctx,
    T,
    ['server/ui/bridge_service.test.ts'],
    [
      [
        'N calls on one handle use one key (unit)',
        'K6: N calls on one handle use exactly one minted key',
      ],
    ]
  );
};

/** K2–K6 on the default config; K1 detects whether the dev-only bypass is on. */
export const runK = async (ctx: SuiteContext) => {
  for (const [name, run] of [
    ['K1', runK1],
    ['K2', runK2],
    ['K3', runK3],
    ['K4', runK4],
    ['K5', runK5],
    ['K6', runK6],
  ] as const) {
    await ctx.report.guard(name, 'suite', 'all', () => run(ctx));
  }
};
