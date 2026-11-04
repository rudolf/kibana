/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SuiteContext } from './context';
import { runT1 } from './t1_shell';
import { runT5, runT6 } from './t5_t6_browser';

export const SUITES: Record<string, (ctx: SuiteContext) => Promise<void>> = {
  t1: runT1,
  t5: runT5,
  t6: runT6,
};
