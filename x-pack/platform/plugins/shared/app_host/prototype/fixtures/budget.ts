/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// The first callback succeeds; the second exceeds the one-callback budget.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { INDEX, denied, type FixtureHost } from './host';

export class App extends WorkerEntrypoint {
  async run(host: FixtureHost) {
    const first = await host.search({ index: INDEX, size: 1 });
    const secondDenied = await denied(() => host.search({ index: INDEX, size: 1 }));
    return { first: first.total, secondDenied };
  }
}
