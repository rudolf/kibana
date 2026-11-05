/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// T5 — chrome, top navigation, popups (S10 frame/consent half in T8/T3).
// T6 — bootstrap spoof/replay and S4 post-handshake flood, with a correct-child positive control.

import type { Frame, Page, Route } from '@playwright/test';
import {
  APP_URL,
  frameStatus,
  pollFrame,
  guardianFrame,
  openAndAllow,
  sleep,
  waitForChild,
  waitForStatus,
} from '../ui_harness';
import { release, session, type SuiteContext } from './context';
import { codeOf, execute } from './u2_authority';

interface Probe {
  results: Record<string, string>;
  bridge: Record<string, string>;
  done: boolean;
}

export const readProbe = (child: Frame) =>
  child.evaluate(() => (window as unknown as { __probe: Probe }).__probe) as Promise<Probe>;

export const waitProbe = async (child: Frame) => {
  await pollFrame(child, () => (window as unknown as { __probe?: Probe }).__probe?.done, 90_000);
  return readProbe(child);
};

const T5 = 'T5';

const CLICK_ACTIONS: Array<[string, string]> = [
  ['click-popup', 'no popup'],
  ['click-top', 'no top navigation (location assignment)'],
  ['click-fullscreen', 'no fullscreen'],
  ['click-download', 'no download'],
  ['click-top-link', 'no _top link navigation'],
  ['click-form', 'no _top form submission'],
];

const PARENT_NAVIGATIONS = [
  'assignLocation',
  'href',
  'assign',
  'replace',
  'openSelf',
  'openParent',
];

/** Calls `__probe.run[name](arg)` in the app frame. */
export const runOn = (child: Frame, name: string, arg: string) =>
  child.evaluate(
    ([fn, value]) =>
      (
        window as unknown as { __probe: { run: Record<string, (m: string) => unknown> } }
      ).__probe.run[fn](value),
    [name, arg] as const
  );

/** Disable (the parent revokes its lease), reload, consent again and wait for a bound probe. */
export const freshBound = async (page: Page, ctx: SuiteContext): Promise<Frame> => {
  const disable = page.locator('[data-test-subj="appHostDisable"]');
  if (await disable.isEnabled({ timeout: 500 }).catch(() => false)) {
    await Promise.all([
      page
        .waitForResponse((r) => /\/revoke$/.test(r.url()), { timeout: 3000 })
        .catch(() => undefined),
      disable.click({ timeout: 1000 }).catch(() => undefined),
    ]);
  }
  await openAndAllow(page, ctx.kibana);
  await waitForStatus(page, /^bound$/);
  const child = await waitForChild(page);
  await waitProbe(child);
  return child;
};

