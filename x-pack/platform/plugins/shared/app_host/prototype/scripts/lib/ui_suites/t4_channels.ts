/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// T4 — every egress channel, one claim per channel. A channel is PASS only with (a) a working
// positive control (the same probe code issues the request from an ordinary page in this engine),
// (b) zero receiver hits for this attempt's unique marker and (c) an observed block (a CSP violation
// attributed to the channel, or the API's own thrown error). An inert probe (control produced no
// request) or a block without an observation is NOT_VERIFIED, never PASS. Navigations run one per
// fresh frame and need a violation observed in some frame. Known leaks are reported as such.

import type { Page } from '@playwright/test';
import { CHANNELS, type ChannelRun } from '../../../ui/fixtures/channels';
import { bundleUi } from '../ui_release';
import { sleep } from '../ui_harness';
import { session, type SuiteContext } from './context';
import { ensureHostile, waitProbe } from './t5_t6_browser';
import { httpDebugMark, httpDebugSince } from './u2_authority';
import { openBound, runIn } from './u3_adversarial';

/** Logs every CSP violation in every frame to the console (observed even after a frame is gone). */
export const VIOLATION_LOGGER = `(() => {
  document.addEventListener('securitypolicyviolation', (event) => {
    console.log('app-host-csp:' + event.effectiveDirective + '|' + String(event.blockedURI).slice(0, 160) + '|' + String(location.href).slice(0, 120));
  }, true);
})();`;

const cspLines = (lines: readonly string[]) =>
  lines.filter((line) => line.includes('app-host-csp:')).map((line) => line.slice(0, 300));

const runId = () => Date.now().toString(36);

/** True if any GET reached Kibana authenticated (401 means no session cookie was sent). */
const sessionSent = (hits: readonly string[]) =>
  hits.some((hit) => /^GET /.test(hit) && !/ 401$/.test(hit));

const ensureControlPages = async (ctx: SuiteContext) => {
  if (!ctx.receiver.static.has('/channel-control.js')) {
    const body = await bundleUi('ui/fixtures/channel_control.ts', {}, { adversarial: true });
    ctx.receiver.static.set('/channel-control.js', { type: 'application/javascript', body });
    ctx.receiver.static.set('/channel-control', {
      type: 'text/html',
      body: '<!doctype html><title>control</title><script src="/channel-control.js"></script>',
    });
    ctx.receiver.static.set('/preconnect-control', {
      type: 'text/html',
      body: `<!doctype html><title>preconnect control</title><link rel="preconnect" href="${ctx.preconnect.origin}">`,
    });
  }
};

/** Runs the channel probes on an ordinary receiver-origin page (no app policy): positive control. */
const controlRun = async (
  page: Page,
  ctx: SuiteContext,
  base: string,
  prefix: string,
  only?: string[]
) => {
  await page.goto(`${ctx.receiver.origin}/channel-control`);
  await page.waitForFunction(() => '__runChannels' in window);
  return (await page.evaluate(
    ([b, p, o]) =>
      (
        window as unknown as {
          __runChannels: (b: string, p: string, o?: string[]) => Promise<ChannelRun>;
        }
      ).__runChannels(b, p, o ?? undefined),
    [base, prefix, only ?? null] as const
  )) as ChannelRun;
};

/** A CSP violation, or the API itself reporting failure (synchronous throw/rejection or error event). */
const observed = (evidence: ChannelRun['channels'][string] | undefined) =>
  Boolean(
    evidence &&
      (evidence.violations.length > 0 ||
        evidence.outcome.startsWith('thrown:') ||
        evidence.outcome === 'error-event')
  );

const KIBANA_CHANNELS = [
  'fetch',
  'fetchnocors',
  'xhr',
  'beacon',
  'img',
  'script',
  'stylesheet',
  'cssbg',
  'nestedframe',
];

/** Kibana's own access log lines (status code) for one marker since `mark`. */
const kibanaHits = (mark: number, marker: string) =>
  httpDebugSince(mark)
    .filter((line) => line.includes(marker))
    .map((line) => {
      const message = (JSON.parse(line) as { message?: string }).message ?? '';
      return message.split(' ').slice(0, 3).join(' ');
    });

const NAVIGATIONS: Array<[string, string]> = [
  ['navigateReceiver', 'self-navigation to receiver'],
  ['linkClick', 'link click to receiver'],
  ['metaRefresh', 'meta refresh to receiver'],
  ['setWindowNameAndNavigate', 'window.name + navigation to receiver'],
  ['navigateKibana', 'self-navigation to another Kibana path'],
  ['navigateRedirect', 'navigation via Kibana login redirect'],
  ['ping', '<a ping> (fragment navigation)'],
];

