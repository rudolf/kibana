/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// W1/W2: the bridge runs in a dedicated Worker per app frame.
// W1: the Kibana main thread stays responsive while the app floods the bridge; a receive-queue
// overflow terminates the Worker and the frame, and the page keeps working; the Worker loads under
// its composed CSP and that policy is enforced. W2: the session handle never appears in the page's
// JS-visible state, in any window, port or Worker message, or (Chromium) anywhere in the page's
// heap. DIAGNOSTIC: whether a CPU-busy loop in the frame itself blocks the Kibana main thread.

import type { Frame, Page, Worker } from '@playwright/test';
import { scanSurfaces, type Surface } from '../leak_scan';
import { frameStatus, sleep, waitForStatus } from '../ui_harness';
import { kfetch, session, type SuiteContext } from './context';
import { workerPolicyFor } from './t1_shell';
import { ensureHostile, waitProbe } from './t5_t6_browser';
import {
  POST_RECORDER,
  handleNeedles,
  handlesFromResponses,
  openBound,
  runIn,
} from './u3_adversarial';

const W1 = 'W1';
const W2 = 'W2';
const DIAG = 'W-diag';
const WORKER_SCRIPT = /\/api\/app_host\/ui_assets\/host-bridge-worker\.js$/;
const WINDOW_MS = 4000;

