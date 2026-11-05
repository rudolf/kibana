/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// U3 suites: T3 XSS and the compromised-UI demo, T4 egress channels (blocked / known-leak /
// not-verified / controls), T8 revoke/update/v2 without restart (S10), T10 attribution (S9, S11).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Frame, Page } from '@playwright/test';
import { approveRelease, setAppEnabled } from '../approval';
import { LOCAL_DIR } from '../secrets';
import { DASHBOARD_TITLE, HOSTILE_RULE } from '../ui_seed_state';
import {
  childFrame,
  frameStatus,
  openAndAllow,
  pollFrame,
  sleep,
  waitForChild,
  waitForStatus,
} from '../ui_harness';
import { jestEvidence, kfetch, release, session, type SuiteContext } from './context';
import { ensureHostile, waitProbe } from './t5_t6_browser';
import {
  apiHeaders,
  codeOf,
  createSession,
  dispatcherConnections,
  execute,
  httpDebugMark,
  httpDebugSince,
  readPanels,
  type TestSession,
} from './u2_authority';

const AUDIT_LOG = join(LOCAL_DIR, 'logs', 'app_host_audit.ndjson');
const KIBANA_AUDIT_LOG = join(LOCAL_DIR, 'logs', 'kibana_audit.ndjson');
const auditLines = (file = AUDIT_LOG): string[] =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
const auditRecords = (file = AUDIT_LOG) =>
  auditLines(file).map((line) => JSON.parse(line) as Record<string, any>);

interface RunProbe {
  __probe: { run: Record<string, (marker: string) => unknown> };
}

export const runIn = (child: Frame, name: string, marker: string): Promise<unknown> =>
  child
    .evaluate(([fn, m]) => (window as unknown as RunProbe).__probe.run[fn](m), [
      name,
      marker,
    ] as const)
    .catch((error) => `evaluate-ended:${String(error).slice(0, 60)}`);

/** Records every window/port postMessage payload (all frames) for the secret-canary check. */
export const POST_RECORDER = `(() => {
  const seen = [];
  Object.defineProperty(window, '__posted', { value: seen });
  const record = (value) => { try { seen.push(typeof value === 'string' ? value.slice(0, 4096) : JSON.stringify(value)); } catch (e) { seen.push('[unserializable]'); } };
  const windowPost = Window.prototype.postMessage;
  Window.prototype.postMessage = function (message, ...rest) { record(message); return windowPost.call(this, message, ...rest); };
  const portPost = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (message, ...rest) { record(message); return portPost.call(this, message, ...rest); };
})();`;

/** Disable via the trusted chrome (the parent drops its handle) before reloading a page. */
const disableFrame = async (page: Page) => {
  const disable = page.locator('[data-test-subj="appHostDisable"]');
  if (await disable.isEnabled({ timeout: 500 }).catch(() => false)) {
    await disable.click({ timeout: 1000 }).catch(() => undefined);
  }
};

const legacyReader = (): { username: string; password: string } | undefined => {
  const file = join(LOCAL_DIR, 'users.json');
  return existsSync(file)
    ? (
        JSON.parse(readFileSync(file, 'utf8')) as {
          reader?: { username: string; password: string };
        }
      ).reader
    : undefined;
};

export const openBound = async (page: Page, ctx: SuiteContext) => {
  await openAndAllow(page, ctx.kibana);
  await waitForStatus(page, /^bound$/);
  return waitForChild(page);
};

