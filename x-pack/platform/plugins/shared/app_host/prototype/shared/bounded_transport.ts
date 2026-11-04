/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { MAX_QUEUED_TRANSPORT_BYTES, RPC_LIMITS } from './protocol';

/** Structural subset of the WHATWG WebSocket shared by Workers and Node 24. */
export interface MinimalWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: any) => void
  ): void;
}

const CONNECTING = 0;

/**
 * UTF-8 byte length without allocating (Workers has no `Buffer`). Matches `TextEncoder`, which
 * encodes a lone surrogate as U+FFFD (3 bytes). Never smaller than the UTF-16 code-unit count.
 */
export const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
};

interface QueuedFrame {
  readonly data: string;
  readonly bytes: number;
}

/**
 * capnweb string transport that rejects binary frames, oversized frames and unbounded receive
 * queues before any JSON parsing. Frame and queue limits count UTF-8 bytes; capnweb's own
 * `limits` (whose `maxMessageSize` counts UTF-16 code units) still apply after this check.
 */
export class BoundedWebSocketTransport {
  readonly #socket: MinimalWebSocket;
  #sendQueue: string[] | undefined;
  #receiveQueue: QueuedFrame[] = [];
  #queuedBytes = 0;
  #resolver: ((value: string) => void) | undefined;
  #rejecter: ((reason: unknown) => void) | undefined;
  #error: unknown;
  readonly #onClose: ((reason: unknown) => void) | undefined;

  constructor(socket: MinimalWebSocket, onClose?: (reason: unknown) => void) {
    this.#socket = socket;
    this.#onClose = onClose;
    if (socket.readyState === CONNECTING) {
      this.#sendQueue = [];
      socket.addEventListener('open', () => {
        const queue = this.#sendQueue ?? [];
        this.#sendQueue = undefined;
        try {
          for (const message of queue) socket.send(message);
        } catch (error) {
          this.#fail(error);
        }
      });
    }
    socket.addEventListener('message', (event: { data: unknown }) => {
      if (this.#error) return;
      const { data } = event;
      if (typeof data !== 'string') {
        this.#abortWith(new Error('Binary frames are not accepted.'));
        return;
      }
      // Cheap pre-check first: more code units than the byte cap is always over it.
      const bytes = data.length > RPC_LIMITS.maxMessageSize ? data.length : utf8ByteLength(data);
      if (bytes > RPC_LIMITS.maxMessageSize) {
        this.#abortWith(new Error('Incoming frame exceeds the message size limit.'));
        return;
      }
      if (this.#resolver) {
        const resolve = this.#resolver;
        this.#resolver = undefined;
        this.#rejecter = undefined;
        resolve(data);
        return;
      }
      this.#queuedBytes += bytes;
      if (this.#queuedBytes > MAX_QUEUED_TRANSPORT_BYTES) {
        this.#abortWith(new Error('Receive queue exceeded its bound.'));
        return;
      }
      this.#receiveQueue.push({ data, bytes });
    });
    socket.addEventListener('close', (event: { code?: number }) => {
      this.#fail(new Error(`Peer closed WebSocket (${event.code ?? 'unknown'}).`));
    });
    socket.addEventListener('error', () => {
      this.#fail(new Error('WebSocket connection failed.'));
    });
  }

  send(message: string): void {
    if (this.#error) throw this.#error;
    if (this.#sendQueue) {
      this.#sendQueue.push(message);
      return;
    }
    this.#socket.send(message);
  }

  receive(): Promise<string> {
    const next = this.#receiveQueue.shift();
    if (next !== undefined) {
      this.#queuedBytes -= next.bytes;
      return Promise.resolve(next.data);
    }
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => {
      this.#resolver = resolve;
      this.#rejecter = reject;
    });
  }

  abort(reason: unknown): void {
    this.#closeSocket(1011, 'rpc aborted');
    this.#fail(reason);
  }

  #abortWith(reason: Error): void {
    this.#closeSocket(1009, 'frame rejected');
    this.#fail(reason);
  }

  #closeSocket(code: number, reason: string): void {
    try {
      this.#socket.close(code, reason);
    } catch {
      // The socket may already be closed.
    }
  }

  #fail(reason: unknown): void {
    if (this.#error) return;
    this.#error = reason;
    this.#receiveQueue = [];
    this.#queuedBytes = 0;
    const reject = this.#rejecter;
    this.#resolver = undefined;
    this.#rejecter = undefined;
    reject?.(reason);
    this.#onClose?.(reason);
  }
}
