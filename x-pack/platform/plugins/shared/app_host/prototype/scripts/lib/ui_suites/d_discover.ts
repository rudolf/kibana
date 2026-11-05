/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// D1–D5: the Mini Discover tile (data views + ES|QL as the app session key) on synthetic data.
// Needs `npm run ui:seed` (demo indices, secret index, data views, viewers).

import { join } from 'node:path';
import { setAppEnabled } from '../approval';
import { invalidateAppKeys } from '../app_keys';
import { http } from '../http';
import { credentialNeedles, scanSurfaces, type Surface } from '../leak_scan';
import { LOCAL_DIR } from '../secrets';
import { pollFrame, sleep } from '../ui_harness';
import { DEMO } from '../ui_seed_state';
import { release, session, type SuiteContext } from './context';
import {
  AUDIT_LOG,
  ES_QUERY_LOG,
  LOGS,
  STATE_CACHE_WAIT_MS,
  esQueriesSince,
  keyById,
  knownKeySession,
  lastRecord,
  logFiles,
  mint,
  readLines,
  readSince,
  sizeOf,
  type EsQueryEntry,
} from './k_session';
import { openBound } from './u3_adversarial';
import { codeOf, execute, type TestSession } from './u2_authority';

const HTTP = 'http';
const DOCS = DEMO.indices.length * DEMO.docsPerIndex;
const ROWS_QUERY = `FROM ${DEMO.dataViewTitle} | SORT @timestamp DESC | LIMIT 50`;
const HISTOGRAM_QUERY = `FROM ${DEMO.dataViewTitle} | STATS c = COUNT(*) BY b = BUCKET(@timestamp, 1 hour) | SORT b`;
const LIST = { op: 'kibana.dataViews.read', params: {} };
const getView = (id: string) => ({ op: 'kibana.dataViews.read', params: { id } });
const esql = (query: string) => ({ op: 'es.esql', params: { query } });

interface EsqlJson {
  columns: Array<{ name: string; type: string }>;
  values: unknown[][];
}
const resultOf = <T>(response: { json: unknown }): T | undefined =>
  (response.json as { ok?: boolean; result?: T } | undefined)?.result;

/** Executes `operation` on `held` and returns the code, audit reason and result. */
const call = async <T = Record<string, unknown>>(
  ctx: SuiteContext,
  held: TestSession,
  operation: { op: string }
) => {
  const from = readLines(AUDIT_LOG).length;
  const response = await execute(ctx, held, operation);
  await sleep(250);
  const record = lastRecord(from, held.user, operation.op);
  return {
    code: codeOf(response),
    reason: record?.event?.reason as string | undefined,
    keyId: record?.api_key?.id as string | undefined,
    result: resultOf<T>(response),
    text: response.text,
  };
};

const withoutDiscover = (manifest: Record<string, unknown>) => {
  const ui = manifest.ui as { scopes: string[] };
  ui.scopes = ui.scopes.filter((scope) => scope !== 'kibana.dataViews.read' && scope !== 'es.esql');
  const permissions = manifest.permissions as { indices: string[] };
  permissions.indices = permissions.indices.filter((index) => !index.startsWith('kbn-apps-demo-'));
};

const withoutDataViewsScope = (manifest: Record<string, unknown>) => {
  const ui = manifest.ui as { scopes: string[] };
  ui.scopes = ui.scopes.filter((scope) => scope !== 'kibana.dataViews.read');
};

const ensureDiscover = async (ctx: SuiteContext) => {
  if (ctx.currentEntry !== 'ui/src/main.ts' || !ctx.current?.ui.scopes.includes('es.esql')) {
    await release(ctx);
  }
};

/** Direct ES|QL as the local admin (superuser): ground truth for the bridge results. */
const adminEsql = async (ctx: SuiteContext, query: string) =>
  (
    await http(`${ctx.es}/_query`, {
      method: 'POST',
      auth: ctx.adminAuth,
      body: { query },
    })
  ).body as EsqlJson;

const hasSecret = (result: EsqlJson | undefined) =>
  JSON.stringify(result ?? '').includes(DEMO.secretMarker);

