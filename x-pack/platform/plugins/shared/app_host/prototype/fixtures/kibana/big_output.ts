/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';

export class App extends WorkerEntrypoint {
  async run() {
    return { label: 'big', counts: { high: 0, low: 0 }, padding: 'x'.repeat(20 * 1024) };
  }
}
