/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Synthetic M1 callback: host returns total 41, the app adds one.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { INDEX, type FixtureHost } from './host';

export class App extends WorkerEntrypoint {
  async run(host: FixtureHost) {
    const { total } = await host.search({ index: INDEX, size: 1 });
    return total + 1;
  }
}
