/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { INDEX, rejects, type VariantHost } from './summary_host';

export class App extends WorkerEntrypoint {
  async run(host: VariantHost) {
    const loose = host as unknown as Record<string, (arg: unknown) => Promise<unknown>>;
    const denied = await rejects(() => loose.deleteIndex({ index: INDEX }));
    return {
      label: denied ? 'unknown-method-denied' : 'UNKNOWN-METHOD-ALLOWED',
      counts: { high: 0, low: 0 },
    };
  }
}
