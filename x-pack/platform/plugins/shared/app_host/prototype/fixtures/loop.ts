/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Infinite CPU loop; must be bounded by the Dynamic Worker CPU limit or the host deadline.

import { WorkerEntrypoint } from 'cloudflare:workers';

export class App extends WorkerEntrypoint {
  async run() {
    let spins = 0;
    for (;;) spins += 1;
    return spins;
  }
}