const runResourceChannels = async (ctx: SuiteContext, engine: string, T: string) => {
  const { report, users } = ctx;
  const id = runId();
  const s = await session(ctx, engine, users.viewer, VIOLATION_LOGGER);
  try {
    const page = s.page;
    const requests: Array<{ url: string; referer?: string }> = [];
    page.on('request', (request) =>
      requests.push({ url: request.url(), referer: request.headers().referer })
    );
    // (a) Positive controls from an ordinary page in this engine, same probe code.
    const controlPrefix = `ctl-${engine}-${id}`;
    const control = await controlRun(page, ctx, ctx.receiver.origin, controlPrefix);
    await sleep(1500);
    const kibanaControlPrefix = `kctl-${engine}-${id}`;
    const kibanaMark = httpDebugMark();
    await controlRun(
      page,
      ctx,
      `${ctx.kibana}/api/spaces/space`,
      kibanaControlPrefix,
      KIBANA_CHANNELS
    );
    await sleep(1500);
    const kibanaControl = Object.fromEntries(
      KIBANA_CHANNELS.map((channel) => [
        channel,
        kibanaHits(kibanaMark, `${kibanaControlPrefix}-${channel}`),
      ])
    );
    // (b) The same probes from the hostile app frame.
    const child = await openBound(page, ctx);
    // Cookie positive control in the frame's own situation: an opaque (sandboxed srcdoc) frame
    // *inside the Kibana page* but without the app policy sends credentialed requests to Kibana.
    // Whether they carry the session (an authenticated GET of an unknown space is 403 or 404) or not
    // (401) shows what the cookie configuration would let the app frame send without the policy.
    const cookiePrefix = `cookie-${engine}-${id}`;
    const cookieMark = httpDebugMark();
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.id = 'app-host-cookie-control';
      frame.srcdoc = '<p>cookie control</p>';
      frame.style.display = 'none';
      document.body.append(frame);
    });
    await sleep(500);
    const opaque = page.frames().find((frame) => frame.url() === 'about:srcdoc');
    await opaque?.evaluate(
      async ([base, prefix]) => {
        await fetch(`${base}/hit?m=${prefix}-fetch`, {
          credentials: 'include',
          mode: 'no-cors',
        }).catch(() => undefined);
        const image = document.createElement('img');
        image.src = `${base}/hit?m=${prefix}-img`;
        document.body.append(image);
        await new Promise((resolve) => setTimeout(resolve, 800));
      },
      [`${ctx.kibana}/api/spaces/space`, cookiePrefix] as const
    );
    await sleep(800);
    const cookieControl = kibanaHits(cookieMark, cookiePrefix);
    await page.evaluate(() => document.getElementById('app-host-cookie-control')?.remove());
    await waitProbe(child);
    const framePrefix = `app-${engine}-${id}`;
    const hitsBefore = ctx.receiver.hits.length;
    const run = (await runIn(child, 'channels', framePrefix)) as ChannelRun | string;
    await sleep(1500);
    if (typeof run !== 'object' || !run?.channels)
      throw new Error(`channel run failed: ${String(run)}`);
    const frameKibanaPrefix = `kapp-${engine}-${id}`;
    const frameKibanaMark = httpDebugMark();
    const kibanaRun = (await runIn(child, 'kibanaChannels', frameKibanaPrefix)) as
      | ChannelRun
      | string;
    await sleep(1500);
    if (typeof kibanaRun !== 'object' || !kibanaRun?.channels) {
      throw new Error(`kibana channel run failed: ${String(kibanaRun)}`);
    }
    for (const channel of CHANNELS) {
      const marker = `${framePrefix}-${channel}`;
      const hits = ctx.receiver.count(marker);
      const controlHits = ctx.receiver.count(`${controlPrefix}-${channel}`);
      const evidence = run.channels[channel];
      const status =
        hits > 0
          ? 'FAIL'
          : controlHits === 0
          ? 'NOT_VERIFIED'
          : observed(evidence)
          ? 'PASS'
          : 'NOT_VERIFIED';
      report.add(
        T,
        `channel ${channel}: no request, block observed (control works)`,
        engine,
        status,
        {
          hits,
          controlHits,
          controlOutcome: control.channels[channel]?.outcome,
          outcome: evidence?.outcome,
          violations: evidence?.violations,
          note:
            status === 'NOT_VERIFIED'
              ? controlHits === 0
                ? 'probe inert in this engine (control issued no request): untested'
                : 'no request, but no violation/exception observed: block not attributed'
              : undefined,
        }
      );
    }
    report.expect(
      T,
      'no other receiver traffic from the frame during the channel run',
      engine,
      ctx.receiver.hits.slice(hitsBefore).every((hit) => !hit.path.includes(framePrefix)),
      { hits: ctx.receiver.hits.slice(hitsBefore).length }
    );
    for (const channel of KIBANA_CHANNELS) {
      const marker = `${frameKibanaPrefix}-${channel}`;
      const hits = kibanaHits(frameKibanaMark, marker);
      const controlHits = kibanaControl[channel];
      const evidence = kibanaRun.channels[channel];
      const status =
        hits.length > 0
          ? 'FAIL'
          : controlHits.length === 0
          ? 'NOT_VERIFIED'
          : observed(evidence)
          ? 'PASS'
          : 'NOT_VERIFIED';
      report.add(
        T,
        `credentialed ${channel} to Kibana never sent${ctx.tls ? ' (SameSite=None HTTPS)' : ''}`,
        engine,
        status,
        {
          kibanaHits: hits,
          control: controlHits,
          outcome: evidence?.outcome,
          violations: evidence?.violations,
        }
      );
    }
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
    report.add(
      T,
      `cookie control: opaque frame inside Kibana without the app policy${
        ctx.tls ? ' (SameSite=None HTTPS)' : ''
      }`,
      engine,
      cookieControl.length > 0 ? 'DIAGNOSTIC' : 'FAIL',
      {
        kibanaHits: cookieControl,
        sessionSent: sessionSent(cookieControl),
        note: 'reachability control for the credentialed-channel checks; 401 = no session cookie, 403/404 = session cookie sent',
      }
    );
    return { kibanaControl, cookieControl };
  } finally {
    await s.close();
  }
};

