/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Returns module and global state counters. A fresh Worker must always report 1 and false.

import { WorkerEntrypoint } from 'cloudflare:workers';

let moduleCount = 0;

export class App extends WorkerEntrypoint {
  async run() {
    moduleCount += 1;
    const globals = globalThis as { __appHostSentinel?: boolean };
    const globalSeen = globals.__appHostSentinel === true;
    globals.__appHostSentinel = true;
    return { moduleCount, globalSeen };
  }
}
