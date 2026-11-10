/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeDispatcher,
  parseTimingHeader,
  requestedTarget,
  verifyDispatcher,
} from '../scripts/lib/dispatcher_target';

const LOCAL = 'ws://127.0.0.1:8787/rpc';
const REMOTE = 'wss://kbn-app-host-proto-dispatcher.example.workers.dev/rpc';
const header = (dispatcher: string) =>
  `dispatcher;desc="${dispatcher}", total;dur=6.1, callbacks;desc="1", logical_bytes;desc="req=1,res=2,cb_req=3,cb_res=4"`;

test('descriptions match the vectors pinned in server/remote/dispatcher_endpoint.test.ts', () => {
  assert.equal(describeDispatcher(LOCAL), 'scheme=ws,class=loopback,fp=731a85aec9305232');
  assert.equal(
    describeDispatcher('WSS://Kbn-App-Host-Proto-Dispatcher.Example.Workers.Dev:443/rpc?x=1#y'),
    'scheme=wss,class=remote,fp=a2df8e3740afaf0a'
  );
});

test('timing header parsing keeps the dispatcher description intact', () => {
  const { durations, descriptions } = parseTimingHeader(header(describeDispatcher(LOCAL)));
  assert.equal(descriptions.dispatcher, 'scheme=ws,class=loopback,fp=731a85aec9305232');
  assert.equal(descriptions.callbacks, '1');
  assert.equal(durations.total, 6.1);
});

test('requested target: remote needs non-loopback wss, --local-workerd needs loopback', () => {
  assert.equal(requestedTarget(LOCAL, true).mode, 'local');
  assert.equal(requestedTarget('wss://localhost:8787/rpc', true).mode, 'local');
  assert.equal(requestedTarget(REMOTE, false).mode, 'remote');
  assert.throws(() => requestedTarget(undefined, false), /--rpc is required/);
  assert.throws(() => requestedTarget(REMOTE, true), /only allowed for a loopback/);
  assert.throws(() => requestedTarget('ws://dispatcher.example.com/rpc', true), /loopback/);
  assert.throws(() => requestedTarget('ws://dispatcher.example.com/rpc', false), /wss:\/\//);
  assert.throws(() => requestedTarget(LOCAL, false), /wss:\/\//);
  assert.throws(() => requestedTarget('wss://127.0.0.1:8787/rpc', false), /non-loopback/);
  assert.throws(() => requestedTarget('https://example.com/rpc', false), /ws:\/\/ or wss:\/\//);
});

test('regression: a remote --rpc against a locally configured Kibana fails verification', () => {
  const target = requestedTarget(REMOTE, false);
  const result = verifyDispatcher(target, header(describeDispatcher(LOCAL)));
  assert.equal(result.verified, false);
  assert.equal(result.observedMode, 'local');
  assert.match(result.reason ?? '', /local dispatcher, remote was requested/);
});

test('a different remote endpoint than --rpc fails on the fingerprint', () => {
  const target = requestedTarget(REMOTE, false);
  const other = describeDispatcher('wss://other.example.workers.dev/rpc');
  const result = verifyDispatcher(target, header(other));
  assert.equal(result.verified, false);
  assert.equal(result.observedMode, 'remote');
  assert.match(result.reason ?? '', /fingerprint mismatch/);
});

test('missing or malformed evidence is never verified', () => {
  const target = requestedTarget(LOCAL, true);
  for (const value of [null, '', 'total;dur=1.0', 'dispatcher;desc="scheme=ws,class=loopback"']) {
    const result = verifyDispatcher(target, value);
    assert.equal(result.verified, false);
    assert.equal(result.observedMode, null);
  }
});

test('the matching endpoint verifies, with mode derived from the evidence', () => {
  const local = verifyDispatcher(requestedTarget(LOCAL, true), header(describeDispatcher(LOCAL)));
  assert.deepEqual([local.verified, local.observedMode], [true, 'local']);
  const remote = verifyDispatcher(
    requestedTarget(REMOTE, false),
    header(describeDispatcher(REMOTE))
  );
  assert.deepEqual([remote.verified, remote.observedMode], [true, 'remote']);
});
