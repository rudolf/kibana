/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, HttpSelfScopedClient } from '@kbn/core/server';
import { loggerMock } from '@kbn/logging-mocks';
import { errors } from '@elastic/elasticsearch';
import type { AppRunner, RunSummaryOptions } from '../app_runner';
import type { AppKey, AppKeyRequest } from './app_key';
import { BridgeAuditLogger } from './audit';
import { BridgeService, type CallerContext } from './bridge_service';
import type { UiReleaseState } from './consent';
import { DASHBOARD_ID, uiManifest } from '../test/ui_fixtures';

type ApprovedManifest = Extract<UiReleaseState, { status: 'approved' }>['manifest'];

const CANARY = 'CANARY_user_elastic_roles_superuser_.security-7_at_Object.<anonymous>';
const RAW_KEY = 'RAWKEYsecretNeverLeaves';
const KEY_ID = 'KeyIdForTheAppSession';
const HANDLE_KEY = 'h'.repeat(32);
const manifest = uiManifest() as never as ApprovedManifest;
const asApproved = (m: ApprovedManifest): UiReleaseState => ({
  status: 'approved',
  manifest: m,
  consent: {} as never,
});
const approved = asApproved(manifest);
const SEARCH = { op: 'es.search', params: { index: 'kbn-apps-prototype-alerts', size: 5 } };
const DASHBOARD = { op: 'kibana.dashboard.read', params: { id: DASHBOARD_ID } };
const SUMMARY = { op: 'app.summary' };

const esHits = (hits: Array<{ _index: string; _source: unknown }>) => ({
  search: jest.fn(async () => ({ hits: { total: { value: hits.length }, hits } })),
});

/** Minimal fetch-Response stand-in (the jsdom test environment has no WHATWG streams). */
const fakeResponse = (status: number, text: string, declareLength = true) => {
  const bytes = new Uint8Array(Buffer.from(text));
  let sent = false;
  return {
    status,
    redirected: false,
    headers: new Map(declareLength ? [['content-length', String(bytes.byteLength)]] : []),
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
        cancel: async () => undefined,
      }),
      cancel: async () => undefined,
    },
  };
};

const makeSelf = (
  status: number,
  body: unknown,
  url?: string,
  declareLength = true
): HttpSelfScopedClient => ({
  fetch: jest.fn(async (path: string) => ({
    fetchOptions: {} as never,
    request: { url: url ?? `http://localhost:5601${path}` } as Request,
    response: fakeResponse(
      status,
      typeof body === 'string' ? body : JSON.stringify(body),
      declareLength
    ),
  })) as never,
});

interface Setup {
  state?: () => UiReleaseState;
  es?: unknown;
  self?: HttpSelfScopedClient;
  summary?: (options: RunSummaryOptions) => Promise<unknown>;
  now?: () => number;
  skipInputSchema?: boolean;
}

const setup = ({ state = () => approved, es, self, summary, now, skipInputSchema }: Setup = {}) => {
  const logger = loggerMock.create();
  const runner = {
    runSummary: jest.fn(
      async (_app: string, _es: unknown, _signal: AbortSignal, options: RunSummaryOptions) =>
        summary
          ? summary(options)
          : {
              status: 'ok',
              body: {
                appId: 'alert-digest',
                version: '2.0.0',
                label: 'L',
                counts: { high: 2, low: 1 },
              },
            }
    ),
  } as unknown as Pick<AppRunner, 'runSummary'>;
  const readState = jest.fn(async () => state());
  const service = new BridgeService({
    packagePath: '/x',
    consentPath: '/y',
    runner,
    audit: new BridgeAuditLogger(logger),
    handleEncryptionKey: HANDLE_KEY,
    readState,
    now,
    skipInputSchema,
  });
  const esClient = (es ??
    esHits([
      { _index: 'kbn-apps-prototype-alerts', _source: { severity: 'high', rule: 'r' } },
    ])) as unknown as ElasticsearchClient;
  const selfClient = self ?? makeSelf(200, { id: DASHBOARD_ID, data: { title: 'T' } });
  let minted = 0;
  const grantKey = jest.fn(
    async (_request: AppKeyRequest): Promise<AppKey | null> => ({
      id: `${KEY_ID}${minted++}`,
      apiKey: RAW_KEY,
    })
  );
  const asKey = jest.fn((_key: AppKey) => ({ esClient, selfClient }));
  const caller = (overrides: Partial<CallerContext> = {}): CallerContext => ({
    principal: '["native","native","viewer"]',
    userName: 'viewer',
    spaceId: 'default',
    isDefaultSpace: true,
    originOk: true,
    runAs: false,
    requestAborted: new AbortController().signal,
    grantKey,
    asKey,
    dashboardPathname: (id) => `/api/dashboards/${id}`,
    ...overrides,
  });
  const audit = () => logger.info.mock.calls.map(([, meta]) => meta as Record<string, any>);
  const mint = async (c = caller()) => {
    const created = await service.createSession(c, 'alert-digest', manifest.releaseDigest);
    return (created.body as { handle: string }).handle;
  };
  return {
    service,
    caller,
    mint,
    audit,
    esClient,
    selfClient,
    grantKey,
    asKey,
    runner,
    readState,
    logger,
  };
};