// ---------------------------------------------------------------- D1
export const runD1 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'D1';
  // Release flow: an approved release without the Discover grant, then the Discover release
  // approved with the same tooling (no Kibana restart); the viewer must consent again.
  await release(ctx, { mutate: withoutDiscover, label: 'Digest pre-Discover' });
  const before = await mint(ctx, users.viewer);
  const beforeEsql = await call(ctx, before, esql(ROWS_QUERY));
  await release(ctx, { label: 'Digest + Mini Discover' });
  await sleep(STATE_CACHE_WAIT_MS);
  const staleAfter = await call(ctx, before, esql(ROWS_QUERY));
  report.expect(
    T,
    'release without the Discover scopes refuses es.esql; the approved Discover release (no restart) needs a new consent (old handle app_stale)',
    HTTP,
    beforeEsql.code === 'app_denied' &&
      beforeEsql.reason === 'scope_not_granted' &&
      staleAfter.code === 'app_stale',
    { before: beforeEsql.code, beforeReason: beforeEsql.reason, oldHandleAfter: staleAfter.code }
  );

  const held = await mint(ctx, users.viewer);
  const list = await call<{ dataViews: Array<Record<string, unknown>> }>(ctx, held, LIST);
  const demoView = list.result?.dataViews.find((view) => view.id === DEMO.dataViewId);
  report.expect(
    T,
    'listDataViews as the key: the demo data view, projected to {id,name,title,timeFieldName}',
    HTTP,
    list.code === 'ok' &&
      JSON.stringify(demoView) ===
        JSON.stringify({
          id: DEMO.dataViewId,
          name: 'Demo logs',
          title: DEMO.dataViewTitle,
          timeFieldName: '@timestamp',
        }),
    { code: list.code, dataViews: list.result?.dataViews.map((view) => view.id) }
  );
  const view = await call<{ fields: Array<Record<string, unknown>> } & Record<string, unknown>>(
    ctx,
    held,
    getView(DEMO.dataViewId)
  );
  const fieldNames = (view.result?.fields ?? []).map((field) => field.name);
  const level = view.result?.fields.find((field) => field.name === 'log.level');
  report.expect(
    T,
    'getDataView as the key: exact keys and the demo fields (field caps run as the key)',
    HTTP,
    view.code === 'ok' &&
      JSON.stringify(Object.keys(view.result ?? {})) ===
        JSON.stringify(['id', 'name', 'title', 'timeFieldName', 'fields']) &&
      ['@timestamp', 'log.level', 'message', 'service.name'].every((name) =>
        fieldNames.includes(name)
      ) &&
      JSON.stringify(level) ===
        JSON.stringify({
          name: 'log.level',
          type: 'string',
          esTypes: ['keyword'],
          aggregatable: true,
          searchable: true,
        }),
    { code: view.code, fields: fieldNames, level }
  );
  const rows = await call<EsqlJson>(ctx, held, esql(ROWS_QUERY));
  const truth = await adminEsql(ctx, ROWS_QUERY);
  const messageAt = rows.result?.columns.findIndex(({ name }) => name === 'message') ?? -1;
  const messages = (rows.result?.values ?? []).map((row) => row[messageAt]);
  report.expect(
    T,
    `ES|QL rows as the key: 50 rows equal to a direct superuser query, attacker strings returned verbatim`,
    HTTP,
    rows.code === 'ok' &&
      rows.result?.values.length === 50 &&
      JSON.stringify(rows.result?.values) === JSON.stringify(truth.values) &&
      DEMO.hostileMessages.every((message) => messages.includes(message)) &&
      !hasSecret(rows.result),
    { code: rows.code, rows: rows.result?.values.length, columns: rows.result?.columns }
  );
  const histogram = await call<EsqlJson>(ctx, held, esql(HISTOGRAM_QUERY));
  const histogramTruth = await adminEsql(ctx, HISTOGRAM_QUERY);
  const total = (histogram.result?.values ?? []).reduce((sum, row) => sum + Number(row[0]), 0);
  report.expect(
    T,
    `histogram as the key: hourly buckets equal to a direct superuser query, counts sum to ${DOCS}`,
    HTTP,
    histogram.code === 'ok' &&
      (histogram.result?.values.length ?? 0) >= 24 &&
      JSON.stringify(histogram.result?.values) === JSON.stringify(histogramTruth.values) &&
      total === DOCS,
    { code: histogram.code, buckets: histogram.result?.values.length, total }
  );
  // Structural bounds: 4 KiB query, 500 rows. ES-native refusal of cluster-level commands.
  const padded = (bytes: number) => {
    const base = `FROM ${DEMO.dataViewTitle} | LIMIT 1 // `;
    return `${base}${'x'.repeat(bytes - base.length)}`;
  };
  const atLimit = await call(ctx, held, esql(padded(4096)));
  const overLimit = await call(ctx, held, esql(padded(4097)));
  const tooMany = await call(ctx, held, esql(`FROM ${DEMO.dataViewTitle} | LIMIT 501`));
  const enrich = await call(ctx, held, esql(`FROM ${DEMO.dataViewTitle} | ENRICH any_policy`));
  report.expect(
    T,
    'bounds: a 4,096-byte query runs, 4,097 bytes → bridge_invalid_request; LIMIT 501 with 480 matching docs runs; ENRICH refused by ES (empty cluster)',
    HTTP,
    atLimit.code === 'ok' &&
      overLimit.code === 'bridge_invalid_request' &&
      tooMany.code === 'ok' &&
      enrich.code === 'app_denied' &&
      enrich.reason === 'native_denied',
    {
      atLimit: atLimit.code,
      overLimit: overLimit.code,
      limit501: tooMany.code,
      enrich: [enrich.code, enrich.reason],
    }
  );
  const rowCap = await call(
    ctx,
    held,
    esql(`FROM ${DEMO.dataViewTitle} | EVAL n = [1, 2] | MV_EXPAND n | LIMIT 501`)
  );
  report.expect(
    T,
    'row cap: 501 rows → app_unavailable (no partial result)',
    HTTP,
    rowCap.code === 'app_unavailable' && rowCap.reason === 'invalid_result',
    { code: rowCap.code, reason: rowCap.reason }
  );

  // Browser: the tile in each engine, with a screenshot.
  const histogramBuckets = histogramTruth.values.length;
  for (const engine of ctx.engines) {
    await report.guard(T, 'browser', engine, async () => {
      const s = await session(ctx, engine, users.viewer);
      try {
        const child = await openBound(s.page, ctx);
        await pollFrame(child, () =>
          Number(document.getElementById('discover')?.getAttribute('data-views') ?? 0) >= 2
            ? true
            : undefined
        );
        await child.locator('#dv-picker').selectOption(DEMO.dataViewId);
        const state = await pollFrame(child, () => {
          const tile = document.getElementById('discover');
          if (!tile?.getAttribute('data-rows') || !tile.getAttribute('data-buckets')) {
            return tile?.getAttribute('data-error')
              ? { error: tile.getAttribute('data-error') }
              : undefined;
          }
          const table = document.getElementById('esql-results');
          return {
            rows: Number(tile.getAttribute('data-rows')),
            buckets: Number(tile.getAttribute('data-buckets')),
            bucketTotal: Number(tile.getAttribute('data-bucket-total')),
            fields: Number(tile.getAttribute('data-fields')),
            query: (document.getElementById('esql-query') as HTMLTextAreaElement).value,
            tableText: table?.textContent ?? '',
            markup: table?.querySelectorAll('img,script,svg,iframe,object').length ?? -1,
            bars: document.querySelectorAll('#esql-chart .bar').length,
            error: tile.getAttribute('data-error'),
          };
        });
        const pwned = await s.page.evaluate(() => document.body.textContent === 'PWN');
        report.expect(
          T,
          'tile: data view picked, fields listed, prefilled query, 50 rows and the hourly chart; attacker strings rendered as text only',
          engine,
          state.rows === 50 &&
            state.buckets === histogramBuckets &&
            state.bars === histogramBuckets &&
            state.bucketTotal === DOCS &&
            (state.fields ?? 0) >= 4 &&
            state.query === ROWS_QUERY &&
            DEMO.hostileMessages.every((message) => state.tableText?.includes(message)) &&
            state.markup === 0 &&
            !pwned &&
            !state.error,
          { ...state, tableText: undefined, pwned }
        );
        await s.page.evaluate(() => document.querySelector('iframe')?.scrollIntoView());
        await sleep(300);
        const shot = join(LOCAL_DIR, `discover-${engine}.png`);
        await s.page.screenshot({ path: shot });
        // Edited query via the Run button, then a query outside the grant.
        await child
          .locator('#esql-query')
          .fill(`FROM ${DEMO.dataViewTitle} | WHERE log.level == "error" | LIMIT 10`);
        await child.locator('#esql-run').click();
        const edited = await pollFrame(
          child,
          () => document.getElementById('discover')?.getAttribute('data-rows') ?? undefined
        );
        // Large results cross the bridge in one frame (~900 KB of a 1 MiB frame);
        // past the 960 KiB result cap the host refuses with the uniform code.
        const large = async (repeat: number) => {
          await child
            .locator('#esql-query')
            .fill(
              `FROM ${DEMO.dataViewTitle} | EVAL n = [1, 2] | MV_EXPAND n | EVAL pad = REPEAT("x", ${repeat}) | KEEP pad | LIMIT 500`
            );
          await child.locator('#esql-run').click();
          return pollFrame(child, () => {
            const tile = document.getElementById('discover');
            const rowCount = tile?.getAttribute('data-rows');
            const error = tile?.getAttribute('data-error');
            return rowCount || error ? { rows: rowCount, error } : undefined;
          });
        };
        const largeOk = await large(1800);
        const largeOver = await large(2000);
        await child.locator('#esql-query').fill(`FROM ${DEMO.secretIndex} | LIMIT 5`);
        await child.locator('#esql-run').click();
        const denied = await pollFrame(
          child,
          () => document.getElementById('discover')?.getAttribute('data-error') ?? undefined
        );
        const status = await child.evaluate(
          () => document.getElementById('esql-status')?.textContent ?? ''
        );
        const frameStatus = await s.page
          .locator('[data-test-subj="appHostFrameStatus"]')
          .innerText();
        report.expect(
          T,
          'Run: an edited query returns 10 rows; a ~900 KB / 500-row result renders; over 960 KiB and FROM the secret index show uniform codes; the session stays bound',
          engine,
          edited === '10' &&
            largeOk.rows === '500' &&
            largeOver.error === 'app_unavailable' &&
            denied === 'app_denied' &&
            status === 'esql: error app_denied' &&
            frameStatus === 'bound',
          { edited, largeOk, largeOver, denied, status, frameStatus, screenshot: shot }
        );
      } finally {
        await s.close();
      }
    });
  }
};

