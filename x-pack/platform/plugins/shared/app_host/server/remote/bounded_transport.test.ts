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

  it('rejects binary and oversized frames and closes with 1009', async () => {
    const binary = openSocket();
    const t1 = new BoundedWebSocketTransport(binary);
    binary.inject(new ArrayBuffer(4));
    await expect(t1.receive()).rejects.toThrow(/Binary/);
    expect(binary.closeCode).toBe(1009);

    const big = openSocket();
    const t2 = new BoundedWebSocketTransport(big);
    big.inject('x'.repeat(256 * 1024 + 1));
    await expect(t2.receive()).rejects.toThrow(/size limit/);
  });

  it('bounds queued bytes', async () => {
    const socket = openSocket();
    const transport = new BoundedWebSocketTransport(socket);
    for (let i = 0; i < 5; i++) socket.inject('x'.repeat(256 * 1024));
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => transport.receive()));
    expect(results.some((r) => r.status === 'rejected')).toBe(true);
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