// ---------------------------------------------------------------- T3
export const runT3 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'T3';
  const canaryTitle = '<img src=x onerror=alert(1)>Alert <b>digest</b>';
  await release(ctx, { mutate: (manifest) => (manifest.title = canaryTitle) });
  for (const engine of ctx.engines) {
    await report.guard(T, 'normal', engine, async () => {
      const s = await session(ctx, engine, users.viewer);
      try {
        const dialogs: string[] = [];
        s.page.on('dialog', (dialog) => {
          dialogs.push(dialog.message());
          dialog.dismiss().catch(() => undefined);
        });
        await s.page.goto(`${ctx.kibana}/app/appHost/alert-digest`);
        await s.page.locator('[data-test-subj="appHostUiTitle"]').waitFor({ timeout: 120_000 });
        const chrome = await s.page.evaluate(() => {
          const title = document.querySelector('[data-test-subj="appHostUiTitle"]') as HTMLElement;
          return { text: title.textContent, imgs: title.querySelectorAll('img,b').length };
        });
        report.expect(
          T,
          'S10 package title with markup renders literally in host chrome',
          engine,
          chrome.text === canaryTitle && chrome.imgs === 0,
          chrome
        );
        const child = await openBound(s.page, ctx);
        const panels = await readPanels(child);
        report.expect(
          T,
          'normal sample: hostile ES rule and dashboard title shown as literal text',
          engine,
          String(panels.records).includes(HOSTILE_RULE) &&
            panels.dashboard === DASHBOARD_TITLE &&
            panels.imgs === 0 &&
            !(await s.page.locator('body').innerText()).startsWith('PWN') &&
            dialogs.length === 0,
          { panels, dialogs }
        );
      } finally {
        await s.close();
      }
    });
  }
  await ensureHostile(ctx);
  for (const engine of ctx.engines) {
    await report.guard(T, 'hostile', engine, async () => {
      const auditBefore = auditLines().length;
      const s = await session(ctx, engine, users.viewer);
      try {
        const child = await openBound(s.page, ctx);
        const probe = await waitProbe(child);
        const b = probe.bridge;
        // Honest compromised-UI demo: permitted reads succeed for hostile code too.
        report.add(
          T,
          'compromised UI: successful permitted bridge reads (disclosed to app code)',
          engine,
          b.summary?.startsWith('ok') && b.search?.startsWith('ok') && b.dashboard?.startsWith('ok')
            ? 'PASS'
            : 'FAIL',
          {
            summary: b.summary?.slice(0, 80),
            search: b.search?.slice(0, 80),
            dashboard: b.dashboard?.slice(0, 120),
          }
        );
        report.expect(
          T,
          'compromised UI: out-of-grant and non-delegable attempts denied with their exact codes',
          engine,
          b.otherIndex === 'err:bridge_invalid_request' &&
            b.ungrantedDashboard === 'err:app_denied' &&
            b.unknownMethod === 'err:app_unavailable',
          {
            otherIndex: b.otherIndex,
            ungrantedDashboard: b.ungrantedDashboard,
            unknownMethod: b.unknownMethod,
          }
        );
        const violations = await child.evaluate(
          () => (window as unknown as { __probe: { violations: string[] } }).__probe.violations
        );
        report.expect(
          T,
          'unsafe renderer: inline handler blocked by CSP (violation observed), parent DOM unchanged',
          engine,
          probe.results.inlineHandler === 'blocked' &&
            violations.some((v) => /^script-src(-attr|-elem)?\|inline/.test(v)) &&
            (probe.results.parentBodyWrite ?? '').startsWith('blocked') &&
            !(await s.page.locator('body').innerText()).startsWith('PWN'),
          {
            inlineHandler: probe.results.inlineHandler,
            inlineViolations: violations.filter((v) => /\|inline/.test(v)),
          }
        );
        await sleep(1000);
        const records = auditLines()
          .slice(auditBefore)
          .map((line) => JSON.parse(line) as Record<string, any>);
        const mine = records.filter((r) => r.user?.name === users.viewer.username);
        const permitted = mine.filter(
          (r) => r.event?.outcome === 'success' && r.app?.via === 'bridge'
        );
        report.expect(
          T,
          'permitted hostile reads are attributed to the app in server audit',
          engine,
          ['app.summary', 'es.search', 'kibana.dashboard.read'].every((cap) =>
            permitted.some((r) => r.app?.capability === cap && r.app?.id === 'alert-digest')
          ),
          { capabilities: permitted.map((r) => r.app?.capability) }
        );
        // The hostile run's out-of-grant attempts (other index, ungranted dashboard, unknown method)
        // are refused by the parent and never reach the server: no failure records, while the
        // permitted reads above (positive control) are recorded.
        const serverFailures = mine.filter(
          (r) => r.event?.outcome === 'failure' && r.app?.via === 'bridge'
        );
        report.expect(
          T,
          'local-only parent rejections are not server audit events (permitted reads are)',
          engine,
          permitted.length >= 3 && serverFailures.length === 0,
          {
            permitted: permitted.length,
            serverFailures: serverFailures.map((r) => r.event?.reason),
          }
        );
      } finally {
        await s.close();
      }
    });
    await report.guard(T, 'bridge abuse corpus', engine, () => runBridgeCorpus(ctx, engine));
  }
};