// ---------------------------------------------------------------- D2
export const runD2 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'D2';
  await ensureDiscover(ctx);
  const viewerDirect = await http(`${ctx.es}/_query`, {
    method: 'POST',
    auth: `${users.viewer.username}:${users.viewer.password}`,
    body: { query: `FROM ${DEMO.secretIndex} | LIMIT 10` },
  });
  report.expect(
    T,
    'control: the viewer can read the secret index directly in ES (5 rows)',
    HTTP,
    viewerDirect.status === 200 &&
      (viewerDirect.body as EsqlJson).values.length === DEMO.secretDocs,
    { status: viewerDirect.status, rows: (viewerDirect.body as EsqlJson).values?.length }
  );
  // Ground truth as the superuser: all documents in exactly the granted indices.
  const granted = Number(
    (
      await adminEsql(
        ctx,
        `FROM kbn-apps-prototype-alerts,${DEMO.dataViewTitle} | STATS c = COUNT(*)`
      )
    ).values[0][0]
  );
  for (const user of [users.viewer, users.superuser]) {
    const held = await mint(ctx, user);
    const list = await call<{ dataViews: Array<{ id: string }> }>(ctx, held, LIST);
    report.expect(
      T,
      `${user.username}: the secret data view is visible through listDataViews (saved-object privileges are per type)`,
      HTTP,
      list.code === 'ok' &&
        (list.result?.dataViews ?? []).some(({ id }) => id === DEMO.secretDataViewId),
      { code: list.code, dataViews: list.result?.dataViews.map(({ id }) => id) }
    );
    const secretView = await call(ctx, held, getView(DEMO.secretDataViewId));
    report.add(T, `${user.username}: getDataView on the secret data view`, HTTP, 'DIAGNOSTIC', {
      code: secretView.code,
      reason: secretView.reason,
      fields: (secretView.result as { fields?: unknown[] } | undefined)?.fields?.length,
      containsSecret: secretView.text.includes(DEMO.secretMarker),
    });
    const only = await call<EsqlJson>(ctx, held, esql(`FROM ${DEMO.secretIndex} | LIMIT 10`));
    report.expect(
      T,
      `${user.username}: FROM ${DEMO.secretIndex} refused by ES (400 "Unknown index", same as a missing index), no data`,
      HTTP,
      only.code === 'app_denied' &&
        only.reason === 'native_rejected' &&
        !only.text.includes(DEMO.secretMarker),
      { code: only.code, reason: only.reason }
    );
    const mixed = await call<EsqlJson>(
      ctx,
      held,
      esql(`FROM kbn-apps-demo-*,${DEMO.secretIndex} | LIMIT 500`)
    );
    report.expect(
      T,
      `${user.username}: FROM kbn-apps-demo-*,${DEMO.secretIndex} → 403 from ES (native_denied), no secret rows`,
      HTTP,
      mixed.code === 'app_denied' &&
        mixed.reason === 'native_denied' &&
        !mixed.text.includes(DEMO.secretMarker),
      { code: mixed.code, reason: mixed.reason }
    );
    const wildcard = await call<EsqlJson>(ctx, held, esql('FROM kbn-apps-* | LIMIT 500'));
    report.expect(
      T,
      `${user.username}: FROM kbn-apps-* resolves only the granted indices (demo + alerts), no secret rows`,
      HTTP,
      wildcard.code === 'ok' &&
        wildcard.result?.values.length === granted &&
        !hasSecret(wildcard.result),
      {
        code: wildcard.code,
        rows: wildcard.result?.values.length,
        grantedRows: granted,
        secret: hasSecret(wildcard.result),
      }
    );
  }
};

