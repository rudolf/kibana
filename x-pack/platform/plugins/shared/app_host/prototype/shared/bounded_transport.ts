/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { MAX_QUEUED_TRANSPORT_BYTES } from './protocol';

/** Structural subset of WebSocket shared by the Workers runtime and Node 24. */
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
 * capnweb string transport. Its one bound is the receive queue: frames received but not yet read
 * by capnweb, counted as 2 bytes per UTF-16 code unit. Overflow or a binary frame closes the socket
 * (1009) and fails the session before capnweb parses anything.
 */
export class BoundedWebSocketTransport {
  readonly #socket: MinimalWebSocket;
  readonly #maxQueuedBytes: number;
  #sendQueue: string[] | undefined;
  #receiveQueue: string[] = [];
  #queuedBytes = 0;
  #resolver: ((value: string) => void) | undefined;
  #rejecter: ((reason: unknown) => void) | undefined;
  #error: unknown;
  readonly #onClose: ((reason: unknown) => void) | undefined;

  constructor(
    socket: MinimalWebSocket,
    onClose?: (reason: unknown) => void,
    maxQueuedBytes: number = MAX_QUEUED_TRANSPORT_BYTES
  ) {
    this.#socket = socket;
    this.#onClose = onClose;
    this.#maxQueuedBytes = maxQueuedBytes;
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
      this.#queuedBytes += data.length * 2;
      if (this.#queuedBytes > this.#maxQueuedBytes) {
        this.#abortWith(new Error('Receive queue exceeded its bound.'));
        return;
      }
      this.#receiveQueue.push(data);
      this.#pump();
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
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => {
      this.#resolver = resolve;
      this.#rejecter = reject;
      this.#pump();
    });
  }

  abort(reason: unknown): void {
    this.#closeSocket(1011, 'rpc aborted');
    this.#fail(reason);
  }

  #pump(): void {
    const resolve = this.#resolver;
    if (this.#error || !resolve) return;
    const next = this.#receiveQueue.shift();
    if (next === undefined) return;
    this.#queuedBytes -= next.length * 2;
    this.#resolver = undefined;
    this.#rejecter = undefined;
    resolve(next);
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