const code = (result: { body: unknown }) => (result.body as { code?: string }).code ?? 'ok';

describe('BridgeService app session (K3/K4/K6)', () => {
  it('requires approval, exact Origin, no run_as and the default space before any state read or mint', async () => {
    const { service, caller, readState, grantKey } = setup();
    for (const overrides of [
      { originOk: false },
      { runAs: true },
      { isDefaultSpace: false, spaceId: 'app-host-empty' },
      { principal: undefined },
    ]) {
      expect(
        code(await service.createSession(caller(overrides), 'alert-digest', manifest.releaseDigest))
      ).toBe('app_denied');
    }
    expect(readState).not.toHaveBeenCalled();
    expect(code(await service.createSession(caller(), 'other-app', manifest.releaseDigest))).toBe(
      'app_denied'
    );
    expect(code(await service.createSession(caller(), 'alert-digest', 'a'.repeat(64)))).toBe(
      'app_stale'
    );
    expect(grantKey).not.toHaveBeenCalled();
  });

  it('refuses to mint for a disabled or unapproved release', async () => {
    for (const [state, expected] of [
      [{ status: 'disabled', manifest, consent: {} }, 'app_disabled'],
      [{ status: 'not_approved', manifest }, 'app_denied'],
    ] as const) {
      const { service, caller, grantKey } = setup({ state: () => state as never });
      expect(
        code(await service.createSession(caller(), 'alert-digest', manifest.releaseDigest))
      ).toBe(expected);
      expect(grantKey).not.toHaveBeenCalled();
    }
  });

  it('mints one restricted key whose role descriptor comes from the approved manifest only', async () => {
    const { mint, grantKey } = setup();
    await mint();
    expect(grantKey).toHaveBeenCalledTimes(1);
    expect(grantKey.mock.calls[0][0]).toStrictEqual({
      name: `app:alert-digest@${manifest.releaseDigest}`,
      expiration: '3600s',
      metadata: {
        app_host: true,
        app: 'alert-digest',
        release: manifest.releaseDigest,
        space: 'default',
      },
      role_descriptors: {
        app: {
          cluster: [],
          indices: [{ names: ['kbn-apps-prototype-alerts'], privileges: ['read'] }],
          applications: [
            {
              application: 'kibana-.kibana',
              privileges: ['feature_dashboard_v2.read'],
              resources: ['space:default'],
            },
          ],
          run_as: [],
        },
      },
    });
  });

  it('grants no Kibana application privilege without the kibana.dashboard.read scope', async () => {
    const noDashboard = uiManifest({
      ui: { ...(manifest.ui as object), scopes: ['app.summary', 'es.search'] },
    }) as never as ApprovedManifest;
    const { service, caller, grantKey } = setup({ state: () => asApproved(noDashboard) });
    await service.createSession(caller(), 'alert-digest', noDashboard.releaseDigest);
    const [[request]] = grantKey.mock.calls;
    expect(request.role_descriptors.app.applications).toEqual([]);
  });

  it('fails closed with app_unavailable when no key can be minted', async () => {
    const { service, caller, grantKey, audit } = setup();
    grantKey.mockResolvedValueOnce(null);
    grantKey.mockRejectedValueOnce(new Error(CANARY));
    for (let i = 0; i < 2; i++) {
      const result = await service.createSession(caller(), 'alert-digest', manifest.releaseDigest);
      expect(result.body).toEqual({ ok: false, code: 'app_unavailable' });
    }
    expect(audit().map((r) => r.event.reason)).toEqual(['mint_failed', 'mint_failed']);
    expect(JSON.stringify(audit())).not.toContain('CANARY');
  });

  it('K3: tampered, other-principal, other-space and expired handles are refused', async () => {
    let now = 1_000;
    const { service, caller, mint, asKey } = setup({ now: () => now });
    const handle = await mint();
    const [release, sealed] = handle.split('.');
    const flipped = `${sealed.slice(0, 20)}${sealed[20] === 'A' ? 'B' : 'A'}${sealed.slice(21)}`;
    for (const [bad, c] of [
      [`${release}.${flipped}`, caller()],
      [`${'0'.repeat(64)}.${sealed}`, caller()],
      ['not-a-handle', caller()],
      [handle, caller({ principal: '["native","native","viewer2"]' })],
      [handle, caller({ principal: '["saml","cloud-saml","viewer"]' })],
    ] as const) {
      expect(code(await service.execute(c, bad, SUMMARY))).toBe('app_denied');
    }
    expect(asKey).not.toHaveBeenCalled();
    expect(code(await service.execute(caller(), handle, SUMMARY))).toBe('ok');
    now += 60 * 60 * 1000;
    expect(code(await service.execute(caller(), handle, SUMMARY))).toBe('app_expired');
  });

  it('K4: the raw key never leaves the server; it reaches only the key-scoped clients', async () => {
    const { service, caller, mint, asKey, logger } = setup();
    const created = await service.createSession(caller(), 'alert-digest', manifest.releaseDigest);
    const handle = (created.body as { handle: string }).handle;
    const results = [
      created,
      await service.execute(caller(), handle, SUMMARY),
      await service.execute(caller(), handle, SEARCH),
      await service.execute(caller(), handle, DASHBOARD),
      await service.execute(caller(), `${handle}x`, SUMMARY),
      await service.createSession(caller(), 'alert-digest', manifest.releaseDigest),
    ];
    await mint();
    const logged = JSON.stringify([
      logger.info.mock.calls,
      logger.debug.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ]);
    const encoded = Buffer.from(`${KEY_ID}0:${RAW_KEY}`).toString('base64');
    for (const text of [JSON.stringify(results), logged]) {
      expect(text).not.toContain(RAW_KEY);
      expect(text).not.toContain(encoded);
    }
    expect(asKey.mock.calls.map(([key]) => key)).toEqual([
      { id: `${KEY_ID}0`, apiKey: RAW_KEY },
      { id: `${KEY_ID}0`, apiKey: RAW_KEY },
      { id: `${KEY_ID}0`, apiKey: RAW_KEY },
    ]);
  });

  it('K6: N calls on one handle use exactly one minted key', async () => {
    const { service, caller, mint, grantKey, asKey } = setup();
    const handle = await mint();
    for (let i = 0; i < 25; i++) {
      expect(code(await service.execute(caller(), handle, i % 2 ? SEARCH : SUMMARY))).toBe('ok');
    }
    expect(grantKey).toHaveBeenCalledTimes(1);
    expect(new Set(asKey.mock.calls.map(([key]) => key.id))).toEqual(new Set([`${KEY_ID}0`]));
  });
});

