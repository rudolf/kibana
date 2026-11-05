/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { MessageChannel } from 'node:worker_threads';
import { RpcSession } from 'capnweb';
import type { UiOperation, UiTheme } from '../../common/ui_protocol';
import {
  AppBridge,
  BridgeLifecycle,
  bridgeError,
  sanitizeBridgeError,
  type ExecuteOutcome,
} from './bridge_root';
import { BoundedPortTransport, type PortLike } from './port_transport';

const DASHBOARD = '78a07dab-f7e4-4bdf-b155-da929711312c';
const THEME: UiTheme = {
  mode: 'light',
  colors: { background: '#fff', text: '#000', border: '#ccc', primary: '#07c', danger: '#c00' },
};
const SUMMARY = {
  appId: 'alert-digest',
  version: '2.0.0',
  label: 'L',
  counts: { high: 2, low: 1 },
};

const setup = (executor?: (op: UiOperation) => Promise<ExecuteOutcome>) => {
  const calls: UiOperation[] = [];
  const terminated: string[] = [];
  const lifecycle = new BridgeLifecycle();
  const exec =
    executor ??
    (async (op: UiOperation): Promise<ExecuteOutcome> => ({ ok: true, result: { ...SUMMARY } }));
  const bridge = new AppBridge(
    { scopes: ['app.summary', 'es.search', 'kibana.dashboard.read'], dashboardIds: [DASHBOARD] },
    () => THEME,
    async (op) => {
      calls.push(op);
      return exec(op);
    },
    { beforeCall: () => true, terminate: (reason) => terminated.push(reason) },
    lifecycle
  );
  return { bridge, calls, terminated, lifecycle };
};

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return (error as Error).message;
  }
};

describe('AppBridge', () => {
  it('validates strict plain-data arguments before any server operation', async () => {
    const { bridge, calls } = setup();
    expect(await codeOf(bridge.callAppRoute({ method: 'GET', path: '/summary' }))).toBe('ok');
    const invalid = [
      bridge.callAppRoute({ method: 'GET', path: '/admin' }),
      bridge.callAppRoute({ method: 'GET', path: '/summary', extra: 1 }),
      bridge.search({ index: '.security-7', size: 1 }),
      bridge.search({ index: 'kbn-apps-prototype-alerts', size: 101 }),
      bridge.search(() => 1),
      bridge.search({ index: 'kbn-apps-prototype-alerts', size: 1, then: () => undefined }),
      bridge.getDashboardPreview({ id: 'not-a-uuid' }),
      bridge.getTheme('x'),
    ];
    for (const promise of invalid) expect(await codeOf(promise)).toBe('bridge_invalid_request');
    expect(calls).toHaveLength(1);
  });

  it('denies ungranted dashboard ids before lookup, identically for existing and missing ids', async () => {
    const { bridge, calls } = setup();
    expect(
      await codeOf(bridge.getDashboardPreview({ id: '00000000-0000-4000-8000-000000000000' }))
    ).toBe('app_denied');
    expect(calls).toHaveLength(0);
  });

  it('terminates after repeated invalid calls', async () => {
    const { bridge, terminated } = setup();
    for (let i = 0; i < 8; i++) await codeOf(bridge.search({}));
    expect(terminated).toEqual(['repeated_invalid_calls']);
  });

  it('enforces 2 in flight and the 5/s burst-10 operation bucket synchronously', async () => {
    const pending: Array<() => void> = [];
    let hold = true;
    const { bridge, calls } = setup(() =>
      hold
        ? new Promise((resolve) =>
            pending.push(() => resolve({ ok: true, result: { ...SUMMARY } }))
          )
        : Promise.resolve({ ok: true, result: { ...SUMMARY } })
    );
    const first = bridge.callAppRoute({ method: 'GET', path: '/summary' });
    const second = bridge.callAppRoute({ method: 'GET', path: '/summary' });
    expect(await codeOf(bridge.callAppRoute({ method: 'GET', path: '/summary' }))).toBe(
      'app_rate_limited'
    );
    expect(calls).toHaveLength(2);
    hold = false;
    pending.forEach((resolve) => resolve());
    await Promise.all([first, second]);
    const results = [];
    for (let i = 0; i < 10; i++)
      results.push(await codeOf(bridge.callAppRoute({ method: 'GET', path: '/summary' })));
    expect(results.filter((r) => r === 'app_rate_limited').length).toBeGreaterThan(0);
  });

  it('suppresses results that arrive after revocation and fails later calls', async () => {
    let resolveCall: (() => void) | undefined;
    const { bridge, lifecycle } = setup(
      () =>
        new Promise(
          (resolve) => (resolveCall = () => resolve({ ok: true, result: { ...SUMMARY } }))
        )
    );
    const pending = bridge.callAppRoute({ method: 'GET', path: '/summary' });
    lifecycle.revoke('app_disabled');
    resolveCall?.();
    expect(await codeOf(pending)).toBe('app_disabled');
    expect(await codeOf(bridge.getTheme())).toBe('app_disabled');
  });

  it('errors carry no stack even where stack is an inherited accessor (Firefox)', () => {
    // Emulate an engine where `stack` is an accessor inherited from the prototype, not an own
    // property: deleting an own `stack` would then expose the inherited one.
    const firefoxLike = Object.create(Error.prototype, {
      stack: {
        configurable: true,
        get: () => 'bridgeError@http://localhost:5601/bundles/app_host.js:1:2',
      },
    });
    for (const error of [bridgeError('app_denied'), sanitizeBridgeError(new Error('x'))]) {
      Object.setPrototypeOf(error, firefoxLike);
      expect(error.stack).toBe('');
    }
  });

  it('never forwards non-schema results or raw error codes', async () => {
    const { bridge } = setup(async () => ({ ok: true, result: { ...SUMMARY, extra: '<b>' } }));
    expect(await codeOf(bridge.callAppRoute({ method: 'GET', path: '/summary' }))).toBe(
      'app_unavailable'
    );
    expect(sanitizeBridgeError(new Error('Forbidden: user x lacks .security')).message).toBe(
      'app_unavailable'
    );
    expect(sanitizeBridgeError(new Error('app_denied')).stack).toBeFalsy();
  });
});

