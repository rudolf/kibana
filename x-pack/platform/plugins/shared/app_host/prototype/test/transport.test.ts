/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BoundedWebSocketTransport, type MinimalWebSocket } from '../shared/bounded_transport';

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
