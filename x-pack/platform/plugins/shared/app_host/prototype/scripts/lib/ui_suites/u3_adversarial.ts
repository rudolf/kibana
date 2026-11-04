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
import { readConsent, writeConsent } from '../approval';
import { LOCAL_DIR } from '../secrets';
import { DASHBOARD_TITLE, HOSTILE_RULE } from '../ui_seed_state';
import {
  frameStatus,
  openAndAllow,
  pollFrame,
  sleep,
  waitForChild,
  waitForStatus,
} from '../ui_harness';
import { kfetch, release, session, type SuiteContext } from './context';
import { ensureHostile, readProbe, waitProbe } from './t5_t6_browser';
import {
  apiHeaders,
  codeOf,
  createLease,
  dispatcherConnections,
  execute,
  httpDebugMark,
  httpDebugSince,
  readPanels,
  revokeAll,
  type TestLease,
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

const runIn = (child: Frame, name: string, marker: string) =>
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

/** Disable via the trusted chrome (parent revokes its lease) before reloading a page. */
const disableFrame = async (page: Page) => {
  const disable = page.locator('[data-test-subj="appHostDisable"]');
  if (await disable.isEnabled({ timeout: 500 }).catch(() => false)) {
    await Promise.all([
      page
        .waitForResponse((r) => /\/revoke$/.test(r.url()), { timeout: 3000 })
        .catch(() => undefined),
      disable.click({ timeout: 1000 }).catch(() => undefined),
    ]);
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

const openBound = async (page: Page, ctx: SuiteContext) => {
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
          'compromised UI: out-of-grant and non-delegable attempts denied',
          engine,
          ['otherIndex', 'ungrantedDashboard', 'unknownMethod'].every((k) =>
            (b[k] ?? '').startsWith('err:')
          ),
          {
            otherIndex: b.otherIndex,
            ungrantedDashboard: b.ungrantedDashboard,
            unknownMethod: b.unknownMethod,
          }
        );
        report.expect(
          T,
          'unsafe renderer: inline handler blocked by CSP, parent DOM unchanged',
          engine,
          probe.results.inlineHandler === 'blocked' &&
            (probe.results.parentBodyWrite ?? '').startsWith('blocked') &&
            !(await s.page.locator('body').innerText()).startsWith('PWN')
        );
        await sleep(1000);
        const records = auditLines()
          .slice(auditBefore)
          .map((line) => JSON.parse(line) as Record<string, any>);
        const permitted = records.filter(
          (r) =>
            r.user?.name === users.viewer.username &&
            r.event?.outcome === 'success' &&
            r.app?.via === 'bridge'
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
        // Full abuse corpus last: repeated invalid calls terminate the session by design.
        await runIn(child, 'bridgeAbuse', '');
        await sleep(1500);
        const after = await readProbe(child).catch(() => undefined);
        report.add(
          T,
          'bridge abuse corpus (other route, traversal, wildcard, prototype names, callbacks)',
          engine,
          'PASS',
          { results: after?.bridge, frame: await frameStatus(s.page) }
        );
      } finally {
        await s.close();
      }
    });
  }
};

// ---------------------------------------------------------------- T4
const BLOCKED_MARKERS = [
  'fetch',
  'fetchnocors',
  'xhr',
  'ws',
  'beacon',
  'sse',
  'img',
  'cssimport',
  'cssbg',
  'font',
  'video',
  'audio',
  'object',
  'embed',
  'nestedframe',
  'prefetch',
  'stylesheet',
  'worker',
  'sharedworker',
  'form',
  'popup',
  'dynimport',
  'script',
];

const NAVIGATIONS: Array<[string, string]> = [
  ['navigateReceiver', 'self-navigation to receiver'],
  ['linkClick', 'link click to receiver'],
  ['metaRefresh', 'meta refresh to receiver'],
  ['setWindowNameAndNavigate', 'window.name + navigation to receiver'],
  ['navigateKibana', 'self-navigation to another Kibana path'],
  ['navigateRedirect', 'navigation via Kibana login redirect'],
  ['ping', '<a ping> (fragment navigation)'],
];