describe('AppBridge over capnweb + bounded MessageChannel (T9)', () => {
  const connect = (executor?: (op: UiOperation) => Promise<ExecuteOutcome>) => {
    const { bridge, calls } = setup(executor);
    const channel = new MessageChannel();
    const ended: string[] = [];
    const transport = new BoundedPortTransport(channel.port1 as unknown as PortLike, (r) =>
      ended.push(r)
    );
    // eslint-disable-next-line no-new
    new RpcSession(transport, bridge, {
      limits: { maxDepth: 12, maxBigIntDigits: 64, maxMessageSize: 32 * 1024 },
      onSendError: sanitizeBridgeError,
    });
    const guestTransport = new BoundedPortTransport(
      channel.port2 as unknown as PortLike,
      () => undefined
    );
    const guest = new RpcSession<Record<string, (...args: unknown[]) => Promise<unknown>>>(
      guestTransport
    );
    const remote = guest.getRemoteMain() as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    return { remote, calls, ended, close: () => channel.port1.close() };
  };

  it('exposes only the four methods; prototype names and unknown methods are refused', async () => {
    const { bridge, calls } = setup();
    const channel = new MessageChannel();
    const transport = new BoundedPortTransport(
      channel.port1 as unknown as PortLike,
      () => undefined
    );
    // eslint-disable-next-line no-new
    new RpcSession(transport, bridge, { onSendError: sanitizeBridgeError });
    const replies: string[] = [];
    channel.port2.on('message', (data: string) => replies.push(data));
    // Raw capnweb frames, as a malicious guest would craft them.
    const names = [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'createApiKey',
      'revoke',
    ];
    names.forEach((name, i) => {
      channel.port2.postMessage(JSON.stringify(['push', ['pipeline', 0, [name], ['x']]]));
      channel.port2.postMessage(JSON.stringify(['pull', i + 1]));
    });
    channel.port2.postMessage(JSON.stringify(['push', ['pipeline', 0, ['getTheme'], []]]));
    channel.port2.postMessage(JSON.stringify(['pull', names.length + 1]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const parsed = replies.map((reply) => JSON.parse(reply) as [string, number]);
    expect(parsed.filter(([type]) => type === 'reject').map(([, id]) => id)).toEqual(
      names.map((_, i) => i + 1)
    );
    expect(
      parsed.find(([type, id]) => type === 'resolve' && id === names.length + 1)
    ).toBeDefined();
    expect(replies.join('')).not.toMatch(/\sat\s|\.ts:|stack/);
    expect(calls).toHaveLength(0);
    channel.port1.close();
    channel.port2.close();
  });

  it('function, stub and thenable arguments never reach the executor', async () => {
    const operations: unknown[] = [];
    const { remote, close } = connect(async (op) => {
      operations.push(op);
      return { ok: true, result: { total: 0, records: [] } };
    });
    expect(await codeOf(remote.search(() => 1))).toBe('bridge_invalid_request');
    expect(
      await codeOf(remote.search({ index: 'kbn-apps-prototype-alerts', size: 1, then: () => 1 }))
    ).toBe('bridge_invalid_request');
    expect(await codeOf(remote.search({ index: 'kbn-apps-prototype-alerts', size: 2 }))).toBe('ok');
    expect(operations).toEqual([
      { op: 'es.search', params: { index: 'kbn-apps-prototype-alerts', size: 2 } },
    ]);
    close();
  });

  it('pipelined calls do not bypass per-lease in-flight and rate budgets', async () => {
    const holds: Array<() => void> = [];
    const operations: unknown[] = [];
    const { remote, close } = connect(
      (op) =>
        new Promise((resolve) => {
          operations.push(op);
          holds.push(() => resolve({ ok: true, result: { ...SUMMARY } }));
        })
    );
    // Twelve calls issued without awaiting (capnweb pushes them back to back).
    const calls = Array.from({ length: 12 }, () =>
      codeOf(remote.callAppRoute({ method: 'GET', path: '/summary' }))
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(operations).toHaveLength(2);
    holds.forEach((release) => release());
    const codes = await Promise.all(calls);
    expect(codes.filter((code) => code === 'ok')).toHaveLength(2);
    expect(codes.filter((code) => code === 'app_rate_limited')).toHaveLength(10);
    close();
  });

  it('a message deeper than 12 levels aborts the session with depth_exceeded', async () => {
    const { remote, ended, calls, close } = connect();
    let deep: unknown = 'x';
    for (let i = 0; i < 20; i++) deep = { deep };
    expect(await codeOf(remote.search(deep))).not.toBe('ok');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ended).toEqual(['depth_exceeded']);
    expect(calls).toHaveLength(0);
    close();
  });
});