interface LagStats {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

// Browser-side code is passed as source text: the tsx loader would otherwise inject its `__name`
// helper into functions serialized for page, frame and Worker evaluation.

/** Event-loop delay on the page's main thread: lateness of a 10 ms timer chain. */
const SAMPLER = `(() => {
  const samples = [];
  let last = performance.now();
  let running = true;
  const tick = () => {
    const now = performance.now();
    samples.push(Math.max(0, now - last - 10));
    last = now;
    if (running) setTimeout(tick, 10);
  };
  setTimeout(tick, 10);
  window.__lag = () => {
    running = false;
    return samples;
  };
})()`;

const startSampler = (page: Page) => page.evaluate(SAMPLER);

const stopSampler = async (page: Page): Promise<LagStats> => {
  const samples = (await page.evaluate('window.__lag()')) as number[];
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
  return {
    samples: samples.length,
    p50: at(0.5),
    p95: at(0.95),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
  };
};

const measure = async (page: Page, during: () => Promise<unknown>) => {
  await startSampler(page);
  const result = await during();
  return { lag: await stopSampler(page), result };
};

const bridgeWorker = (page: Page): Worker | undefined =>
  page.workers().find((worker) => WORKER_SCRIPT.test(worker.url()));

const child = async (page: Page, ctx: SuiteContext): Promise<Frame> => {
  const frame = await openBound(page, ctx);
  await waitProbe(frame);
  return frame;
};

// ---------------------------------------------------------------- W1
const runW1Engine = async (ctx: SuiteContext, engine: string) => {
  const { report, users } = ctx;
  const s = await session(ctx, engine, users.viewer);
  try {
    let workerHeaders: Record<string, string> | undefined;
    s.page.on('response', (response) => {
      if (WORKER_SCRIPT.test(response.url())) workerHeaders = response.headers();
    });
    const closed: string[] = [];
    s.page.on('worker', (worker) => worker.on('close', () => closed.push(worker.url())));
    const frame = await child(s.page, ctx);
    const worker = bridgeWorker(s.page);

    // The Worker loads under its composed CSP (Core's policy plus the Worker policy). Only Firefox
    // reports the Worker's script response to the page; otherwise the served headers are checked.
    const served = await kfetch(ctx, '/api/app_host/ui_assets/host-bridge-worker.js');
    const csp = (workerHeaders ?? served.headers)['content-security-policy'] ?? '';
    const policies = csp.split(',').map((policy) => policy.trim());
    report.expect(
      W1,
      "bridge Worker loaded from the host asset under Core's policy plus the Worker policy",
      engine,
      Boolean(worker) &&
        policies.length === 2 &&
        /script-src 'self'/.test(policies[0]) &&
        policies[1] === workerPolicyFor(ctx),
      { worker: worker?.url(), headersFrom: workerHeaders ? 'browser' : 'served', policies }
    );
    if (worker) {
      const marker = `w1-${engine}-${Date.now()}`;
      const probe = await worker
        .evaluate(
          `(async () => {
            const attempt = async (run) => {
              try {
                return 'allowed:' + String(await run());
              } catch (error) {
                return 'blocked:' + error.name;
              }
            };
            return {
              execute: await attempt(() =>
                fetch('/internal/app_host/ui/execute', {
                  method: 'POST',
                  headers: { 'kbn-xsrf': 'w1', 'content-type': 'application/json' },
                  body: '{}',
                }).then((response) => response.status)
              ),
              status: await attempt(() => fetch('/api/status').then((response) => response.status)),
              receiver: await attempt(() =>
                fetch(${JSON.stringify(
                  `${ctx.receiver.origin}/w1?m=${marker}`
                )}, { mode: 'no-cors' })
                  .then(() => 'sent')
              ),
              importGuardian: await attempt(async () =>
                importScripts('/api/app_host/ui_assets/host-guardian.js')
              ),
            };
          })()`
        )
        .catch((error) => ({ error: String(error).slice(0, 200) }));
      await sleep(500);
      const hits = ctx.receiver.hits.filter(({ path }) => path.includes(marker)).length;
      const p = probe as Record<string, string>;
      report.expect(
        W1,
        'Worker CSP enforced: only the execute/session routes are reachable (control: execute answers); /api/status, the receiver and other scripts are blocked',
        engine,
        /^allowed:4\d\d$/.test(p.execute ?? '') &&
          /^blocked/.test(p.status ?? '') &&
          /^blocked/.test(p.receiver ?? '') &&
          /^blocked/.test(p.importGuardian ?? '') &&
          hits === 0,
        { ...p, receiverHits: hits }
      );
    }

    // Responsiveness: idle control, positive control (the sampler sees a busy page), then the flood.
    const idle = await measure(s.page, () => sleep(WINDOW_MS));
    const busy = await measure(s.page, async () => {
      await s.page.evaluate(
        'setTimeout(() => { const end = performance.now() + 300; while (performance.now() < end) {} }, 200)'
      );
      await sleep(1500);
    });
    report.expect(
      W1,
      'sampler positive control: a 300 ms busy loop on the page is seen (max lag ≥ 250 ms)',
      engine,
      busy.lag.max >= 250,
      busy.lag
    );
    const flood = await measure(s.page, () => runIn(frame, 'spam', String(WINDOW_MS)));
    const spam = String(flood.result);
    const [, calls, refused, themes] = /calls=(\d+) refused=(\d+) themes=(\d+)/.exec(spam) ?? [];
    report.expect(
      W1,
      'flood (16-call bursts: 8 calls with a 256 KiB argument the Worker parses and refuses, 8 valid calls it answers): Kibana main-thread delay stays within the idle control (p95 ≤ idle p95 + 25 ms, max ≤ 150 ms) and the frame stays bound',
      engine,
      Number(calls) >= 160 &&
        Number(refused) + Number(themes) === Number(calls) &&
        flood.lag.p95 <= idle.lag.p95 + 25 &&
        flood.lag.max <= 150 &&
        (await frameStatus(s.page)) === 'bound',
      { idle: idle.lag, flood: flood.lag, spam }
    );

    // Queue overflow: one frame past the byte bound ends the Worker and the frame.
    const overflow = await measure(s.page, async () => {
      await runIn(frame, 'overflow', '');
      await waitForStatus(s.page, /^ended: /, 10_000).catch(() => undefined);
      await sleep(500);
    });
    const status = await frameStatus(s.page);
    report.expect(
      W1,
      'receive-queue overflow (10 MiB frame): the Worker is terminated and the frame torn down (protocol_error (queue_overflow))',
      engine,
      status === 'ended: protocol_error (queue_overflow)' &&
        closed.some((url) => WORKER_SCRIPT.test(url)) &&
        !bridgeWorker(s.page) &&
        s.page.frames().length === 1,
      { status, closedWorkers: closed.length, frames: s.page.frames().length, lag: overflow.lag }
    );
    const kibana = await s.page.evaluate(
      "fetch('/api/status').then((response) => response.status)"
    );
    await s.page.locator('[data-test-subj="appHostAllowVersion"]').click();
    await waitForStatus(s.page, /^bound$/);
    report.expect(
      W1,
      'after the overflow the Kibana page keeps working: its API answers and a new consent binds a fresh Worker and frame',
      engine,
      kibana === 200 && Boolean(bridgeWorker(s.page)) && (await frameStatus(s.page)) === 'bound',
      { kibanaStatus: kibana, status: await frameStatus(s.page) }
    );

    // Honest limitation: the frame's own CPU. Same-site frames may share the page's main thread.
    const fresh = await child(s.page, ctx).catch(() => undefined);
    if (fresh) {
      const loop = await measure(s.page, async () => {
        await runIn(fresh, 'busySoon', '2000');
        await sleep(3000);
      });
      report.add(
        DIAG,
        'a 2 s CPU-busy loop in the app frame itself vs the Kibana main thread',
        engine,
        'DIAGNOSTIC',
        {
          idle: idle.lag,
          frameLoop: loop.lag,
          blocksKibanaMainThread: loop.lag.max >= 1000,
        }
      );
    }
  } finally {
    await s.close();
  }
};

// ---------------------------------------------------------------- W2
/**
 * Every run of ≥ 40 base64url characters (any handle's encrypted segment is one) in the strings on
 * the page's JS-visible object graph: globals, DOM expandos such as React fibers, storage, cookies
 * and markup. The needles never enter the page: they are matched in Node.
 */
const COLLECT = `(() => {
  const found = new Set();
  const RUN = /[A-Za-z0-9_-]{40,2048}/g;
  const consider = (value) => {
    if (value.length < 40) return;
    for (const [run] of value.matchAll(RUN)) {
      if (found.size < 200000) found.add(run);
    }
  };
  // Breadth-first over own data properties (no getters run), from window and every element.
  const seen = new WeakSet();
  const queue = [window, ...document.querySelectorAll('*')];
  const enqueue = (value) => {
    if (typeof value === 'string') consider(value);
    else if (
      value !== null &&
      (typeof value === 'object' || typeof value === 'function') &&
      !ArrayBuffer.isView(value) &&
      !(value instanceof ArrayBuffer) &&
      !seen.has(value)
    ) {
      seen.add(value);
      queue.push(value);
    }
  };
  let head = 0;
  for (; head < queue.length && head < 300000; head++) {
    const value = queue[head];
    queue[head] = undefined;
    let names = [];
    try {
      names = Object.getOwnPropertyNames(value);
    } catch (error) {
      continue;
    }
    for (const name of names) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (descriptor && 'value' in descriptor) enqueue(descriptor.value);
      } catch (error) {
        // cross-origin or exotic
      }
    }
    if (value instanceof Map || value instanceof Set) {
      value.forEach((entry, key) => {
        enqueue(entry);
        enqueue(key);
      });
    }
  }
  const visited = head;
  // Storage and cookies throw in the opaque app frame.
  try {
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i) || '';
        consider(key);
        consider(store.getItem(key) || '');
      }
    }
  } catch (error) {
    // not available in this frame
  }
  try {
    consider(document.cookie);
  } catch (error) {
    // not available in this frame
  }
  consider(document.documentElement.outerHTML);
  return { strings: [...found], visited };
})()`;

const collectCandidates = (frame: Frame) =>
  frame.evaluate(COLLECT) as Promise<{ strings: string[]; visited: number }>;

/** Chromium only: streams a heap snapshot of the page's main isolate and reports which needles occur. */
const heapContains = async (page: Page, needles: readonly string[]) => {
  const cdp = await page.context().newCDPSession(page);
  const longest = Math.max(...needles.map((needle) => needle.length));
  const hits = new Set<string>();
  let tail = '';
  let bytes = 0;
  cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }: { chunk: string }) => {
    const text = tail + chunk;
    bytes += chunk.length;
    needles.forEach((needle) => {
      if (text.includes(needle)) hits.add(needle);
    });
    tail = text.slice(-longest);
  });
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  await cdp.detach();
  return { hits: needles.map((needle) => hits.has(needle)), bytes };
};

