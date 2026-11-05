/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { randomUUID } from 'node:crypto';
import { RpcSession } from 'capnweb';
import { expose } from '@kbn/core-remote-common';
import { projectWorkerManifest } from '../package/manifest_schema';
import type { AppPackage } from '../package/read_package';
import { BoundedWebSocketTransport, type MinimalWebSocket } from './bounded_transport';
import { sanitizeOutboundError } from './host_error';
import { HostEs } from './host_es';
import type { SearchCapability } from './search_capability';

/** Structural view of the dispatcher's authenticated capability. */
interface DispatcherInvocation extends Disposable {
  invoke(request: unknown, host: unknown): Promise<unknown>;
}

/** Structural view of the dispatcher's public root; only `authenticate` exists remotely. */
interface DispatcherRoot extends Disposable {
  authenticate(token: string): Promise<DispatcherInvocation>;
}

export type InvokeErrorCode =
  | 'aborted'
  | 'disconnected'
  | 'dispatcher_unauthorized'
  | 'remote_error';

export class InvokeError extends Error {
  readonly code: InvokeErrorCode;
  /** Sanitized `app_host:<code>` reported by the dispatcher, if any. */
  readonly remoteCode: string | undefined;

  constructor(code: InvokeErrorCode, remoteCode?: string) {
    super(`App invocation failed: ${code}${remoteCode ? ` (${remoteCode})` : ''}`);
    this.name = 'InvokeError';
    this.code = code;
    this.remoteCode = remoteCode;
  }
}

export interface InvokeTimings {
  connectMs: number;
  authMs: number;
  invokeMs: number;
  requestBytes: number;
  responseBytes: number;
}

export interface InvokeAppOptions {
  readonly dispatcherUrl: string;
  readonly callerToken: string;
  readonly pkg: AppPackage;
  readonly capability: SearchCapability;
  /** Aborts when the request is aborted. */
  readonly signal: AbortSignal;
  readonly createSocket?: (url: string) => MinimalWebSocket;
}

const defaultSocket = (url: string): MinimalWebSocket => new WebSocket(url);

const remoteCodeOf = (error: unknown): string | undefined => {
  const message = error instanceof Error ? error.message : undefined;
  const match = message?.match(/^app_host:([a-z_]+)$/);
  return match ? match[1] : undefined;
};

/**
 * Runs one invocation on a fresh WebSocket: authenticate, then invoke with a freshly exposed
 * `HostEs`. Never replays. Always revokes the capability, disposes stubs and closes the socket.
 */
export const invokeApp = async ({
  dispatcherUrl,
  callerToken,
  pkg,
  capability,
  signal,
  createSocket = defaultSocket,
}: InvokeAppOptions): Promise<{ value: unknown; timings: InvokeTimings }> => {
  const started = performance.now();
  // Preserve the Worker wire schema: never forward UI, approval or dashboard grant fields.
  const request = {
    manifest: projectWorkerManifest(pkg.manifest),
    bundle: pkg.bundle,
    invocationId: randomUUID(),
  };
  const timings: InvokeTimings = {
    connectMs: 0,
    authMs: 0,
    invokeMs: 0,
    requestBytes: Buffer.byteLength(JSON.stringify(request)),
    responseBytes: 0,
  };
  if (signal.aborted) throw new InvokeError('aborted');

  const socket = createSocket(dispatcherUrl);
  socket.addEventListener('open', () => {
    timings.connectMs = Math.round(performance.now() - started);
  });
  // No local main capability: nothing on the Node side is reachable before authentication.
  const session = new RpcSession(new BoundedWebSocketTransport(socket), undefined, {
    onSendError: sanitizeOutboundError,
  });
  const root = session.getRemoteMain() as unknown as DispatcherRoot;

  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new InvokeError('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    socket.addEventListener('close', () => reject(new InvokeError('disconnected')));
  });
  stopped.catch(() => undefined);

  let invocation: DispatcherInvocation | undefined;
  let phase: 'auth' | 'invoke' = 'auth';
  try {
    invocation = await Promise.race([root.authenticate(callerToken), stopped]);
    timings.authMs = Math.round(performance.now() - started) - timings.connectMs;
    phase = 'invoke';
    const invokeStarted = performance.now();
    const host = expose(new HostEs(capability));
    const value = await Promise.race([invocation.invoke(request, host), stopped]);
    timings.invokeMs = Math.round(performance.now() - invokeStarted);
    timings.responseBytes = Buffer.byteLength(JSON.stringify(value) ?? '');
    return { value, timings };
  } catch (error) {
    if (error instanceof InvokeError) throw error;
    if (signal.aborted) throw new InvokeError('aborted');
    const remoteCode = remoteCodeOf(error);
    if (phase === 'auth' && remoteCode === 'unauthorized') {
      throw new InvokeError('dispatcher_unauthorized', remoteCode);
    }
    throw new InvokeError('remote_error', remoteCode);
  } finally {
    capability.revoke();
    if (onAbort) signal.removeEventListener('abort', onAbort);
    try {
      socket.close(1000, 'invocation complete');
    } catch {
      // Already closed.
    }
    invocation?.[Symbol.dispose]();
    root[Symbol.dispose]();
  }
};