/** Leases created by the page (the parent's lease POST responses), for server-side checks. */
const captureLeases = (page: Page) => {
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

/**
 * F2: joint session history. The frame calls history.back(). Where that navigates the top page
 * (a navigation residual, KNOWN_LEAK), the lease the old page held must be refused by the server.
 */
const runHistory = async (ctx: SuiteContext, engine: string) => {
  const { report } = ctx;
  const s = await session(ctx, engine, ctx.users.viewer);
  try {
    const { page } = s;
    const leases = captureLeases(page);
    await page.goto(`${ctx.kibana}/app/home`, { waitUntil: 'domcontentloaded' });
    await openAndAllow(page, ctx.kibana);
    await waitForStatus(page, /^bound$/);
    const child = await waitForChild(page);
    await waitProbe(child);
    const held = leases[leases.length - 1];
    if (!held) throw new Error('no lease captured');
    const lease = { user: ctx.users.viewer, ...held };
    const before = await execute(ctx, lease, { op: 'app.summary' });
    const topBefore = page.url();
    await runOn(child, 'historyBack', '').catch(() => undefined);
    await sleep(2000);
    const topChanged = page.url() !== topBefore;
    let after = '';
    for (let i = 0; i < 10; i++) {
      after = codeOf(await execute(ctx, lease, { op: 'app.summary' }));
      if (after !== 'ok') break;
      await sleep(500);
    }
    report.expect(
      T5,
      'history control: the held lease worked before history.back()',
      engine,
      codeOf(before) === 'ok',
      codeOf(before)
    );
    if (topChanged) {
      report.add(
        T5,
        'history.back() from frame navigated the top page (joint history)',
        engine,
        'KNOWN_LEAK',
        {
          from: topBefore.replace(ctx.kibana, ''),
          to: page.url().replace(ctx.kibana, ''),
          note: 'navigation residual: the app cannot choose the URL, only traverse existing entries',
        }
      );
      report.expect(
        T5,
        'F2: after history.back() changed the top page, the old lease is refused',
        engine,
        after === 'app_denied',
        { afterNavigation: after }
      );
    } else {
      report.add(
        T5,
        'history.back() from frame (joint history): top page unchanged here',
        engine,
        'DIAGNOSTIC',
        {
          afterCall: after,
          status: await frameStatus(page).catch(() => 'page navigated'),
        }
      );
    }
  } finally {
    await s.close();
  }
};

const runT5Engine = async (ctx: SuiteContext, engine: string) => {
  const { report } = ctx;
  const s = await session(ctx, engine, ctx.users.viewer);
  try {
    const { page, context } = s;
    const popups: string[] = [];
    const downloads: string[] = [];
    context.on('page', (opened) => popups.push(opened.url()));
    page.on('download', (download) => downloads.push(download.suggestedFilename()));
    await openAndAllow(page, ctx.kibana);
    await waitForStatus(page, /^bound$/);
    const topUrl = page.url();
    let child = await waitForChild(page);
    const probe = await waitProbe(child);
    const r = probe.results;
    const blocked = (key: string) => (r[key] ?? '').startsWith('blocked');
    report.expect(
      T5,
      'parent.document / top.document / parent DOM write denied',
      engine,
      blocked('parentDocument') &&
        blocked('topDocument') &&
        blocked('parentBodyWrite') &&
        !(await page.locator('body').innerText()).startsWith('PWN'),
      { parent: r.parentDocument, top: r.topDocument, write: r.parentBodyWrite }
    );
    report.expect(
      T5,
      'cookies/localStorage/sessionStorage/IndexedDB/Cache/ServiceWorker denied',
      engine,
      [
        'cookie',
        'localStorage',
        'sessionStorage',
        'indexedDB',
        'cacheStorage',
        'serviceWorker',
      ].every(blocked),
      Object.fromEntries(
        [
          'cookie',
          'localStorage',
          'sessionStorage',
          'indexedDB',
          'cacheStorage',
          'serviceWorker',
        ].map((k) => [k, r[k]])
      )
    );
    report.expect(
      T5,
      'popup without activation → null, fullscreen without activation denied',
      engine,
      (r.windowOpen === 'executed:null' || blocked('windowOpen')) &&
        blocked('requestFullscreen') &&
        ctx.receiver.count('popup') === 0,
      { open: r.windowOpen, fullscreen: r.requestFullscreen }
    );
    // Real user activation inside the frame: one fresh bound frame per destructive action (a
    // blocked action may reload the child in some engines). Each action needs proof that its click
    // handler ran (console line from the frame) and is asserted on its own.
    for (const [id, label] of CLICK_ACTIONS) {
      const marker = `${id}-${engine}-${Date.now().toString(36)}`;
      child = await freshBound(page, ctx);
      const consoleBefore = s.console.length;
      const popupsBefore = popups.length;
      const downloadsBefore = downloads.length;
      await runOn(child, 'setClickMarker', marker);
      let clicked = 'clicked';
      await child.click(`#${id}`, { timeout: 5000 }).catch((error) => {
        clicked = `click failed: ${String(error).slice(0, 80)}`;
      });
      await sleep(1200);
      const handlerRan = s.console
        .slice(consoleBefore)
        .some((line) => line.includes(`app-host-click:${id}`));
      const fullscreen = await page.evaluate(() => Boolean(document.fullscreenElement));
      const evidence = {
        clicked,
        handlerRan,
        popups: popups.length - popupsBefore,
        downloads: downloads.length - downloadsBefore,
        fullscreen,
        topUrlUnchanged: page.url() === topUrl,
        receiverHits: ctx.receiver.count(marker),
        frame: await frameStatus(page),
      };
      const effects =
        evidence.popups === 0 &&
        evidence.downloads === 0 &&
        !fullscreen &&
        evidence.topUrlUnchanged &&
        evidence.receiverHits === 0;
      report.expect(
        T5,
        `with a real click (handler ran): ${label}`,
        engine,
        clicked === 'clicked' && handlerRan && effects,
        evidence
      );
    }
    child = await freshBound(page, ctx);
    const noClickMarker = `topnav-noclick-${engine}-${Date.now().toString(36)}`;
    const top = String(await runOn(child, 'topNavigation', noClickMarker));
    await sleep(800);
    report.expect(
      T5,
      'top location assignment without click blocked (SecurityError), top URL unchanged',
      engine,
      top.startsWith('blocked:') &&
        page.url() === topUrl &&
        ctx.receiver.count(noClickMarker) === 0,
      { result: top }
    );
    // Fixed-position overlay stays clipped: trusted chrome remains hit-testable and uncovered.
    const covered = await page.evaluate(() => {
      const results: boolean[] = [];
      for (const selector of [
        '[data-test-subj="appHostDisable"]',
        '[data-test-subj="appHostTrustedLabel"]',
      ]) {
        const element = document.querySelector(selector) as HTMLElement;
        const rect = element.getBoundingClientRect();
        const found = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2
        );
        results.push(Boolean(found && element.contains(found)));
      }
      const frame = document.querySelector(
        '[data-test-subj="appHostGuardianFrame"]'
      ) as HTMLElement;
      return {
        button: results[0],
        label: results[1],
        frameHeight: frame.getBoundingClientRect().height,
      };
    });
    report.expect(
      T5,
      'fixed/high z-index overlay clipped; consent/Disable not covered',
      engine,
      covered.button && covered.label && covered.frameHeight === 480,
      covered
    );
    // External-site embedding of the trusted page fails frame-ancestors.
    const external = await context.newPage();
    await external.goto(
      `${ctx.receiver.origin}/embed-page?src=${encodeURIComponent(`${ctx.kibana}${APP_URL}`)}`
    );
    await sleep(4000);
    const embedded = external.frames().find((frame) => frame.url().startsWith(ctx.kibana));
    const embeddedText = embedded
      ? await embedded
          .locator('body')
          .innerText()
          .catch(() => '')
      : '';
    report.expect(
      T5,
      'external site cannot embed the host page (frame-ancestors self)',
      engine,
      !embeddedText.includes('Third-party app'),
      { frameUrl: embedded?.url().slice(0, 80) ?? null }
    );
    await external.close();
    // F1: navigating the parent (guardian) in each variant, one fresh frame each.
    for (const variant of PARENT_NAVIGATIONS) {
      child = await freshBound(page, ctx);
      const guardianBefore = guardianFrame(page)?.url();
      const result = String(await runOn(child, 'parentNavigation', variant));
      await sleep(1500);
      const guardianAfter = guardianFrame(page)?.url();
      const status = await frameStatus(page);
      const hits = ctx.receiver.count(`parentnav-${variant}`);
      report.expect(
        T5,
        `F1 frame navigating its parent (${variant}): denied, guardian not replaced`,
        engine,
        hits === 0 &&
          page.url() === topUrl &&
          ((guardianAfter === guardianBefore && status === 'bound') ||
            /ended: guardian_reloaded/.test(status)),
        { result, hits, guardianUnchanged: guardianAfter === guardianBefore, status }
      );
    }
    // Same-document fragment navigation: engine-specific iframe load behaviour (diagnostic).
    const fresh = await context.newPage();
    await openAndAllow(fresh, ctx.kibana);
    await waitForStatus(fresh, /^bound$/);
    const freshChild = await waitForChild(fresh);
    await waitProbe(freshChild);
    await freshChild
      .evaluate(() =>
        (
          window as unknown as { __probe: { run: Record<string, (m: string) => string> } }
        ).__probe.run.ping('ping-diag')
      )
      .catch(() => undefined);
    await sleep(1500);
    report.add(T5, 'same-document fragment navigation (a[ping] click)', engine, 'DIAGNOSTIC', {
      status: await frameStatus(fresh),
      pingHits: ctx.receiver.count('ping-diag'),
    });
  } finally {
    await s.close();
  }
};

