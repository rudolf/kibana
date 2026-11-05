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

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { approveRelease, readConsent, setAppEnabled } from '../approval';
import { AppKeyInvalidationError, appKeyName, invalidateAppKeys } from '../app_keys';
import { http } from '../http';
import { credentialNeedles, encodedPrefixNeedle, scanSurfaces, type Surface } from '../leak_scan';
import { SessionHandles } from '../../../../server/ui/session_handle';
import { LOCAL_DIR, kibanaSystemAuth } from '../secrets';
import type { UiUser } from '../ui_harness';
import { sleep } from '../ui_harness';
import { jestEvidence, kfetch, release, session, type SuiteContext } from './context';
import { POST_RECORDER, openBound } from './u3_adversarial';
import {
  apiHeaders,
  codeOf,
  createSession,
  execute,
  readPanels,
  type TestSession,
} from './u2_authority';

const HTTP = 'http';
const LOGS = join(LOCAL_DIR, 'logs');
const PROTOTYPE_DIR = join(LOCAL_DIR, '..');
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
const readSince = (file: string, offset: number): string | undefined => {
  if (!existsSync(file)) return undefined;
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

/** Keys are minted with refresh=false, so a fresh key may need up to one refresh to be listed. */
const keyById = async (ctx: SuiteContext, id: string): Promise<KeyInfo | undefined> => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const found = (
      (await esAdmin(ctx, `/_security/api_key?id=${encodeURIComponent(id)}&with_limited_by=true`))
        .body as { api_keys?: KeyInfo[] }
    ).api_keys?.[0];
    if (found) return found;
    await sleep(400);
  }
  return undefined;
};
/** One `.security` refresh (1 s): searches and name invalidation then see newly minted keys. */
const SETTLE_MS = 1_200;

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
    rules: (
      (response.json as { result?: { records?: Array<{ rule?: string }> } } | undefined)?.result
        ?.records ?? []
    ).map(({ rule }) => rule),
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
  for (const index of ['.security-7', '.kibana']) {
    const result = await probe(ctx, users.superuser, search(index));
    report.expect(
      T,
      `bypass on: superuser, ${index} → 403 from ES (native_denied)`,
      HTTP,
      result.code === 'app_denied' && result.reason === 'native_denied',
      result
    );
  }
  // A pattern over granted and ungranted indices: ES either denies it or returns only granted data.
  const pattern = await probe(ctx, users.superuser, search('kbn-apps-prototype-*'));
  report.expect(
    T,
    'bypass on: superuser, kbn-apps-prototype-* → denied by ES, or only granted-index data',
    HTTP,
    (pattern.code === 'app_denied' && pattern.reason === 'native_denied') ||
      (pattern.code === 'ok' && pattern.rules.length > 0 && !pattern.rules.includes('viewer-only')),
    pattern
  );
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
      }),
    { roleDescriptors: viewerKey?.role_descriptors, metadata: viewerKey?.metadata }
  );
  // limited_by is the viewer's own roles, as Elasticsearch stores them.
  const viewerRoles =
    (
      (await esAdmin(ctx, `/_security/user/${users.viewer.username}`)).body as Record<
        string,
        { roles?: string[] }
      >
    )[users.viewer.username]?.roles ?? [];
  const roleBodies = (await esAdmin(ctx, `/_security/role/${viewerRoles.join(',')}`))
    .body as Record<string, Record<string, unknown>>;
  const pick = (role: Record<string, unknown> | undefined) => ({
    cluster: role?.cluster,
    indices: role?.indices,
    applications: role?.applications,
    run_as: role?.run_as,
  });
  const limitedBy = (viewerKey?.limited_by ?? []) as Array<Record<string, Record<string, unknown>>>;
  const limitedRoles = Object.keys(limitedBy[0] ?? {}).sort();
  report.expect(
    T,
    "limited_by = the viewer's roles (names and index/application/cluster/run_as privileges)",
    HTTP,
    limitedBy.length === 1 &&
      viewerRoles.length > 0 &&
      JSON.stringify(limitedRoles) === JSON.stringify([...viewerRoles].sort()) &&
      viewerRoles.every(
        (role) =>
          JSON.stringify(pick(limitedBy[0][role])) === JSON.stringify(pick(roleBodies[role]))
      ),
    {
      viewerRoles,
      limitedRoles,
      limitedIndices: viewerRoles.map((role) => limitedBy[0]?.[role]?.indices),
    }
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
const kibanaLog = () => process.env.KIBANA_LOG ?? 'kibana-key.log';
const ES_QUERY_LOG = join(LOGS, 'es_query_debug.ndjson');
const logFiles = () => [
  'app_host_audit.ndjson',
  'kibana_audit.ndjson',
  'http_debug.ndjson',
  'kibana_debug.ndjson',
  'es_query_debug.ndjson',
  kibanaLog(),
  'wrangler.log',
];

interface EsQueryEntry {
  readonly message: string;
  readonly authorization?: unknown;
}

/** Outgoing ES requests logged by Kibana's `elasticsearch.query` debug logger since `offset`. */
const esQueriesSince = (offset: number): EsQueryEntry[] | undefined =>
  readSince(ES_QUERY_LOG, offset)
    ?.split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        const record = JSON.parse(line) as {
          message?: string;
          http?: { request?: { headers?: Record<string, unknown> } };
        };
        return {
          message: String(record.message ?? ''),
          authorization: record.http?.request?.headers?.authorization,
        };
      } catch {
        return { message: '' };
      }
    });

