/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RpcTransport } from 'capnweb';
import { UI_LIMITS } from '../../common/ui_protocol';
import { TokenBucket } from './token_bucket';

export { TokenBucket } from './token_bucket';

/** UTF-8 byte length without allocating; lone surrogates count as 3 bytes (U+FFFD). */
export const utf8Bytes = (value: string): number => {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
};

export type TerminationReason =
  | 'non_string_frame'
  | 'frame_too_large'
  | 'queue_overflow'
  | 'messageerror'
  | 'closed'
  | 'aborted';

export interface PortLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: string): void;
  close(): void;
}

/** Upper bound on queued (not yet delivered) frames, independent of their byte size. */
export const MAX_QUEUED_FRAMES = 1024;

/**
 * capnweb string-only transport over a MessagePort. Rejects objects/binary, frames over 32 KiB
 * UTF-8 and a receive queue over 256 KiB (or 1,024 frames) *before* capnweb parses anything, and
 * terminates the session on `messageerror`. Ingress is paced at 60 msgs/s (burst 16): frames above
 * the rate wait in the bounded queue instead of being delivered to capnweb. The browser's structured
 * clone of the incoming value still happens before this code runs (documented residual).
 */
export class BoundedPortTransport implements RpcTransport {
  readonly #port: PortLike;
  readonly #ingress: TokenBucket;
  readonly #onTerminate: (reason: TerminationReason) => void;
  #queue: Array<{ data: string; bytes: number }> = [];
  #queuedBytes = 0;
  #resolve: ((value: string) => void) | undefined;
  #reject: ((reason: Error) => void) | undefined;
  #error: Error | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    port: PortLike,
    onTerminate: (reason: TerminationReason) => void,
    ingress: TokenBucket = new TokenBucket(UI_LIMITS.ingressPerSecond, UI_LIMITS.ingressBurst)
  ) {
    this.#port = port;
    this.#onTerminate = onTerminate;
    this.#ingress = ingress;
    port.onmessage = (event) => this.#onMessage(event.data);
    port.onmessageerror = () => this.terminate('messageerror');
  }

  public get terminated(): boolean {
    return this.#error !== undefined;
  }

  send(message: string): void {
    if (this.#error) throw this.#error;
    this.#port.postMessage(message);
  }

  receive(): Promise<string> {
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
      this.#pump();
    });
  }

  /** Delivers the next queued frame when both a receiver and an ingress token are available. */
  #pump(): void {
    if (this.#error || !this.#resolve || this.#queue.length === 0 || this.#timer) return;
    if (!this.#ingress.tryTake()) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#pump();
      }, Math.ceil(1000 / UI_LIMITS.ingressPerSecond));
      return;
    }
    const next = this.#queue.shift();
    if (!next) return;
    this.#queuedBytes -= next.bytes;
    const resolve = this.#resolve;
    this.#resolve = undefined;
    this.#reject = undefined;
    resolve(next.data);
  }

  abort(): void {
    this.terminate('aborted');
  }

  /** Idempotent: closes the port, drops queued frames and rejects the pending receive. */
  terminate(reason: TerminationReason): void {
    if (this.#error) return;
    this.#error = new Error(`bridge_protocol_error:${reason}`);
    this.#port.onmessage = null;
    this.#port.onmessageerror = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    try {
      this.#port.close();
    } catch {
      // Already closed.
    }
    this.#queue = [];
    this.#queuedBytes = 0;
    const reject = this.#reject;
    this.#resolve = undefined;
    this.#reject = undefined;
    reject?.(this.#error);
    this.#onTerminate(reason);
  }

  #onMessage(data: unknown): void {
    if (this.#error) return;
    if (typeof data !== 'string') {
      this.terminate('non_string_frame');
      return;
    }
    // More code units than the byte cap is always over it; otherwise count exactly.
    const bytes = data.length > UI_LIMITS.frameBytes ? data.length : utf8Bytes(data);
    if (bytes > UI_LIMITS.frameBytes) {
      this.terminate('frame_too_large');
      return;
    }
    this.#queuedBytes += bytes;
    if (
      this.#queuedBytes > UI_LIMITS.receiveQueueBytes ||
      this.#queue.length >= MAX_QUEUED_FRAMES
    ) {
      this.terminate('queue_overflow');
      return;
    }
    this.#queue.push({ data, bytes });
    this.#pump();
  }
}