/** F6: preconnect in its own frame, to a receiver no other probe references. */
const runPreconnect = async (ctx: SuiteContext, engine: string, T: string) => {
  const { report, users } = ctx;
  const s = await session(ctx, engine, users.viewer);
  try {
    const before = ctx.preconnect.connections;
    await s.page.goto(`${ctx.receiver.origin}/preconnect-control`);
    await sleep(2000);
    const control = ctx.preconnect.connections - before;
    const child = await openBound(s.page, ctx);
    await waitProbe(child);
    const idleBefore = ctx.preconnect.connections;
    await sleep(2000);
    const idle = ctx.preconnect.connections - idleBefore;
    const probeBefore = ctx.preconnect.connections;
    const result = await runIn(child, 'preconnect', '');
    await sleep(3000);
    const sockets = ctx.preconnect.connections - probeBefore;
    report.add(
      T,
      'preconnect canary, isolated (TCP to a receiver only the preconnect element names)',
      engine,
      idle !== 0 ? 'FAIL' : sockets > 0 ? 'KNOWN_LEAK' : 'NOT_VERIFIED',
      {
        result,
        controlSocketsFromOrdinaryPage: control,
        idleWindowSockets: idle,
        socketsAfterPreconnect: sockets,
        note:
          sockets > 0
            ? 'socket attributable exactly to <link rel=preconnect> (no other code references this port; idle window had none)'
            : 'no socket observed in a 3 s window; not proof of absence',
      }
    );
    await runIn(child, 'dnsPrefetch', '');
    report.add(T, 'DNS-prefetch canary (app-host-dns-canary.invalid)', engine, 'NOT_VERIFIED', {
      note: 'no authoritative DNS observer provisioned; packet absence not verified',
    });
    report.add(T, 'WebRTC/STUN canary (stun:127.0.0.1:3478)', engine, 'NOT_VERIFIED', {
      result: await runIn(child, 'webrtc', ''),
      note: 'ICE gathering result only; no UDP/STUN observer',
    });
  } finally {
    await s.close();
  }
};

