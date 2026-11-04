/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { LIMITS, SYNTHETIC_INDEX } from '../common';

/** The grant of one verified release, held for the whole operation. Never client-supplied. */
export interface VerifiedGrant {
  readonly appId: string;
  readonly indices: readonly string[];
}

export type SearchDecision =
  | { readonly allowed: true; readonly index: typeof SYNTHETIC_INDEX; readonly size: number }
  | { readonly allowed: false; readonly reason: 'invalid_search' | 'index_not_granted' };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * The single pure decision for every host-built search, used by both the Worker `HostEs` callback
 * and the UI bridge adapter. S8: besides the release grant, the synthetic index literal is asserted
 * here independently of the manifest schema, so an approved manifest naming any other concrete
 * index (dot-prefixed or not) still cannot be read. No patterns, lists, aliases or CCS names.
 */
export const evaluateSearch = (grant: VerifiedGrant, params: unknown): SearchDecision => {
  if (!isPlainObject(params)) return { allowed: false, reason: 'invalid_search' };
  const keys = Object.getOwnPropertyNames(params);
  if (keys.length !== 2 || !keys.includes('index') || !keys.includes('size')) {
    return { allowed: false, reason: 'invalid_search' };
  }
  const { index, size } = params;
  if (
    index !== SYNTHETIC_INDEX ||
    grant.indices.length !== 1 ||
    grant.indices[0] !== SYNTHETIC_INDEX
  ) {
    return { allowed: false, reason: 'index_not_granted' };
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
    return { allowed: false, reason: 'invalid_search' };
  }
  if (size > LIMITS.callbackRecords) return { allowed: false, reason: 'invalid_search' };
  return { allowed: true, index: SYNTHETIC_INDEX, size };
};

/** Post-check on every hit: an alias with the granted name could resolve elsewhere. */
export const isGrantedHitIndex = (grant: VerifiedGrant, hitIndex: string): boolean =>
  hitIndex === SYNTHETIC_INDEX && grant.indices.includes(hitIndex);