// ---------------------------------------------------------------- D3
export const runD3 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'D3';
  await ensureDiscover(ctx);
  const noIndex = await mint(ctx, users.noIndex);
  const noIndexEsql = await call<EsqlJson>(ctx, noIndex, esql(ROWS_QUERY));
  const noIndexKey = noIndexEsql.keyId ? await keyById(ctx, noIndexEsql.keyId) : undefined;
  report.expect(
    T,
    'viewer without index read on the demo indices: ES refuses although the key grants the pattern',
    HTTP,
    noIndexEsql.code === 'app_denied' &&
      (noIndexEsql.reason === 'native_denied' || noIndexEsql.reason === 'native_rejected') &&
      JSON.stringify(noIndexKey?.role_descriptors?.app?.indices ?? []).includes(DEMO.dataViewTitle),
    { code: noIndexEsql.code, reason: noIndexEsql.reason }
  );
  const noViews = await mint(ctx, users.noDataViews);
  const noViewsList = await call<{ dataViews: unknown[] }>(ctx, noViews, LIST);
  const noViewsGet = await call(ctx, noViews, getView(DEMO.dataViewId));
  const noViewsEsql = await call<EsqlJson>(ctx, noViews, esql(ROWS_QUERY));
  report.expect(
    T,
    'viewer without the data view feature: Kibana returns no data views (saved-object find filters the type) and refuses getDataView natively (400 "Unable to bulk_get index-pattern"); ES|QL still works',
    HTTP,
    noViewsList.code === 'ok' &&
      noViewsList.result?.dataViews.length === 0 &&
      noViewsGet.code === 'app_denied' &&
      noViewsGet.reason === 'native_rejected' &&
      noViewsEsql.code === 'ok',
    {
      list: [noViewsList.code, noViewsList.result?.dataViews.length],
      get: [noViewsGet.code, noViewsGet.reason],
      esql: noViewsEsql.code,
    }
  );
  // Native check with Kibana's scope check out of the way: a key with exactly the manifest's
  // descriptor (granted from the superuser's password) calls the Data Views API directly.
  const nativeWithKey = async () => {
    const known = await knownKeySession(ctx, users.superuser);
    const apiKey = `ApiKey ${Buffer.from(`${known.key.id}:${known.key.secret}`).toString(
      'base64'
    )}`;
    const direct = async (path: string) => {
      const response = await fetch(`${ctx.kibana}${path}`, {
        headers: { authorization: apiKey, 'elastic-api-version': '2023-10-31' },
      });
      return {
        status: response.status,
        body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
      };
    };
    const list = await direct('/api/data_views');
    const get = await direct(`/api/data_views/data_view/${DEMO.dataViewId}`);
    const key = await keyById(ctx, known.key.id);
    await http(`${ctx.es}/_security/api_key`, {
      method: 'DELETE',
      auth: ctx.adminAuth,
      body: { ids: [known.key.id] },
    });
    return {
      applications: key?.role_descriptors?.app?.applications,
      listStatus: list.status,
      listed: (list.body.data_view as unknown[] | undefined)?.length,
      getStatus: get.status,
      getMessage: get.body.message,
    };
  };
  // 1. Without kibana.dataViews.read (Dashboard read kept): the bridge refuses the scope. Kibana's
  // Dashboard privilege also grants `index-pattern` read, so the key itself could still read them.
  await release(ctx, { mutate: withoutDataViewsScope, label: 'Digest without data views' });
  const superHeld = await mint(ctx, users.superuser);
  const superList = await call(ctx, superHeld, LIST);
  const superGet = await call(ctx, superHeld, getView(DEMO.dataViewId));
  const superEsql = await call(ctx, superHeld, esql(ROWS_QUERY));
  report.expect(
    T,
    'manifest without kibana.dataViews.read: superuser denied listDataViews and getDataView (ES|QL still granted)',
    HTTP,
    superList.code === 'app_denied' && superGet.code === 'app_denied' && superEsql.code === 'ok',
    {
      list: [superList.code, superList.reason],
      get: [superGet.code, superGet.reason],
      esql: superEsql.code,
    }
  );
  report.add(
    T,
    'finding: with kibana.dashboard.read kept, the key still reads data views natively (feature_dashboard_v2.read includes index-pattern read)',
    HTTP,
    'DIAGNOSTIC',
    await nativeWithKey()
  );
  // 2. Without both Kibana scopes: the key has no Kibana privilege and Kibana itself refuses it.
  await release(ctx, {
    mutate: (manifest) => {
      withoutDataViewsScope(manifest);
      const ui = manifest.ui as { scopes: string[] };
      ui.scopes = ui.scopes.filter((scope) => scope !== 'kibana.dashboard.read');
    },
    label: 'Digest without Kibana scopes',
  });
  const native = await nativeWithKey();
  report.expect(
    T,
    'manifest without kibana.dataViews.read and kibana.dashboard.read: a superuser-granted key gets no data views and a native refusal from Kibana',
    HTTP,
    JSON.stringify(native.applications) === '[]' &&
      native.listStatus === 200 &&
      native.listed === 0 &&
      native.getStatus === 400 &&
      native.getMessage === 'Unable to bulk_get index-pattern',
    native
  );
  await release(ctx);
};