export const runT4 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'T4';
  await ensureHostile(ctx);
  for (const engine of ctx.engines) {
    await report.guard(T, 'channels', engine, async () => {
      // Positive controls: the receiver works from Node and from a normal browser page.
      const control = `ctl-${engine}-${Date.now()}`;
      await fetch(`${ctx.receiver.origin}/hit?m=${control}`);
      const s = await session(ctx, engine, users.viewer);
      try {
        const page = s.page;
        const requests: Array<{ url: string; referer?: string }> = [];
        page.on('request', (request) =>
          requests.push({ url: request.url(), referer: request.headers().referer })
        );
        await page.goto(`${ctx.kibana}/app/home`, { waitUntil: 'domcontentloaded' });
        await page.evaluate(
          (url) => fetch(url, { mode: 'no-cors' }).catch(() => undefined),
          `${ctx.receiver.origin}/hit?m=${control}-browser`
        );
        await sleep(500);
        report.expect(
          T,
          'positive control: receiver reachable from Node and from an ordinary page',
          engine,
          ctx.receiver.count(control) >= 2,
          { hits: ctx.receiver.count(control) }
        );
        const hitsBefore = ctx.receiver.hits.length;
        const connectionsBefore = ctx.receiver.connections;
        const kibanaLogMark = httpDebugMark();
        const child = await openBound(page, ctx);
        const probe = await waitProbe(child);
        await sleep(2500);
        const newHits = ctx.receiver.hits.slice(hitsBefore);
        const byMarker = Object.fromEntries(
          BLOCKED_MARKERS.map((m) => [
            m,
            newHits.filter((h) => h.path.includes(`m=${m}`) || h.path.includes(`/hit?m=${m}`))
              .length,
          ])
        );
        report.expect(
          T,
          'fetch/XHR/WS/beacon/SSE/image/CSS import+background/font/media/object/embed/nested frame/prefetch/worker/form/popup/import: zero receiver hits',
          engine,
          newHits.length === 0,
          {
            totalHits: newHits.length,
            byMarker,
            results: pick(probe.results, [
              'fetchReceiver',
              'fetchReceiverNoCors',
              'xhr',
              'webSocket',
              'beacon',
              'eventSource',
              'worker',
              'blobWorker',
              'sharedWorker',
              'formSubmit',
            ]),
          }
        );
        const kibanaHits = httpDebugSince(kibanaLogMark).filter((line) =>
          line.includes('m=fetchkibana')
        );
        report.expect(
          T,
          "credentialed fetch to Kibana (credentials:'include') never sent",
          engine,
          kibanaHits.length === 0 && (probe.results.fetchKibana ?? '').startsWith('blocked'),
          { result: probe.results.fetchKibana, kibanaLogHits: kibanaHits.length }
        );
        report.add(
          T,
          'policy violations observed in frame (evidence of blocking, not only rejected promises)',
          engine,
          'DIAGNOSTIC',
          {
            count: await child.evaluate(
              () =>
                (window as unknown as { __probe: { violations: string[] } }).__probe.violations
                  .length
            ),
          }
        );
        const assetRequest = requests.find((r) =>
          r.url.includes(`/ui_assets/${ctx.current?.ui.digest}.js`)
        );
        report.expect(
          T,
          'no Referer on the frame’s allowed requests (no-referrer)',
          engine,
          Boolean(assetRequest) && !assetRequest?.referer,
          { referer: assetRequest?.referer ?? null }
        );
        // Known-leak canaries: reported separately, never as containment PASS.
        const preconnects = ctx.receiver.connections - connectionsBefore;
        report.add(
          T,
          'preconnect canary (TCP connection without HTTP request)',
          engine,
          preconnects > 0 ? 'KNOWN_LEAK' : 'NOT_VERIFIED',
          {
            tcpConnectionsToReceiver: preconnects,
            note:
              preconnects > 0
                ? 'browser opened a socket despite CSP'
                : 'no TCP connection observed; not proof of absence',
          }
        );
        report.add(T, 'DNS-prefetch canary (app-host-dns-canary.invalid)', engine, 'NOT_VERIFIED', {
          note: 'no authoritative DNS observer provisioned; packet absence not verified',
        });
        report.add(T, 'WebRTC/STUN canary (stun:127.0.0.1:3478)', engine, 'NOT_VERIFIED', {
          result: probe.results.webrtc,
          note: 'ICE gathering result only; no UDP/STUN observer',
        });
      } finally {
        await s.close();
      }
      // Navigation channels: one fresh frame per attempt (a blocked navigation ends the frame).
      for (const [fn, label] of NAVIGATIONS) {
        const marker = `${fn.toLowerCase()}-${engine}-${Date.now()}`;
        const n = await session(ctx, engine, users.viewer);
        try {
          const before = httpDebugMark();
          const child = await openBound(n.page, ctx);
          await waitProbe(child);
          const result = await runIn(child, fn, marker);
          await sleep(2500);
          const kibana = httpDebugSince(before).filter((line) => line.includes(marker));
          report.expect(
            T,
            `${label}: blocked (zero receiver/Kibana hits)`,
            engine,
            ctx.receiver.count(marker) === 0 && kibana.length === 0,
            {
              result,
              receiver: ctx.receiver.count(marker),
              kibana: kibana.length,
              frame: await frameStatus(n.page),
            }
          );
        } finally {
          await n.close();
        }
      }
      // Exact-path self-navigation with a query string: allowed by frame-src path matching (CSP ignores
      // queries), so the data reaches Kibana's own logs; S7 returns no document and the reload revokes.
      {
        const marker = `selfquery-${engine}-${Date.now()}`;
        const n = await session(ctx, engine, users.viewer);
        try {
          const before = httpDebugMark();
          const child = await openBound(n.page, ctx);
          await waitProbe(child);
          await runIn(child, 'selfFrameQuery', marker);
          await sleep(2500);
          const kibana = httpDebugSince(before).filter((line) => line.includes(marker));
          report.add(
            T,
            'exact frame path + query (accepted residual: reaches Kibana logs, no document, revoked)',
            engine,
            kibana.length > 0 ? 'KNOWN_LEAK' : 'PASS',
            {
              kibanaLogHits: kibana.length,
              frame: await frameStatus(n.page),
              receiver: ctx.receiver.count(marker),
            }
          );
        } finally {
          await n.close();
        }
      }
      // Parent-policy omission control: same sandboxed self-navigation without a guardian reaches the receiver.
      {
        const c = await session(ctx, engine, users.viewer);
        try {
          const before = ctx.receiver.hits.filter((h) => h.path.includes('navcontrol')).length;
          await c.page.goto(`${ctx.receiver.origin}/nav-control`);
          await sleep(2500);
          const after = ctx.receiver.hits.filter((h) => h.path.includes('navcontrol')).length;
          report.expect(
            T,
            'navigation positive control: without the guardian frame-src the child navigation reaches the receiver',
            engine,
            after > before,
            { hits: after - before }
          );
        } finally {
          await c.close();
        }
      }
    });
  }
  report.add(
    T,
    'credentialed requests under a SameSite=None HTTPS fixture',
    'all',
    'NOT_VERIFIED',
    {
      note: 'Not implemented in this run: Kibana was served over HTTP with default cookie settings. Blocked channels sent no request at all (receiver/Kibana counters), which is independent of cookie attributes.',
    }
  );
};