/**
 * Grants a key directly (as kibana_system, from `user`'s password) with exactly the descriptor
 * Kibana would mint, and seals a handle for it with the local handle key: a session whose secret
 * the test knows, so that the real Kibana ES/self clients and their loggers can be checked for it.
 * The secret is held in memory only and never written to a report.
 */
const knownKeySession = async (ctx: SuiteContext, user: UiUser) => {
  const manifest = ctx.current;
  const consent = readConsent();
  if (!manifest || !consent) throw new Error('no approved release');
  // Same name, metadata and descriptor as server/ui/app_key.ts derives from this manifest (K2
  // asserts the minted descriptor equals this).
  const request = {
    name: appKeyName(manifest.id, manifest.releaseDigest),
    expiration: '1h',
    metadata: {
      app_host: true,
      app: manifest.id,
      release: manifest.releaseDigest,
      space: 'default',
    },
    role_descriptors: {
      app: {
        cluster: [],
        indices: [{ names: [...manifest.permissions.indices], privileges: ['read'] }],
        applications: manifest.ui.scopes.includes('kibana.dashboard.read')
          ? [
              {
                application: 'kibana-.kibana',
                privileges: ['feature_dashboard_v2.read'],
                resources: ['space:default'],
              },
            ]
          : [],
        run_as: [],
      },
    },
  };
  const granted = await http(`${ctx.es}/_security/api_key/grant`, {
    method: 'POST',
    auth: kibanaSystemAuth(),
    body: {
      grant_type: 'password',
      username: user.username,
      password: user.password,
      api_key: {
        name: request.name,
        expiration: request.expiration,
        metadata: request.metadata,
        role_descriptors: request.role_descriptors,
      },
    },
  });
  const { id, api_key: secret } = granted.body as { id?: string; api_key?: string };
  if (granted.status !== 200 || !id || !secret) throw new Error(`grant ${granted.status}`);
  const me = await kfetch(ctx, '/internal/security/me', {
    user,
    headers: { 'x-elastic-internal-origin': 'Kibana' },
  });
  const realm = (me.json as { authentication_realm?: { type?: string; name?: string } })
    .authentication_realm;
  const handle = new SessionHandles(
    readFileSync(join(LOCAL_DIR, 'handle_key'), 'utf8').trim()
  ).seal({
    id,
    apiKey: secret,
    app: 'alert-digest',
    release: manifest.releaseDigest,
    space: 'default',
    principal: JSON.stringify([realm?.type, realm?.name, user.username]),
    generation: consent.generation,
    exp: Date.now() + 10 * 60 * 1000,
  });
  return { key: { id, secret }, held: { user, handle } as TestSession };
};