// ---------------------------------------------------------------- D4
export const runD4 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'D4';
  await ensureDiscover(ctx);
  const files = logFiles();
  const sizes = Object.fromEntries(files.map((file) => [file, sizeOf(join(LOGS, file))]));
  const known = await knownKeySession(ctx, users.viewer);
  const responses: Surface[] = [];
  const step = async (
    name: string,
    operation: { op: string },
    accept: (code: string, text: string) => boolean,
    logged: (entries: EsQueryEntry[]) => boolean
  ) => {
    const offset = sizeOf(ES_QUERY_LOG);
    const response = await execute(ctx, known.held, operation);
    await sleep(500);
    responses.push({ where: `response ${name}`, text: response.text });
    const entries = esQueriesSince(offset);
    const ok = accept(codeOf(response), response.text);
    const fresh = entries !== undefined && logged(entries);
    report.add(
      T,
      `known key, ${name}: operation as expected and its outgoing ES request logged`,
      HTTP,
      entries === undefined ? 'NOT_VERIFIED' : ok && fresh ? 'PASS' : 'FAIL',
      { code: codeOf(response), esQueryEntries: entries?.length ?? 'missing log', matched: fresh }
    );
    return entries ?? [];
  };
  const has = (entries: EsQueryEntry[], pattern: RegExp) =>
    entries.some(({ message }) => pattern.test(message));
  await step(
    'listDataViews',
    LIST,
    (code, text) => code === 'ok' && text.includes(DEMO.dataViewId),
    (entries) => has(entries, /_has_privileges/)
  );
  await step(
    'getDataView',
    getView(DEMO.dataViewId),
    (code) => code === 'ok',
    (entries) => has(entries, /^200\b[\s\S]*\/_field_caps/)
  );
  const esqlEntries = await step(
    'esql',
    esql(ROWS_QUERY),
    (code) => code === 'ok',
    (entries) => has(entries, /^200\b[\s\S]*\/_query/)
  );
  await step(
    'esql refused by ES',
    esql(`FROM kbn-apps-demo-*,${DEMO.secretIndex} | LIMIT 5`),
    (code) => code === 'app_denied',
    (entries) => has(entries, /^403\b[\s\S]*\/_query/)
  );
  const redacted = esqlEntries
    .filter(({ message }) => /\/_query/.test(message))
    .map(({ authorization }) => authorization);
  report.expect(
    T,
    'outgoing /_query log entries: authorization present and [REDACTED]',
    HTTP,
    redacted.length > 0 && redacted.every((value) => value === '[REDACTED]'),
    { values: [...new Set(redacted.map(String))] }
  );
  const surfaces: Surface[] = [
    ...responses,
    ...files.map((file) => ({ where: file, text: readSince(join(LOGS, file), sizes[file]) })),
  ];
  const needles = credentialNeedles(known.key);
  const scan = scanSurfaces(surfaces, needles);
  report.add(
    T,
    'known key: no bare secret, id:secret or base64 credential in responses or any log (incl. elasticsearch.query debug)',
    HTTP,
    scan.status,
    { hits: scan.hits, missing: scan.missing, surfaces: surfaces.length }
  );
  const injected = scanSurfaces(
    [...surfaces, { where: 'injected', text: `x ${needles[0]} y` }],
    needles
  );
  report.expect(
    T,
    'negative control: an injected secret is caught',
    HTTP,
    injected.status === 'FAIL',
    {
      status: injected.status,
    }
  );
  await http(`${ctx.es}/_security/api_key`, {
    method: 'DELETE',
    auth: ctx.adminAuth,
    body: { ids: [known.key.id] },
  });
};

