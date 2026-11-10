/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { INDEX, count, type VariantHost } from './summary_host';

declare const __DELAY_MS__: number;

export class App extends WorkerEntrypoint {
  async run(host: VariantHost) {
    // Wall-clock wait; consumes no CPU.
    await new Promise((resolve) => setTimeout(resolve, __DELAY_MS__));
    const { records } = await host.search({ index: INDEX, size: 100 });
    return { label: `slow-${__DELAY_MS__}`, counts: count(records) };
  }
}
