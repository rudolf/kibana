/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { MAX_TOKEN_LENGTH, MIN_TOKEN_LENGTH } from './env';

const encoder = new TextEncoder();

const digest = (value: string) => crypto.subtle.digest('SHA-256', encoder.encode(value));

/** Constant-time comparison of fixed-length SHA-256 digests (Workers `timingSafeEqual`). */
export const isValidCallerToken = async (
  candidate: unknown,
  expected: string
): Promise<boolean> => {
  if (typeof candidate !== 'string') return false;
  if (candidate.length < MIN_TOKEN_LENGTH || candidate.length > MAX_TOKEN_LENGTH) return false;
  if (expected.length < MIN_TOKEN_LENGTH) return false;
  const [a, b] = await Promise.all([digest(candidate), digest(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
};
