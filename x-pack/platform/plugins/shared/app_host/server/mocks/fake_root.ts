/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RpcTarget } from 'capnweb';
import { FakeInvocation } from './fake_invocation';
import type { FakeConnection, FakeDispatcherOptions } from './fake_types';

export class FakeRoot extends RpcTarget {
  readonly #connection: FakeConnection;
  readonly #options: FakeDispatcherOptions;

  constructor(connection: FakeConnection, options: FakeDispatcherOptions) {
    super();
    this.#connection = connection;
    this.#options = options;
  }

  authenticate(token: unknown): FakeInvocation {
    if (token !== this.#options.token) throw new Error('app_host:unauthorized');
    this.#connection.authenticated = true;
    return new FakeInvocation(this.#connection, this.#options.behaviour);
  }
}
