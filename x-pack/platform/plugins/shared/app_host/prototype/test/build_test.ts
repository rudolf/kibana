/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, buildFixture } from '../scripts/lib/build';
import { parseManifest, sha256Hex } from '../shared/protocol';

test('app bundle is self-contained and digest-addressed', async () => {
  const { manifest, bundle } = await buildApp('1.0.0', 'Digest v1');
  parseManifest(manifest);
  assert.equal(manifest.digest, await sha256Hex(bundle));
  assert.match(bundle, /from "cloudflare:workers"/);
  // No Node, capnweb or Kibana remotable helpers inside the Worker bundle.
  assert.doesNotMatch(bundle, /node:|capnweb|@kbn\/|reflect-metadata|inversify/);
  assert.match(bundle, /Digest v1/);
});

test('different labels produce different digests', async () => {
  const v1 = await buildApp('1.0.0', 'Digest v1');
  const v2 = await buildApp('1.0.1', 'Digest v2');
  assert.notEqual(v1.manifest.digest, v2.manifest.digest);
});

test('fixtures build', async () => {
  for (const name of ['adder', 'egress', 'loop', 'sentinel', 'echo', 'misuse', 'env_probe']) {
    const { manifest } = await buildFixture(name);
    parseManifest(manifest);
  }
});
