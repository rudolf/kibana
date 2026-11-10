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

/**
 * Label reporting a rejection: `<prefix>:<rejection message>` (truncated to the 80-char label
 * limit), or `<PREFIX>-ALLOWED` when the call was not rejected.
 */
export const rejectionLabel = async (
  prefix: string,
  fn: () => Promise<unknown>
): Promise<string> => {
  try {
    await fn();
    return `${prefix.toUpperCase()}-ALLOWED`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${prefix}:${message}`.slice(0, 80);
  }
};
