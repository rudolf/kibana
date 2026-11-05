/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { MessageChannel } from 'node:worker_threads';
import {
  BoundedPortTransport,
  MAX_QUEUED_FRAMES,
  utf8Bytes,
  type PortLike,
  type TerminationReason,
} from './port_transport';

class FakePort implements PortLike {
  onmessage: PortLike['onmessage'] = null;
  onmessageerror: PortLike['onmessageerror'] = null;
  readonly sent: string[] = [];
  closed = false;
  postMessage(message: string) {
    this.sent.push(message);
  }
  close() {
    this.closed = true;
  }
  deliver(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const setup = () => {
  const port = new FakePort();
  const reasons: TerminationReason[] = [];
  const transport = new BoundedPortTransport(port, (reason) => reasons.push(reason));
  return { port, reasons, transport };
};

describe('utf8Bytes', () => {
  it('matches Buffer.byteLength, including surrogate pairs and lone surrogates', () => {
    for (const value of ['abc', '\u00e9', '\u6f22', '\ud83d\ude00', 'a\ud800b', '']) {
      expect(utf8Bytes(value)).toBe(Buffer.byteLength(value, 'utf8'));
    }
  });
});

describe('BoundedPortTransport (T9)', () => {
  it('delivers a frame at the 32 KiB limit, terminates at 33 KiB ASCII before parsing', async () => {
    const { port, reasons, transport } = setup();
    port.deliver('x'.repeat(32 * 1024));
    await expect(transport.receive()).resolves.toHaveLength(32 * 1024);
    port.deliver('x'.repeat(33 * 1024));
    expect(reasons).toEqual(['frame_too_large']);
    expect(port.closed).toBe(true);
    await expect(transport.receive()).rejects.toThrow('bridge_protocol_error:frame_too_large');
  });

  it('counts UTF-8 bytes, not code units (11,000 x U+6F22 = 33,000 bytes)', () => {
    const { port, reasons } = setup();
    port.deliver('\u6f22'.repeat(11_000));
    expect(reasons).toEqual(['frame_too_large']);
  });

  it('rejects objects and binary frames', () => {
    for (const data of [{ a: 1 }, new ArrayBuffer(4), new Uint8Array(2), 1]) {
      const { port, reasons } = setup();
      port.deliver(data);
      expect(reasons).toEqual(['non_string_frame']);
    }
  });

  it('terminates when the receive queue exceeds 256 KiB or 1,024 frames', () => {
    const bytes = setup();
    for (let i = 0; i < 9; i++) bytes.port.deliver('y'.repeat(30 * 1024));
    expect(bytes.reasons).toEqual(['queue_overflow']);
    const count = setup();
    for (let i = 0; i <= MAX_QUEUED_FRAMES; i++) count.port.deliver('z');
    expect(count.reasons).toEqual(['queue_overflow']);
  });

  it('messageerror terminates the session (S4)', () => {
    const { port, reasons } = setup();
    port.onmessageerror?.({} as MessageEvent);
    expect(reasons).toEqual(['messageerror']);
  });

  it('works over a real MessageChannel', async () => {
    const channel = new MessageChannel();
    const reasons: TerminationReason[] = [];
    const transport = new BoundedPortTransport(channel.port1 as unknown as PortLike, (reason) =>
      reasons.push(reason)
    );
    channel.port2.postMessage('hello');
    await expect(transport.receive()).resolves.toBe('hello');
    channel.port2.postMessage({ structured: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reasons).toEqual(['non_string_frame']);
    channel.port2.close();
  });
});
