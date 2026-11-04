/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RpcTransport } from 'capnweb';
import { RPC_LIMITS } from '../../common';

export interface WebSocketEventLike {
  readonly data?: unknown;
  readonly code?: number;
}

/** Structural subset of the WHATWG WebSocket available in Node 24. */
export interface MinimalWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: WebSocketEventLike) => void
  ): void;
}

const CONNECTING = 0;
const MAX_QUEUED_BYTES = 4 * RPC_LIMITS.maxMessageSize;

/** UTF-8 byte length of a frame. A UTF-16 code unit never encodes to fewer than one UTF-8 byte. */
export const frameBytes = (data: string): number => Buffer.byteLength(data, 'utf8');

interface QueuedFrame {
  readonly data: string;
  readonly bytes: number;
}

/**
 * capnweb string transport that rejects binary frames, oversized frames and unbounded receive
 * queues before JSON parsing. Frame and queue limits count UTF-8 bytes, not UTF-16 code units
 * (capnweb's own `maxMessageSize` counts code units, so it would let a multibyte frame through). Node's built-in WebSocket cannot cap the frame size it buffers
 * (`maxPayload`), so a single oversized frame is still received before it is rejected here.
 */
export class BoundedWebSocketTransport implements RpcTransport {
  readonly #socket: MinimalWebSocket;
  #sendQueue: string[] | undefined;
  #receiveQueue: QueuedFrame[] = [];
  #queuedBytes = 0;
  #resolve: ((value: string) => void) | undefined;
  #reject: ((reason: unknown) => void) | undefined;
  #error: unknown;

  constructor(socket: MinimalWebSocket) {
    this.#socket = socket;
    if (socket.readyState === CONNECTING) {
      this.#sendQueue = [];
      socket.addEventListener('open', () => this.#flush());
    }
    socket.addEventListener('message', ({ data }) => this.#onMessage(data));
    socket.addEventListener('close', ({ code }) =>
      this.#fail(new Error(`Dispatcher closed the connection (${code ?? 'unknown'}).`))
    );
    socket.addEventListener('error', () => this.#fail(new Error('Dispatcher connection failed.')));
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
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  abort(reason: unknown): void {
    this.#close(1011, 'rpc aborted');
    this.#fail(reason);
  }

  #flush(): void {
    const queue = this.#sendQueue ?? [];
    this.#sendQueue = undefined;
    try {
      for (const message of queue) this.#socket.send(message);
    } catch (error) {
      this.#fail(error);
    }
  }

  #onMessage(data: unknown): void {
    if (this.#error) return;
    if (typeof data !== 'string') {
      this.#rejectFrame('Binary frames are not accepted.');
      return;
    }
    // Cheap pre-check first: more code units than the byte cap is always over it.
    const bytes = data.length > RPC_LIMITS.maxMessageSize ? data.length : frameBytes(data);
    if (bytes > RPC_LIMITS.maxMessageSize) {
      this.#rejectFrame('Incoming frame exceeds the message size limit.');
      return;
    }
    if (this.#resolve) {
      const resolve = this.#resolve;
      this.#resolve = undefined;
      this.#reject = undefined;
      resolve(data);
      return;
    }
    this.#queuedBytes += bytes;
    if (this.#queuedBytes > MAX_QUEUED_BYTES) {
      this.#rejectFrame('Receive queue exceeded its bound.');
      return;
    }
    this.#receiveQueue.push({ data, bytes });
  }

  #rejectFrame(message: string): void {
    this.#close(1009, 'frame rejected');
    this.#fail(new Error(message));
  }

  #close(code: number, reason: string): void {
    try {
      this.#socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  #fail(reason: unknown): void {
    if (this.#error) return;
    this.#error = reason;
    this.#receiveQueue = [];
    this.#queuedBytes = 0;
    const reject = this.#reject;
    this.#resolve = undefined;
    this.#reject = undefined;
    reject?.(reason);
  }
}
