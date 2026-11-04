/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { INDEX, count, rejectionLabel, type VariantHost } from './summary_host';

export class App extends WorkerEntrypoint {
  async run(host: VariantHost) {
    const { records } = await host.search({ index: INDEX, size: 100 });
    return {
      label: await rejectionLabel('second-callback-denied', () =>
        host.search({ index: INDEX, size: 100 })
      ),
      counts: count(records),
    };
  }
}
