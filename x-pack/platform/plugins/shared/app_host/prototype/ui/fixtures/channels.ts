/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// T4 resource-channel probes, shared verbatim by the hostile app frame and by the harness's
// positive-control page (an ordinary page with no app policy). Each channel runs on its own with a
// unique marker; policy violations are attributed to the channel whose marker they name, or else to
// the channel running when they fired. Results are evidence only; the harness decides.

export const CHANNELS = [
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
  'dynimport',
  'script',
] as const;
export type Channel = (typeof CHANNELS)[number];

export interface ChannelEvidence {
  readonly marker: string;
  /** Synchronous throw or rejection name, `ok:<detail>` when the API call itself returned. */
  outcome: string;
  /** `effectiveDirective|blockedURI` of CSP violations attributed to this channel. */
  readonly violations: string[];
}

export interface ChannelRun {
  readonly prefix: string;
  readonly channels: Record<string, ChannelEvidence>;
}

const SLOW = new Set<string>(['object', 'embed', 'nestedframe', 'font', 'video', 'audio']);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Inserts markup through a deliberately unsafe renderer (DOMParser + importNode). */
const insert = (html: string): HTMLElement => {
  const holder = document.createElement('div');
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  holder.append(
    ...Array.from(parsed.body.childNodes).map((node) => document.importNode(node, true))
  );
  document.body.append(holder);
  // Force layout: some engines start <object>/<embed> loads only at the next layout.
  void holder.getBoundingClientRect();
  void document.body.offsetHeight;
  return holder;
};

const errorName = (error: unknown): string =>
  `thrown:${(error as Error)?.name ?? 'Error'}`.slice(0, 60);

/**
 * Runs every channel against `base` (`<origin>` of the target); each request URL carries
 * `m=<prefix>-<channel>`. `only` restricts the run to a subset.
 */
export const runChannels = async (
  base: string,
  prefix: string,
  only: readonly string[] = CHANNELS
): Promise<ChannelRun> => {
  const channels: Record<string, ChannelEvidence> = {};
  let current = '';
  const url = (channel: string, path = 'hit') => `${base}/${path}?m=${prefix}-${channel}`;
  const onViolation = (event: SecurityPolicyViolationEvent) => {
    const named = Object.keys(channels).find((channel) =>
      event.blockedURI.includes(`${prefix}-${channel}`)
    );
    const owner = named ?? current;
    channels[owner]?.violations.push(
      `${event.effectiveDirective}|${event.blockedURI}`.slice(0, 200)
    );
  };
  document.addEventListener('securitypolicyviolation', onViolation, true);
  const actions: Record<Channel, () => unknown> = {
    fetch: () => fetch(url('fetch'), { credentials: 'include' }).then((r) => `ok:${r.status}`),
    fetchnocors: () =>
      fetch(url('fetchnocors'), { mode: 'no-cors', credentials: 'include' }).then(
        (r) => `ok:${r.type}`
      ),
    xhr: () =>
      new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url('xhr'));
        xhr.withCredentials = true;
        xhr.onload = () => resolve(`ok:${xhr.status}`);
        xhr.onerror = () => resolve('error-event');
        xhr.send();
      }),
    ws: () =>
      new Promise((resolve) => {
        const socket = new WebSocket(url('ws').replace(/^http/, 'ws'));
        socket.onopen = () => resolve('ok:open');
        socket.onerror = () => resolve('error-event');
      }),
    beacon: () => `ok:${navigator.sendBeacon(url('beacon'), 'data')}`,
    sse: () =>
      new Promise((resolve) => {
        const source = new EventSource(url('sse'));
        source.onopen = () => resolve('ok:open');
        source.onerror = () => {
          source.close();
          resolve('error-event');
        };
      }),
    img: () => insert(`<img src="${url('img')}">`),
    cssimport: () => insert(`<style>@import url("${url('cssimport')}");</style>`),
    cssbg: () =>
      insert(`<div style="background:url('${url('cssbg')}');width:10px;height:10px"></div>`),
    font: () =>
      insert(
        `<style>@font-face{font-family:p_${prefix.replace(/\W/g, '')};src:url("${url(
          'font'
        )}")}</style><span style="font-family:p_${prefix.replace(/\W/g, '')}">font probe</span>`
      ),
    video: () => insert(`<video preload="auto" src="${url('video')}"></video>`),
    audio: () => insert(`<audio preload="auto" src="${url('audio')}"></audio>`),
    object: () => insert(`<object data="${url('object')}"></object>`),
    embed: () => insert(`<embed src="${url('embed')}">`),
    nestedframe: () => insert(`<iframe src="${url('nestedframe')}"></iframe>`),
    prefetch: () => insert(`<link rel="prefetch" href="${url('prefetch')}">`),
    stylesheet: () => insert(`<link rel="stylesheet" href="${url('stylesheet')}">`),
    worker: () =>
      new Promise((resolve) => {
        const worker = new Worker(url('worker', 'w.js'));
        worker.onerror = () => resolve('error-event');
        setTimeout(() => resolve('ok:no-error'), 1500);
      }),
    sharedworker: () =>
      new Promise((resolve) => {
        const worker = new SharedWorker(url('sharedworker', 'w.js'));
        worker.onerror = () => resolve('error-event');
        setTimeout(() => resolve('ok:no-error'), 1500);
      }),
    dynimport: () => import(/* @vite-ignore */ url('dynimport', 'mod.js')),
    script: () =>
      new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = url('script', 'evil.js');
        script.onload = () => resolve('ok:loaded');
        script.onerror = () => resolve('error-event');
        document.head.append(script);
      }),
  };
  try {
    for (const channel of CHANNELS) {
      if (!only.includes(channel)) continue;
      current = channel;
      const evidence: ChannelEvidence = {
        marker: `${prefix}-${channel}`,
        outcome: 'pending',
        violations: [],
      };
      channels[channel] = evidence;
      try {
        const value = await Promise.race([
          Promise.resolve().then(actions[channel]),
          sleep(2000).then(() => 'timeout'),
        ]);
        evidence.outcome =
          typeof value === 'string'
            ? value.slice(0, 60)
            : value instanceof HTMLElement
            ? 'inserted'
            : 'ok';
      } catch (error) {
        evidence.outcome = errorName(error);
      }
      // Plugin/frame/media elements report their violation late; wait longer before moving on.
      await sleep(SLOW.has(channel) ? 1500 : 400);
    }
    // Late violations (fonts, media) still carry their marker in blockedURI.
    current = '';
    await sleep(1000);
  } finally {
    document.removeEventListener('securitypolicyviolation', onViolation, true);
  }
  return { prefix, channels };
};