const HOSTILE = 'ui/fixtures/hostile.ts';

export const ensureHostile = async (ctx: SuiteContext) => {
  if (ctx.currentEntry !== HOSTILE) await release(ctx, { entry: HOSTILE });
};

export const runT5 = async (ctx: SuiteContext) => {
  await ensureHostile(ctx);
  for (const engine of ctx.engines) {
    await ctx.report.guard(T5, 'browser', engine, () => runT5Engine(ctx, engine));
    await ctx.report.guard(T5, 'history', engine, () => runHistory(ctx, engine));
  }
};

const T6 = 'T6';

/** Counts message-handler invocations per frame (installed in every frame before any script). */
export const MESSAGE_COUNTER = `(() => {
  // F6: in the top window, also record who registered each message listener (registration stack
  // and the listener's source head), so the listener that runs during the flood is identified.
  const counts = { message: 0, listeners: 0, sources: [] };
  Object.defineProperty(window, '__msgCounter', { value: counts });
  const original = EventTarget.prototype.addEventListener;
  const wrapped = new WeakMap();
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === 'message' && this === window && typeof listener === 'function') {
      counts.listeners += 1;
      if (window === window.top) {
        counts.sources.push({
          stack: String(new Error().stack).split('\\n').slice(1, 8).map((l) => l.trim().slice(0, 200)),
          fn: String(listener).slice(0, 600),
        });
      }
      const wrapper = function (event) { counts.message += 1; return listener.call(this, event); };
      wrapped.set(listener, wrapper);
      return original.call(this, type, wrapper, options);
    }
    return original.call(this, type, listener, options);
  };
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (type === 'message' && this === window && wrapped.has(listener)) {
      counts.listeners -= 1;
      return remove.call(this, type, wrapped.get(listener), options);
    }
    return remove.call(this, type, listener, options);
  };
  window.__seen = [];
  original.call(window, 'message', (event) => {
    try { if (event.data && typeof event.data === 'object') window.__seen.push(event.data); } catch (e) {}
  });
})();`;

