/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { describeDispatcher, normalizeDispatcherUrl } from './dispatcher_endpoint';

// The same vectors are pinned in prototype/test/dispatcher_target_test.ts, so the tooling's
// recomputation from `--rpc` stays byte-identical to what Kibana reports.
describe('describeDispatcher', () => {
  it('describes a loopback dispatcher', () => {
    expect(describeDispatcher('ws://127.0.0.1:8787/rpc')).toBe(
      'scheme=ws,class=loopback,fp=731a85aec9305232'
    );
  });

  it('normalizes case, default port, query and hash for a remote dispatcher', () => {
    const raw = 'WSS://Kbn-App-Host-Proto-Dispatcher.Example.Workers.Dev:443/rpc?x=1#y';
    expect(normalizeDispatcherUrl(raw)).toBe(
      'wss://kbn-app-host-proto-dispatcher.example.workers.dev/rpc'
    );
    expect(describeDispatcher(raw)).toBe('scheme=wss,class=remote,fp=a2df8e3740afaf0a');
  });

  it('distinguishes endpoints and never includes the URL itself', () => {
    const a = describeDispatcher('ws://127.0.0.1:8787/rpc');
    const b = describeDispatcher('ws://127.0.0.1:8788/rpc');
    expect(a).not.toBe(b);
    expect(a).not.toContain('127.0.0.1');
  });
});
