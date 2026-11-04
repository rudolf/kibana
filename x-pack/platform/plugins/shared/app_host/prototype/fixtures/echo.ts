/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Returns exactly what its own host returned, for cross-invocation isolation checks.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { INDEX, type FixtureHost } from './host';

export class App extends WorkerEntrypoint {
  async run(host: FixtureHost) {
    const { total, records } = await host.search({ index: INDEX, size: 1 });
    return { total, rule: records[0]?.rule ?? null };
  }
}
