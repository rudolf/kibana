/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TargetMode } from './dispatcher_target';

export const LATENCY_THRESHOLD_MS = 2000;

export interface LatencyDecisionInput {
  /** Mode derived from the verified, host-owned dispatcher evidence; null if not verified. */
  readonly verifiedMode: TargetMode | null;
  readonly requestedSamples: number;
  /** Samples that returned 200 with verified dispatcher evidence and valid timings. */
  readonly validSamples: number;
  /** Non-200, exceptions and invalid samples. */
  readonly failedSamples: number;
  readonly seamRequestedSamples: number;
  readonly seamValidSamples: number;
  readonly p95: number | null;
}

/** A latency GO needs a verified remote target and every requested sample to succeed and be valid. */
export const latencyDecision = ({
  verifiedMode,
  requestedSamples,
  validSamples,
  failedSamples,
  seamRequestedSamples,
  seamValidSamples,
  p95,
}: LatencyDecisionInput): string => {
  if (verifiedMode === null) return 'NO DECISION: dispatcher target not verified';
  if (
    failedSamples > 0 ||
    validSamples !== requestedSamples ||
    seamValidSamples !== seamRequestedSamples
  ) {
    return (
      `NO DECISION: ${validSamples}/${requestedSamples} Kibana and ` +
      `${seamValidSamples}/${seamRequestedSamples} seam samples valid; every sample must succeed`
    );
  }
  if (p95 === null) return 'NO DATA';
  if (verifiedMode === 'local') {
    return `NO DECISION: local workerd p95 ${p95} ms says nothing about the remote topology`;
  }
  if (p95 <= LATENCY_THRESHOLD_MS) return 'GO (latency)';
  return 'NO-GO for the chosen topology pending investigation';
};
