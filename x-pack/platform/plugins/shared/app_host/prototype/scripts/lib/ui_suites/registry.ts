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
import { runD } from './d_discover';
import { runK, runK1, runK2, runK3, runK4, runK5, runK5Reset, runK6 } from './k_session';
import { runT10, runT3, runT8 } from './u3_adversarial';
import { runW } from './w_worker';
import { runT11, runT12, runT13, runT7 } from './u2_authority';

// `k` runs K1–K6 (app session key); `k1` alone is meant for Kibana started with the dev-only
// input-schema bypass config.
export const SUITES: Record<string, (ctx: SuiteContext) => Promise<void>> = {
  k: runK,
  k1: runK1,
  k2: runK2,
  k3: runK3,
  k4: runK4,
  k5: runK5,
  k5r: runK5Reset,
  k6: runK6,
  t7: runT7,
  t11: runT11,
  t12: runT12,
  t13: runT13,
  t1: runT1,
  t5: runT5,
  t6: runT6,
  t3: runT3,
  t4: runT4,
  t8: runT8,
  t10: runT10,
  // W1/W2: the bridge Worker (main-thread responsiveness, queue overflow, handle confinement).
  w: runW,
  // D1–D5: the Mini Discover tile (data views + ES|QL as the app session key).
  discover: runD,
  // Not in the default selection: needs Kibana over TLS with SameSite=None cookies (--tls).
  t4tls: runT4Tls,
};

/** Suites run when `--suites` is omitted. */
export const DEFAULT_SUITES = Object.keys(SUITES).filter(
  (name) => name !== 't4tls' && !/^k\d/.test(name)
);
