/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { rejects, type VariantHost } from './summary_host';

export class App extends WorkerEntrypoint {
  async run(host: VariantHost) {
    const denied = await rejects(() => host.search({ index: '.kibana', size: 1 }));
    return {
      label: denied ? 'forbidden-index-denied' : 'FORBIDDEN-INDEX-ALLOWED',
      counts: { high: 0, low: 0 },
    };
  }
}