/** Expected public code for each named abuse case (asserted exactly). */
const ABUSE_EXPECTED: Record<string, string> = {
  otherRoute: 'err:bridge_invalid_request',
  traversal: 'err:bridge_invalid_request',
  encodedPath: 'err:bridge_invalid_request',
  queryTrick: 'err:bridge_invalid_request',
  postMethod: 'err:bridge_invalid_request',
  otherIndex: 'err:bridge_invalid_request',
  auditIndex: 'err:bridge_invalid_request',
  wildcard: 'err:bridge_invalid_request',
  extraField: 'err:bridge_invalid_request',
  functionArg: 'err:bridge_invalid_request',
  thenableArg: 'err:bridge_invalid_request',
  ungrantedDashboard: 'err:app_denied',
  unknownMethod: 'err:app_unavailable',
};
// The hostile auto-run already makes 1 invalid call (other index), so at most 6 more per frame (the
// 8th invalid call terminates by design). Each batch ends with a positive control proving the
// session was still open, so no case is "passed" by a dead session.
const ABUSE_BATCHES: string[][] = [
  ['otherRoute', 'traversal', 'encodedPath', 'queryTrick', 'postMethod', 'otherIndex'],
  [
    'auditIndex',
    'wildcard',
    'extraField',
    'functionArg',
    'thenableArg',
    'ungrantedDashboard',
    'unknownMethod',
  ],
];
const RAW_NAMES = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];

const runBridgeCorpus = async (ctx: SuiteContext, engine: string) => {
  const { report, users } = ctx;
  const T = 'T3';
  const s = await session(ctx, engine, users.viewer);
  try {
    const executes: string[] = [];
    s.page.on('request', (request) => {
      if (/\/internal\/app_host\/ui\/execute$/.test(request.url())) executes.push(request.url());
    });
    for (const [index, batch] of ABUSE_BATCHES.entries()) {
      if (index > 0) {
        await disableFrame(s.page);
        await s.page.reload();
      }
      const child = await openBound(s.page, ctx);
      await waitProbe(child);
      const executesBefore = executes.length;
      for (const name of batch) {
        const result = String(await runIn(child, 'bridgeCase', name));
        report.expect(
          T,
          `bridge abuse: ${name} → ${ABUSE_EXPECTED[name]}`,
          engine,
          result === ABUSE_EXPECTED[name],
          { result }
        );
      }
      const alive = String(await runIn(child, 'bridgeCase', 'alive'));
      report.expect(
        T,
        `bridge abuse batch ${
          index + 1
        }: no server call; session still open afterwards (positive control)`,
        engine,
        executes.length === executesBefore &&
          alive.startsWith('ok:') &&
          (await frameStatus(s.page)) === 'bound',
        { executes: executes.length - executesBefore, alive: alive.slice(0, 40) }
      );
      if (index === ABUSE_BATCHES.length - 1) {
        // Raw protocol frames naming Object/prototype members: each rejected with a fixed code.
        const result = await runIn(child, 'rawProtocolNames', '');
        const pairs = Array.isArray(result) ? (result as Array<[string, string]>) : [];
        for (const name of RAW_NAMES) {
          const found = pairs.find(([key]) => key === name);
          const reply =
            typeof found?.[1] === 'string'
              ? found[1]
              : `missing (${typeof result === 'string' ? result.slice(0, 60) : 'no result'})`;
          report.expect(
            T,
            `bridge abuse (raw frame): ${name} → reject app_unavailable, no stack`,
            engine,
            reply.startsWith('["reject"') &&
              reply.includes('app_unavailable') &&
              // V8 (`at fn (file:1:2)`) and Firefox/WebKit (`fn@url:1:2`) stack formats.
              !/\sat\s|\.ts:|@https?:|\.js:\d/.test(reply),
            { reply, frame: await frameStatus(s.page) }
          );
        }
        report.expect(
          T,
          'bridge abuse (raw frames): no server call',
          engine,
          executes.length === executesBefore
        );
      }
    }
    // Intentional termination: the 8th invalid call ends the session.
    await disableFrame(s.page);
    await s.page.reload();
    const child = await openBound(s.page, ctx);
    await waitProbe(child);
    // 1 invalid call in the auto-run + 6 here = 7 tolerated; the next one is the 8th.
    const results: string[] = [];
    for (let i = 0; i < 6; i++)
      results.push(String(await runIn(child, 'bridgeCase', 'otherRoute')));
    const statusBefore = await frameStatus(s.page);
    results.push(String(await runIn(child, 'bridgeCase', 'otherRoute')));
    await waitForStatus(s.page, /ended: protocol_error/, 10_000).catch(() => undefined);
    report.expect(
      T,
      'bridge abuse: 7 invalid calls tolerated (1 auto-run + 6), the 8th terminates the session (repeated_invalid_calls)',
      engine,
      statusBefore === 'bound' &&
        results.slice(0, 6).every((r) => r === 'err:bridge_invalid_request') &&
        /ended: protocol_error \(repeated_invalid_calls\)/.test(await frameStatus(s.page)),
      { statusBefore, statusAfter: await frameStatus(s.page), eighth: results[6]?.slice(0, 60) }
    );
  } finally {
    await s.close();
  }
};

