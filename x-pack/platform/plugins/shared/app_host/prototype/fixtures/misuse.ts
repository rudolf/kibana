/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// One host-contract misuse attempt per invocation, selected at build time with __MISUSE_CASE__.
// Each case runs in a fresh invocation; the app reports the exact rejection message so the seam can
// check the specific contract error.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { INDEX, rejection, type FixtureHost } from './host';

declare const __MISUSE_CASE__: string;

type Loose = Record<string, (...args: unknown[]) => Promise<unknown>>;

const MISUSE_CASES: Record<string, (host: FixtureHost) => Promise<unknown>> = {
  unknownMethod: (host) => (host as unknown as Loose).deleteIndex({ index: INDEX }),
  wildcard: (host) => host.search({ index: 'kbn-apps-*', size: 1 }),
  alias: (host) => host.search({ index: '.alerts-security.alerts-default', size: 1 }),
  arrayIndex: (host) => host.search({ index: [INDEX], size: 1 }),
  extraField: (host) => host.search({ index: INDEX, size: 1, query: { match_all: {} } }),
  badSize: (host) => host.search({ index: INDEX, size: 'x' }),
};

export class App extends WorkerEntrypoint {
  async run(host: FixtureHost) {
    const attempt = MISUSE_CASES[__MISUSE_CASE__];
    if (!attempt) return { case: __MISUSE_CASE__, error: 'unknown misuse case' };
    return { case: __MISUSE_CASE__, error: await rejection(() => attempt(host)) };
  }
}
