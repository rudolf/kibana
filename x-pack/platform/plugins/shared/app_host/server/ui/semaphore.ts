/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** Process-wide cap on concurrent UI server operations (intentionally shared). */
export class Semaphore {
  readonly #max: number;
  #inFlight = 0;

  constructor(max: number) {
    this.#max = max;
  }

  tryAcquire(): (() => void) | undefined {
    if (this.#inFlight >= this.#max) return undefined;
    this.#inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inFlight -= 1;
    };
  }
}