// ---------------------------------------------------------------- T8
/** Handles minted by the page (the parent's session POST responses), for server-side checks. */
const handlesFromResponses = (page: Page) => {
  const handles: string[] = [];
  page.on('response', async (response) => {
    if (
      response.request().method() === 'POST' &&
      /\/internal\/app_host\/ui\/session$/.test(response.url())
    ) {
      const body = (await response.json().catch(() => undefined)) as
        | { handle?: string }
        | undefined;
      if (body?.handle) handles.push(body.handle);
    }
  });
  return handles;
};

/** Longer than the server's 2 s enablement/approval cache. */
const STATE_CACHE_WAIT_MS = 2_100;

/** A user-initiated call from the sample UI (its Refresh button): the next bridge call. */
const refreshFromFrame = async (page: Page) => {
  const child = childFrame(page);
  await child
    ?.locator('#refresh-summary')
    .click({ timeout: 5000 })
    .catch(() => undefined);
};

const kibanaRestarts = () =>
  readFileSync(join(LOCAL_DIR, 'logs', process.env.KIBANA_LOG ?? 'kibana4.log'), 'utf8').match(
    /Kibana is now available/g
  )?.length ?? 0;
const wranglerReloads = () =>
  existsSync(join(LOCAL_DIR, 'logs', 'wrangler.log'))
    ? readFileSync(join(LOCAL_DIR, 'logs', 'wrangler.log'), 'utf8').match(/Reloading|Ready on/g)
        ?.length ?? 0
    : -1;

