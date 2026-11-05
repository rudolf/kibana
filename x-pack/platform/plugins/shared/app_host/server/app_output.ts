/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { LIMITS } from '../common';
import type { SeverityCounts } from '../common';

export interface AppOutput {
  readonly label: string;
  readonly counts: SeverityCounts;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Strictly validates app output `{label, counts:{high, low}}`; returns undefined when invalid. */
export const parseAppOutput = (value: unknown): AppOutput | undefined => {
  if (!isPlainObject(value) || !hasExactKeys(value, ['label', 'counts'])) return undefined;
  const { label, counts } = value;
  if (typeof label !== 'string' || label.length === 0 || label.length > LIMITS.labelLength) {
    return undefined;
  }
  if (!isPlainObject(counts) || !hasExactKeys(counts, ['high', 'low'])) return undefined;
  const { high, low } = counts;
  if (!isCount(high) || !isCount(low)) return undefined;
  return { label, counts: { high, low } };
};
