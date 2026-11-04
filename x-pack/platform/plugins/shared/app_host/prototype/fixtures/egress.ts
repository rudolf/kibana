/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Attempts global fetch and TCP connect, then proves the granted callback still works.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import { INDEX, denied, type FixtureHost } from './host';

export class App extends WorkerEntrypoint {
  async run(host: FixtureHost) {
    const fetchBlocked = await denied(async () => {
      const response = await fetch('https://example.com/');
      await response.arrayBuffer();
    });
    const connectBlocked = await denied(async () => {
      const socket = connect({ hostname: 'example.com', port: 80 });
      await socket.opened;
      await socket.close();
    });
    const { total } = await host.search({ index: INDEX, size: 1 });
    return { fetchBlocked, connectBlocked, callback: total + 1 };
  }
}
