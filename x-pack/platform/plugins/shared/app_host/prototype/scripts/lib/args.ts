/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** Minimal `--flag value` parser; unknown flags are rejected. */
export const parseArgs = <K extends string>(
  argv: readonly string[],
  allowed: readonly K[],
  booleans: readonly K[] = []
): Partial<Record<K, string>> => {
  const out: Partial<Record<K, string>> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2) as K;
    if (!allowed.includes(key)) throw new Error(`Unknown flag: ${arg}`);
    if (booleans.includes(key)) {
      out[key] = 'true';
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    out[key] = value;
    i++;
  }
  return out;
};