const runNavigations = async (ctx: SuiteContext, engine: string, T: string) => {
  const { report, users } = ctx;
  for (const [fn, label] of NAVIGATIONS) {
    const marker = `${fn.toLowerCase()}-${engine}-${runId()}`;
    const n = await session(ctx, engine, users.viewer, VIOLATION_LOGGER);
    try {
      const before = httpDebugMark();
      const child = await openBound(n.page, ctx);
      await waitProbe(child);
      const consoleBefore = n.console.length;
      await child.evaluate((m) => {
        (window as unknown as { __navMarker: string }).__navMarker = m;
      }, marker);
      const result = await runIn(child, fn, marker);
      await sleep(2500);
      const kibana = httpDebugSince(before).filter((line) => line.includes(marker));
      const violations = cspLines(n.console.slice(consoleBefore));
      const hits = ctx.receiver.count(marker) + kibana.length;
      // Blocked-navigation observation without a violation event (e.g. Firefox does not dispatch one
      // for a frame-src block): the original document is still running in the frame afterwards.
      const sameDocument = await child
        .evaluate(() => (window as unknown as { __navMarker?: string }).__navMarker)
        .then((m) => m === marker)
        .catch(() => false);
      // A fragment navigation (<a ping>) keeps the document by design, so only a violation counts.
      const blockObserved = violations.length > 0 || (fn !== 'ping' && sameDocument);
      report.add(
        T,
        `${label}: zero receiver/Kibana hits, block observed`,
        engine,
        hits > 0 ? 'FAIL' : blockObserved ? 'PASS' : 'NOT_VERIFIED',
        {
          result,
          receiver: ctx.receiver.count(marker),
          kibana: kibana.length,
          violations,
          originalDocumentStillRunning: sameDocument,
          frame: await n.page
            .locator('[data-test-subj="appHostFrameStatus"]')
            .innerText()
            .catch(() => 'unknown'),
        }
      );
    } finally {
      await n.close();
    }
  }
  // Exact-path self-navigation with a query string: allowed by frame-src path matching (CSP ignores
  // queries), so the data reaches Kibana's own logs; S7 returns no document and the reload revokes.
  {
    const marker = `selfquery-${engine}-${runId()}`;
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
        kibana.length > 0 ? 'KNOWN_LEAK' : 'NOT_VERIFIED',
        {
          kibanaLogHits: kibana.length,
          frame: await n.page.locator('[data-test-subj="appHostFrameStatus"]').innerText(),
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
};

export const runT4 = async (ctx: SuiteContext) => {
  const T = 'T4';
  await ensureHostile(ctx);
  await ensureControlPages(ctx);
  for (const engine of ctx.engines) {
    await ctx.report.guard(T, 'resource channels', engine, async () => {
      // Receiver positive control from Node.
      const marker = `node-${engine}-${runId()}`;
      await fetch(`${ctx.receiver.origin}/hit?m=${marker}`);
      ctx.report.expect(
        T,
        'positive control: receiver reachable from Node',
        engine,
        ctx.receiver.count(marker) === 1
      );
      await runResourceChannels(ctx, engine, T);
    });
    await ctx.report.guard(T, 'preconnect', engine, () => runPreconnect(ctx, engine, T));
    await ctx.report.guard(T, 'navigations', engine, () => runNavigations(ctx, engine, T));
  }
};

/**
 * A17 fixture: Kibana over local TLS with `SameSite=None; Secure` session cookies (receivers also
 * TLS). Positive control: an ordinary cross-site page's credentialed request reaches Kibana *with*
 * the session (404 for an unknown space, not 401). The frame's credentialed channels must never
 * reach Kibana at all.
 */
export const runT4Tls = async (ctx: SuiteContext) => {
  const T = 'T4-TLS';
  if (!ctx.tls || !ctx.kibana.startsWith('https://')) {
    ctx.report.add(T, 'SameSite=None HTTPS fixture', 'all', 'NOT_VERIFIED', {
      note: 'run with --tls <dir> against an HTTPS Kibana with xpack.security.sameSiteCookies: None',
    });
    return;
  }
  await ensureHostile(ctx);
  await ensureControlPages(ctx);
  for (const engine of ctx.engines) {
    await ctx.report.guard(T, 'fixture', engine, async () => {
      const s = await session(ctx, engine, ctx.users.viewer);
      let cookie: { sameSite?: string; secure?: boolean } | undefined;
      try {
        cookie = (await s.context.cookies(ctx.kibana)).find((c) => c.name === 'sid');
      } finally {
        await s.close();
      }
      ctx.report.expect(
        T,
        'fixture: Kibana session cookie is SameSite=None; Secure over HTTPS',
        engine,
        cookie?.sameSite === 'None' && cookie?.secure === true,
        { sameSite: cookie?.sameSite, secure: cookie?.secure }
      );
      const { kibanaControl, cookieControl } = await runResourceChannels(ctx, engine, T);
      // Where the engine attaches the SameSite=None cookie to an opaque frame's request, the
      // cookie-present condition is established and the frame checks above ran under it. Where it
      // does not (third-party cookie restrictions), the condition cannot arise in that engine: the
      // frame's credentialed requests were still never sent, but this is not a cookie-present test.
      ctx.report.add(
        T,
        'cookie-present positive control: an opaque frame in the Kibana page without the app policy sends the session cookie (403/404, not 401)',
        engine,
        sessionSent(cookieControl) ? 'PASS' : 'NOT_VERIFIED',
        {
          cookieControl,
          crossSiteTopLevelControl: kibanaControl,
          note: sessionSent(cookieControl)
            ? 'session cookie attached to an opaque frame request inside Kibana: the frame checks ran with the cookie present'
            : 'this engine did not attach the SameSite=None session cookie to an opaque frame request (401), so the cookie-present condition was not reproduced here',
        }
      );
    });
  }
};
