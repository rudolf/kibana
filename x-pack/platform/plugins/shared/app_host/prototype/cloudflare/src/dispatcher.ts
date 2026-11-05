/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// App Host prototype dispatcher Worker.
// Public RPC root exposes only `authenticate(token)`. A successful call returns a single-use
// invocation capability. Each invocation loads a fresh Dynamic Worker with no egress and no env,
// and passes it a native RpcTarget bridge that forwards only `search` to the Kibana host stub.

import { RpcSession } from 'capnweb';
import { BoundedWebSocketTransport } from '../../shared/bounded_transport';
import { UNAUTHENTICATED_IDLE_MS } from '../../shared/protocol';
import { MIN_TOKEN_LENGTH, type Env } from './env';
import { sanitize } from './errors';
import { PublicRoot } from './public_root';

const acceptRpc = (env: Env): Response => {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const close = (code: number, reason: string) => {
    clearIdle();
    try {
      server.close(code, reason);
    } catch {
      // Already closed.
    }
  };
  const root = new PublicRoot(env, {
    onAuthenticated: clearIdle,
    // Let capnweb deliver the rejection before closing.
    onRejected: () => setTimeout(() => close(1008, 'unauthorized'), 50),
  });
  idleTimer = setTimeout(() => close(1008, 'authentication timeout'), UNAUTHENTICATED_IDLE_MS);
  // The session lives exactly as long as the socket; nothing is kept in globals.
  new RpcSession(new BoundedWebSocketTransport(server, clearIdle), root, {
    onSendError: (error) => sanitize(error),
  });
  return new Response(null, { status: 101, webSocket: client });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/rpc') return new Response('Not found', { status: 404 });
    const upgrade = request.headers.get('Upgrade')?.toLowerCase();
    if (request.method !== 'GET' || upgrade !== 'websocket') {
      return new Response('Upgrade Required', { status: 426, headers: { Upgrade: 'websocket' } });
    }
    if ((env.KIBANA_CALLER_TOKEN ?? '').length < MIN_TOKEN_LENGTH) {
      return new Response('Dispatcher not configured', { status: 503 });
    }
    return acceptRpc(env);
  },
} satisfies ExportedHandler<Env>;
