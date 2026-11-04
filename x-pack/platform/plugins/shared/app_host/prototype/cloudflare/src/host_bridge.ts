/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RpcTarget } from 'capnweb';
import {
  MAX_CALLBACKS_PER_INVOCATION,
  parseSearchParams,
  parseSearchResult,
  stacklessError,
  type SearchResult,
} from '../../shared/protocol';
import { sanitize } from './errors';
import type { HostStub } from './env';

/**
 * Native Workers RPC bridge handed to the Dynamic Worker as `run(bridge)`.
 * On Workers, capnweb's `RpcTarget` is the built-in `cloudflare:workers` class.
 * The capnweb host stub stays in a private field; only `search` is on the prototype.
 */
export class HostBridge extends RpcTarget {
  #host: HostStub | undefined;
  #calls = 0;

  constructor(host: HostStub) {
    super();
    this.#host = host;
  }

  /** Static, so it is not on the prototype and never reachable over RPC. */
  static revoke(bridge: HostBridge): void {
    bridge.#host = undefined;
  }

  async search(params: unknown): Promise<SearchResult> {
    const host = this.#host;
    if (!host) throw stacklessError('app_host:host_revoked');
    this.#calls += 1;
    if (this.#calls > MAX_CALLBACKS_PER_INVOCATION) {
      throw stacklessError('app_host:callback_budget');
    }
    try {
      const request = parseSearchParams(params);
      const result = await host.search(request);
      if (!this.#host) throw new Error('app_host:host_revoked');
      return parseSearchResult(result);
    } catch (error) {
      throw sanitize(error);
    }
  }
}
