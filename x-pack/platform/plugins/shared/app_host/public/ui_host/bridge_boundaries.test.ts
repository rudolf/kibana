/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Structural boundary tests: every parent-side bound exactly at its limit (accepted) and one past
// it (rejected or terminated with the named reason).

import { MessageChannel } from 'node:worker_threads';
import type { UiOperation, UiTheme } from '../../common/ui_protocol';
import { UI_LIMITS } from '../../common/ui_protocol';
import { BridgeLifecycle } from './bridge_lifecycle';
import { AppBridge, type ExecuteOutcome } from './bridge_root';
import { startBridgeSession } from './bridge_session';
import {
  BoundedPortTransport,
  MAX_QUEUED_FRAMES,
  type PortLike,
  type TerminationReason,
} from './port_transport';

const THEME: UiTheme = {
  mode: 'light',
  colors: { background: '#fff', text: '#000', border: '#ccc', primary: '#07c', danger: '#c00' },
};
const SUMMARY = { appId: 'a', version: '1.0.0', label: 'L', counts: { high: 0, low: 0 } };
const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

const closers: Array<() => void> = [];
afterEach(() => {
  closers.splice(0).forEach((close) => close());
  jest.restoreAllMocks();
});

class FakePort implements PortLike {
  onmessage: PortLike['onmessage'] = null;
  onmessageerror: PortLike['onmessageerror'] = null;
  closed = false;
  postMessage() {}
  close() {
    this.closed = true;
  }
  deliver(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const fakeTransport = () => {
  const port = new FakePort();
  const reasons: TerminationReason[] = [];
  // Nobody calls receive(): nothing is dequeued, so everything stays queued.
  const transport = new BoundedPortTransport(port, (r) => reasons.push(r));
  return { port, reasons, transport };
};

/** Parent end as FrameHost wires it, over a real MessageChannel with a raw guest port. */
const realSession = () => {
  const channel = new MessageChannel();
  const ended: string[] = [];
  const executed: UiOperation[] = [];
  startBridgeSession({
    port: channel.port1 as unknown as PortLike,
    grant: { scopes: ['es.search'], dashboardIds: [] },
    theme: () => THEME,
    executor: async (operation): Promise<ExecuteOutcome> => {
      executed.push(operation);
      return { ok: true, result: { total: 0, records: [] } };
    },
    lifecycle: new BridgeLifecycle(),
    onTerminate: (reason) => ended.push(reason),
  });
  const replies: unknown[][] = [];
  channel.port2.on('message', (data: string) => replies.push(JSON.parse(data)));
  closers.push(() => {
    channel.port1.close();
    channel.port2.close();
  });
  let nextId = 1;
  /** Sends one pipelined `search(arg)` call and pulls its result; returns the export id. */
  const call = (encodedArg: unknown) => {
    const id = nextId++;
    channel.port2.postMessage(JSON.stringify(['push', ['pipeline', 0, ['search'], [encodedArg]]]));
    channel.port2.postMessage(JSON.stringify(['pull', id]));
    return id;
  };
  const replyTo = (id: number) =>
    replies.find(([type, replyId]) => replyId === id && type !== 'release');
  return { ended, executed, call, replyTo };
};

const nested = (levels: number): unknown => {
  let value: unknown = 'x';
  for (let i = 0; i < levels; i++) value = { a: value };
  return value;
};

describe('transport byte and queue boundaries (T9)', () => {
  it('frame: exactly 1 MiB (1,048,576 UTF-8 bytes) accepted, one byte more terminates', () => {
    expect(UI_LIMITS.frameBytes).toBe(1024 * 1024);
    const at = fakeTransport();
    at.port.deliver('x'.repeat(UI_LIMITS.frameBytes));
    expect(at.reasons).toEqual([]);
    const past = fakeTransport();
    past.port.deliver('x'.repeat(UI_LIMITS.frameBytes + 1));
    expect(past.reasons).toEqual(['frame_too_large']);
    // Multibyte: 349,525 x U+6F22 (3 bytes) + 1 ASCII = 1,048,576 bytes; one more ASCII byte is over.
    const multiAt = fakeTransport();
    multiAt.port.deliver(`${'\u6f22'.repeat(349_525)}x`);
    expect(multiAt.reasons).toEqual([]);
    const multiPast = fakeTransport();
    multiPast.port.deliver(`${'\u6f22'.repeat(349_525)}xx`);
    expect(multiPast.reasons).toEqual(['frame_too_large']);
  });

  it('queue: exactly 4 MiB queued accepted, one more byte overflows', () => {
    expect(UI_LIMITS.receiveQueueBytes).toBe(4 * 1024 * 1024);
    const { port, reasons } = fakeTransport();
    for (let i = 0; i < 4; i++) port.deliver('q'.repeat(UI_LIMITS.frameBytes));
    expect(reasons).toEqual([]);
    port.deliver('q');
    expect(reasons).toEqual(['queue_overflow']);
  });

  it(`queue: exactly ${MAX_QUEUED_FRAMES} frames accepted, one more overflows`, () => {
    const { port, reasons } = fakeTransport();
    for (let i = 0; i < MAX_QUEUED_FRAMES; i++) port.deliver('z');
    expect(reasons).toEqual([]);
    port.deliver('z');
    expect(reasons).toEqual(['queue_overflow']);
  });
});

describe('capnweb parse boundaries over a real MessageChannel (T9)', () => {
  // Message depth 12 = pipeline + argument list + 10 levels of argument value.
  it('depth: 10 nested argument levels parse (strict arguments still refused), 11 terminate', async () => {
    const at = realSession();
    const id = at.call(nested(10));
    await flush();
    expect(at.ended).toEqual([]);
    expect(at.replyTo(id)?.[0]).toBe('reject');
    expect(JSON.stringify(at.replyTo(id))).toContain('bridge_invalid_request');

    const past = realSession();
    past.call(nested(11));
    await flush();
    expect(past.ended).toEqual(['depth_exceeded']);
    expect(past.executed).toEqual([]);
  });

  it('BigInt: 64 digits parse, 65 digits terminate', async () => {
    const at = realSession();
    const id = at.call(['bigint', '9'.repeat(UI_LIMITS.rpcMaxBigIntDigits)]);
    await flush();
    expect(at.ended).toEqual([]);
    expect(JSON.stringify(at.replyTo(id))).toContain('bridge_invalid_request');

    const past = realSession();
    past.call(['bigint', '9'.repeat(UI_LIMITS.rpcMaxBigIntDigits + 1)]);
    await flush();
    expect(past.ended).toEqual(['bigint_too_large']);
  });

  it('positive control: a valid call on the same wiring resolves', async () => {
    const control = realSession();
    const id = control.call({ index: 'kbn-apps-prototype-alerts', size: 1 });
    await flush();
    expect(control.replyTo(id)?.[0]).toBe('resolve');
    expect(control.executed).toHaveLength(1);
  });
});

describe('AppBridge invalid-call boundary (T9)', () => {
  const bridgeWith = (hooks: Partial<{ terminate: (r: string) => void }> = {}) => {
    const executed: UiOperation[] = [];
    const terminated: string[] = [];
    const bridge = new AppBridge(
      { scopes: ['app.summary'], dashboardIds: [] },
      () => THEME,
      async (operation) => {
        executed.push(operation);
        return { ok: true, result: { ...SUMMARY } };
      },
      {
        beforeCall: () => true,
        terminate: hooks.terminate ?? ((reason) => terminated.push(reason)),
      },
      new BridgeLifecycle()
    );
    return { bridge, executed, terminated };
  };
  const outcome = (promise: Promise<unknown>) =>
    promise.then(
      () => 'ok',
      (error: Error) => error.message
    );
  it(`invalid calls: ${
    UI_LIMITS.invalidCallsBeforeTermination - 1
  } tolerated, the next terminates`, async () => {
    const { bridge, terminated } = bridgeWith();
    for (let i = 0; i < UI_LIMITS.invalidCallsBeforeTermination - 1; i++) {
      expect(await outcome(bridge.search({}))).toBe('bridge_invalid_request');
    }
    expect(terminated).toEqual([]);
    expect(await outcome(bridge.search({}))).toBe('bridge_invalid_request');
    expect(terminated).toEqual(['repeated_invalid_calls']);
  });
});
