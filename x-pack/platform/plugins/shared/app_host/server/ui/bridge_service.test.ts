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
import { BridgeAuditLogger } from './audit';
import { BridgeService, type CallerContext } from './bridge_service';
import type { UiReleaseState } from './consent';
import { DASHBOARD_ID, uiManifest } from '../test/ui_fixtures';

const CANARY = 'CANARY_user_elastic_roles_superuser_.security-7_at_Object.<anonymous>';
const manifest = uiManifest() as never as Extract<
  UiReleaseState,
  { status: 'approved' }
>['manifest'];
const approved: UiReleaseState = { status: 'approved', manifest, consent: {} as never };

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
}

const setup = ({ state = () => approved, es, self, summary, now }: Setup = {}) => {
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
    readState,
    now,
  });
  const esClient = jest.fn(
    () =>
      (es ??
        esHits([
          { _index: 'kbn-apps-prototype-alerts', _source: { severity: 'high', rule: 'r' } },
        ])) as unknown as ElasticsearchClient
  );
  const selfClient = jest.fn(
    () => self ?? makeSelf(200, { id: DASHBOARD_ID, data: { title: 'T' } })
  );
  const caller = (overrides: Partial<CallerContext> = {}): CallerContext => ({
    principal: '["native","native","viewer"]',
    userName: 'viewer',
    spaceId: 'default',
    isDefaultSpace: true,
    originOk: true,
    runAs: false,
    requestAborted: new AbortController().signal,
    esClient,
    selfClient,
    dashboardPathname: (id) => `/api/dashboards/${id}`,
    ...overrides,
  });
  const audit = () => logger.info.mock.calls.map(([, meta]) => meta as Record<string, any>);
  const lease = async (c = caller()) => {
    const created = await service.createLease(c, 'alert-digest', manifest.releaseDigest);
    return created.body as { leaseId: string; secret: string };
  };
  return { service, caller, lease, audit, esClient, selfClient, runner, readState, logger };
};

const code = (result: { body: unknown }) => (result.body as { code?: string }).code ?? 'ok';

