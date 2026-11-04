/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'node:crypto';
import { UI_CONTRACT_V1, canonicalJson } from '../../common/ui_contract';

export const sha256Hex = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

/** Host-computed `ui.scopeMapDigest` for bridgeApi 1 (capabilities + UI security profile). */
export const SCOPE_MAP_DIGEST_V1 = sha256Hex(canonicalJson(UI_CONTRACT_V1));

/** Full release digest: canonical manifest content excluding `releaseDigest` itself. */
export const computeReleaseDigest = (manifest: Readonly<Record<string, unknown>>): string => {
  const { releaseDigest: _omitted, ...rest } = manifest;
  return sha256Hex(canonicalJson(rest));
};
