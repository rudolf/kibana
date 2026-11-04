/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RpcTarget } from 'capnweb';
import type { Env } from './env';
import { Invocation } from './invocation';
import { isValidCallerToken } from './token';

export interface AuthHooks {
  onAuthenticated(): void;
  onRejected(): void;
}

/** The only object reachable before authentication: one `authenticate` attempt per socket. */
export class PublicRoot extends RpcTarget {
  #env: Env;
  #hooks: AuthHooks;
  #attempted = false;

  constructor(env: Env, hooks: AuthHooks) {
    super();
    this.#env = env;
    this.#hooks = hooks;
  }

  async authenticate(token: unknown): Promise<Invocation> {
    if (this.#attempted) {
      this.#hooks.onRejected();
      throw new Error('app_host:unauthorized');
    }
    this.#attempted = true;
    if (!(await isValidCallerToken(token, this.#env.KIBANA_CALLER_TOKEN ?? ''))) {
      this.#hooks.onRejected();
      throw new Error('app_host:unauthorized');
    }
    this.#hooks.onAuthenticated();
    return new Invocation(this.#env);
  }
}