describe('BridgeService leases (T7/T14/S11)', () => {
  it('requires approval, exact Origin, no run_as and the default space before any state read', async () => {
    const { service, caller, readState } = setup();
    for (const overrides of [
      { originOk: false },
      { runAs: true },
      { isDefaultSpace: false, spaceId: 'app-host-empty' },
      { principal: undefined },
    ]) {
      expect(
        code(await service.createLease(caller(overrides), 'alert-digest', manifest.releaseDigest))
      ).toBe('app_denied');
    }
    expect(readState).not.toHaveBeenCalled();
    expect(code(await service.createLease(caller(), 'other-app', manifest.releaseDigest))).toBe(
      'app_denied'
    );
    expect(code(await service.createLease(caller(), 'alert-digest', 'a'.repeat(64)))).toBe(
      'app_stale'
    );
  });

  it('caps leases at 4 per principal and 32 globally', async () => {
    const { service, caller } = setup();
    for (let i = 0; i < 4; i++)
      expect(
        code(await service.createLease(caller(), 'alert-digest', manifest.releaseDigest))
      ).toBe('ok');
    expect(code(await service.createLease(caller(), 'alert-digest', manifest.releaseDigest))).toBe(
      'app_rate_limited'
    );
    for (let p = 1; p < 8; p++) {
      for (let i = 0; i < 4; i++) {
        expect(
          code(
            await service.createLease(
              caller({ principal: `p${p}` }),
              'alert-digest',
              manifest.releaseDigest
            )
          )
        ).toBe('ok');
      }
    }
    expect(service.activeLeases).toBe(32);
    expect(
      code(
        await service.createLease(
          caller({ principal: 'p9' }),
          'alert-digest',
          manifest.releaseDigest
        )
      )
    ).toBe('app_rate_limited');
  });

  it('binds principal, space and secret; expiry fails closed', async () => {
    let now = 1_000;
    const { service, caller, lease } = setup({ now: () => now });
    const { leaseId, secret } = await lease();
    const op = { op: 'app.summary' };
    expect(code(await service.execute(caller(), leaseId, 'x'.repeat(43), op))).toBe('app_denied');
    expect(code(await service.execute(caller({ principal: 'other' }), leaseId, secret, op))).toBe(
      'app_denied'
    );
    expect(
      code(
        await service.execute(caller({ spaceId: 'x', isDefaultSpace: false }), leaseId, secret, op)
      )
    ).toBe('app_denied');
    expect(code(await service.execute(caller(), leaseId, secret, op))).toBe('ok');
    now += 5 * 60 * 1000;
    expect(code(await service.execute(caller(), leaseId, secret, op))).toBe('app_expired');
  });

  describe('P1: lease expiry during a pending read (fake clock)', () => {
    beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
    afterEach(() => jest.useRealTimers());

    it('aborts the pending read at expiry and returns app_expired instead of data', async () => {
      let finish: (() => void) | undefined;
      let seen: AbortSignal | undefined;
      const { service, caller, lease, runner } = setup({ now: () => Date.now() });
      (runner.runSummary as jest.Mock).mockImplementation(
        (_a: string, _e: unknown, signal: AbortSignal) => {
          seen = signal;
          return new Promise((resolve) => {
            finish = () =>
              resolve({
                status: 'ok',
                body: {
                  appId: 'alert-digest',
                  version: '2.0.0',
                  label: 'L',
                  counts: { high: 9, low: 9 },
                },
              });
          });
        }
      );
      const { leaseId, secret } = await lease();
      // Start the read 1 ms before expiry, inside the 5 s operation deadline.
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
      const pending = service.execute(caller(), leaseId, secret, { op: 'app.summary' });
      await jest.advanceTimersByTimeAsync(0);
      expect(seen?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(2);
      const abortedAtExpiry = seen?.aborted;
      finish?.();
      const result = await pending;
      expect(result.body).toEqual({ ok: false, code: 'app_expired' });
      expect(JSON.stringify(result)).not.toContain('"high":9');
      // Expiry is enforced by the server on its own, not only by a later request.
      expect(abortedAtExpiry).toBe(true);
      expect(
        code(await service.execute(caller(), leaseId, secret, { op: 'app.summary' }))
      ).not.toBe('ok');
    });
  });

  it('never logs the lease secret or id', async () => {
    const { service, caller, lease, logger } = setup();
    const { leaseId, secret } = await lease();
    await service.execute(caller(), leaseId, secret, { op: 'app.summary' });
    await service.execute(caller(), leaseId, 'y'.repeat(43), { op: 'app.summary' });
    const logged = JSON.stringify([
      logger.info.mock.calls,
      logger.debug.mock.calls,
      logger.warn.mock.calls,
    ]);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(leaseId);
  });
});

describe('BridgeService execute (T2/T7/T8/T11/T13/T14)', () => {
  it('serves the three granted operations as the current viewer', async () => {
    const { service, caller, lease } = setup();
    const { leaseId, secret } = await lease();
    expect((await service.execute(caller(), leaseId, secret, { op: 'app.summary' })).body).toEqual({
      ok: true,
      result: { appId: 'alert-digest', version: '2.0.0', label: 'L', counts: { high: 2, low: 1 } },
    });
    expect(
      (
        await service.execute(caller(), leaseId, secret, {
          op: 'es.search',
          params: { index: 'kbn-apps-prototype-alerts', size: 5 },
        })
      ).body
    ).toEqual({
      ok: true,
      result: { total: 1, records: [{ severity: 'high', rule: 'r' }] },
    });
    expect(
      (
        await service.execute(caller(), leaseId, secret, {
          op: 'kibana.dashboard.read',
          params: { id: DASHBOARD_ID },
        })
      ).body
    ).toEqual({
      ok: true,
      result: { id: DASHBOARD_ID, title: 'T' },
    });
  });

  it('T11 corpus: unsupported operations, query languages, handles and non-delegable APIs fail before any I/O', async () => {
    const { service, caller, lease, esClient, selfClient, runner } = setup();
    const { leaseId, secret } = await lease(caller({ principal: 'superuser' }));
    const su = caller({ principal: 'superuser' });
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
      expect(code(await service.execute(su, leaseId, secret, operation))).toBe(
        'bridge_invalid_request'
      );
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
        code(
          await service.execute(su, leaseId, secret, {
            op: 'es.search',
            params: { index, size: 1 },
          })
        )
      ).toBe('app_denied');
    }
    expect(esClient).not.toHaveBeenCalled();
    expect(selfClient).not.toHaveBeenCalled();
    expect(runner.runSummary).not.toHaveBeenCalled();
  });

  it('denies ungranted dashboard ids identically before lookup (existing or not)', async () => {
    const { service, caller, lease, selfClient } = setup();
    const { leaseId, secret } = await lease();
    const a = await service.execute(caller(), leaseId, secret, {
      op: 'kibana.dashboard.read',
      params: { id: '00000000-0000-4000-8000-000000000000' },
    });
    const b = await service.execute(caller(), leaseId, secret, {
      op: 'kibana.dashboard.read',
      params: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    });
    expect(a).toEqual(b);
    expect(code(a)).toBe('app_denied');
    expect(selfClient).not.toHaveBeenCalled();
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
      const { service, caller, lease } = setup({
        es,
        self: makeSelf(status, { message: CANARY, stack: CANARY }),
      });
      const { leaseId, secret } = await lease();
      const search = await service.execute(caller(), leaseId, secret, {
        op: 'es.search',
        params: { index: 'kbn-apps-prototype-alerts', size: 1 },
      });
      const dashboard = await service.execute(caller(), leaseId, secret, {
        op: 'kibana.dashboard.read',
        params: { id: DASHBOARD_ID },
      });
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
      const { service, caller, lease } = setup({ self });
      const { leaseId, secret } = await lease();
      expect(
        code(
          await service.execute(caller(), leaseId, secret, {
            op: 'kibana.dashboard.read',
            params: { id: DASHBOARD_ID },
          })
        )
      ).toBe(expected);
    }
  });

  it('T8: a release change or disable during a pending read returns no data and revokes the lease', async () => {
    let state: UiReleaseState = approved;
    let release: (() => void) | undefined;
    const { service, caller, lease } = setup({
      state: () => state,
      summary: () =>
        new Promise(
          (resolve) =>
            (release = () =>
              resolve({
                status: 'ok',
                body: {
                  appId: 'alert-digest',
                  version: '2.0.0',
                  label: 'L',
                  counts: { high: 0, low: 0 },
                },
              }))
        ),
    });
    const { leaseId, secret } = await lease();
    const pending = service.execute(caller(), leaseId, secret, { op: 'app.summary' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    state = { status: 'disabled', manifest, consent: {} as never };
    release?.();
    expect((await pending).body).toEqual({ ok: false, code: 'app_disabled' });
    state = approved;
    expect(code(await service.execute(caller(), leaseId, secret, { op: 'app.summary' }))).toBe(
      'app_denied'
    );
    const second = await lease();
    state = {
      status: 'approved',
      manifest: { ...manifest, releaseDigest: 'b'.repeat(64) },
      consent: {} as never,
    };
    expect(
      code(await service.execute(caller(), second.leaseId, second.secret, { op: 'app.summary' }))
    ).toBe('app_stale');
  });

  it('T14/T9: leases of one (app, user, space) share the operation bucket; other users do not', async () => {
    const { service, caller, lease } = setup({ now: () => 0 });
    const a = await lease();
    const b = await lease();
    const op = { op: 'app.summary' };
    const results: string[] = [];
    for (let i = 0; i < 6; i++)
      results.push(code(await service.execute(caller(), a.leaseId, a.secret, op)));
    for (let i = 0; i < 6; i++)
      results.push(code(await service.execute(caller(), b.leaseId, b.secret, op)));
    expect(results.filter((r) => r === 'ok')).toHaveLength(10);
    expect(results.slice(10)).toEqual(['app_rate_limited', 'app_rate_limited']);
    const other = caller({ principal: 'viewer2', userName: 'viewer2' });
    const c = await lease(other);
    expect(code(await service.execute(other, c.leaseId, c.secret, op))).toBe('ok');
  });

  it('enforces 2 in flight per lease and 4 operations per process', async () => {
    const releases: Array<() => void> = [];
    const { service, caller, lease } = setup({
      summary: () =>
        new Promise((resolve) =>
          releases.push(() =>
            resolve({
              status: 'ok',
              body: {
                appId: 'alert-digest',
                version: '2.0.0',
                label: 'L',
                counts: { high: 0, low: 0 },
              },
            })
          )
        ),
    });
    const a = await lease();
    const op = { op: 'app.summary' };
    const p1 = service.execute(caller(), a.leaseId, a.secret, op);
    const p2 = service.execute(caller(), a.leaseId, a.secret, op);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(code(await service.execute(caller(), a.leaseId, a.secret, op))).toBe('app_rate_limited');
    const others = await Promise.all(
      ['u2', 'u3'].map(async (p) => ({
        c: caller({ principal: p }),
        l: await lease(caller({ principal: p })),
      }))
    );
    const p3 = service.execute(others[0].c, others[0].l.leaseId, others[0].l.secret, op);
    const p4 = service.execute(others[1].c, others[1].l.leaseId, others[1].l.secret, op);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const u4 = caller({ principal: 'u4' });
    const l4 = await lease(u4);
    expect(code(await service.execute(u4, l4.leaseId, l4.secret, op))).toBe('app_rate_limited');
    releases.forEach((r) => r());
    await Promise.all([p1, p2, p3, p4]);
  });
});

