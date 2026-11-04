/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Summary } from '../app/src/summary';

test('Summary groups records by severity and requests only the granted index', async () => {
  const calls: unknown[] = [];
  const host = {
    search: async (params: { index: string; size: number }) => {
      calls.push(params);
      return {
        total: 4,
        records: [
          { severity: 'high', rule: 'a' },
          { severity: 'high', rule: 'b' },
          { severity: 'low', rule: 'c' },
          { severity: 'medium', rule: 'd' },
        ],
      };
    },
  };
  assert.deepEqual(await new Summary(host, 'Digest v1').compute(), {
    label: 'Digest v1',
    counts: { high: 2, low: 1 },
  });
  assert.deepEqual(calls, [{ index: 'kbn-apps-prototype-alerts', size: 100 }]);
});
