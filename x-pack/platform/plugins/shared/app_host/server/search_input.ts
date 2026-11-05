/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { LIMITS, SYNTHETIC_INDEX } from '../common';

export type SearchInput =
  | { readonly ok: true; readonly index: string; readonly size: number }
  | { readonly ok: false; readonly reason: 'invalid_search' | 'index_not_granted' };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * Input schema for every host-built search (Worker `HostEs` callback and UI bridge): exactly
 * `{index, size}`, the synthetic index literal and an integer size 1–100. It is input validation
 * only, not an authorizer: Elasticsearch enforces what the app session key may read.
 * `anyIndex` (K1 fault injection, dev-only config) accepts any bounded index string.
 */
export const parseSearchInput = (params: unknown, { anyIndex = false } = {}): SearchInput => {
  if (!isPlainObject(params)) return { ok: false, reason: 'invalid_search' };
  const keys = Object.getOwnPropertyNames(params);
  if (keys.length !== 2 || !keys.includes('index') || !keys.includes('size')) {
    return { ok: false, reason: 'invalid_search' };
  }
  const { index, size } = params;
  if (typeof index !== 'string' || index.length === 0 || index.length > 255) {
    return { ok: false, reason: 'index_not_granted' };
  }
  if (!anyIndex && index !== SYNTHETIC_INDEX) return { ok: false, reason: 'index_not_granted' };
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
    return { ok: false, reason: 'invalid_search' };
  }
  if (size > LIMITS.callbackRecords) return { ok: false, reason: 'invalid_search' };
  return { ok: true, index, size };
};
