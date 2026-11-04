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

export const denied = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};