describe('BridgeService execute as the key (K1/K2/T8/T11/T13)', () => {
  it('serves the three granted operations through the key-scoped clients', async () => {
    const { service, caller, mint } = setup();
    const handle = await mint();
    expect((await service.execute(caller(), handle, SUMMARY)).body).toEqual({
      ok: true,
      result: { appId: 'alert-digest', version: '2.0.0', label: 'L', counts: { high: 2, low: 1 } },
    });
    expect((await service.execute(caller(), handle, SEARCH)).body).toEqual({
      ok: true,
      result: { total: 1, records: [{ severity: 'high', rule: 'r' }] },
    });
    expect((await service.execute(caller(), handle, DASHBOARD)).body).toEqual({
      ok: true,
      result: { id: DASHBOARD_ID, title: 'T' },
    });
  });

  it('app.summary runs the Worker HostEs callbacks with the key-scoped client', async () => {
    const { service, caller, mint, runner, esClient } = setup();
    await service.execute(caller(), await mint(), SUMMARY);
    const [[appId, client, , options]] = (runner.runSummary as jest.Mock).mock.calls;
    expect(appId).toBe('alert-digest');
    expect(client).toBe(esClient);
    expect(options.expectedReleaseDigest).toBe(manifest.releaseDigest);
  });

  it('T11 corpus: unsupported operations, query languages, handles and non-delegable APIs fail before any I/O', async () => {
    const { service, caller, mint, asKey, runner } = setup();
    const su = caller({ principal: 'superuser' });
    const handle = await mint(su);
    const corpus: unknown[] = [
      { op: 'security.apiKey.grant' },
      { op: 'alerting.rule.create', params: {} },
      { op: 'task_manager.schedule' },
      { op: 'transform.create' },
      { op: 'reporting.generate' },
      { op: 'workflows.run' },
      { op: 'actions.execute', params: { connectorId: 'x' } },
      { op: 'inference.completion' },
      { op: 'saved_objects.create', params: { type: 'visualization' } },
      { op: 'http.request', params: { method: 'GET', path: '/api/security/role' } },
      { op: 'es.transport', params: { path: '/_security/user' } },
      {
        op: 'es.search',
        params: { index: 'kbn-apps-prototype-alerts', size: 1, query: { match_all: {} } },
      },
      {
        op: 'es.search',
        params: { index: 'kbn-apps-prototype-alerts', size: 1, run_as: 'elastic' },
      },
      ...[
        'FROM .security* | LIMIT 1',
        'FROM a | LOOKUP JOIN b ON x',
        'FROM a | ENRICH p',
        'FROM a | FORK (LIMIT 1)',
        'FROM a | FUSE',
        'PROMQL up',
        'TS metrics',
        'FROM remote:idx',
        'FROM a | COMPLETION x',
        'FROM a | RERANK q ON f',
      ].map((esql) => ({ op: 'es.search', params: { esql } })),
      ...[
        'lookup',
        'more_like_this',
        'percolate',
        'indexed_shape',
        'pit',
        'scroll',
        'async',
        'template',
        'script',
        'runtime_mappings',
        'knn',
        'retriever',
        'inference',
      ].map((field) => ({
        op: 'es.search',
        params: { index: 'kbn-apps-prototype-alerts', size: 1, [field]: {} },
      })),
    ];
    for (const operation of corpus) {
      expect(code(await service.execute(su, handle, operation))).toBe('bridge_invalid_request');
    }
    for (const index of [
      '.security-7',
      '.kibana',
      '.fleet-agents',
      'logs-kibana.audit-default',
      'kbn-*',
      'kbn-apps-prototype-alerts,other',
      'remote:kbn-apps-prototype-alerts',
    ]) {
      expect(
        code(await service.execute(su, handle, { op: 'es.search', params: { index, size: 1 } }))
      ).toBe('app_denied');
    }
    expect(asKey).not.toHaveBeenCalled();
    expect(runner.runSummary).not.toHaveBeenCalled();
  });

  it('denies ungranted dashboard ids identically before lookup (existing or not)', async () => {
    const { service, caller, mint, asKey } = setup();
    const handle = await mint();
    const a = await service.execute(caller(), handle, {
      op: 'kibana.dashboard.read',
      params: { id: '00000000-0000-4000-8000-000000000000' },
    });
    const b = await service.execute(caller(), handle, {
      op: 'kibana.dashboard.read',
      params: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    });
    expect(a).toEqual(b);
    expect(code(a)).toBe('app_denied');
    expect(asKey).not.toHaveBeenCalled();
  });

  it('K1: with the test-only input-schema bypass, Elasticsearch and Kibana authz decide', async () => {
    const forbidden = new errors.ResponseError({
      statusCode: 403,
      body: { error: { reason: CANARY } },
      headers: {},
      warnings: null,
      meta: {} as never,
    });
    const search = jest.fn(async () => {
      throw forbidden;
    });
    const noDashboard = uiManifest({
      ui: { ...(manifest.ui as object), scopes: ['app.summary', 'es.search'] },
    }) as never as ApprovedManifest;
    const self = makeSelf(403, { message: CANARY });
    const { service, caller, audit } = setup({
      es: { search },
      self,
      skipInputSchema: true,
      state: () => asApproved(noDashboard),
    });
    const created = await service.createSession(
      caller(),
      'alert-digest',
      noDashboard.releaseDigest
    );
    const handle = (created.body as { handle: string }).handle;
    const result = await service.execute(caller(), handle, {
      op: 'es.search',
      params: { index: '.security', size: 1 },
    });
    expect(result).toEqual({ status: 403, body: { ok: false, code: 'app_denied' } });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ index: '.security' }),
      expect.anything()
    );
    // Scope absent from the manifest: the bypass reaches Kibana's native authz, which denies.
    expect(code(await service.execute(caller(), handle, DASHBOARD))).toBe('app_denied');
    expect(self.fetch).toHaveBeenCalledTimes(1);
    expect(
      audit()
        .slice(-2)
        .map((r) => r.event.reason)
    ).toEqual(['native_denied', 'native_denied']);
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it('T13: native ES 403 bodies and Kibana 403/404/500 bodies never leak', async () => {
    const forbidden = new errors.ResponseError({
      statusCode: 403,
      body: { error: { reason: CANARY } },
      headers: { 'www-authenticate': CANARY },
      warnings: null,
      meta: {} as never,
    });
    const es = {
      search: jest.fn(async () => {
        throw forbidden;
      }),
    };
    for (const [status, expected] of [
      [403, 'app_denied'],
      [404, 'app_denied'],
      [500, 'app_unavailable'],
      [401, 'app_denied'],
    ] as const) {
      const { service, caller, mint } = setup({
        es,
        self: makeSelf(status, { message: CANARY, stack: CANARY }),
      });
      const handle = await mint();
      const search = await service.execute(caller(), handle, {
        op: 'es.search',
        params: { index: 'kbn-apps-prototype-alerts', size: 1 },
      });
      const dashboard = await service.execute(caller(), handle, DASHBOARD);
      expect(search).toEqual({ status: 403, body: { ok: false, code: 'app_denied' } });
      expect(code(dashboard)).toBe(expected);
      expect(JSON.stringify([search, dashboard])).not.toContain('CANARY');
    }
  });

  it('S5: alias match, redirect and oversized bodies fail closed', async () => {
    const cases: Array<[HttpSelfScopedClient, string]> = [
      [
        makeSelf(200, {
          id: '11111111-1111-4111-8111-111111111111',
          data: { title: 'other object' },
        }),
        'app_denied',
      ],
      [
        makeSelf(
          200,
          { id: DASHBOARD_ID, data: { title: 'T' } },
          'http://localhost:5601/api/dashboards/elsewhere'
        ),
        'app_unavailable',
      ],
      [
        makeSelf(200, `{"id":"${DASHBOARD_ID}","data":{"title":"${'x'.repeat(300 * 1024)}"}}`),
        'app_unavailable',
      ],
      [
        makeSelf(
          200,
          `{"id":"${DASHBOARD_ID}","data":{"title":"${'x'.repeat(300 * 1024)}"}}`,
          undefined,
          false
        ),
        'app_unavailable',
      ],
      [
        {
          fetch: jest.fn(async () => {
            throw new Error(
              'Kibana self HTTP call received a redirect (302) but server.selfHttp.maxRedirects is 0.'
            );
          }),
        } as never,
        'app_unavailable',
      ],
    ];
    for (const [self, expected] of cases) {
      const { service, caller, mint } = setup({ self });
      expect(code(await service.execute(caller(), await mint(), DASHBOARD))).toBe(expected);
    }
  });

  it('T8: disable or a release change is refused on the next call once the 2 s state cache expires', async () => {
    let now = 1_000;
    let state: UiReleaseState = approved;
    const { service, caller, mint, readState, asKey } = setup({
      state: () => state,
      now: () => now,
    });
    const handle = await mint();
    expect(code(await service.execute(caller(), handle, SUMMARY))).toBe('ok');
    const reads = readState.mock.calls.length;
    state = { status: 'disabled', manifest, consent: {} as never };
    now += 1_999;
    // Within the cache window the key's own invalidation is what stops it (Elasticsearch denies).
    expect(code(await service.execute(caller(), handle, SUMMARY))).toBe('ok');
    expect(readState.mock.calls.length).toBe(reads);
    now += 1;
    expect(code(await service.execute(caller(), handle, SUMMARY))).toBe('app_disabled');
    const v2 = uiManifest({ version: '2.0.1' }) as never as ApprovedManifest;
    state = asApproved(v2);
    now += 2_000;
    expect(code(await service.execute(caller(), handle, SUMMARY))).toBe('app_stale');
    state = { status: 'not_approved', manifest: v2 };
    now += 2_000;
    expect(code(await service.execute(caller(), handle, SUMMARY))).toBe('app_stale');
    expect(asKey).toHaveBeenCalledTimes(2);
  });

  it('result size: exactly 16 KiB returned, one byte more refused', async () => {
    const body = (labelLength: number) => ({
      appId: 'alert-digest',
      version: '2.0.0',
      label: 'x'.repeat(labelLength),
      counts: { high: 1, low: 1 },
    });
    const overhead = Buffer.byteLength(JSON.stringify(body(0)));
    for (const [length, expected] of [
      [16 * 1024 - overhead, 'ok'],
      [16 * 1024 - overhead + 1, 'app_unavailable'],
    ] as const) {
      const { service, caller, mint } = setup({
        summary: async () => ({ status: 'ok', body: body(length) }),
      });
      expect(code(await service.execute(caller(), await mint(), SUMMARY))).toBe(expected);
    }
  });

  describe('operation deadline (fake clock)', () => {
    beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
    afterEach(() => jest.useRealTimers());

    it('aborts the handler at exactly 5 s and returns app_timeout; not before', async () => {
      let seen: AbortSignal | undefined;
      const { service, caller, mint, runner } = setup({ now: () => Date.now() });
      (runner.runSummary as jest.Mock).mockImplementation(
        (_a: string, _e: unknown, signal: AbortSignal) => {
          seen = signal;
          return new Promise(() => undefined);
        }
      );
      const handle = await mint();
      let settled: unknown;
      const pending = service
        .execute(caller(), handle, SUMMARY)
        .then((result) => (settled = result));
      await jest.advanceTimersByTimeAsync(4999);
      expect(settled).toBeUndefined();
      expect(seen?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await pending;
      expect(seen?.aborted).toBe(true);
      expect((settled as { body: unknown }).body).toEqual({ ok: false, code: 'app_timeout' });
    });
  });
});

