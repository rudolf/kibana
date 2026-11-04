/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { FakeSocket } from '../mocks/fake_dispatcher';
import { BoundedWebSocketTransport, frameBytes } from './bounded_transport';

const CAP = 256 * 1024;
// U+6F22: one UTF-16 code unit, three UTF-8 bytes.
const KANJI = '\u6f22';

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

  it('counts UTF-8 bytes, not UTF-16 code units, for the frame cap', async () => {
    // 102,400 code units but 307,200 UTF-8 bytes: over the 262,144-byte cap.
    const over = KANJI.repeat(102_400);
    expect(over.length).toBeLessThan(CAP);
    expect(frameBytes(over)).toBe(307_200);
    const socket = openSocket();
    const transport = new BoundedWebSocketTransport(socket);
    socket.inject(over);
    await expect(transport.receive()).rejects.toThrow(/size limit/);
    expect(socket.closeCode).toBe(1009);

    // 87,381 x 3 = 262,143 bytes: just under the cap, accepted.
    const under = KANJI.repeat(87_381);
    const ok = openSocket();
    const okTransport = new BoundedWebSocketTransport(ok);
    ok.inject(under);
    await expect(okTransport.receive()).resolves.toBe(under);
    expect(ok.closeCode).toBeUndefined();

    // A 4-byte character (surrogate pair) counts as 4 bytes.
    expect(frameBytes('\u{1F600}')).toBe(4);
  });

  it('counts UTF-8 bytes for the receive queue bound', async () => {
    // Each frame is 240,000 bytes (80,000 code units): under the frame cap. Four fit in the
    // 1 MiB queue; the fifth (1,200,000 bytes queued) aborts. Code-unit counting would allow all
    // five (400,000 units).
    const frame = KANJI.repeat(80_000);
    const four = openSocket();
    const fourTransport = new BoundedWebSocketTransport(four);
    for (let i = 0; i < 4; i++) four.inject(frame);
    expect(four.closeCode).toBeUndefined();
    for (let i = 0; i < 4; i++) await expect(fourTransport.receive()).resolves.toBe(frame);

    const five = openSocket();
    const fiveTransport = new BoundedWebSocketTransport(five);
    for (let i = 0; i < 5; i++) five.inject(frame);
    expect(five.closeCode).toBe(1009);
    await expect(fiveTransport.receive()).rejects.toThrow(/queue/);
  });

  it('releases queued bytes on receive', async () => {
    const frame = KANJI.repeat(80_000);
    const socket = openSocket();
    const transport = new BoundedWebSocketTransport(socket);
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) socket.inject(frame);
      for (let i = 0; i < 4; i++) await transport.receive();
    }
    expect(socket.closeCode).toBeUndefined();
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
