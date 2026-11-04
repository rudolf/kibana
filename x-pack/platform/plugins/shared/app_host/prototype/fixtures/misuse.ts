/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Calls methods and arguments outside the host contract. Every attempt must be denied.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { INDEX, denied, type FixtureHost } from './host';

type Loose = Record<string, (...args: unknown[]) => Promise<unknown>>;

export class App extends WorkerEntrypoint {
  async run(host: FixtureHost) {
    const loose = host as unknown as Loose;
    return {
      unknownMethodDenied: await denied(() => loose.deleteIndex({ index: INDEX })),
      wildcardDenied: await denied(() => host.search({ index: 'kbn-apps-*', size: 1 })),
      aliasDenied: await denied(() =>
        host.search({ index: '.alerts-security.alerts-default', size: 1 })
      ),
      arrayIndexDenied: await denied(() => host.search({ index: [INDEX], size: 1 })),
      extraFieldDenied: await denied(() =>
        host.search({ index: INDEX, size: 1, query: { match_all: {} } })
      ),
      badSizeDenied: await denied(() => host.search({ index: INDEX, size: 'x' })),
      oversizeDenied: await denied(() => host.search({ index: INDEX, size: 101 })),
    };
  }
}