export const runT8 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'T8';
  await release(ctx, { label: 'Digest v1', serverLabel: 'Server v1' });
  for (const engine of ctx.engines) {
    await report.guard(T, 'flow', engine, async () => {
      const s = await session(ctx, engine, users.viewer);
      try {
        const { page } = s;
        const handles = handlesFromResponses(page);
        await openBound(page, ctx);
        await sleep(500);
        const held: TestSession = { user: users.viewer, handle: handles[handles.length - 1] };
        // 1. Operator disable (state flip, then key invalidation): the held handle fails on the
        // next call and the parent tears the frame down on that rejection (no polling).
        const revoked = await setAppEnabled(false, { esUrl: ctx.es });
        await sleep(STATE_CACHE_WAIT_MS);
        const next = await execute(ctx, held, { op: 'app.summary' });
        await refreshFromFrame(page);
        await waitForStatus(page, /ended: disabled|ended: stale/, 10_000).catch(() => undefined);
        report.expect(
          T,
          'disable: held handle rejected on next call; frame removed on the next bridge call',
          engine,
          // ES invalidation is cleanup: a key minted < 1 s earlier (refresh=false) may not be
          // found by name yet; the raised generation refuses its handle regardless.
          codeOf(next) === 'app_disabled' &&
            (await page.locator('[data-test-subj="appHostGuardianFrame"]').count()) === 0,
          { next: codeOf(next), invalidated: revoked?.invalidated, status: await frameStatus(page) }
        );
        await setAppEnabled(true, { esUrl: ctx.es });
        await sleep(STATE_CACHE_WAIT_MS);
        // 2. Tampered UI bytes under the approved digest filename → 404, no script executes.
        const assetPath = join(ctx.packageDir, `${ctx.current?.ui.digest}.js`);
        const original = readFileSync(assetPath, 'utf8');
        writeFileSync(assetPath, `${original}\n;document.title='tampered';`);
        try {
          const asset = await kfetch(ctx, `/api/app_host/ui_assets/${ctx.current?.ui.digest}.js`);
          await disableFrame(page);
          await page.reload();
          await openAndAllow(page, ctx.kibana);
          await waitForStatus(page, /^bound$/);
          const child = await waitForChild(page);
          await sleep(3000);
          const ran = await child
            .evaluate(() => Boolean(document.getElementById('ui-version')))
            .catch(() => false);
          report.expect(
            T,
            'tampered UI asset under old digest name: 404, no app script executes',
            engine,
            asset.status === 404 && !ran,
            { asset: asset.status, uiRan: ran }
          );
        } finally {
          writeFileSync(assetPath, original);
        }
        // 3. Unapproved new code (same scopes): old handle stale, no auto-mount.
        await disableFrame(page);
        await page.reload();
        const v1Child = await openBound(page, ctx);
        await readPanels(v1Child);
        const v1: TestSession = { user: users.viewer, handle: handles[handles.length - 1] };
        const restartsBefore = kibanaRestarts();
        const reloadsBefore = wranglerReloads();
        const dispatcherBefore = dispatcherConnections();
        await release(ctx, { label: 'Digest v2', serverLabel: 'Server v2', approve: false });
        await sleep(STATE_CACHE_WAIT_MS);
        const stale = await execute(ctx, v1, { op: 'app.summary' });
        await refreshFromFrame(page);
        await waitForStatus(page, /ended: stale/, 10_000).catch(() => undefined);
        await sleep(1000);
        const allowEnabled = await page
          .locator('[data-test-subj="appHostAllowVersion"]')
          .isEnabled();
        report.expect(
          T,
          'unapproved v2 (same scopes): old handle app_stale, frame removed on the next call, not auto-mounted',
          engine,
          codeOf(stale) === 'app_stale' &&
            (await page.locator('[data-test-subj="appHostGuardianFrame"]').count()) === 0 &&
            !allowEnabled,
          { stale: codeOf(stale), allowEnabled }
        );
        // 4. Operator approves v2: S10 — no v1 frame while the v2 prompt is visible; explicit click needed.
        await approveRelease({
          manifest: ctx.current as never,
          esUrl: ctx.es,
          kbUrl: ctx.kibana,
          esAuth: ctx.adminAuth,
          kbAuth: ctx.adminAuth,
        });
        // No polling: the next page load reads the new metadata.
        await page.reload();
        await page.locator('[data-test-subj="appHostAllowVersion"]').waitFor();
        await page.waitForFunction(
          () =>
            !(document.querySelector('[data-test-subj="appHostAllowVersion"]') as HTMLButtonElement)
              .disabled,
          undefined,
          { timeout: 15_000 }
        );
        await page.waitForFunction(
          (version) =>
            document.querySelector('[data-test-subj="appHostUiVersion"]')?.textContent === version,
          ctx.current?.version,
          { timeout: 15_000 }
        );
        const promptState = await page.evaluate(() => ({
          frames: document.querySelectorAll('[data-test-subj="appHostGuardianFrame"]').length,
          allow: !(
            document.querySelector('[data-test-subj="appHostAllowVersion"]') as HTMLButtonElement
          ).disabled,
        }));
        report.expect(
          T,
          'S10: v2 prompt shown with no v1 frame mounted; requires a new click',
          engine,
          promptState.frames === 0 && promptState.allow,
          promptState
        );
        await page.locator('[data-test-subj="appHostAllowVersion"]').click();
        await waitForStatus(page, /^bound$/);
        const panels = await readPanels(await waitForChild(page));
        report.expect(
          T,
          'approved v2 after viewer consent: UI v2 and server label v2, no restart/redeploy',
          engine,
          /^Digest v2 UI /.test(panels.version ?? '') &&
            /^Server v2 /.test(panels.summary ?? '') &&
            kibanaRestarts() === restartsBefore &&
            wranglerReloads() === reloadsBefore &&
            dispatcherConnections() > dispatcherBefore,
          {
            version: panels.version,
            summary: panels.summary,
            kibanaRestarts: kibanaRestarts() - restartsBefore,
            wranglerReloads: wranglerReloads() - reloadsBefore,
          }
        );
        // 5. Logout: the handle is useless without the viewer's Kibana session.
        const logoutUser = legacyReader();
        if (logoutUser) {
          const l = await session(ctx, engine, logoutUser);
          try {
            const logoutHandles = handlesFromResponses(l.page);
            await openBound(l.page, ctx);
            await sleep(300);
            const last = logoutHandles[logoutHandles.length - 1];
            await l.context.request
              .get(`${ctx.kibana}/api/security/logout`, { maxRedirects: 0 })
              .catch(() => undefined);
            const afterLogout = await l.context.request.post(
              `${ctx.kibana}/internal/app_host/ui/execute`,
              {
                headers: { ...apiHeaders(ctx), 'content-type': 'application/json' },
                data: { handle: last, op: 'app.summary' },
              }
            );
            report.expect(
              T,
              'logout: handle unusable without the Kibana session',
              engine,
              afterLogout.status() === 401,
              afterLogout.status()
            );
          } finally {
            await l.close();
          }
        }
      } finally {
        await s.close();
        await release(ctx, { label: 'Digest v1', serverLabel: 'Server v1' });
      }
    });
  }
  // Lifecycle races that need a controlled clock or a held session request run as Jest tests; this
  // harness executes them now and records each one's actual result (never a literal PASS).
  await jestEvidence(
    ctx,
    T,
    [
      'server/ui/bridge_service.test.ts',
      'public/components/app_ui_page.test.tsx',
      'public/ui_host/session_client.test.ts',
    ],
    [
      [
        'disable / release change refused on the next call after the 2 s state cache',
        'T8: disable or a release change is refused on the next call once the 2 s state cache expires',
      ],
      [
        'expiry / principal / space / tamper fail closed',
        'K3: tampered, other-principal, other-space and expired handles are refused',
      ],
      [
        'session resolving after Disable never mounts',
        'a session that resolves after Disable never mounts a frame',
      ],
      [
        'session resolving after unmount never mounts',
        'a session that resolves after unmount never mounts a frame',
      ],
      [
        'positive control: a current session mounts exactly one frame',
        'positive control: a session that resolves while consent is current mounts exactly one frame',
      ],
      [
        'no metadata polling, no mint before consent',
        'mints nothing before consent and never polls the metadata',
      ],
    ]
  );
};

