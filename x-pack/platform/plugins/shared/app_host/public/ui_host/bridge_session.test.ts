/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { MessageChannel } from 'node:worker_threads';
import type { UiTheme } from '../../common/ui_protocol';
import { UI_LIMITS } from '../../common/ui_protocol';
import { BridgeLifecycle } from './bridge_lifecycle';
import type { ExecuteOutcome } from './bridge_root';
import { startBridgeSession } from './bridge_session';
import { TokenBucket, type PortLike } from './port_transport';

const THEME: UiTheme = {
  mode: 'light',
  colors: { background: '#fff', text: '#000', border: '#ccc', primary: '#07c', danger: '#c00' },
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach((close) => close()));

/**
 * The parent end of the bridge as FrameHost wires it, over a real MessageChannel. The guest end is a
 * raw port so that tests can send protocol-only capnweb frames that never reach a bridge method.
 */
const connect = () => {
  const channel = new MessageChannel();
  const ended: string[] = [];
  const executed: unknown[] = [];
  const { session, transport } = startBridgeSession({
    port: channel.port1 as unknown as PortLike,
    grant: { scopes: ['app.summary'], dashboardIds: [] },
    theme: () => THEME,
    executor: async (operation): Promise<ExecuteOutcome> => {
      executed.push(operation);
      return {
        ok: true,
        result: { appId: 'a', version: '1.0.0', label: 'L', counts: { high: 0, low: 0 } },
      };
    },
    lifecycle: new BridgeLifecycle(),
    onTerminate: (reason) => ended.push(reason),
    // Remove ingress pacing so that the test exercises only the live-stub boundary.
    ingress: new TokenBucket(1_000_000, 1_000_000),
  });
  const replies: string[] = [];
  channel.port2.on('message', (data: string) => replies.push(data));
  const send = (frame: unknown) => channel.port2.postMessage(JSON.stringify(frame));
  const live = () => {
    const { imports, exports } = session.getStats();
    return imports + exports;
  };
  const close = () => {
    channel.port1.close();
    channel.port2.close();
  };
  closers.push(close);
  return { session, transport, ended, executed, replies, send, live, close };
};

// A fresh session already holds 2 entries: the main import and the bridge export.
const BASELINE = 2;

describe('bridge session live-stub cap (P1: protocol-only growth)', () => {
  it('terminates on protocol-only pushes one past 128 live entries; exactly 128 stays open', async () => {
    const { ended, transport, send, live, close, executed } = connect();
    const atLimit = UI_LIMITS.liveRpcStubs - BASELINE;
    for (let i = 0; i < atLimit; i++) send(['push', 0]);
    await flush();
    expect(live()).toBe(UI_LIMITS.liveRpcStubs);
    expect(ended).toEqual([]);
    expect(transport.terminated).toBe(false);
    send(['push', 0]);
    await flush();
    expect(ended).toEqual(['live_stubs']);
    expect(transport.terminated).toBe(true);
    // No bridge method was ever invoked: the cap is enforced at the protocol receive boundary.
    expect(executed).toEqual([]);
    close();
  });

  it('counts imports created by guest-exported stubs and unknown-method pipelines', async () => {
    const imports = connect();
    // Each frame imports one guest stub (imports + 1) and retains one pushed payload (exports + 1).
    for (let i = 1; i <= 64; i++) imports.send(['push', ['export', -i]]);
    await flush();
    expect(imports.ended).toEqual(['live_stubs']);
    imports.close();

    const unknown = connect();
    for (let i = 0; i < 200; i++) unknown.send(['push', ['pipeline', 0, ['nope'], []]]);
    await flush();
    expect(unknown.ended).toEqual(['live_stubs']);
    expect(unknown.executed).toEqual([]);
    unknown.close();
  });

  it('positive control: below the cap, retained pushes do not stop normal calls', async () => {
    const { ended, send, replies, close, executed } = connect();
    for (let i = 0; i < 100; i++) send(['push', 0]);
    // Call callAppRoute as export id 101 and pull it.
    send(['push', ['pipeline', 0, ['callAppRoute'], [{ method: 'GET', path: '/summary' }]]]);
    send(['pull', 101]);
    await flush();
    expect(ended).toEqual([]);
    expect(executed).toEqual([{ op: 'app.summary' }]);
    expect(replies.map((reply) => JSON.parse(reply)[0])).toContain('resolve');
    close();
  });
});
