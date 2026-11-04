/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcSession, RpcTarget, type RpcTransport } from 'capnweb';
import { sanitize } from '../cloudflare/src/errors';
import { sanitizeClientError } from '../scripts/lib/client';
import { ProtocolError } from '../shared/protocol';

/** In-memory capnweb transport pair; `frames` records what `a` puts on the wire. */
const transportPair = () => {
  const frames: string[] = [];
  const make = (inbox: string[], outbox: string[], record: boolean) => {
    let waiting: ((value: string) => void) | undefined;
    const transport: RpcTransport & { deliver(message: string): void } = {
      send(message: string) {
        if (record) frames.push(message);
        outbox.push(message);
        queueMicrotask(() => peer.deliver(outbox.shift() as string));
      },
      receive() {
        const next = inbox.shift();
        if (next !== undefined) return Promise.resolve(next);
        return new Promise<string>((resolve) => {
          waiting = resolve;
        });
      },
      deliver(message: string) {
        if (waiting) {
          const resolve = waiting;
          waiting = undefined;
          resolve(message);
        } else {
          inbox.push(message);
        }
      },
    };
    let peer: { deliver(message: string): void };
    return { transport, connect: (other: { deliver(message: string): void }) => (peer = other) };
  };
  const a = make([], [], true);
  const b = make([], [], false);
  a.connect(b.transport);
  b.connect(a.transport);
  return { a: a.transport, b: b.transport, frames };
};

class Failing extends RpcTarget {
  readonly #error: () => Error;
  constructor(error: () => Error) {
    super();
    this.#error = error;
  }
  async fail(): Promise<never> {
    throw this.#error();
  }
}

/** Every capnweb `["error", name, message, stack?, props?]` tuple in a decoded frame. */
const errorTuples = (node: unknown): unknown[][] => {
  if (!Array.isArray(node)) return [];
  if (node[0] === 'error' && typeof node[1] === 'string') return [node];
  return node.flatMap(errorTuples);
};

/** Throws `thrown` on side A (with `onSendError`), calls it from side B, returns A's error frames. */
const encodedError = async (thrown: () => Error, onSendError: (error: Error) => Error) => {
  const { a, b, frames } = transportPair();
  new RpcSession(a, new Failing(thrown), { onSendError });
  const caller = new RpcSession(b);
  const stub = caller.getRemoteMain() as unknown as { fail(): Promise<never> };
  const received = await stub.fail().then(
    () => undefined,
    (error: Error) => error
  );
  return {
    received,
    tuples: frames.flatMap((frame) => errorTuples(JSON.parse(frame))),
    frames,
  };
};

const pathy = () => new TypeError(`boom in ${import.meta.filename}`);
const HOST_PATH = /errors_test|\.ts\b|\/Users\/|\bat \S+ \(/;

test('control: an unsanitized replacement Error puts its stack on the wire', async () => {
  const { tuples } = await encodedError(pathy, (error) => new Error(error.message));
  assert.equal(tuples.length, 1);
  assert.equal(tuples[0].length, 4);
  assert.match(String(tuples[0][3]), HOST_PATH);
});

for (const [name, thrown, expected] of [
  ['unknown error', pathy, 'app_host:app_failed'],
  ['protocol error', () => new ProtocolError('digest_mismatch', 'x'), 'app_host:digest_mismatch'],
  ['coded error', () => new Error('app_host:callback_budget'), 'app_host:callback_budget'],
  ['CPU limit', () => new Error('Worker exceeded CPU time limit.'), 'app_host:app_cpu_limit'],
  [
    'depth limit',
    () => new TypeError('Deserialization exceeded maximum allowed message depth of 32.'),
    'app_host:rpc_limit',
  ],
] as const) {
  test(`dispatcher sanitize encodes ${name} as a stackless code with no host path`, async () => {
    const { received, tuples, frames } = await encodedError(thrown, sanitize);
    assert.equal(received?.message, expected);
    assert.deepEqual(tuples, [['error', 'Error', expected]]);
    for (const frame of frames) assert.doesNotMatch(frame, HOST_PATH);
  });
}

test('tool client sanitizer encodes any error as a stackless fixed code', async () => {
  const { received, tuples, frames } = await encodedError(pathy, sanitizeClientError);
  assert.equal(received?.message, 'app_host:host_error');
  assert.deepEqual(tuples, [['error', 'Error', 'app_host:host_error']]);
  for (const frame of frames) assert.doesNotMatch(frame, HOST_PATH);
});