// ---------------------------------------------------------------- T10
export const runT10 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'T10';
  if (ctx.currentEntry !== 'ui/src/main.ts') await release(ctx);
  const before = auditLines().length;
  const httpMark = httpDebugMark();
  const kibanaAuditBefore = auditLines(KIBANA_AUDIT_LOG).length;
  const handles: string[] = [];
  const held = (await createSession(ctx, users.viewer2)).session as TestSession;
  handles.push(held.handle);
  await execute(ctx, held, { op: 'app.summary' }, { headers: { 'x-kbn-app-id': 'spoofed-app' } });
  await execute(ctx, held, {
    op: 'kibana.dashboard.read',
    params: { id: ctx.seed.dashboardId },
  });
  await execute(ctx, held, { op: 'es.search', params: { index: '.security-7', size: 1 } });
  const injected = `\r\n{"event":{"action":"forged"}}\u001b[31m${'x'.repeat(300)}`;
  await execute(ctx, held, { op: injected });
  await execute(
    ctx,
    held,
    { op: 'app.summary' },
    { handle: `${'0'.repeat(64)}.${'B'.repeat(60)}`, headers: { 'x-kbn-app-id': 'spoofed-app' } }
  );
  // Browser session: window/port payloads must never carry the handle.
  for (const engine of ctx.engines) {
    const s = await session(ctx, engine, users.viewer2, POST_RECORDER);
    try {
      const pageHandles = handlesFromResponses(s.page);
      const child = await openBound(s.page, ctx);
      await readPanels(child);
      await sleep(500);
      const frames = s.page.frames();
      const posted: string[] = [];
      for (const frame of frames) {
        posted.push(
          ...((await frame
            .evaluate(() => (window as unknown as { __posted?: string[] }).__posted ?? [])
            .catch(() => [])) as string[])
        );
      }
      handles.push(...pageHandles);
      const leaked = posted.filter((p) =>
        pageHandles.some((h) => p.includes(h) || p.includes(h.split('.')[1]))
      );
      report.expect(
        T,
        'S11: the session handle never in window or port messages',
        engine,
        pageHandles.length > 0 && posted.length > 0 && leaked.length === 0,
        { messages: posted.length, leaked: leaked.length }
      );
    } finally {
      await s.close();
    }
  }
  await sleep(1500);
  const records = auditLines()
    .slice(before)
    .map((line) => JSON.parse(line) as Record<string, any>);
  const raw = auditLines().slice(before).join('\n');
  const viewerRecords = records.filter((r) => r.user?.name === users.viewer2.username);
  const summary = viewerRecords.find(
    (r) => r.app?.capability === 'app.summary' && r.event?.outcome === 'success'
  );
  report.expect(
    T,
    'success + denial records carry handle-derived app/release/viewer/space/capability/outcome/reason + api_key.id + correlation id',
    T === 'T10' ? 'http' : 'http',
    Boolean(summary) &&
      summary?.app?.id === 'alert-digest' &&
      summary?.app?.release_digest === ctx.current?.releaseDigest &&
      summary?.kibana?.space_id === 'default' &&
      /^[0-9a-f-]{36}$/.test(summary?.kibana?.correlation_id ?? '') &&
      typeof summary?.api_key?.id === 'string' &&
      viewerRecords.some(
        (r) =>
          r.event?.outcome === 'failure' &&
          r.event?.reason === 'resource_not_granted' &&
          r.app?.capability === 'es.search'
      ),
    { sample: summary }
  );
  report.expect(
    T,
    'spoofed x-kbn-app-id cannot alter attribution; invalid handle has no app actor',
    'http',
    !raw.includes('spoofed-app') &&
      records.some(
        (r) => r.event?.reason === 'bad_handle' && r.app === undefined && r.api_key === undefined
      )
  );
  const worker = viewerRecords.find(
    (r) => r.app?.via === 'app.summary' && r.app?.capability === 'es.search'
  );
  report.expect(
    T,
    'S9: Worker-path HostEs read attributed with the wrapper correlation id',
    'http',
    Boolean(worker) && worker?.kibana?.correlation_id === summary?.kibana?.correlation_id,
    { worker: worker?.kibana?.correlation_id, wrapper: summary?.kibana?.correlation_id }
  );
  const injectedRecord = records.find(
    (r) =>
      String(r.app?.capability ?? '').includes('event') || r.event?.reason === 'invalid_operation'
  );
  report.expect(
    T,
    'CRLF/ANSI/oversize input cannot inject records',
    'http',
    !raw.includes('"action":"forged"') &&
      auditLines()
        .slice(before)
        .every((line) => line.startsWith('{')) &&
      !/[\r\u001b]/.test(raw) &&
      String(injectedRecord?.app?.capability ?? '').length <= 64,
    { capability: injectedRecord?.app?.capability }
  );
  const logs = [
    auditLines().slice(before).join('\n'),
    httpDebugSince(httpMark).join('\n'),
    readFileSync(join(LOCAL_DIR, 'logs', process.env.KIBANA_LOG ?? 'kibana4.log'), 'utf8'),
    auditLines(KIBANA_AUDIT_LOG).join('\n'),
    auditLines(join(LOCAL_DIR, 'logs', 'kibana_debug.ndjson')).join('\n'),
  ];
  const handleLeaks = handles.filter((handle) =>
    logs.some((log) => log.includes(handle.split('.')[1]))
  );
  const keyLeaks = logs.filter((log) => /ApiKey [A-Za-z0-9+/=]{20,}|"api_key"\s*:\s*"/.test(log));
  report.expect(
    T,
    'S11: handles and API keys absent from audit, Kibana, security-audit, kibana_debug and http.server.response debug logs',
    'http',
    handles.length > 0 &&
      handleLeaks.length === 0 &&
      keyLeaks.length === 0 &&
      httpDebugSince(httpMark).length > 100,
    {
      handlesChecked: handles.length,
      leaks: handleLeaks.length,
      keyPatternHits: keyLeaks.length,
      httpDebugLines: httpDebugSince(httpMark).length,
    }
  );
  report.expect(
    T,
    'no handles, keys, tokens, payloads or raw errors in bridge audit records',
    'http',
    handles.every((handle) => !raw.includes(handle.split('.')[1])) &&
      !raw.includes(HOSTILE_RULE) &&
      !raw.includes('Synthetic <b>') &&
      !/\bat\s.+\.ts:/.test(raw)
  );
  const kibanaAudit = auditLines(KIBANA_AUDIT_LOG)
    .slice(kibanaAuditBefore)
    .map((line) => JSON.parse(line) as Record<string, any>);
  const dashboardRecord = viewerRecords.find(
    (r) => r.app?.capability === 'kibana.dashboard.read' && r.event?.outcome === 'success'
  );
  const native = kibanaAudit.find(
    (r) =>
      r.user?.name === users.viewer2.username && JSON.stringify(r).includes(ctx.seed.dashboardId)
  );
  report.expect(
    T,
    'Dashboard read correlates with Kibana’s own security audit (user + object + time)',
    'http',
    Boolean(dashboardRecord) && Boolean(native),
    {
      bridge: dashboardRecord?.['@timestamp'],
      native: native ? { action: native.event?.action, at: native['@timestamp'] } : null,
    }
  );
};

export { pollFrame };

// ---------------------------------------------------------------- T9 (browser smoke)
/** A real oversized frame from hostile app code terminates the parent session at the boundary. */
export const runT9Browser = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  await ensureHostile(ctx);
  for (const engine of ctx.engines) {
    await report.guard('T9', 'browser', engine, async () => {
      const s = await session(ctx, engine, users.viewer);
      try {
        const child = await openBound(s.page, ctx);
        await waitProbe(child);
        await runIn(child, 'oversizedFrame', '');
        await waitForStatus(s.page, /ended: protocol_error/, 10_000).catch(() => undefined);
        report.expect(
          'T9',
          '33 KiB frame from the real app frame → parent terminates (frame_too_large)',
          engine,
          /ended: protocol_error \(frame_too_large\)/.test(await frameStatus(s.page)),
          await frameStatus(s.page)
        );
      } finally {
        await s.close();
      }
    });
  }
  report.add('T9', 'unbounded UI CPU loop', 'all', 'NOT_VERIFIED', {
    note: 'Not run. An iframe is not a CPU quota; a hostile UI can still busy-loop its renderer (tab DoS residual).',
  });
};
