/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** Token bucket checked synchronously, before any awaited work. */
export class TokenBucket {
  readonly #ratePerMs: number;
  readonly #burst: number;
  readonly #now: () => number;
  #tokens: number;
  #last: number;

  constructor(perSecond: number, burst: number, now: () => number = () => Date.now()) {
    this.#ratePerMs = perSecond / 1000;
    this.#burst = burst;
    this.#now = now;
    this.#tokens = burst;
    this.#last = now();
  }

  tryTake(): boolean {
    const now = this.#now();
    this.#tokens = Math.min(this.#burst, this.#tokens + (now - this.#last) * this.#ratePerMs);
    this.#last = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