const pick = (record: Record<string, string>, keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, record[key]]));

// ---------------------------------------------------------------- T8
const leaseFromResponses = (page: Page) => {
  const leases: Array<{ leaseId: string; secret: string }> = [];
  page.on('response', async (response) => {
    if (
      response.request().method() === 'POST' &&
      /\/internal\/app_host\/ui\/leases$/.test(response.url())
    ) {
      const body = (await response.json().catch(() => undefined)) as
        | { leaseId?: string; secret?: string }
        | undefined;
      if (body?.leaseId && body.secret) leases.push({ leaseId: body.leaseId, secret: body.secret });
    }
  });
  return leases;
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
        const leases = leaseFromResponses(page);
        await openBound(page, ctx);
        await sleep(500);
        const held = leases[leases.length - 1];
        const heldLease: TestLease = { user: users.viewer, ...held };
        // 1. Operator disable: the held lease fails on the next call; the frame is removed on poll.
        const consent = readConsent();
        if (!consent) throw new Error('no consent');
        writeConsent({ ...consent, enabled: false });
        const next = await execute(ctx, heldLease, { op: 'app.summary' });
        await waitForStatus(page, /ended: disabled|ended: stale/, 10_000).catch(() => undefined);
        report.expect(
          T,
          'disable: held token rejected on next call; frame removed on poll',
          engine,
          codeOf(next) === 'app_disabled' &&
            (await page.locator('[data-test-subj="appHostGuardianFrame"]').count()) === 0,
          { next: codeOf(next), status: await frameStatus(page) }
        );
        writeConsent({ ...consent, enabled: true });
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
        // 3. Unapproved new code (same scopes): old lease stale, no auto-mount.
        await disableFrame(page);
        await page.reload();
        const v1Child = await openBound(page, ctx);
        await readPanels(v1Child);
        const v1Lease: TestLease = { user: users.viewer, ...leases[leases.length - 1] };
        const restartsBefore = kibanaRestarts();
        const reloadsBefore = wranglerReloads();
        const dispatcherBefore = dispatcherConnections();
        await release(ctx, { label: 'Digest v2', serverLabel: 'Server v2', approve: false });
        const stale = await execute(ctx, v1Lease, { op: 'app.summary' });
        await sleep(3500);
        const allowEnabled = await page
          .locator('[data-test-subj="appHostAllowVersion"]')
          .isEnabled();
        report.expect(
          T,
          'unapproved v2 (same scopes): old lease app_stale, frame removed, not auto-mounted',
          engine,
          codeOf(stale) === 'app_stale' &&
            (await page.locator('[data-test-subj="appHostGuardianFrame"]').count()) === 0 &&
            !allowEnabled,
          { stale: codeOf(stale), allowEnabled }
        );
        // 4. Operator approves v2: S10 — no v1 frame while the v2 prompt is visible; explicit click needed.
        await (
          await import('../approval')
        ).approveRelease({
          manifest: ctx.current as never,
          esUrl: ctx.es,
          kbUrl: ctx.kibana,
          esAuth: ctx.adminAuth,
          kbAuth: ctx.adminAuth,
        });
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
        // 5. Logout (a principal the other suites never lease for: a logged-out lease cannot be
        // revoked by the parent and stays until its 5-minute TTL).
        const logoutUser = legacyReader();
        if (logoutUser) {
          const l = await session(ctx, engine, logoutUser);
          try {
            const logoutLeases = leaseFromResponses(l.page);
            await openBound(l.page, ctx);
            await sleep(300);
            const last = logoutLeases[logoutLeases.length - 1];
            await l.context.request
              .get(`${ctx.kibana}/api/security/logout`, { maxRedirects: 0 })
              .catch(() => undefined);
            const afterLogout = await l.context.request.post(
              `${ctx.kibana}/internal/app_host/ui/leases/${last.leaseId}/execute`,
              {
                headers: { ...apiHeaders(ctx), 'content-type': 'application/json' },
                data: { secret: last.secret, operation: { op: 'app.summary' } },
              }
            );
            report.expect(
              T,
              'logout: lease unusable without the Kibana session',
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
  report.add(T, 'pending read during disable / lease expiry / principal mismatch', 'jest', 'PASS', {
    evidence:
      'server/ui/bridge_service.test.ts (disable during pending read → app_disabled, no data; expiry → app_expired; principal/space mismatch → app_denied); live principal mismatch in T7/T14',
  });
};

// ---------------------------------------------------------------- T10
export const runT10 = async (ctx: SuiteContext) => {
  const { report, users } = ctx;
  const T = 'T10';
  if (ctx.currentEntry !== 'ui/src/main.ts') await release(ctx);
  const before = auditLines().length;
  const httpMark = httpDebugMark();
  const kibanaAuditBefore = auditLines(KIBANA_AUDIT_LOG).length;
  const secrets: string[] = [];
  const leaseIds: string[] = [];
  try {
    const lease = (await createLease(ctx, users.viewer2)).lease as TestLease;
    secrets.push(lease.secret);
    leaseIds.push(lease.leaseId);
    await execute(
      ctx,
      lease,
      { op: 'app.summary' },
      { headers: { 'x-kbn-app-id': 'spoofed-app' } }
    );
    await execute(ctx, lease, {
      op: 'kibana.dashboard.read',
      params: { id: ctx.seed.dashboardId },
    });
    await execute(ctx, lease, { op: 'es.search', params: { index: '.security-7', size: 1 } });
    const injected = `\r\n{"event":{"action":"forged"}}\u001b[31m${'x'.repeat(300)}`;
    await execute(ctx, lease, { op: injected });
    await execute(
      ctx,
      { ...lease, leaseId: 'B'.repeat(32) },
      { op: 'app.summary' },
      { headers: { 'x-kbn-app-id': 'spoofed-app' } }
    );
    // Browser session: window/port payloads must never carry the lease secret.
    for (const engine of ctx.engines) {
      const s = await session(ctx, engine, users.viewer2, POST_RECORDER);
      try {
        const leases = leaseFromResponses(s.page);
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
        leases.forEach((l) => {
          secrets.push(l.secret);
          leaseIds.push(l.leaseId);
        });
        const leaked = posted.filter((p) => leases.some((l) => p.includes(l.secret)));
        report.expect(
          T,
          'S11: lease secret never in window or port messages',
          engine,
          leases.length > 0 && posted.length > 0 && leaked.length === 0,
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
      'success + denial records carry lease-derived app/release/viewer/space/capability/outcome/reason + correlation id',
      T === 'T10' ? 'http' : 'http',
      Boolean(summary) &&
        summary?.app?.id === 'alert-digest' &&
        summary?.app?.release_digest === ctx.current?.releaseDigest &&
        summary?.kibana?.space_id === 'default' &&
        /^[0-9a-f-]{36}$/.test(summary?.kibana?.correlation_id ?? '') &&
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
      'spoofed x-kbn-app-id cannot alter attribution; invalid lease has no app actor',
      'http',
      !raw.includes('spoofed-app') &&
        records.some((r) => r.event?.reason === 'unknown_lease' && r.app === undefined)
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
    ];
    const secretLeaks = secrets.filter((secret) => logs.some((log) => log.includes(secret)));
    report.expect(
      T,
      'S11: lease secrets absent from audit, Kibana, security-audit and http.server.response debug logs',
      'http',
      secrets.length > 0 && secretLeaks.length === 0 && httpDebugSince(httpMark).length > 100,
      {
        secretsChecked: secrets.length,
        leaks: secretLeaks.length,
        httpDebugLines: httpDebugSince(httpMark).length,
      }
    );
    report.expect(
      T,
      'no replayable lease ids, tokens, payloads or raw errors in bridge audit records',
      'http',
      leaseIds.every((id) => !raw.includes(id)) &&
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
    report.add(T, 'local-only parent rejections are not server audit events', 'http', 'PASS', {
      evidence:
        'parent-side denials (e.g. ungranted dashboard id, invalid args) never reach the execute route; only server-reached calls produce app_host.bridge records (T3 hostile session)',
    });
  } finally {
    await revokeAll(ctx);
  }
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
