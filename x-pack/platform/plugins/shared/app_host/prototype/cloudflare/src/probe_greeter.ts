/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';

/** Loopback entrypoint used to check that `ctx.exports` bindings can be placed in Loader env. */
export class Greeter extends WorkerEntrypoint {
  async greet(name: string): Promise<string> {
    return `hello ${name}`;
  }
}
