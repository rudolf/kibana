/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RpcTransport } from 'capnweb';
import { RECEIVE_QUEUE_BYTES } from '../../common';

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

/**
 * capnweb string transport over the dispatcher WebSocket. Its one bound is the receive queue:
 * frames received but not yet read by capnweb, counted as 2 bytes per UTF-16 code unit
 * (`RECEIVE_QUEUE_BYTES`). Overflow or a binary frame closes the socket (1009) and fails the
 * session before capnweb parses anything.
 */
export class BoundedWebSocketTransport implements RpcTransport {
  readonly #socket: MinimalWebSocket;
  readonly #maxQueuedBytes: number;
  #sendQueue: string[] | undefined;
  #receiveQueue: string[] = [];
  #queuedBytes = 0;
  #resolve: ((value: string) => void) | undefined;
  #reject: ((reason: unknown) => void) | undefined;
  #error: unknown;

  constructor(socket: MinimalWebSocket, maxQueuedBytes: number = RECEIVE_QUEUE_BYTES) {
    this.#socket = socket;
    this.#maxQueuedBytes = maxQueuedBytes;
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
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
      this.#pump();
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

  #pump(): void {
    const resolve = this.#resolve;
    if (this.#error || !resolve) return;
    const next = this.#receiveQueue.shift();
    if (next === undefined) return;
    this.#queuedBytes -= next.length * 2;
    this.#resolve = undefined;
    this.#reject = undefined;
    resolve(next);
  }

  #onMessage(data: unknown): void {
    if (this.#error) return;
    if (typeof data !== 'string') {
      this.#rejectFrame('Binary frames are not accepted.');
      return;
    }
    this.#queuedBytes += data.length * 2;
    if (this.#queuedBytes > this.#maxQueuedBytes) {
      this.#rejectFrame('Receive queue exceeded its bound.');
      return;
    }
    this.#receiveQueue.push(data);
    this.#pump();
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