describe('BridgeService audit (T10/S9)', () => {
  it('records handle-derived attribution and api_key.id; Worker-path reads share the correlation id', async () => {
    const { service, caller, mint, audit } = setup({
      summary: async (options) => {
        options.searchObserver?.('success', 'ok');
        return {
          status: 'ok',
          body: {
            appId: 'alert-digest',
            version: '2.0.0',
            label: 'L',
            counts: { high: 0, low: 0 },
          },
        };
      },
    });
    const evil = caller({ userName: 'evil\r\n\u001b[31mname' });
    await service.execute(evil, await mint(evil), SUMMARY);
    const [created, inner, outer] = audit();
    expect(created.event).toEqual(
      expect.objectContaining({
        outcome: 'success',
        reason: 'session_created',
        provider: 'session',
      })
    );
    expect(created.api_key).toEqual({ id: `${KEY_ID}0` });
    expect(outer.event).toEqual(
      expect.objectContaining({ action: 'app_host.bridge', outcome: 'success', reason: 'ok' })
    );
    expect(outer.app).toEqual({
      id: 'alert-digest',
      version: '2.0.0',
      release_digest: manifest.releaseDigest,
      capability: 'app.summary',
      via: 'bridge',
    });
    expect(outer.api_key).toEqual({ id: `${KEY_ID}0` });
    expect(inner.app).toEqual(
      expect.objectContaining({ capability: 'es.search', via: 'app.summary' })
    );
    expect(inner.api_key).toEqual({ id: `${KEY_ID}0` });
    expect(inner.kibana.correlation_id).toBe(outer.kibana.correlation_id);
    expect(outer.user.name).not.toMatch(/[\r\n\u001b]/);
    expect(outer.kibana.space_id).toBe('default');
  });

  it('records failures without inventing an app actor when the handle is invalid', async () => {
    const { service, caller, audit } = setup();
    await service.execute(caller(), `${'a'.repeat(64)}.${'B'.repeat(60)}`, SUMMARY);
    const [record] = audit();
    expect(record.app).toBeUndefined();
    expect(record.api_key).toBeUndefined();
    expect(record.event).toEqual(
      expect.objectContaining({ outcome: 'failure', reason: 'bad_handle' })
    );
  });
});

