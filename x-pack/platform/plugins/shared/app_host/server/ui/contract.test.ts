/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { BRIDGE_V1_CAPABILITIES, UI_CONTRACT_V1, canonicalJson } from '../../common/ui_contract';
import { SCOPE_MAP_DIGEST_V1, computeReleaseDigest } from './contract';

describe('bridgeApi 1 contract', () => {
  it('is pinned: any semantic expansion or policy relaxation changes this digest', () => {
    // Updating this value requires a new contract identity, security review and renewed approvals.
    expect(SCOPE_MAP_DIGEST_V1).toMatchInlineSnapshot(
      `"696dca371b839606c8fd6173cd1bea24bd32d1395fa32e21d11ce9f0032cd508"`
    );
  });

  it('declares only the four bridge methods with all safety flags false', () => {
    expect(BRIDGE_V1_CAPABILITIES.map(({ id, bridgeMethod }) => `${id}:${bridgeMethod}`)).toEqual([
      'app.summary:callAppRoute',
      'es.search:search',
      'kibana.dashboard.read:getDashboardPreview',
      'host.theme:getTheme',
    ]);
    for (const capability of BRIDGE_V1_CAPABILITIES) {
      expect([
        capability.mintsCredential,
        capability.executesLater,
        capability.egressSideEffect,
        capability.acceptsReferences,
      ]).toEqual([false, false, false, false]);
    }
  });

  it('canonical JSON is key-order independent and the release digest excludes itself', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
    expect(computeReleaseDigest({ a: 1, releaseDigest: 'x' })).toBe(computeReleaseDigest({ a: 1 }));
    expect(UI_CONTRACT_V1.securityProfile.childIframe.attributes.sandbox).toBe('allow-scripts');
  });
});
