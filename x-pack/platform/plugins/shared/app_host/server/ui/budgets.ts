/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { UI_LIMITS } from '../../common/ui_protocol';
import { TokenBucket } from './token_bucket';

export { Semaphore } from './semaphore';

/**
 * Operation buckets keyed by (app, user, space): shared by every lease of the same viewer, never by
 * all viewers of an app. Bounded map; idle buckets are dropped.
 */
export class OperationBuckets {
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  tryTake(appId: string, principal: string, spaceId: string): boolean {
    const key = JSON.stringify([appId, principal, spaceId]);
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      if (this.#buckets.size >= 1024) {
        for (const [existing, value] of this.#buckets)
          if (value.idle()) this.#buckets.delete(existing);
        if (this.#buckets.size >= 1024) return false;
      }
      bucket = new TokenBucket(UI_LIMITS.operationsPerSecond, UI_LIMITS.operationsBurst, this.#now);
      this.#buckets.set(key, bucket);
    }
    return bucket.tryTake();
  }
}
