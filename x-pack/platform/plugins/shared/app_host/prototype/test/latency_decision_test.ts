/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latencyDecision, type LatencyDecisionInput } from '../scripts/lib/latency_decision';

const allValid: LatencyDecisionInput = {
  verifiedMode: 'remote',
  requestedSamples: 20,
  validSamples: 20,
  failedSamples: 0,
  seamRequestedSamples: 20,
  seamValidSamples: 20,
  p95: 400,
};

test('GO only for a verified remote target with every sample valid and p95 <= 2 s', () => {
  assert.equal(latencyDecision(allValid), 'GO (latency)');
  assert.match(latencyDecision({ ...allValid, p95: 2500 }), /^NO-GO/);
});

test('failed or invalid samples block a GO, however fast the successful ones were', () => {
  assert.match(
    latencyDecision({ ...allValid, validSamples: 19, failedSamples: 1 }),
    /^NO DECISION/
  );
  assert.match(latencyDecision({ ...allValid, validSamples: 19 }), /^NO DECISION/);
  assert.match(latencyDecision({ ...allValid, seamValidSamples: 19 }), /^NO DECISION/);
});

test('unverified or local targets never produce a GO', () => {
  assert.equal(
    latencyDecision({ ...allValid, verifiedMode: null }),
    'NO DECISION: dispatcher target not verified'
  );
  assert.match(latencyDecision({ ...allValid, verifiedMode: 'local' }), /^NO DECISION: local/);
});
