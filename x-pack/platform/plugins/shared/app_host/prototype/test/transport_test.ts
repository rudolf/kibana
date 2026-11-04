/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  BoundedWebSocketTransport,
  utf8ByteLength,
  type MinimalWebSocket,
} from '../shared/bounded_transport';

const CAP = 256 * 1024;
// U+6F22: one UTF-16 code unit, three UTF-8 bytes.
const KANJI = '\u6f22';

class FakeSocket extends EventEmitter implements MinimalWebSocket {
  readyState = 1;
  sent: string[] = [];
  closedWith: number | undefined;
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code;
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.on(type, listener);
  }
}

test('delivers string frames in order', async () => {
  const socket = new FakeSocket();
  const transport = new BoundedWebSocketTransport(socket);
  socket.emit('message', { data: 'a' });
  socket.emit('message', { data: 'b' });
  assert.equal(await transport.receive(), 'a');
  assert.equal(await transport.receive(), 'b');
});

test('rejects binary and oversized frames before parsing and closes the socket', async () => {
  const binary = new FakeSocket();
  const t1 = new BoundedWebSocketTransport(binary);
  binary.emit('message', { data: new ArrayBuffer(1) });
  await assert.rejects(t1.receive(), /Binary/);
  assert.equal(binary.closedWith, 1009);

  const big = new FakeSocket();
  const t2 = new BoundedWebSocketTransport(big);
  big.emit('message', { data: 'x'.repeat(256 * 1024 + 1) });
  await assert.rejects(t2.receive(), /size limit/);
});

test('bounds the receive queue', async () => {
  const socket = new FakeSocket();
  const transport = new BoundedWebSocketTransport(socket);
  for (let i = 0; i < 5; i++) socket.emit('message', { data: 'x'.repeat(256 * 1024) });
  await assert.rejects(async () => {
    for (let i = 0; i < 5; i++) await transport.receive();
  }, /queue/);
});

test('queues sends until open and fails on close', async () => {
  const socket = new FakeSocket();
  socket.readyState = 0;
  let closedReason: unknown;
  const transport = new BoundedWebSocketTransport(socket, (reason) => {
    closedReason = reason;
  });
  transport.send('early');
  assert.deepEqual(socket.sent, []);
  socket.emit('open', {});
  assert.deepEqual(socket.sent, ['early']);
  const pending = transport.receive();
  socket.emit('close', { code: 1006 });
  await assert.rejects(pending, /1006/);
  assert.ok(closedReason instanceof Error);
  assert.throws(() => transport.send('late'));
});

test('utf8ByteLength matches TextEncoder, including surrogate pairs and lone surrogates', () => {
  const encoder = new TextEncoder();
  for (const sample of [
    '',
    'abc',
    '\u00e9',
    KANJI,
    '\u{1F600}',
    'a\ud800b',
    '\udc00',
    'x\u{10FFFF}',
  ]) {
    assert.equal(utf8ByteLength(sample), encoder.encode(sample).byteLength, JSON.stringify(sample));
  }
});

test('frame cap counts UTF-8 bytes, not UTF-16 code units', async () => {
  // The review's reproduction: 102,400 code units, 307,200 UTF-8 bytes, above the 262,144 cap.
  const over = KANJI.repeat(102_400);
  assert.ok(over.length < CAP);
  const socket = new FakeSocket();
  const transport = new BoundedWebSocketTransport(socket);
  socket.emit('message', { data: over });
  await assert.rejects(transport.receive(), /size limit/);
  assert.equal(socket.closedWith, 1009);

  // 87,381 x 3 = 262,143 bytes: accepted.
  const under = KANJI.repeat(87_381);
  const ok = new FakeSocket();
  const okTransport = new BoundedWebSocketTransport(ok);
  ok.emit('message', { data: under });
  assert.equal(await okTransport.receive(), under);
  assert.equal(ok.closedWith, undefined);
});

test('receive queue bound counts UTF-8 bytes', async () => {
  // 240,000-byte frames (80,000 code units): four fit in 1 MiB, the fifth aborts. Counting code
  // units would accept all five (400,000).
  const frame = KANJI.repeat(80_000);
  const four = new FakeSocket();
  const fourTransport = new BoundedWebSocketTransport(four);
  for (let i = 0; i < 4; i++) four.emit('message', { data: frame });
  assert.equal(four.closedWith, undefined);
  for (let i = 0; i < 4; i++) assert.equal(await fourTransport.receive(), frame);

  const five = new FakeSocket();
  const fiveTransport = new BoundedWebSocketTransport(five);
  for (let i = 0; i < 5; i++) five.emit('message', { data: frame });
  assert.equal(five.closedWith, 1009);
  await assert.rejects(fiveTransport.receive(), /queue/);

  // Bytes are released on receive.
  const cycle = new FakeSocket();
  const cycleTransport = new BoundedWebSocketTransport(cycle);
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 4; i++) cycle.emit('message', { data: frame });
    for (let i = 0; i < 4; i++) await cycleTransport.receive();
  }
  assert.equal(cycle.closedWith, undefined);
});
