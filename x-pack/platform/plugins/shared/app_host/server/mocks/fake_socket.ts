/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { MinimalWebSocket, WebSocketEventLike } from '../remote/bounded_transport';

type Listener = (event: WebSocketEventLike) => void;

/** In-memory WebSocket endpoint; frames are delivered asynchronously to its peer. */
export class FakeSocket implements MinimalWebSocket {
  readyState = 0;
  peer: FakeSocket | undefined;
  closeCode: number | undefined;
  readonly #listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const set = this.#listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(type, set);
  }

  emit(type: string, event: WebSocketEventLike = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket not open');
    const { peer } = this;
    setImmediate(() => {
      if (peer && peer.readyState === 1) peer.emit('message', { data });
    });
  }

  /** Delivers a raw frame to this socket, bypassing the peer (for oversized/binary frame tests). */
  inject(data: unknown): void {
    this.emit('message', { data });
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCode = code;
    setImmediate(() => {
      this.emit('close', { code });
      this.peer?.close(code);
    });
  }
}