describe('BridgeService second app identity (T7)', () => {
  it('a valid handle for one app is refused when the installed context is another app', async () => {
    const second = uiManifest({
      id: 'second-app',
      title: 'Second app',
    }) as never as ApprovedManifest;
    let now = 0;
    let state = approved;
    const { service, caller, mint, asKey } = setup({ state: () => state, now: () => now });
    const handle = await mint();
    state = asApproved(second);
    now += 2_000;
    expect(code(await service.execute(caller(), handle, SUMMARY))).not.toBe('ok');
    expect(asKey).not.toHaveBeenCalled();
  });
});

describe('BridgeService handlers reach only their own services (T11, behavioural)', () => {
  /** Records every property read and call on a client; only `allowed` members are callable. */
  const recorder = (allowed: Record<string, (...args: unknown[]) => unknown>) => {
    const touched: string[] = [];
    const proxy = (path: string): unknown =>
      new Proxy(function stub() {}, {
        get: (_t, key) => {
          const name = `${path}${path ? '.' : ''}${String(key)}`;
          if (key === 'then') return undefined;
          touched.push(name);
          return allowed[name] ?? proxy(name);
        },
        apply: () => {
          touched.push(`${path}()`);
          throw new Error(`unexpected call ${path}`);
        },
      });
    return { client: proxy(''), touched };
  };

  it('es.search uses only search(), dashboard read only fetch(GET /api/dashboards/{granted}), summary only the runner', async () => {
    const es = recorder({
      search: async () => ({
        hits: {
          total: { value: 1 },
          hits: [{ _index: 'kbn-apps-prototype-alerts', _source: { severity: 'high', rule: 'r' } }],
        },
      }),
    });
    const fetches: Array<[string, Record<string, unknown>]> = [];
    const self = recorder({
      fetch: async (path: unknown, options: unknown) => {
        fetches.push([path as string, options as Record<string, unknown>]);
        return (makeSelf(200, { id: DASHBOARD_ID, data: { title: 'T' } }).fetch as jest.Mock)(path);
      },
    });
    const { service, caller, mint, runner } = setup({
      es: es.client,
      self: self.client as HttpSelfScopedClient,
    });
    const handle = await mint();
    expect(
      code(
        await service.execute(caller(), handle, {
          op: 'es.search',
          params: { index: 'kbn-apps-prototype-alerts', size: 1 },
        })
      )
    ).toBe('ok');
    expect(code(await service.execute(caller(), handle, DASHBOARD))).toBe('ok');
    expect(code(await service.execute(caller(), handle, SUMMARY))).toBe('ok');
    // No security (API keys, run_as), transport, connector or inference access on the key clients.
    expect(es.touched).toEqual(['search']);
    expect(self.touched).toEqual(['fetch']);
    expect(fetches.map(([path, options]) => [path, options.method])).toEqual([
      [`/api/dashboards/${DASHBOARD_ID}`, 'GET'],
    ]);
    expect(runner.runSummary).toHaveBeenCalledTimes(1);
  });

  it('F4: the dashboard self call uses exactly the pinned options', async () => {
    const self = makeSelf(200, { id: DASHBOARD_ID, data: { title: 'T' } });
    const { service, caller, mint } = setup({ self });
    await service.execute(caller(), await mint(), DASHBOARD);
    const [[path, options]] = (self.fetch as jest.Mock).mock.calls;
    expect(path).toBe(`/api/dashboards/${DASHBOARD_ID}`);
    const { signal, ...rest } = options;
    expect(signal).toBeInstanceOf(AbortSignal);
    // Exact object: no prependBasePath override, no forwardRequestHeaders, no extra headers.
    expect(rest).toStrictEqual({
      target: 'local',
      method: 'GET',
      access: 'public',
      version: '2023-10-31',
      timeout: 2000,
      asResponse: true,
      rawResponse: true,
    });
  });
});
