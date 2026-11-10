/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { FakeSocket } from '../mocks/fake_dispatcher';
import { BoundedWebSocketTransport } from './bounded_transport';

const openSocket = () => {
  const socket = new FakeSocket();
  socket.readyState = 1;
  return socket;
};

describe('BoundedWebSocketTransport', () => {
  it('delivers string frames in order', async () => {
    const socket = openSocket();
    const transport = new BoundedWebSocketTransport(socket);
    socket.inject('a');
    socket.inject('b');
    await expect(transport.receive()).resolves.toBe('a');
    await expect(transport.receive()).resolves.toBe('b');
  });

  it('rejects binary frames and closes with 1009', async () => {
    const binary = openSocket();
    const transport = new BoundedWebSocketTransport(binary);
    binary.inject(new ArrayBuffer(4));
    await expect(transport.receive()).rejects.toThrow(/Binary/);
    expect(binary.closeCode).toBe(1009);
  });

  it('the receive queue is the one bound (2 bytes per code unit); drained frames no longer count', async () => {
    const MAX = 1024;
    const socket = openSocket();
    const transport = new BoundedWebSocketTransport(socket, MAX);
    for (let round = 0; round < 3; round++) {
      socket.inject('a'.repeat(MAX / 4));
      socket.inject('b'.repeat(MAX / 4));
      await expect(transport.receive()).resolves.toHaveLength(MAX / 4);
      await expect(transport.receive()).resolves.toHaveLength(MAX / 4);
    }
    expect(socket.closeCode).toBeUndefined();
    socket.inject('x'.repeat(MAX / 2));
    socket.inject('y');
    expect(socket.closeCode).toBe(1009);
    await expect(transport.receive()).rejects.toThrow(/queue/);
  });

  it('one frame larger than the bound is refused even when a reader is waiting', async () => {
    const socket = openSocket();
    const transport = new BoundedWebSocketTransport(socket, 1024);
    const pending = transport.receive();
    socket.inject('x'.repeat(513));
    await expect(pending).rejects.toThrow(/queue/);
    expect(socket.closeCode).toBe(1009);
  });

  it('queues sends until open', () => {
    const socket = new FakeSocket();
    const sent: string[] = [];
    socket.send = (data: string) => {
      sent.push(data);
    };
    const transport = new BoundedWebSocketTransport(socket);
    transport.send('early');
    expect(sent).toEqual([]);
    socket.open();
    expect(sent).toEqual(['early']);
  });
});
