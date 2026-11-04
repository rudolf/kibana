/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RpcTarget } from 'capnweb';
import type { FakeConnection, HostStub, InvokeBehaviour } from './fake_types';

export class FakeInvocation extends RpcTarget {
  readonly #connection: FakeConnection;
  readonly #behaviour: InvokeBehaviour;

  constructor(connection: FakeConnection, behaviour: InvokeBehaviour) {
    super();
    this.#connection = connection;
    this.#behaviour = behaviour;
  }

  invoke(request: unknown, host: HostStub): Promise<unknown> {
    this.#connection.invocations += 1;
    return this.#behaviour(request, host);
  }
}
