/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';

export class App extends WorkerEntrypoint {
  async run() {
    return {
      label: 'x'.repeat(81),
      counts: { high: 0, low: 0 },
      html: '<script>alert(1)</script>',
    };
  }
}
