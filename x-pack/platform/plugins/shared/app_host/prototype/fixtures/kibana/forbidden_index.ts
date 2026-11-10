/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { rejectionLabel, type VariantHost } from './summary_host';

export class App extends WorkerEntrypoint {
  async run(host: VariantHost) {
    return {
      label: await rejectionLabel('forbidden-index-denied', () =>
        host.search({ index: '.kibana', size: 1 })
      ),
      counts: { high: 0, low: 0 },
    };
  }
}
