/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUiRelease, releaseDigestOf, scopeMapDigest, sha256 } from '../scripts/lib/ui_release';

const DASHBOARD = '78a07dab-f7e4-4bdf-b155-da929711312c';

test('tool scope-map digest equals the plugin-pinned bridgeApi 1 contract digest', () => {
  // Same value as the inline snapshot in server/ui/contract.test.ts.
  assert.equal(
    scopeMapDigest(),
    'f46b850c3116e006552cab012d76df65e63ec4bea4814233f99e6c1282d10a4c'
  );
});

test('UI release: one classic IIFE, digest-named entry, empty egress, full release digest', async () => {
  const { manifest, uiBundle, serverBundle } = await buildUiRelease({
    version: '2.0.0',
    label: 'Digest v2',
    dashboardId: DASHBOARD,
  });
  assert.equal(manifest.ui.digest, sha256(uiBundle));
  assert.equal(manifest.ui.entry, `${manifest.ui.digest}.js`);
  assert.equal(manifest.digest, sha256(serverBundle));
  assert.deepEqual(manifest.ui.egress, { client: [], server: [] });
  assert.deepEqual(manifest.permissions.dashboardIds, [DASHBOARD]);
  assert.deepEqual(manifest.permissions.indices, [
    'kbn-apps-prototype-alerts',
    'kbn-apps-demo-logs-*',
  ]);
  assert.equal(
    manifest.releaseDigest,
    releaseDigestOf(manifest as unknown as Record<string, unknown>)
  );
  assert.ok(Buffer.byteLength(uiBundle) < 512 * 1024);
  assert.match(uiBundle, /^\(\(\) => \{|^"use strict";\n\(\(\) => \{|^\(function/);
  assert.doesNotMatch(uiBundle, /\bimport\s*\(|sourceMappingURL|\beval\(|new Function/);
});

test('any change (same scopes) produces a new release digest', async () => {
  const a = await buildUiRelease({ version: '2.0.0', label: 'A', dashboardId: DASHBOARD });
  const b = await buildUiRelease({ version: '2.0.0', label: 'B', dashboardId: DASHBOARD });
  assert.notEqual(a.manifest.releaseDigest, b.manifest.releaseDigest);
  assert.deepEqual(a.manifest.ui.scopes, b.manifest.ui.scopes);
});
