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
  ProtocolError,
  parseAppResult,
  parseInvokeRequest,
  sha256Hex,
} from '../../shared/protocol';
import { APP_ENTRYPOINT, type Env, type HostStub } from './env';
import { sanitize } from './errors';
import { HostBridge } from './host_bridge';

interface AppEntrypoint {
  run(host: HostBridge): Promise<unknown>;
}

/** Authenticated, single-use capability returned by `authenticate`. */
export class Invocation extends RpcTarget {
  #env: Env | undefined;

  constructor(env: Env) {
    super();
    this.#env = env;
  }

  async invoke(request: unknown, host: HostStub): Promise<unknown> {
    const env = this.#env;
    this.#env = undefined;
    if (!env) throw new Error('app_host:capability_used');
    let bridge: HostBridge | undefined;
    try {
      const { manifest, bundle } = parseInvokeRequest(request);
      if ((await sha256Hex(bundle)) !== manifest.digest) {
        throw new ProtocolError('digest_mismatch', 'bundle digest mismatch');
      }
      if (typeof host?.search !== 'function') throw new ProtocolError('invalid_request', 'host');
      // Fresh Dynamic Worker per invocation: no cache id, no env, no egress.
      const worker = env.LOADER.load({
        compatibilityDate: COMPATIBILITY_DATE,
        mainModule: 'app.js',
        modules: { 'app.js': bundle },
        globalOutbound: null,
        env: {},
        limits: { cpuMs: APP_CPU_MS, subRequests: APP_SUBREQUESTS },
      });
      const entrypoint = worker.getEntrypoint(APP_ENTRYPOINT) as unknown as AppEntrypoint;
      bridge = new HostBridge(host);
      // Awaiting keeps the callback lifetime inside this invocation.
      const result = await entrypoint.run(bridge);
      return parseAppResult(result);
    } catch (error) {
      throw sanitize(error);
    } finally {
      if (bridge) HostBridge.revoke(bridge);
    }
  }
}
