/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RpcSession } from 'capnweb';
import type { FakeSocket } from './fake_socket';

export type HostStub = Record<string, (...args: unknown[]) => Promise<unknown>>;

export type InvokeBehaviour = (request: unknown, host: HostStub) => Promise<unknown>;

export interface FakeDispatcherOptions {
  readonly token: string;
  readonly behaviour: InvokeBehaviour;
}

export interface FakeConnection {
  readonly client: FakeSocket;
  readonly server: FakeSocket;
  readonly session: RpcSession;
  authenticated: boolean;
  invocations: number;
}