const reversed = (value: string) => [...value].reverse().join('');

const runW2Engine = async (ctx: SuiteContext, engine: string) => {
  const { report, users } = ctx;
  const s = await session(ctx, engine, users.viewer, POST_RECORDER);
  try {
    const handles = handlesFromResponses(s.page);
    // The hostile auto-run has made summary, search, dashboard and refused calls through the bridge.
    await child(s.page, ctx);
    await sleep(500);
    const needles = handleNeedles(handles);
    report.expect(
      W2,
      'control: the Worker minted a handle (captured from its session response)',
      engine,
      handles.length > 0,
      { handles: handles.length }
    );

    // Every window, port and Worker message, in every frame.
    const posted: Surface[] = [];
    for (const [index, each] of s.page.frames().entries()) {
      const messages = (await each.evaluate('window.__posted || []').catch(() => [])) as string[];
      messages.forEach((text, i) => posted.push({ where: `frame${index}-message${i}`, text }));
    }
    const workerNotices = posted.filter(({ text }) => /"t":"(ready|end)"/.test(text ?? '')).length;
    const messages = scanSurfaces(posted, needles);
    report.add(
      W2,
      'no handle in any window, port or Worker message (parent ↔ guardian ↔ app, app ↔ Worker, Worker → page)',
      engine,
      handles.length === 0 || workerNotices === 0 ? 'NOT_VERIFIED' : messages.status,
      { messages: posted.length, workerNotices, hits: messages.hits.length }
    );

    // JS-visible state of the page (and the guardian), with a positive control hidden in a DOM expando.
    const decoy = reversed(needles[1] ?? needles[0] ?? 'x'.repeat(48));
    await s.page.evaluate(
      `Object.assign(document.querySelector('[data-test-subj="appHostFrameContainer"]') || document.body, { __w2: { state: { nested: [${JSON.stringify(
        decoy
      )}] } } })`
    );
    const surfaces: Surface[] = [];
    let visited = 0;
    for (const [index, each] of s.page.frames().entries()) {
      const collected = await collectCandidates(each).catch(() => undefined);
      visited += collected?.visited ?? 0;
      surfaces.push({ where: `frame${index}-js-state`, text: collected?.strings.join('\n') });
    }
    const control = scanSurfaces(surfaces, [decoy]);
    const state = scanSurfaces(surfaces, needles);
    report.expect(
      W2,
      'state scanner positive control: a value hidden in a DOM expando is found',
      engine,
      control.status === 'FAIL',
      { visitedObjects: visited }
    );
    report.add(
      W2,
      "no handle in the page's JS-visible state (globals, DOM expandos incl. React state, storage, cookies, markup) in any frame",
      engine,
      handles.length === 0 ? 'NOT_VERIFIED' : state.status,
      { visitedObjects: visited, hits: state.hits }
    );

    if (engine === 'chromium') {
      const heap = await heapContains(s.page, [decoy, ...needles]);
      const [decoyFound, ...needleHits] = heap.hits;
      report.expect(
        W2,
        "Chromium heap snapshot of the page's main isolate: positive control found, no handle anywhere",
        engine,
        handles.length > 0 && decoyFound && needleHits.every((hit) => !hit),
        { snapshotChars: heap.bytes, decoyFound, handleHits: needleHits.filter(Boolean).length }
      );
    }
  } finally {
    await s.close();
  }
};

/** W1, W2 and the frame-CPU diagnostic (`--suites w`). */
export const runW = async (ctx: SuiteContext) => {
  await ensureHostile(ctx);
  for (const engine of ctx.engines) {
    await ctx.report.guard(W1, 'browser', engine, () => runW1Engine(ctx, engine));
    await ctx.report.guard(W2, 'browser', engine, () => runW2Engine(ctx, engine));
  }
};
