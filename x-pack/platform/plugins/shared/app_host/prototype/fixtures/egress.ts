/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Attempts global fetch and TCP connect, then proves the granted callback still works.
// Returns each denial reason, so the seam can tell a sandbox-policy denial from an unrelated
// DNS/network failure.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import { INDEX, rejection, type FixtureHost } from './host';

export class App extends WorkerEntrypoint {
  async run(host: FixtureHost) {
    const fetchError = await rejection(async () => {
      const response = await fetch('https://example.com/');
      await response.arrayBuffer();
    });
    const connectError = await rejection(async () => {
      const socket = connect({ hostname: 'example.com', port: 80 });
      await socket.opened;
      await socket.close();
    });
    const { total } = await host.search({ index: INDEX, size: 1 });
    return { fetchError, connectError, callback: total + 1 };
  }
}
