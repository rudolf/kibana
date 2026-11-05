/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// K4 credential scanner. Reports only locations, never the needles themselves.

/** One observed surface; `text: undefined` means its observer (log file, capture) is missing. */
export interface Surface {
  readonly where: string;
  readonly text: string | undefined;
}

export interface ScanResult {
  readonly status: 'PASS' | 'FAIL' | 'NOT_VERIFIED';
  readonly hits: readonly string[];
  readonly missing: readonly string[];
}

export interface KnownKey {
  readonly id: string;
  readonly secret: string;
}

/** Every form a known key can leak in: the bare secret, `id:secret` and its base64 credential. */
export const credentialNeedles = ({ id, secret }: KnownKey): string[] => {
  const pair = `${id}:${secret}`;
  return [
    secret,
    pair,
    Buffer.from(pair).toString('base64'),
    Buffer.from(pair).toString('base64url'),
  ];
};

/**
 * For keys whose secret is unknown (minted by Kibana): any encoding of `ApiKey base64(id:secret)`
 * starts with base64(`${id}:`) cut to whole 3-byte groups, which the public id fully determines.
 */
export const encodedPrefixNeedle = (id: string): string => {
  const prefix = Buffer.from(`${id}:`);
  return prefix.subarray(0, prefix.length - (prefix.length % 3)).toString('base64');
};

const API_KEY_HEADER = /ApiKey [A-Za-z0-9+/=_-]{20,}/;

/** FAIL on any needle or `ApiKey <credential>` text; NOT_VERIFIED when an observer is missing. */
export const scanSurfaces = (
  surfaces: readonly Surface[],
  needles: readonly string[]
): ScanResult => {
  const missing = surfaces.filter(({ text }) => text === undefined).map(({ where }) => where);
  const hits = surfaces
    .filter(
      ({ text }) =>
        text !== undefined &&
        (API_KEY_HEADER.test(text) || needles.some((needle) => needle && text.includes(needle)))
    )
    .map(({ where }) => where);
  if (hits.length > 0) return { status: 'FAIL', hits, missing };
  if (missing.length > 0 || surfaces.length === 0) return { status: 'NOT_VERIFIED', hits, missing };
  return { status: 'PASS', hits, missing };
};