// ---------------------------------------------------------------- D5
export const runD5 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'D5';
  await ensureDiscover(ctx);
  const held = await mint(ctx, users.viewer);
  const ok = await call(ctx, held, esql(ROWS_QUERY));
  await sleep(1_200); // refresh=false: let the key become visible to name invalidation
  const revoked = await setAppEnabled(false, { esUrl: ctx.es });
  await sleep(STATE_CACHE_WAIT_MS);
  const disabled = await call(ctx, held, esql(ROWS_QUERY));
  const key = ok.keyId ? await keyById(ctx, ok.keyId) : undefined;
  await setAppEnabled(true, { esUrl: ctx.es });
  await sleep(STATE_CACHE_WAIT_MS);
  const after = await call(ctx, held, esql(ROWS_QUERY));
  const fresh = await call(ctx, await mint(ctx, users.viewer), esql(ROWS_QUERY));
  report.expect(
    T,
    'disable: next esql app_disabled, key invalidated; after re-enable the old handle is app_stale; a new consent works',
    HTTP,
    ok.code === 'ok' &&
      disabled.code === 'app_disabled' &&
      key?.invalidated === true &&
      (revoked?.errors ?? 1) === 0 &&
      after.code === 'app_stale' &&
      fresh.code === 'ok',
    {
      before: ok.code,
      afterDisable: disabled.code,
      keyInvalidated: key?.invalidated,
      afterEnable: after.code,
      newConsent: fresh.code,
    }
  );
  await invalidateAppKeys({ esUrl: ctx.es, appId: 'alert-digest' }).catch(() => undefined);
};

/** D1–D5 (`--suites discover`). */
export const runD = async (ctx: SuiteContext) => {
  for (const [name, run] of [
    ['D1', runD1],
    ['D2', runD2],
    ['D3', runD3],
    ['D4', runD4],
    ['D5', runD5],
  ] as const) {
    await ctx.report.guard(name, 'suite', 'all', () => run(ctx));
  }
};