describe('BridgeService audit (T10/S9)', () => {
  it('records lease-derived attribution with an independent correlation id; Worker-path reads share it', async () => {
    const { service, caller, lease, audit } = setup({
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
    const { leaseId, secret } = await lease(caller({ userName: 'evil\r\n\u001b[31mname' }));
    await service.execute(caller({ userName: 'evil\r\n\u001b[31mname' }), leaseId, secret, {
      op: 'app.summary',
    });
    const records = audit().filter((r) => r.app?.capability !== 'lease.create');
    const [inner, outer] = records;
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
    expect(inner.app).toEqual(
      expect.objectContaining({ capability: 'es.search', via: 'app.summary' })
    );
    expect(inner.kibana.correlation_id).toBe(outer.kibana.correlation_id);
    expect(outer.user.name).not.toMatch(/[\r\n\u001b]/);
    expect(outer.kibana.space_id).toBe('default');
  });

  it('records failures without inventing an app actor when no valid lease exists', async () => {
    const { service, caller, audit } = setup();
    await service.execute(caller(), 'A'.repeat(32), 'x'.repeat(43), { op: 'app.summary' });
    const [record] = audit();
    expect(record.app).toBeUndefined();
    expect(record.event).toEqual(
      expect.objectContaining({ outcome: 'failure', reason: 'unknown_lease' })
    );
  });
});

describe('BridgeService second app identity (T7/T14)', () => {
  const second = uiManifest({ id: 'second-app', title: 'Second app' }) as never as Extract<
    UiReleaseState,
    { status: 'approved' }
  >['manifest'];
  const asApproved = (m: typeof manifest): UiReleaseState => ({
    status: 'approved',
    manifest: m,
    consent: {} as never,
  });

  it('a valid lease for one app is refused when the installed context is another app', async () => {
    let state = asApproved(manifest);
    const { service, caller, runner, esClient, selfClient } = setup({ state: () => state });
    const first = (await service.createLease(caller(), 'alert-digest', manifest.releaseDigest))
      .body as { leaseId: string; secret: string };
    expect(
      code(await service.execute(caller(), first.leaseId, first.secret, { op: 'app.summary' }))
    ).toBe('ok');
    // The installed context becomes a different app (even reusing the old digest value).
    state = asApproved({ ...second, releaseDigest: manifest.releaseDigest });
    expect(
      code(await service.execute(caller(), first.leaseId, first.secret, { op: 'app.summary' }))
    ).toBe('app_stale');
    // Revoked: switching the context back does not revive it.
    state = asApproved(manifest);
    expect(
      code(await service.execute(caller(), first.leaseId, first.secret, { op: 'app.summary' }))
    ).toBe('app_denied');
    // Leases for the second app, then the first app installed again: refused before any I/O.
    (runner.runSummary as jest.Mock).mockClear();
    esClient.mockClear();
    selfClient.mockClear();
    for (const operation of [
      { op: 'app.summary' },
      { op: 'es.search', params: { index: 'kbn-apps-prototype-alerts', size: 1 } },
      { op: 'kibana.dashboard.read', params: { id: DASHBOARD_ID } },
    ]) {
      state = asApproved(second);
      const other = (await service.createLease(caller(), 'second-app', second.releaseDigest))
        .body as { leaseId: string; secret: string };
      state = asApproved(manifest);
      expect(code(await service.execute(caller(), other.leaseId, other.secret, operation))).toBe(
        'app_stale'
      );
    }
    expect(runner.runSummary).not.toHaveBeenCalled();
    expect(esClient).not.toHaveBeenCalled();
    expect(selfClient).not.toHaveBeenCalled();
    // A lease request naming the other app while this one is installed is refused.
    expect(code(await service.createLease(caller(), 'second-app', second.releaseDigest))).toBe(
      'app_stale'
    );
  });

  it('different app contexts of one user have independent operation buckets', async () => {
    let state = asApproved(manifest);
    const { service, caller } = setup({ state: () => state, now: () => 0 });
    const a = (await service.createLease(caller(), 'alert-digest', manifest.releaseDigest))
      .body as {
      leaseId: string;
      secret: string;
    };
    state = asApproved(second);
    const b = (await service.createLease(caller(), 'second-app', second.releaseDigest)).body as {
      leaseId: string;
      secret: string;
    };
    state = asApproved(manifest);
    const codesA: string[] = [];
    for (let i = 0; i < 11; i++)
      codesA.push(
        code(await service.execute(caller(), a.leaseId, a.secret, { op: 'app.summary' }))
      );
    expect(codesA.slice(0, 10).every((c) => c === 'ok')).toBe(true);
    expect(codesA[10]).toBe('app_rate_limited');
    state = asApproved(second);
    expect(code(await service.execute(caller(), b.leaseId, b.secret, { op: 'app.summary' }))).toBe(
      'ok'
    );
  });
});

describe('BridgeService budget boundaries (T9)', () => {
  it('operations per lease: 100 accepted, the 101st refused with lease_budget', async () => {
    let now = 0;
    const { service, caller, lease, audit } = setup({ now: () => now });
    const { leaseId, secret } = await lease();
    const codes: string[] = [];
    for (let i = 0; i < 101; i++) {
      now += 1000; // refill the shared bucket so only the per-lease budget applies
      codes.push(code(await service.execute(caller(), leaseId, secret, { op: 'app.summary' })));
    }
    expect(codes.slice(0, 100).every((c) => c === 'ok')).toBe(true);
    expect(codes[100]).toBe('app_rate_limited');
    expect(audit().at(-1)?.event).toEqual(expect.objectContaining({ reason: 'lease_budget' }));
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
      const { service, caller, lease } = setup({
        summary: async () => ({ status: 'ok', body: body(length) }),
      });
      const { leaseId, secret } = await lease();
      expect(code(await service.execute(caller(), leaseId, secret, { op: 'app.summary' }))).toBe(
        expected
      );
    }
  });

  describe('operation deadline (fake clock)', () => {
    beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
    afterEach(() => jest.useRealTimers());

    it('aborts the handler at exactly 5 s and returns app_timeout; not before', async () => {
      let seen: AbortSignal | undefined;
      const { service, caller, lease, runner } = setup({ now: () => Date.now() });
      (runner.runSummary as jest.Mock).mockImplementation(
        (_a: string, _e: unknown, signal: AbortSignal) => {
          seen = signal;
          return new Promise(() => undefined);
        }
      );
      const { leaseId, secret } = await lease();
      let settled: unknown;
      const pending = service
        .execute(caller(), leaseId, secret, { op: 'app.summary' })
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
    const { service, caller, lease, runner } = setup({
      es: es.client,
      self: self.client as HttpSelfScopedClient,
    });
    const { leaseId, secret } = await lease();
    expect(
      code(
        await service.execute(caller(), leaseId, secret, {
          op: 'es.search',
          params: { index: 'kbn-apps-prototype-alerts', size: 1 },
        })
      )
    ).toBe('ok');
    expect(
      code(
        await service.execute(caller(), leaseId, secret, {
          op: 'kibana.dashboard.read',
          params: { id: DASHBOARD_ID },
        })
      )
    ).toBe('ok');
    expect(code(await service.execute(caller(), leaseId, secret, { op: 'app.summary' }))).toBe(
      'ok'
    );
    // No security (API keys, grantAsInternalUser, run_as), transport, connector or inference access.
    expect(es.touched).toEqual(['search']);
    expect(self.touched).toEqual(['fetch']);
    expect(fetches.map(([path, options]) => [path, options.method])).toEqual([
      [`/api/dashboards/${DASHBOARD_ID}`, 'GET'],
    ]);
    expect(runner.runSummary).toHaveBeenCalledTimes(1);
  });

  it('F4: the dashboard self call uses exactly the pinned options', async () => {
    const self = makeSelf(200, { id: DASHBOARD_ID, data: { title: 'T' } });
    const { service, caller, lease } = setup({ self });
    const { leaseId, secret } = await lease();
    await service.execute(caller(), leaseId, secret, {
      op: 'kibana.dashboard.read',
      params: { id: DASHBOARD_ID },
    });
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
