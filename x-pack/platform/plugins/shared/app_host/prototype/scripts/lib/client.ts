/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Standalone Node capnweb client for the dispatcher (M1 seam). Kibana has its own implementation.

import { randomUUID } from 'node:crypto';
import { RpcSession, RpcTarget } from 'capnweb';
import { BoundedWebSocketTransport } from '../../shared/bounded_transport';
import { parseSearchParams, stacklessError, type SearchResult } from '../../shared/protocol';
import type { BuiltPackage } from './build';

/** Structural view of the dispatcher's authenticated capability as seen through a capnweb stub. */
export interface RemoteInvocation extends Disposable {
  invoke(request: unknown, host: unknown): Promise<unknown>;
}

/** Structural view of the dispatcher's public root; only `authenticate` exists remotely. */
export interface RemoteRoot extends Disposable {
  authenticate(token: unknown): Promise<RemoteInvocation>;
}

/** Untyped view for negative tests that call methods which must not exist. */
export type LooseStub = Record<string, (...args: unknown[]) => Promise<unknown>>;

export interface Session {
  readonly root: RemoteRoot;
  readonly socket: WebSocket;
  readonly session: RpcSession;
  /** Resolves with the elapsed milliseconds when the socket closes. */
  readonly closed: Promise<{ code: number; afterMs: number }>;
  close(): void;
}

/** `onSendError` for the tool client: one fixed, stackless code; never local paths or messages. */
export const sanitizeClientError = (): Error => stacklessError('app_host:host_error');

export const openSession = (url: string): Session => {
  const openedAt = performance.now();
  const socket = new WebSocket(url);
  const closed = new Promise<{ code: number; afterMs: number }>((resolve) => {
    socket.addEventListener('close', (event) =>
      resolve({ code: event.code, afterMs: Math.round(performance.now() - openedAt) })
    );
  });
  const session = new RpcSession(new BoundedWebSocketTransport(socket), undefined, {
    // Never send stacks or host-internal messages to the remote peer.
    onSendError: sanitizeClientError,
  });
  return {
    root: session.getRemoteMain() as unknown as RemoteRoot,
    socket,
    session,
    closed,
    close: () => {
      try {
        socket.close(1000, 'done');
      } catch {
        // Already closed.
      }
    },
  };
};

export type SearchHandler = (params: { index: string; size: number }) => Promise<SearchResult>;

/** Synthetic Node host capability with only `search`; revocable. */
export class SyntheticHost extends RpcTarget {
  #handler: SearchHandler | undefined;
  #calls = 0;

  constructor(handler: SearchHandler) {
    super();
    this.#handler = handler;
  }

  static revoke(host: SyntheticHost): void {
    host.#handler = undefined;
  }

  static calls(host: SyntheticHost): number {
    return host.#calls;
  }

  static isRevoked(host: SyntheticHost): boolean {
    return host.#handler === undefined;
  }

  async search(params: unknown): Promise<SearchResult> {
    const handler = this.#handler;
    if (!handler) throw new Error('revoked');
    this.#calls += 1;
    return handler(parseSearchParams(params));
  }
}

export interface InvokeTiming {
  connectAuthMs: number;
  invokeMs: number;
  totalMs: number;
  requestBytes: number;
  responseBytes: number;
}

export interface InvokeOutcome {
  ok: boolean;
  value?: unknown;
  error?: string;
  timing: InvokeTiming;
  host: SyntheticHost;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** One fresh connection, authentication and single invocation; always revokes and closes. */
export const invokeOnce = async (options: {
  url: string;
  token: string;
  pkg: BuiltPackage;
  handler: SearchHandler;
  /** Harness timeout only (so a hung run reports instead of hanging); not a host limit. */
  deadlineMs?: number;
  onSession?: (session: Session, host: SyntheticHost) => void;
}): Promise<InvokeOutcome> => {
  const { url, token, pkg, handler, deadlineMs = 5000, onSession } = options;
  const start = performance.now();
  const host = new SyntheticHost(handler);
  const session = openSession(url);
  onSession?.(session, host);
  const request = { manifest: pkg.manifest, bundle: pkg.bundle, invocationId: randomUUID() };
  const timing: InvokeTiming = {
    connectAuthMs: 0,
    invokeMs: 0,
    totalMs: 0,
    requestBytes: Buffer.byteLength(JSON.stringify(request)),
    responseBytes: 0,
  };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('deadline')), deadlineMs);
  });
  const closedEarly = session.closed.then(({ code }) => {
    throw new Error(`socket closed (${code})`);
  });
  let invocation: RemoteInvocation | undefined;
  try {
    invocation = await Promise.race([session.root.authenticate(token), deadline, closedEarly]);
    timing.connectAuthMs = Math.round(performance.now() - start);
    const invokeStart = performance.now();
    const value = await Promise.race([invocation.invoke(request, host), deadline, closedEarly]);
    timing.invokeMs = Math.round(performance.now() - invokeStart);
    timing.responseBytes = Buffer.byteLength(JSON.stringify(value) ?? '');
    return { ok: true, value, timing, host };
  } catch (error) {
    return { ok: false, error: errorMessage(error), timing, host };
  } finally {
    clearTimeout(timer);
    closedEarly.catch(() => undefined);
    SyntheticHost.revoke(host);
    invocation?.[Symbol.dispose]();
    session.root[Symbol.dispose]();
    session.close();
    timing.totalMs = Math.round(performance.now() - start);
  }
};
