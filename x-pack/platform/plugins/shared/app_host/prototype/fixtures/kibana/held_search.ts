/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Holds one invocation open across operator actions: one search now, then one more after each
// wall-clock wait (no CPU). The label reports each later search's outcome.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { INDEX, count, rejectionLabel, type VariantHost } from './summary_host';

declare const __WAITS_MS__: number[];

export class App extends WorkerEntrypoint {
  async run(host: VariantHost) {
    const { records } = await host.search({ index: INDEX, size: 10 });
    const later: string[] = [];
    for (const wait of __WAITS_MS__) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      later.push(await rejectionLabel('s', () => host.search({ index: INDEX, size: 10 })));
    }
    return { label: later.join('|').slice(0, 80), counts: count(records) };
  }
}
