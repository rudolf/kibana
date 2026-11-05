/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { BridgeWorkerInit, BridgeWorkerNotice } from '../../common/ui_protocol';
import { UI_HANDSHAKE_PROTOCOL, UI_LIMITS } from '../../common/ui_protocol';
import { UI_SECURITY_PROFILE } from '../../common/ui_contract';

export type FrameHostEndReason =
  | 'unmounted'
  | 'disabled'
  | 'stale'
  | 'expired'
  | 'session_failed'
  | 'worker_error'
  | 'handshake_timeout'
  | 'guardian_reloaded'
  | 'child_reloaded'
  | 'bad_init'
  | 'bad_ready'
  | 'messageerror'
  | 'protocol_error';

/** The parts of a `Worker` the frame host uses (a test double needs only these). */
export interface BridgeWorkerLike {
  onmessage: ((event: MessageEvent<BridgeWorkerNotice>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: BridgeWorkerInit, transfer: Transferable[]): void;
  terminate(): void;
}

export interface FrameHostOptions {
  readonly container: HTMLElement;
  /** Basepath-prefixed guardian document path from server metadata. */
  readonly guardianUrl: string;
  /** This page's own origin; the guardian is same-origin. */
  readonly kibanaOrigin: string;
  readonly createWorker: () => BridgeWorkerLike;
  readonly workerInit: Omit<BridgeWorkerInit, 't'>;
  readonly onBound?: () => void;
  readonly onEnded: (reason: FrameHostEndReason, detail?: string) => void;
  readonly handshakeTimeoutMs?: number;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;

const randomChallenge = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const WORKER_END: Partial<Record<string, FrameHostEndReason>> = {
  session_failed: 'session_failed',
  app_disabled: 'disabled',
  app_stale: 'stale',
  app_expired: 'expired',
};

/**
 * Owns one app frame's lifecycle: the bridge Worker (which mints the session and runs the RPC
 * session off this thread), the guardian iframe and its one-time MessageChannel handshake. The
 * page never sees the session handle or a bridge message. There is no global window `message`
 * listener; guardian lifecycle notices arrive on a dedicated control port. Any later guardian or
 * child load ends the frame; nothing is ever rebound. Ending terminates the Worker.
 */
export class FrameHost {
  readonly #options: FrameHostOptions;
  #worker: BridgeWorkerLike | undefined;
  #guestPort: MessagePort | undefined;
  #iframe: HTMLIFrameElement | undefined;
  #control: MessagePort | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #ended = false;
  #bound = false;

  constructor(options: FrameHostOptions) {
    this.#options = options;
  }

  public get bound(): boolean {
    return this.#bound;
  }

  /** Starts the Worker; the frame is mounted only once the Worker reports a minted session. */
  start(): void {
    const worker = this.#options.createWorker();
    this.#worker = worker;
    worker.onmessage = ({ data }) => this.#onWorker(data);
    worker.onerror = () => this.end('worker_error');
    worker.onmessageerror = () => this.end('messageerror');
    const rpc = new MessageChannel();
    this.#guestPort = rpc.port2;
    worker.postMessage({ t: 'init', ...this.#options.workerInit }, [rpc.port1]);
    this.#timer = setTimeout(() => {
      if (!this.#bound) this.end('handshake_timeout');
    }, this.#options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  }

  /** Idempotent teardown: terminate the Worker, close ports and remove the frame. */
  end(reason: FrameHostEndReason, detail?: string): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#guestPort?.close();
    this.#guestPort = undefined;
    if (this.#control) {
      this.#control.onmessage = null;
      this.#control.close();
    }
    this.#iframe?.remove();
    this.#iframe = undefined;
    this.#options.onEnded(reason, detail);
  }

  #onWorker(notice: BridgeWorkerNotice): void {
    if (this.#ended) return;
    if (notice?.t === 'ready' && !this.#iframe) {
      this.#mount();
      return;
    }
    const reason = notice?.t === 'end' ? notice.reason : 'unexpected_notice';
    const mapped = WORKER_END[reason];
    if (mapped) this.end(mapped);
    else this.end('protocol_error', reason);
  }

  #mount(): void {
    const iframe = document.createElement('iframe');
    // S3: fixed guardian attributes. No sandbox, allow or allowfullscreen; no-referrer.
    Object.entries(UI_SECURITY_PROFILE.guardianIframe.attributes).forEach(([name, value]) =>
      iframe.setAttribute(name, value)
    );
    iframe.setAttribute('title', 'Third-party app (untrusted content)');
    iframe.setAttribute('data-test-subj', 'appHostGuardianFrame');
    iframe.style.display = 'block';
    iframe.style.width = '100%';
    iframe.style.height = `${UI_LIMITS.frameHeightPx}px`;
    iframe.style.border = '0';
    let loads = 0;
    iframe.addEventListener('load', () => {
      loads += 1;
      if (loads === 1) this.#handshake(iframe);
      else this.end('guardian_reloaded');
    });
    this.#iframe = iframe;
    iframe.src = this.#options.guardianUrl;
    this.#options.container.appendChild(iframe);
  }

  #handshake(iframe: HTMLIFrameElement): void {
    const target = iframe.contentWindow;
    const guestPort = this.#guestPort;
    if (!target || !guestPort || this.#ended) return;
    this.#guestPort = undefined;
    const control = new MessageChannel();
    this.#control = control.port1;
    control.port1.onmessage = (event: MessageEvent) => this.#onControl(event.data);
    control.port1.onmessageerror = () => this.end('messageerror');
    // The guardian is same-origin: target the exact Kibana origin, never '*'.
    target.postMessage(
      { t: 'init', p: UI_HANDSHAKE_PROTOCOL, c: randomChallenge() },
      this.#options.kibanaOrigin,
      [guestPort, control.port2]
    );
  }

  #onControl(data: unknown): void {
    const type =
      typeof data === 'object' && data !== null && 't' in data
        ? (data as { t: unknown }).t
        : undefined;
    if (type === 'bound' && !this.#bound) {
      this.#bound = true;
      if (this.#timer) clearTimeout(this.#timer);
      this.#options.onBound?.();
      return;
    }
    const known: FrameHostEndReason[] = ['child_reloaded', 'bad_init', 'bad_ready', 'messageerror'];
    this.end(known.find((reason) => reason === type) ?? 'protocol_error');
  }
}
