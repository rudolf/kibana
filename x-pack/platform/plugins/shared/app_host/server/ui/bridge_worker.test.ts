/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createContext, runInContext } from 'node:vm';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { RpcSession, type RpcTransport } from 'capnweb';
import type { BridgeWorkerInit, BridgeWorkerNotice } from '../../common/ui_protocol';
import { CAPNWEB_ASSET_FILE, UI_LIMITS } from '../../common/ui_protocol';
import { BRIDGE_WORKER_SCRIPT, capnwebWorkerScript } from './host_scripts';

const INIT: BridgeWorkerInit = {
  t: 'init',
  appId: 'alert-digest',
  releaseDigest: 'a'.repeat(64),
  theme: {
    mode: 'light',
    colors: { background: '#fff', text: '#000', border: '#ccc', primary: '#07c', danger: '#c00' },
  },
  sessionUrl: '/base/internal/app_host/ui/session',
  executeUrl: '/base/internal/app_host/ui/execute',
};
const SUMMARY = {
  appId: 'alert-digest',
  version: '2.0.0',
  label: 'L',
  counts: { high: 2, low: 1 },
};

type Remote = Record<string, (...args: unknown[]) => Promise<unknown>>;
interface Reply {
  status: number;
  body: unknown;
}
interface WorkerScope {
  onmessage: ((event: { data: unknown; ports: unknown[] }) => void) | null;
  postMessage(notice: BridgeWorkerNotice): void;
  capnweb?: unknown;
}

/**
 * Runs the served Worker script in its own realm (as a Worker would), with `importScripts`
 * evaluating the served capnweb asset and a fake `fetch` whose JSON is parsed in that realm.
 */
const runWorkerScript = (
  scope: WorkerScope,
  fetch: (url: string, init: RequestInit) => Promise<Reply>
): string[] => {
  const imported: string[] = [];
  // capnweb compares prototypes against these Web API classes; none of them cross this bridge.
  const absent = () => function Absent() {};
  const context = createContext({
    setTimeout,
    URL,
    Blob: absent(),
    Headers: absent(),
    Request: absent(),
    Response: absent(),
    ReadableStream: absent(),
    WritableStream: absent(),
  });
  const realmJson = runInContext('JSON', context) as JSON;
  Object.assign(context, {
    self: scope,
    importScripts: (url: string) => {
      imported.push(url);
      runInContext(capnwebWorkerScript(), context);
    },
    fetch: async (url: string, init: RequestInit) => {
      const { status, body } = await fetch(url, init);
      return { status, json: async () => realmJson.parse(JSON.stringify(body)) };
    },
  });
  // `self` inside the script is the scope object; capnweb's wrapper assigns `self.capnweb`.
  runInContext(BRIDGE_WORKER_SCRIPT, context);
  return imported;
};

/** Guest side: a plain string transport over the other end of the channel. */
class GuestTransport implements RpcTransport {
  readonly #queue: string[] = [];
  readonly #port: MessagePort;
  #waiter: ((value: string) => void) | undefined;
  constructor(port: MessagePort) {
    this.#port = port;
    port.on('message', (data: string) => {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      if (waiter) waiter(data);
      else this.#queue.push(data);
    });
  }
  send(message: string) {
    this.#port.postMessage(message);
  }
  receive(): Promise<string> {
    const next = this.#queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => (this.#waiter = resolve));
  }
}

const reply = (status: number, body: unknown): Reply => ({ status, body });

const startWorker = (respond: (body: Record<string, unknown>) => Reply) => {
  let minted = 0;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const executed: Array<Record<string, unknown>> = [];
  const notices: BridgeWorkerNotice[] = [];
  const scope: WorkerScope = { onmessage: null, postMessage: (notice) => notices.push(notice) };
  const fetch = async (url: string, init: RequestInit): Promise<Reply> => {
    requests.push({ url, init });
    if (url === INIT.sessionUrl) return reply(200, { handle: `handle-${++minted}` });
    const body = JSON.parse(String(init.body));
    executed.push(body);
    return respond(body);
  };
  const imported = runWorkerScript(scope, fetch);
  const channel = new MessageChannel();
  scope.onmessage?.({ data: INIT, ports: [channel.port1] });
  const guest = new RpcSession<Remote>(new GuestTransport(channel.port2));
  const remote = guest.getRemoteMain() as unknown as Remote;
  const ready = async () => {
    while (notices.length === 0) await tick(5);
  };
  return {
    remote,
    channel,
    requests,
    executed,
    notices,
    imported,
    ready,
    minted: () => minted,
  };
};

