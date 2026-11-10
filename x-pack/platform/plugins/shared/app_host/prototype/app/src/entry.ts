/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Native WorkerEntrypoint adapter. The dispatcher calls `run(bridge)`; the bridge exposes only `search`.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { Summary, type SummaryHost } from './summary';

declare const __APP_LABEL__: string;

export class App extends WorkerEntrypoint {
  async run(host: SummaryHost) {
    return new Summary(host, __APP_LABEL__).compute();
  }
}