const counter = (frame: Frame | Page) =>
  frame.evaluate(
    () =>
      (window as unknown as { __msgCounter: { message: number; listeners: number } }).__msgCounter
  );

/** Holds the frame document request so the guardian sits in its await_child state. */
const holdFrameDocument = async (page: Page) => {
  let unblock: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  await page.route(
    /\/api\/app_host\/ui\/alert-digest\/[0-9a-f]{64}\/frame$/,
    async (route: Route) => {
      await held;
      await route.continue();
    }
  );
  return () => unblock?.();
};

const bootstrapVariant = async (page: Page, replace: (source: string) => string) => {
  await page.route(/\/api\/app_host\/ui_assets\/host-child\.js$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: replace(await response.text()) });
  });
};

const runT6Engine = async (ctx: SuiteContext, engine: string) => {
  const { report } = ctx;
  // (a) spoofing during the handshake window + correct-child positive control.
  {
    const s = await session(ctx, engine, ctx.users.viewer, MESSAGE_COUNTER);
    try {
      const { page } = s;
      const executes: string[] = [];
      page.on('request', (request) => {
        if (/\/leases\/[^/]+\/execute$/.test(request.url())) executes.push(request.url());
      });
      const releaseFrame = await holdFrameDocument(page);
      await openAndAllow(page, ctx.kibana);
      const started = Date.now();
      let guardian = guardianFrame(page);
      while (!guardian && Date.now() - started < 30_000) {
        await sleep(100);
        guardian = guardianFrame(page);
      }
      if (!guardian) throw new Error('guardian did not load');
      await guardian.waitForSelector('iframe', { state: 'attached' });
      // Sibling opaque frame inside the guardian document (origin "null" too).
      await guardian.evaluate(() => {
        const sibling = document.createElement('iframe');
        sibling.setAttribute('sandbox', 'allow-scripts');
        sibling.id = 'sibling';
        sibling.srcdoc = '<p>sibling</p>';
        document.body.append(sibling);
      });
      await sleep(500);
      const sibling = page
        .frames()
        .find((frame) => frame.parentFrame() === guardian && frame.url() === 'about:srcdoc');
      const siblingResult = await sibling?.evaluate(() => {
        const got: unknown[] = [];
        window.addEventListener('message', (event) => got.push(event.data));
        (window as unknown as { __got: unknown[] }).__got = got;
        const channel = new MessageChannel();
        window.parent.postMessage({ t: 'ready', p: 'app_host.ui.v1', c: 'guess' }, '*');
        window.parent.postMessage({ t: 'init', p: 'app_host.ui.v1', c: 'x'.repeat(43) }, '*', [
          channel.port1,
          channel.port2,
        ]);
        return self.origin;
      });
      // Unrelated window: a popup of the top page posts into the guardian.
      const [popup] = await Promise.all([
        s.context.waitForEvent('page'),
        page.evaluate(() => {
          window.open('about:blank', 'unrelated');
        }),
      ]);
      await popup.evaluate(() => {
        const channel = new MessageChannel();
        const target = (window.opener as Window).document.querySelector(
          '[data-test-subj="appHostGuardianFrame"]'
        ) as HTMLIFrameElement;
        target.contentWindow?.postMessage({ t: 'ready', p: 'app_host.ui.v1', c: 'x' }, '*', [
          channel.port1,
        ]);
        target.contentWindow?.postMessage(
          { t: 'init', p: 'app_host.ui.v1', c: 'y'.repeat(43) },
          '*',
          [channel.port2]
        );
      });
      await popup.close();
      await sleep(500);
      const executesDuringSpoof = executes.length;
      releaseFrame();
      await waitForStatus(page, /^bound$/);
      const child = await waitForChild(page);
      await child.waitForSelector('#ui-version', { timeout: 20_000 });
      const siblingGot =
        (await sibling?.evaluate(
          () => (window as unknown as { __got: Array<{ t?: string }> }).__got
        )) ?? [];
      report.expect(
        T6,
        'positive control: correct child binds despite spoof attempts',
        engine,
        (await frameStatus(page)) === 'bound',
        { siblingOrigin: siblingResult }
      );
      report.expect(
        T6,
        'sibling opaque frame and unrelated window receive no capability',
        engine,
        siblingGot.every((data) => data?.t !== 'port') && executesDuringSpoof === 0,
        { siblingMessages: siblingGot.length, executesDuringSpoof }
      );

      // S4: post-handshake flood, 1,000 x 1 MiB to the guardian and to top.
      const guardianBefore = await counter(guardian);
      const topBefore = await counter(page);
      const probe = await waitProbe(child);
      const flood = await child.evaluate(() =>
        (
          window as unknown as { __probe: { run: Record<string, () => Promise<string>> } }
        ).__probe.run.flood()
      );
      await sleep(3000);
      const guardianAfter = await counter(guardian);
      const topAfter = await counter(page);
      report.expect(
        T6,
        'S4 flood: guardian handler never runs after handshake (listener removed)',
        engine,
        guardianAfter.message === guardianBefore.message && guardianAfter.listeners === 0,
        { flood, guardianBefore, guardianAfter }
      );
      report.add(
        T6,
        'S4 flood: Kibana top-window message handlers (App Host registers none)',
        engine,
        'DIAGNOSTIC',
        {
          topHandlerInvocations: topAfter.message - topBefore.message,
          topListeners: topAfter.listeners,
          // F6 listener inventory (registration stack + source head of each top-window listener).
          topListenerSources: (topAfter as { sources?: unknown }).sources,
        }
      );
      report.expect(
        T6,
        'injected replacement port / spoofed ready after bind: no rebind',
        engine,
        (await frameStatus(page)) === 'bound' && (probe.bridge.afterSpoof ?? '').startsWith('ok'),
        { afterSpoof: probe.bridge.afterSpoof }
      );
      // A second child load revokes; nothing is rebound.
      await child
        .evaluate(() =>
          (
            window as unknown as { __probe: { run: Record<string, () => string> } }
          ).__probe.run.reload()
        )
        .catch(() => undefined);
      await waitForStatus(page, /ended: child_reloaded/, 15_000);
      report.expect(
        T6,
        'second child load revokes (no rebind); frame removed',
        engine,
        (await page.locator('[data-test-subj="appHostGuardianFrame"]').count()) === 0,
        await frameStatus(page)
      );
    } finally {
      await s.close();
    }
  }
  // (b) wrong challenge from the actual child.
  {
    const s = await session(ctx, engine, ctx.users.viewer);
    try {
      const { page } = s;
      const uiLoads: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes(`/ui_assets/${ctx.current?.ui.digest}.js`))
          uiLoads.push(request.url());
      });
      await bootstrapVariant(page, (source) =>
        source.replace(
          "{ t: 'ready', p: PROTOCOL, c: challenge }",
          "{ t: 'ready', p: PROTOCOL, c: challenge + 'x' }"
        )
      );
      await openAndAllow(page, ctx.kibana);
      await waitForStatus(page, /ended: bad_ready/, 20_000);
      report.expect(
        T6,
        'wrong challenge → revoked, no port, UI bundle never fetched',
        engine,
        uiLoads.length === 0,
        { status: await frameStatus(page), uiLoads: uiLoads.length }
      );
    } finally {
      await s.close();
    }
  }
  // (c) stale ready: a challenge captured from an earlier document is replayed.
  {
    const s = await session(ctx, engine, ctx.users.viewer, MESSAGE_COUNTER);
    let stale = '';
    try {
      const { page } = s;
      await openAndAllow(page, ctx.kibana);
      await waitForStatus(page, /^bound$/);
      const child = await waitForChild(page);
      const seen =
        (await child.evaluate(
          () => (window as unknown as { __seen: Array<{ t?: string; c?: string }> }).__seen
        )) ?? [];
      stale = seen.find((data) => data.t === 'challenge')?.c ?? '';
      await page.reload();
      await bootstrapVariant(page, (source) =>
        source.replace(
          "{ t: 'ready', p: PROTOCOL, c: challenge }",
          `{ t: 'ready', p: PROTOCOL, c: ${JSON.stringify(stale)} }`
        )
      );
      await openAndAllow(page, ctx.kibana);
      await waitForStatus(page, /ended: bad_ready/, 20_000);
      report.expect(
        T6,
        'stale ready (replayed challenge) → revoked',
        engine,
        stale.length >= 32,
        await frameStatus(page)
      );
    } finally {
      await s.close();
    }
  }
};

export const runT6 = async (ctx: SuiteContext) => {
  await ensureHostile(ctx);
  for (const engine of ctx.engines)
    await ctx.report.guard(T6, 'browser', engine, () => runT6Engine(ctx, engine));
};