const ok = () => reply(200, { ok: true, result: SUMMARY });

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return (error as Error).message;
  }
};

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe('bridge Worker script', () => {
  let open: MessageChannel[] = [];
  const track = <T extends { channel: MessageChannel }>(worker: T): T => {
    open.push(worker.channel);
    return worker;
  };
  afterEach(() => {
    open.forEach(({ port1, port2 }) => {
      port1.close();
      port2.close();
    });
    open = [];
  });

  it('imports only the capnweb host asset, mints once and sends {handle, op, params} with Kibana headers', async () => {
    const w = track(startWorker(ok));
    await w.ready();
    expect(w.imported).toEqual([CAPNWEB_ASSET_FILE]);
    expect(await w.remote.callAppRoute({ method: 'GET', path: '/summary' })).toEqual(SUMMARY);
    await w.remote.search({ index: 'kbn-apps-prototype-alerts', size: 1 });
    expect(w.minted()).toBe(1);
    expect(w.executed).toEqual([
      { handle: 'handle-1', op: 'app.summary' },
      {
        handle: 'handle-1',
        op: 'es.search',
        params: { index: 'kbn-apps-prototype-alerts', size: 1 },
      },
    ]);
    expect(JSON.parse(String(w.requests[0].init.body))).toEqual({
      appId: 'alert-digest',
      releaseDigest: 'a'.repeat(64),
    });
    for (const { init } of w.requests) {
      expect(init).toMatchObject({
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'kbn-xsrf': 'app-host-bridge',
          'x-elastic-internal-origin': 'Kibana',
        },
      });
    }
    // W2: the parent hears lifecycle only.
    expect(w.notices).toEqual([{ t: 'ready' }]);
    expect(JSON.stringify(w.notices)).not.toContain('handle-');
  });

  it('maps each method to its fixed operation and forwards results unchanged', async () => {
    const native = {
      data_view: { id: 'dv', runtimeFieldMap: { hour: { type: 'long' } }, fieldFormats: {} },
    };
    const w = track(startWorker(() => reply(200, { ok: true, result: native })));
    await w.ready();
    const dashboard = '78a07dab-f7e4-4bdf-b155-da929711312c';
    expect(await w.remote.listDataViews()).toEqual(native);
    expect(await w.remote.getDataView({ id: 'dv' })).toEqual(native);
    expect(await w.remote.getDashboardPreview({ id: dashboard })).toEqual(native);
    expect(await w.remote.esql({ query: 'FROM x' })).toEqual(native);
    expect(await w.remote.getTheme()).toEqual(INIT.theme);
    expect(w.executed.map(({ handle, ...operation }) => operation)).toEqual([
      { op: 'kibana.dataViews.read', params: {} },
      { op: 'kibana.dataViews.read', params: { id: 'dv' } },
      { op: 'kibana.dashboard.read', params: { id: dashboard } },
      { op: 'es.esql', params: { query: 'FROM x' } },
    ]);
  });

  it('plain-data arguments only: functions, stubs, thenables and wrong arity never reach Kibana', async () => {
    const w = track(startWorker(ok));
    await w.ready();
    for (const call of [
      () => w.remote.callAppRoute({ method: 'GET', path: '/admin' }),
      () => w.remote.callAppRoute({ method: 'GET', path: '/summary', extra: 1 }),
      () => w.remote.search(() => 1),
      () => w.remote.search({ index: 'kbn-apps-prototype-alerts', size: 1, then: () => 1 }),
      () => w.remote.search({ index: 'kbn-apps-prototype-alerts' }, 2),
      () => w.remote.getDataView({}),
      () => w.remote.listDataViews('x'),
      () => w.remote.esql('FROM x'),
      () => w.remote.getTheme('x'),
    ]) {
      expect(await codeOf(call())).toBe('bridge_invalid_request');
    }
    expect(w.executed).toHaveLength(0);
  });

  it('only the typed methods are callable; refusals are stackless fixed codes', async () => {
    const w = track(startWorker(() => reply(500, { message: 'at x.ts:1 stack' })));
    await w.ready();
    // Raw capnweb frames on a second listener, as a malicious guest would craft them.
    const replies: string[] = [];
    w.channel.port2.on('message', (data: string) => replies.push(data));
    const names = [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'createApiKey',
      'request',
    ];
    names.forEach((name, i) => {
      w.channel.port2.postMessage(JSON.stringify(['push', ['pipeline', 0, [name], ['x']]]));
      w.channel.port2.postMessage(JSON.stringify(['pull', i + 1]));
    });
    w.channel.port2.postMessage(JSON.stringify(['push', ['pipeline', 0, ['getTheme'], []]]));
    w.channel.port2.postMessage(JSON.stringify(['pull', names.length + 1]));
    await tick(100);
    const parsed = replies.map((raw) => JSON.parse(raw) as [string, number]);
    expect(parsed.filter(([type]) => type === 'reject').map(([, id]) => id)).toEqual(
      names.map((_, i) => i + 1)
    );
    expect(parsed.some(([type, id]) => type === 'resolve' && id === names.length + 1)).toBe(true);
    expect(replies.join('')).not.toMatch(/\sat\s|\.ts:|stack/);
    expect(w.executed).toHaveLength(0);
  });

  it('server failures reach the guest as a fixed code; no stack on the wire', async () => {
    const w = track(startWorker(() => reply(500, { message: 'at x.ts:1 stack' })));
    await w.ready();
    const wire: string[] = [];
    w.channel.port2.on('message', (data: string) => wire.push(data));
    expect(await codeOf(w.remote.callAppRoute({ method: 'GET', path: '/summary' }))).toBe(
      'app_unavailable'
    );
    expect(wire.join('')).toContain('app_unavailable');
    expect(wire.join('')).not.toMatch(/\.ts:|\sat\s|x\.ts/);
  });

  it('K3: an expired handle is re-minted once, then the call is retried', async () => {
    const w = track(
      startWorker((body) =>
        body.handle === 'handle-1' ? reply(403, { attributes: { code: 'app_expired' } }) : ok()
      )
    );
    await w.ready();
    expect(await codeOf(w.remote.callAppRoute({ method: 'GET', path: '/summary' }))).toBe('ok');
    expect(w.minted()).toBe(2);
    expect(w.executed.map(({ handle }) => handle)).toEqual(['handle-1', 'handle-2']);
  });

  it('a lifecycle refusal reaches the guest first, then ends the session', async () => {
    const w = track(startWorker(() => reply(409, { attributes: { code: 'app_stale' } })));
    await w.ready();
    expect(await codeOf(w.remote.callAppRoute({ method: 'GET', path: '/summary' }))).toBe(
      'app_stale'
    );
    await tick();
    expect(w.notices).toEqual([{ t: 'ready' }, { t: 'end', reason: 'app_stale' }]);
  });

  it('a failed mint ends the session before anything can bind', async () => {
    const notices: BridgeWorkerNotice[] = [];
    const scope: WorkerScope = { onmessage: null, postMessage: (notice) => notices.push(notice) };
    runWorkerScript(scope, async () => reply(403, { attributes: { code: 'app_disabled' } }));
    const channel = new MessageChannel();
    open.push(channel);
    scope.onmessage?.({ data: INIT, ports: [channel.port1] });
    await tick();
    expect(notices).toEqual([{ t: 'end', reason: 'session_failed' }]);
  });

  it('the receive queue is the one bound: overflow ends the session (queue_overflow)', async () => {
    const w = track(startWorker(ok));
    await w.ready();
    w.channel.port2.postMessage('x'.repeat(UI_LIMITS.receiveQueueBytes / 2 + 1));
    await tick(50);
    expect(w.notices).toEqual([{ t: 'ready' }, { t: 'end', reason: 'queue_overflow' }]);
    expect(w.executed).toHaveLength(0);
  });

  it('a non-string frame ends the session', async () => {
    const w = track(startWorker(ok));
    await w.ready();
    w.channel.port2.postMessage({ structured: true });
    await tick();
    expect(w.notices).toEqual([{ t: 'ready' }, { t: 'end', reason: 'non_string_frame' }]);
  });
});
