/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Types shared by the seam fixtures. Fixtures are adversarial test apps, not samples.

export interface FixtureHost {
  search(
    params: unknown
  ): Promise<{ total: number; records: Array<{ severity: string; rule: string }> }>;
}

export const INDEX = 'kbn-apps-prototype-alerts';

/** The rejection message of `fn` (truncated), or null when it did not reject. */
export const rejection = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try {
    await fn();
    return null;
  } catch (error) {
    return String(error instanceof Error ? error.message : error).slice(0, 300);
  }
};
