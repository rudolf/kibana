/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { HttpStart } from '@kbn/core/public';
import type { LeaseFactory } from '../components/app_ui_page';

/** U1: no data capability is wired into the frame yet; the bridge exposes only getTheme. */
export const createLeaseFactory =
  (_http: HttpStart): LeaseFactory =>
  async () =>
    undefined;
