/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { BridgeErrorCode } from '../../common/ui_protocol';

/**
 * Host-held lifecycle of one bridge. Kept outside `AppBridge` so that revocation is not a method
 * reachable over RPC. Revoking aborts pending reads and suppresses their results.
 */
export class BridgeLifecycle {
  readonly #abort = new AbortController();
  #revoked: BridgeErrorCode | undefined;

  public get revoked(): BridgeErrorCode | undefined {
    return this.#revoked;
  }

  public get signal(): AbortSignal {
    return this.#abort.signal;
  }

  revoke(code: BridgeErrorCode): void {
    if (this.#revoked) return;
    this.#revoked = code;
    this.#abort.abort();
  }
}
