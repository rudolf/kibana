/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { INDEX, rejectionLabel, type VariantHost } from './summary_host';

export class App extends WorkerEntrypoint {
  async run(host: VariantHost) {
    const loose = host as unknown as Record<string, (arg: unknown) => Promise<unknown>>;
    return {
      label: await rejectionLabel('unknown-method', () => loose.deleteIndex({ index: INDEX })),
      counts: { high: 0, low: 0 },
    };
  }
}
