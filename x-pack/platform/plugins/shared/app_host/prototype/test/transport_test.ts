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

test('rejects binary frames before parsing and closes the socket', async () => {
  const binary = new FakeSocket();
  const transport = new BoundedWebSocketTransport(binary);
  binary.emit('message', { data: new ArrayBuffer(1) });
  await assert.rejects(transport.receive(), /Binary/);
  assert.equal(binary.closedWith, 1009);
});

test('the receive queue is the one bound (2 bytes per code unit); drained frames no longer count', async () => {
  const MAX = 1024;
  const socket = new FakeSocket();
  const transport = new BoundedWebSocketTransport(socket, undefined, MAX);
  for (let round = 0; round < 3; round++) {
    socket.emit('message', { data: 'a'.repeat(MAX / 4) });
    socket.emit('message', { data: 'b'.repeat(MAX / 4) });
    assert.equal((await transport.receive()).length, MAX / 4);
    assert.equal((await transport.receive()).length, MAX / 4);
  }
  assert.equal(socket.closedWith, undefined);
  socket.emit('message', { data: 'x'.repeat(MAX / 2) });
  socket.emit('message', { data: 'y' });
  assert.equal(socket.closedWith, 1009);
  await assert.rejects(transport.receive(), /queue/);
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
