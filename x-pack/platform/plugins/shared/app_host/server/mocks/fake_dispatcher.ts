/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RpcSession } from 'capnweb';
import { BoundedWebSocketTransport, type MinimalWebSocket } from '../remote/bounded_transport';
import { FakeRoot } from './fake_root';
import { FakeSocket } from './fake_socket';
import type { FakeConnection, FakeDispatcherOptions } from './fake_types';

export { FakeSocket } from './fake_socket';
export type { FakeConnection, HostStub, InvokeBehaviour } from './fake_types';

/** A capnweb dispatcher double reachable through `createSocket`, recording every connection. */
export const createFakeDispatcher = (options: FakeDispatcherOptions) => {
  const connections: FakeConnection[] = [];
  const createSocket = (): MinimalWebSocket => {
    const client = new FakeSocket();
    const server = new FakeSocket();
    client.peer = server;
    server.peer = client;
    const connection = { client, server, authenticated: false, invocations: 0 } as FakeConnection;
    const session = new RpcSession(
      new BoundedWebSocketTransport(server),
      new FakeRoot(connection, options)
    );
    Object.assign(connection, { session });
    connections.push(connection);
    setImmediate(() => {
      server.open();
      client.open();
    });
    return client;
  };
  return { createSocket, connections };
};