export const runK4 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'K4';
  await ensureMain(ctx);
  const files = logFiles();
  const sizes = Object.fromEntries(files.map((file) => [file, sizeOf(join(LOGS, file))]));
  const auditFrom = readLines(AUDIT_LOG).length;

  // A. Known secret through the real Kibana clients and loggers (search, Dashboard, Worker path,
  // and one native ES rejection), with the outgoing `elasticsearch.query` logger at debug.
  const known = await knownKeySession(ctx, users.viewer);
  const knownNoIndex = await knownKeySession(ctx, users.noIndex);
  const responses: Surface[] = [];
  const step = async (
    name: string,
    held: TestSession,
    operation: { op: string },
    accept: (json: Record<string, any>) => boolean,
    expectLogged: (entries: EsQueryEntry[]) => boolean
  ) => {
    const offset = sizeOf(ES_QUERY_LOG);
    const response = await execute(ctx, held, operation);
    await sleep(500);
    responses.push({ where: `response ${name}`, text: response.text });
    const entries = esQueriesSince(offset);
    const ok = accept((response.json ?? {}) as Record<string, any>);
    const logged = entries !== undefined && expectLogged(entries);
    const observed = entries === undefined ? 'NOT_VERIFIED' : ok && logged ? 'PASS' : 'FAIL';
    report.add(
      T,
      `known key, ${name}: operation as expected and its outgoing ES request logged`,
      HTTP,
      observed,
      {
        status: response.status,
        code: codeOf(response),
        esQueryEntries: entries?.length ?? 'missing log',
        matched: logged,
      }
    );
    return entries ?? [];
  };
  const searchPath = (entries: EsQueryEntry[], status: number) =>
    entries.filter(({ message }) =>
      new RegExp(`^${status}\\b[\\s\\S]*/${SYNTHETIC_INDEX}/_search`).test(message)
    );
  const searchEntries = await step(
    'es.search',
    known.held,
    search(SYNTHETIC_INDEX),
    (json) => json.ok === true && json.result?.records?.length > 0,
    (entries) => searchPath(entries, 200).length > 0
  );
  await step(
    'kibana.dashboard.read',
    known.held,
    dashboard(ctx),
    (json) => json.ok === true && json.result?.id === ctx.seed.dashboardId,
    (entries) => entries.some(({ message }) => message.includes(ctx.seed.dashboardId))
  );
  await step(
    'app.summary (Worker HostEs)',
    known.held,
    SUMMARY,
    (json) => json.ok === true && typeof json.result?.counts?.high === 'number',
    (entries) => searchPath(entries, 200).length > 0
  );
  await step(
    'native ES rejection (viewer without index read)',
    knownNoIndex.held,
    search(SYNTHETIC_INDEX),
    (json) => json.attributes?.code === 'app_denied',
    (entries) => searchPath(entries, 403).length > 0
  );
  const redacted = searchPath(searchEntries, 200).map(({ authorization }) => authorization);
  report.expect(
    T,
    'outgoing ES request log: authorization header present and [REDACTED]',
    HTTP,
    redacted.length > 0 && redacted.every((value) => value === '[REDACTED]'),
    { values: [...new Set(redacted.map(String))] }
  );
  const knownSurfaces: Surface[] = [
    ...responses,
    ...files.map((file) => ({ where: file, text: readSince(join(LOGS, file), sizes[file]) })),
  ];
  const needles = [...credentialNeedles(known.key), ...credentialNeedles(knownNoIndex.key)];
  const knownScan = scanSurfaces(knownSurfaces, needles);
  report.add(
    T,
    'known key: neither the bare secret nor id:secret nor the base64 credential in responses or any log (incl. elasticsearch.query debug, wrangler)',
    HTTP,
    knownScan.status,
    { hits: knownScan.hits, missing: knownScan.missing, surfaces: knownSurfaces.length }
  );
  // Negative controls: the same checker must catch an injected leak of each form.
  const injected = credentialNeedles(known.key).map((needle, index) =>
    scanSurfaces([...knownSurfaces, { where: `injected-${index}`, text: `x ${needle} y` }], needles)
  );
  const withoutLog = scanSurfaces(
    knownSurfaces.map((surface) =>
      surface.where === 'es_query_debug.ndjson' ? { ...surface, text: undefined } : surface
    ),
    needles
  );
  report.expect(
    T,
    'negative controls: injected bare/pair/base64/base64url leaks FAIL; a removed ES query log is NOT_VERIFIED',
    HTTP,
    injected.every((r) => r.status === 'FAIL' && r.hits.some((h) => h.startsWith('injected-'))) &&
      withoutLog.status !== 'PASS',
    { injected: injected.map((r) => r.status), withoutLog: withoutLog.status }
  );
  await http(`${ctx.es}/_security/api_key`, {
    method: 'DELETE',
    auth: ctx.adminAuth,
    body: { ids: [known.key.id, knownNoIndex.key.id] },
  });

  // B. Kibana-minted keys (secret unknown to the test) across the three browsers.
  const observed: Surface[] = [];
  const handles: string[] = [];
  let boundEngines = 0;
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
        const panels = await readPanels(child);
        if (/^Digest .*: high \d+/.test(panels.summary ?? '') && panels.dashboard)
          boundEngines += 1;
        await sleep(1000);
        for (const frame of s.page.frames()) {
          const posted = (await frame
            .evaluate(() => (window as unknown as { __posted?: string[] }).__posted ?? [])
            .catch(() => undefined)) as string[] | undefined;
          observed.push({ where: `${engine} posted ${frame.url()}`, text: posted?.join('\n') });
          observed.push({
            where: `${engine} dom ${frame.url()}`,
            text: await frame.content().catch(() => undefined),
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
        .filter((r) => r.event?.reason === 'session_created')
        .map((r) => r.api_key?.id as string | undefined)
        .filter((id): id is string => Boolean(id))
    ),
  ].filter((id) => id !== known.key.id && id !== knownNoIndex.key.id);
  const logText: Surface[] = files.map((file) => ({
    where: file,
    text: readSince(join(LOGS, file), sizes[file]),
  }));
  const minted = scanSurfaces([...observed, ...logText], keyIds.map(encodedPrefixNeedle));
  report.add(
    T,
    'Kibana-minted keys: no encoding in responses, window/port messages, frame DOM or logs (all engines, data read)',
    'all',
    boundEngines === ctx.engines.length && keyIds.length >= ctx.engines.length
      ? minted.status
      : 'FAIL',
    { boundEngines, keys: keyIds.length, hits: minted.hits, missing: minted.missing }
  );
  const handleHits = [...observed, ...logText].filter(
    ({ where, text }) =>
      text !== undefined &&
      !/response \/internal\/app_host\/ui\/session$/.test(where) &&
      handles.some((handle) => text.includes(handle.split('.')[2]))
  );
  report.expect(
    T,
    'the handle appears only in the session response to the parent: never in window/port messages, frames or logs',
    'all',
    handles.length >= ctx.engines.length && handleHits.length === 0,
    { handles: handles.length, hits: handleHits.map((h) => h.where) }
  );
  await jestEvidence(
    ctx,
    T,
    ['server/ui/bridge_service.test.ts'],
    [
      [
        'known raw key absent from bridge responses, audit and logger calls (unit)',
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
  const generationOf = (held: TestSession) => Number(held.handle.split('.')[1]);
  const mintedKeyId = async (user: UiUser) => {
    const from = readLines(AUDIT_LOG).length;
    const held = await mint(ctx, user);
    await sleep(200);
    return {
      held,
      id: lastRecord(from, user, 'session.create')?.api_key?.id as string | undefined,
    };
  };
  // 1. Serial disable of settled keys: state flip, then name invalidation as kibana_system.
  const before = await mint(ctx, users.viewer);
  const ok = await execute(ctx, before, SUMMARY);
  await sleep(SETTLE_MS); // refresh=false: let the key become searchable for the name invalidation
  const revoked = await setAppEnabled(false, { esUrl: ctx.es });
  const name = appKeyName('alert-digest', ctx.current?.releaseDigest ?? '');
  const afterDisable = await keysByName(ctx, name);
  await sleep(STATE_CACHE_WAIT_MS);
  const denied = await execute(ctx, before, SUMMARY);
  const mintDisabled = await createSession(ctx, users.viewer);
  report.expect(
    T,
    'disable: generation raised, then all app keys invalidated by name as kibana_system; next call app_disabled',
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
    're-enable does not resurrect a pre-disable handle (superseded generation)',
    HTTP,
    codeOf(stillDead) === 'app_stale',
    codeOf(stillDead)
  );
  // 2. Immediate mint → disable → enable with refresh=false: the name invalidation may miss the
  // unrefreshed key; the generation must still kill the handle.
  const quick = await mintedKeyId(users.viewer);
  await setAppEnabled(false, { esUrl: ctx.es });
  await setAppEnabled(true, { esUrl: ctx.es });
  await sleep(STATE_CACHE_WAIT_MS);
  const quickCode = codeOf(await execute(ctx, quick.held, SUMMARY));
  const quickKey = quick.id ? await keyById(ctx, quick.id) : undefined;
  report.expect(
    T,
    'mint → immediate disable → enable: the old handle is dead',
    HTTP,
    quickCode === 'app_stale',
    { code: quickCode, esInvalidatedTheKey: quickKey?.invalidated }
  );
  if (quick.id && quickKey && !quickKey.invalidated) {
    await http(`${ctx.es}/_security/api_key`, {
      method: 'DELETE',
      auth: ctx.adminAuth,
      body: { ids: [quick.id] },
    });
  }
  // 3. Partial invalidation (HTTP 200, error_count 1; the real key is left valid).
  const partial = await mintedKeyId(users.viewer);
  await sleep(SETTLE_MS);
  const partialHttp: typeof http = async () => ({
    status: 200,
    body: { invalidated_api_keys: [], previously_invalidated_api_keys: [], error_count: 1 },
    headers: new Headers(),
    ms: 0,
  });
  const partialError = await setAppEnabled(false, { esUrl: ctx.es, http: partialHttp }).then(
    () => undefined,
    (error: unknown) => error
  );
  const stateAfterPartial = readConsent();
  const leftValid = partial.id ? await keyById(ctx, partial.id) : undefined;
  await setAppEnabled(true, { esUrl: ctx.es });
  await sleep(STATE_CACHE_WAIT_MS);
  const partialCode = codeOf(await execute(ctx, partial.held, SUMMARY));
  const retry = await invalidateAppKeys({ esUrl: ctx.es, appId: 'alert-digest' });
  const afterRetry = partial.id ? await keyById(ctx, partial.id) : undefined;
  const freshAfterRetry = await mint(ctx, users.viewer);
  const freshCode = codeOf(await execute(ctx, freshAfterRetry, SUMMARY));
  report.expect(
    T,
    'partial invalidation: disable reports failure and stays disabled; re-enable cannot revive the still-valid key; retry invalidates it; a new consent works',
    HTTP,
    partialError instanceof AppKeyInvalidationError &&
      stateAfterPartial?.enabled === false &&
      leftValid?.invalidated === false &&
      partialCode === 'app_stale' &&
      retry.invalidated >= 1 &&
      afterRetry?.invalidated === true &&
      freshCode === 'ok',
    {
      reported: partialError instanceof AppKeyInvalidationError,
      disabled: stateAfterPartial?.enabled === false,
      keyLeftValid: leftValid?.invalidated === false,
      oldHandle: partialCode,
      retryInvalidated: retry.invalidated,
      keyInvalidatedAfterRetry: afterRetry?.invalidated,
      newSession: freshCode,
    }
  );
  // 4. Operator CLI with an HTTP failure (wrong internal-user password): non-zero exit, state stays
  // disabled; enable is not blocked.
  const operator = (command: string, auth: string) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'scripts/ui_operator.ts', command], {
      cwd: PROTOTYPE_DIR,
      env: { ...process.env, ES_URL: ctx.es, KIBANA_SYSTEM_AUTH: auth },
      encoding: 'utf8',
    });
  const cliHandle = await mint(ctx, users.viewer);
  const cliDisable = operator('disable', 'kibana_system:not-the-password');
  const cliOut = JSON.parse(cliDisable.stdout.trim().split('\n').pop() ?? '{}') as {
    consent?: { enabled?: boolean };
    revoked?: { failed?: { status?: unknown } };
  };
  const cliEnable = operator('enable', kibanaSystemAuth());
  await sleep(STATE_CACHE_WAIT_MS);
  const cliCode = codeOf(await execute(ctx, cliHandle, SUMMARY));
  report.expect(
    T,
    'ui:operator disable with an invalidation HTTP failure exits non-zero and reports it; state disabled; old handle dead after enable',
    HTTP,
    cliDisable.status === 1 &&
      cliOut.consent?.enabled === false &&
      cliOut.revoked?.failed?.status === 401 &&
      cliEnable.status === 0 &&
      cliCode === 'app_stale',
    {
      disableExit: cliDisable.status,
      failure: cliOut.revoked?.failed?.status,
      enableExit: cliEnable.status,
      oldHandle: cliCode,
    }
  );
  await invalidateAppKeys({ esUrl: ctx.es, appId: 'alert-digest' });
  // 5. Live race: a mint racing disable + enable. A returned handle works iff it carries the
  // current generation; no handle with a superseded generation ever works.
  const race: Array<{ minted: boolean; generation?: number; current?: number; code?: string }> = [];
  for (let i = 0; i < 6; i++) {
    const [created] = await Promise.all([
      createSession(ctx, users.viewer),
      (async () => {
        await sleep(i * 40);
        await setAppEnabled(false, { esUrl: ctx.es });
        await setAppEnabled(true, { esUrl: ctx.es });
      })(),
    ]);
    await sleep(STATE_CACHE_WAIT_MS);
    const current = readConsent()?.generation;
    if (!created.session) {
      race.push({ minted: false, code: codeOf(created.response), current });
      continue;
    }
    race.push({
      minted: true,
      generation: generationOf(created.session),
      current,
      code: codeOf(await execute(ctx, created.session, SUMMARY)),
    });
  }
  report.expect(
    T,
    'mint racing disable + enable (6 runs): only current-generation handles work',
    HTTP,
    race.every(({ minted, generation, current, code }) =>
      minted
        ? (generation === current) === (code === 'ok') && (code === 'ok' || code === 'app_stale')
        : code === 'app_disabled' || code === 'app_stale'
    ),
    race.map(({ minted, generation, current, code }) => ({
      minted,
      code,
      current: minted ? generation === current : undefined,
    }))
  );
  await sleep(SETTLE_MS);
  await invalidateAppKeys({ esUrl: ctx.es, appId: 'alert-digest' });
  // Release change: a new approved release invalidates the previous release's keys.
  const v1 = await mint(ctx, users.viewer);
  await sleep(SETTLE_MS);
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
  await sleep(SETTLE_MS);
  const before = await appKeyCount(ctx);
  const held = await mint(ctx, users.viewer);
  const codes: string[] = [];
  for (let i = 0; i < 30; i++) {
    codes.push(codeOf(await execute(ctx, held, i % 3 === 0 ? SUMMARY : search(SYNTHETIC_INDEX))));
  }
  await sleep(SETTLE_MS);
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
