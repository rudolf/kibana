/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RpcTarget } from 'capnweb';
import {
  APP_CPU_MS,
  APP_SUBREQUESTS,
  COMPATIBILITY_DATE,
  parseInvokeRequest,
} from '../../shared/protocol';
import { APP_ENTRYPOINT, type Env } from './env';

export interface ProbeContext {
  exports?: Record<string, unknown>;
}

interface Runnable {
  run(): Promise<unknown>;
}

const loadProbe = (env: Env, bundle: string, probeEnv: Record<string, unknown>): Runnable =>
  env.LOADER.load({
    compatibilityDate: COMPATIBILITY_DATE,
    mainModule: 'app.js',
    modules: { 'app.js': bundle },
    globalOutbound: null,
    env: probeEnv,
    limits: { cpuMs: APP_CPU_MS, subRequests: APP_SUBREQUESTS },
  }).getEntrypoint(APP_ENTRYPOINT) as unknown as Runnable;

const describe = (error: unknown): string => String(error).slice(0, 300);

/** Diagnostic capability: tries the two Loader-env delivery options and reports the outcome. */
export class Probe extends RpcTarget {
  #env: Env;
  #ctx: ProbeContext;

  constructor(env: Env, ctx: ProbeContext) {
    super();
    this.#env = env;
    this.#ctx = ctx;
  }

  async rawStubInEnv(request: unknown, host: unknown): Promise<unknown> {
    const { bundle } = parseInvokeRequest(request);
    try {
      return { ok: true, value: await loadProbe(this.#env, bundle, { HOST: host }).run() };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  }

  async ctxExportsInEnv(request: unknown): Promise<unknown> {
    const { bundle } = parseInvokeRequest(request);
    const loopback = this.#ctx.exports?.Greeter as
      | ((options: { props: object }) => unknown)
      | undefined;
    if (typeof loopback !== 'function') {
      return { ok: false, error: 'ctx.exports.Greeter unavailable' };
    }
    try {
      // A loopback binding must be specialised with props before it can be placed in env.
      const greeter = loopback({ props: {} });
      return { ok: true, value: await loadProbe(this.#env, bundle, { GREETER: greeter }).run() };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  }
}
