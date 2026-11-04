/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Diagnostic Worker for the day-one risk "can Loader env carry a capnweb stub?".
// Deliberately separate from the dispatcher; not the selected architecture; local only.

import { RpcSession } from 'capnweb';
import { BoundedWebSocketTransport } from '../../shared/bounded_transport';
import { RPC_LIMITS } from '../../shared/protocol';
import type { Env } from './env';
import { ProbeRoot } from './probe_root';
import type { ProbeContext } from './probe_target';

export { Greeter } from './probe_greeter';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Upgrade Required', { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    new RpcSession(new BoundedWebSocketTransport(server), new ProbeRoot(env, ctx as ProbeContext), {
      limits: RPC_LIMITS,
    });
    return new Response(null, { status: 101, webSocket: client });
  },
} satisfies ExportedHandler<Env>;
