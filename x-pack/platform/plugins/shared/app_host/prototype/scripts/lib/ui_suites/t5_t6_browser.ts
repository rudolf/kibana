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
    // Real user activation inside the frame.
    for (const id of [
      'click-popup',
      'click-top',
      'click-fullscreen',
      'click-download',
      'click-top-link',
      'click-form',
    ]) {
      await child.click(`#${id}`).catch(() => undefined);
      await sleep(700);
    }
    const after = await readProbe(child).catch(() => undefined);
    const fullscreen = await page.evaluate(() => Boolean(document.fullscreenElement));
    report.expect(
      T5,
      'with a real click: no popup, download, fullscreen, top navigation or form',
      engine,
      popups.length === 0 &&
        downloads.length === 0 &&
        !fullscreen &&
        page.url() === topUrl &&
        ctx.receiver.count('clickpopup') +
          ctx.receiver.count('clicktop') +
          ctx.receiver.count('clickform') ===
          0,
      {
        popups,
        downloads,
        fullscreen,
        url: page.url() === topUrl,
        clicks: after?.results && {
          popup: after.results.clickPopup,
          top: after.results.clickTop,
          fullscreen: after.results.clickFullscreen,
          form: after.results.clickForm,
        },
      }
    );
    // Some engines turn a blocked click action into a child reload, which the guardian revokes;
    // record it, then continue on a fresh frame.
    report.add(T5, 'frame state after blocked click actions', engine, 'DIAGNOSTIC', {
      status: await frameStatus(page),
    });
    if (!/^bound$/.test(await frameStatus(page))) {
      await page.reload();
      await openAndAllow(page, ctx.kibana);
      await waitForStatus(page, /^bound$/);
      child = await waitForChild(page);
      await waitProbe(child);
    }
    const top = await child.evaluate(() =>
      (
        window as unknown as { __probe: { run: Record<string, (m: string) => string> } }
      ).__probe.run.topNavigation('topnav-noclick')
    );
    await sleep(800);
    report.expect(
      T5,
      'top location assignment without click blocked, top URL unchanged',
      engine,
      page.url() === topUrl && ctx.receiver.count('topnav-noclick') === 0,
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
    // Joint session history: diagnostic only, never claimed as blocked.
    const historyBefore = page.url();
    await child
      .evaluate(() =>
        (
          window as unknown as { __probe: { run: Record<string, () => string> } }
        ).__probe.run.historyBack()
      )
      .catch(() => undefined);
    await sleep(1500);
    report.add(T5, 'history.back() from frame (joint history)', engine, 'DIAGNOSTIC', {
      topUrlChanged: page.url() !== historyBefore,
      status: await frameStatus(page).catch(() => 'page navigated'),
    });
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
  for (const engine of ctx.engines)
    await ctx.report.guard(T5, 'browser', engine, () => runT5Engine(ctx, engine));
};

const T6 = 'T6';

/** Counts message-handler invocations per frame (installed in every frame before any script). */
export const MESSAGE_COUNTER = `(() => {
  const counts = { message: 0, listeners: 0 };
  Object.defineProperty(window, '__msgCounter', { value: counts });
  const original = EventTarget.prototype.addEventListener;
  const wrapped = new WeakMap();
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === 'message' && this === window && typeof listener === 'function') {
      counts.listeners += 1;
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
