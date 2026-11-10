/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RpcTarget } from 'capnweb';
import type { Env } from './env';
import { Probe, type ProbeContext } from './probe_target';
import { isValidCallerToken } from './token';

export class ProbeRoot extends RpcTarget {
  #env: Env;
  #ctx: ProbeContext;

  constructor(env: Env, ctx: ProbeContext) {
    super();
    this.#env = env;
    this.#ctx = ctx;
  }

  async authenticate(token: unknown): Promise<Probe> {
    if (!(await isValidCallerToken(token, this.#env.KIBANA_CALLER_TOKEN ?? ''))) {
      throw new Error('app_host:unauthorized');
    }
    return new Probe(this.#env, this.#ctx);
  }
}
