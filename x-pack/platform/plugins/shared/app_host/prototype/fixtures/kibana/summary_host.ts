/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Shared helpers for the Kibana acceptance variants of alert-digest. Each variant reports what it
// observed through the label, which Kibana validates and returns as plain text.

export interface VariantHost {
  search(params: unknown): Promise<{ total: number; records: Array<{ severity: string }> }>;
}

export const INDEX = 'kbn-apps-prototype-alerts';

export const count = (records: Array<{ severity: string }>) => ({
  high: records.filter(({ severity }) => severity === 'high').length,
  low: records.filter(({ severity }) => severity === 'low').length,
});

export const rejects = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};
