/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SuiteContext } from './context';
import { runT1 } from './t1_shell';
import { runT5, runT6 } from './t5_t6_browser';
import { runT4, runT4Tls } from './t4_channels';
import { runT10, runT3, runT8, runT9Browser } from './u3_adversarial';
import { runT11, runT12, runT13, runT14, runT2, runT7, runT9Server } from './u2_authority';

// Order matters: T9 asserts the per-principal and global lease caps, so it runs before browser
// sessions hold leases of their own (5-minute TTL).
export const SUITES: Record<string, (ctx: SuiteContext) => Promise<void>> = {
  t9: runT9Server,
  t2: runT2,
  t7: runT7,
  t11: runT11,
  t12: runT12,
  t13: runT13,
  t14: runT14,
  t1: runT1,
  t5: runT5,
  t6: runT6,
  t9b: runT9Browser,
  t3: runT3,
  t4: runT4,
  t8: runT8,
  t10: runT10,
  // Not in the default selection: needs Kibana over TLS with SameSite=None cookies (--tls).
  t4tls: runT4Tls,
};

/** Suites run when `--suites` is omitted. */
export const DEFAULT_SUITES = Object.keys(SUITES).filter((name) => name !== 't4tls');
