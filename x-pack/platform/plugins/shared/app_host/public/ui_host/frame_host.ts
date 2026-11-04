/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RpcSession } from 'capnweb';
import type { BridgeErrorCode, UiTheme } from '../../common/ui_protocol';
import { UI_HANDSHAKE_PROTOCOL, UI_LIMITS } from '../../common/ui_protocol';
import { UI_SECURITY_PROFILE } from '../../common/ui_contract';
import type { BridgeExecutor, BridgeGrant } from './bridge_root';
import { AppBridge, BridgeLifecycle, sanitizeBridgeError } from './bridge_root';
import { BoundedPortTransport } from './port_transport';

export type FrameHostEndReason =
  | 'unmounted'
  | 'disabled'
  | 'stale'
  | 'expired'
  | 'handshake_timeout'
  | 'guardian_reloaded'
  | 'child_reloaded'
  | 'bad_init'
  | 'bad_ready'
  | 'messageerror'
  | 'protocol_error'
  | 'lease_rejected';

export interface FrameHostOptions {
  readonly container: HTMLElement;
  /** Basepath-prefixed guardian document path from server metadata. */
  readonly guardianUrl: string;
  /** This page's own origin; the guardian is same-origin. */
  readonly kibanaOrigin: string;
  readonly grant: BridgeGrant;
  readonly theme: () => UiTheme;
  readonly executor: BridgeExecutor | undefined;
  readonly onBound?: () => void;
  readonly onEnded: (reason: FrameHostEndReason, detail?: string) => void;
  readonly onLocalRejection?: (method: string, code: BridgeErrorCode) => void;
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

const END_CODES: Partial<Record<FrameHostEndReason, BridgeErrorCode>> = {
  disabled: 'app_disabled',
  stale: 'app_stale',
  expired: 'app_expired',
};

/**
 * Owns one guardian iframe, its one-time MessageChannel handshake and the bounded RPC session.
 * There is no global window `message` listener; guardian lifecycle notices arrive on a dedicated
 * control port. Any subsequent guardian or child load revokes; nothing is ever rebound.
 */
export class FrameHost {
  readonly #options: FrameHostOptions;
  readonly #lifecycle = new BridgeLifecycle();
  #iframe: HTMLIFrameElement | undefined;
  #transport: BoundedPortTransport | undefined;
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

  start(): void {
    const { container, guardianUrl } = this.#options;
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
    this.#timer = setTimeout(() => {
      if (!this.#bound) this.end('handshake_timeout');
    }, this.#options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    this.#iframe = iframe;
    iframe.src = guardianUrl;
    container.appendChild(iframe);
  }

  /** Idempotent teardown: revoke the bridge, close ports and remove the frame. */
  end(reason: FrameHostEndReason, detail?: string): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#lifecycle.revoke(END_CODES[reason] ?? 'app_disabled');
    this.#transport?.terminate('closed');
    if (this.#control) {
      this.#control.onmessage = null;
      this.#control.close();
    }
    this.#iframe?.remove();
    this.#iframe = undefined;
    this.#options.onEnded(reason, detail);
  }

  #handshake(iframe: HTMLIFrameElement): void {
    const target = iframe.contentWindow;
    if (!target || this.#ended) return;
    const rpc = new MessageChannel();
    const control = new MessageChannel();
    this.#control = control.port1;
    control.port1.onmessage = (event: MessageEvent) => this.#onControl(event.data);
    control.port1.onmessageerror = () => this.end('messageerror');
    this.#startSession(rpc.port1);
    // The guardian is same-origin: target the exact Kibana origin, never '*'.
    target.postMessage(
      { t: 'init', p: UI_HANDSHAKE_PROTOCOL, c: randomChallenge() },
      this.#options.kibanaOrigin,
      [rpc.port2, control.port2]
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

  #startSession(port: MessagePort): void {
    const sessionRef: { current?: RpcSession } = {};
    const transport = new BoundedPortTransport(port, (reason) =>
      this.end('protocol_error', reason)
    );
    this.#transport = transport;
    const bridge = new AppBridge(
      this.#options.grant,
      this.#options.theme,
      this.#options.executor,
      {
        beforeCall: () => {
          if (!sessionRef.current) return true;
          const { imports, exports } = sessionRef.current.getStats();
          if (imports + exports <= UI_LIMITS.liveRpcStubs) return true;
          this.end('protocol_error', 'live_stubs');
          return false;
        },
        terminate: (reason) => this.end('protocol_error', reason),
        onLocalRejection: this.#options.onLocalRejection,
      },
      this.#lifecycle
    );
    sessionRef.current = new RpcSession(transport, bridge, {
      limits: {
        maxDepth: UI_LIMITS.rpcMaxDepth,
        maxBigIntDigits: UI_LIMITS.rpcMaxBigIntDigits,
        maxMessageSize: UI_LIMITS.frameBytes,
      },
      onSendError: sanitizeBridgeError,
    });
  }
}
