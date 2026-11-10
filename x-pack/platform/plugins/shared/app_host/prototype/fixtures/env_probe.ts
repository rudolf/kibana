/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Diagnostic only: reports whether a raw capnweb stub placed in Loader env is usable.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { INDEX } from './host';

interface ProbeEnv {
  HOST?: { search(params: unknown): Promise<{ total: number }> };
  GREETER?: { greet(name: string): Promise<string> };
}

export class App extends WorkerEntrypoint<ProbeEnv> {
  async run() {
    const out: Record<string, unknown> = {};
    const { HOST, GREETER } = this.env;
    out.hostType = typeof HOST;
    if (HOST) {
      try {
        out.hostResult = (await HOST.search({ index: INDEX, size: 1 })).total + 1;
      } catch (error) {
        out.hostError = String(error).slice(0, 200);
      }
    }
    if (GREETER) {
      try {
        out.greeter = await GREETER.greet('probe');
      } catch (error) {
        out.greeterError = String(error).slice(0, 200);
      }
    }
    return out;
  }
}
