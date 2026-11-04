/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProtocolError,
  SYNTHETIC_INDEX,
  parseAppResult,
  parseInvokeRequest,
  parseManifest,
  parseSearchParams,
  parseSearchResult,
  sha256Hex,
} from '../shared/protocol';

const manifest = () => ({
  id: 'alert-digest',
  title: 'Alert digest',
  version: '1.0.0',
  hostApi: 1,
  digest: 'a'.repeat(64),
  permissions: { indices: [SYNTHETIC_INDEX] },
  routes: [{ method: 'GET', path: '/summary', handler: 'summary' }],
});

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ProtocolError);
    return error.code;
  }
  return 'no-error';
};

test('accepts the exact manifest', () => {
  assert.deepEqual(parseManifest(manifest()), manifest());
});

test('rejects unknown fields, grants, routes and host API', () => {
  assert.equal(
    code(() => parseManifest({ ...manifest(), extra: 1 })),
    'invalid_manifest'
  );
  assert.equal(
    code(() => parseManifest({ ...manifest(), hostApi: 2 })),
    'invalid_manifest'
  );
  assert.equal(
    code(() => parseManifest({ ...manifest(), permissions: { indices: ['kbn-apps-*'] } })),
    'invalid_manifest'
  );
  assert.equal(
    code(() =>
      parseManifest({ ...manifest(), permissions: { indices: [SYNTHETIC_INDEX, 'other'] } })
    ),
    'invalid_manifest'
  );
  assert.equal(
    code(() =>
      parseManifest({
        ...manifest(),
        routes: [{ method: 'POST', path: '/summary', handler: 'summary' }],
      })
    ),
    'invalid_manifest'
  );
  assert.equal(
    code(() => parseManifest({ ...manifest(), digest: 'A'.repeat(64) })),
    'invalid_manifest'
  );
  assert.equal(
    code(() => parseManifest({ ...manifest(), title: 't'.repeat(81) })),
    'invalid_manifest'
  );
  assert.equal(
    code(() => parseManifest({ ...manifest(), version: 'v'.repeat(33) })),
    'invalid_manifest'
  );
});

test('bounds the bundle and invocation id', () => {
  const ok = {
    manifest: manifest(),
    bundle: 'export default {}',
    invocationId: crypto.randomUUID(),
  };
  assert.equal(parseInvokeRequest(ok).bundle, ok.bundle);
  assert.equal(
    code(() => parseInvokeRequest({ ...ok, bundle: 'a'.repeat(64 * 1024 + 1) })),
    'invalid_bundle'
  );
  assert.equal(
    code(() => parseInvokeRequest({ ...ok, invocationId: 'x' })),
    'invalid_request'
  );
  assert.equal(
    code(() => parseInvokeRequest({ ...ok, extra: true })),
    'invalid_request'
  );
});

test('search params require the exact index and a bounded integer size', () => {
  assert.deepEqual(parseSearchParams({ index: SYNTHETIC_INDEX, size: 100 }), {
    index: SYNTHETIC_INDEX,
    size: 100,
  });
  for (const index of [
    'kbn-apps-*',
    `${SYNTHETIC_INDEX},other`,
    'remote:' + SYNTHETIC_INDEX,
    [SYNTHETIC_INDEX],
  ]) {
    assert.equal(
      code(() => parseSearchParams({ index, size: 1 })),
      'index_not_granted'
    );
  }
  for (const size of [0, 101, 1.5, '1']) {
    assert.equal(
      code(() => parseSearchParams({ index: SYNTHETIC_INDEX, size })),
      'invalid_search'
    );
  }
  assert.equal(
    code(() => parseSearchParams({ index: SYNTHETIC_INDEX, size: 1, query: {} })),
    'invalid_search'
  );
});

test('search results are bounded in records and bytes', () => {
  const record = { severity: 'high', rule: 'r' };
  assert.equal(parseSearchResult({ total: 1, records: [record] }).records.length, 1);
  assert.equal(
    code(() => parseSearchResult({ total: 1, records: Array(101).fill(record) })),
    'invalid_result'
  );
  assert.equal(
    code(() =>
      parseSearchResult({
        total: 1,
        records: Array(100).fill({ severity: 'high', rule: 'é'.repeat(128) }),
      })
    ),
    'invalid_result'
  );
  assert.equal(
    code(() => parseSearchResult({ total: 1, records: [{ ...record, extra: 1 }] })),
    'invalid_result'
  );
});

test('app results must be plain bounded JSON', () => {
  assert.deepEqual(parseAppResult({ a: [1, 'x', null] }), { a: [1, 'x', null] });
  assert.equal(
    code(() => parseAppResult({ a: 'x'.repeat(17 * 1024) })),
    'invalid_app_result'
  );
  let deep: unknown = 1;
  for (let i = 0; i < 10; i++) deep = [deep];
  assert.equal(
    code(() => parseAppResult(deep)),
    'invalid_app_result'
  );
  assert.equal(
    code(() => parseAppResult(new Map())),
    'invalid_app_result'
  );
});

test('digest helper', async () => {
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});
