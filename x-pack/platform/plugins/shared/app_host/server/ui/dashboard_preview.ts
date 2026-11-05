/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { HttpSelfScopedClient } from '@kbn/core/server';
import { selfGetJson, type NativeOutcome } from './data_views';

/**
 * Reads the granted dashboard through the native Dashboard API as the app session key and returns
 * the response body unchanged. The read route uses `resolve`, so an alias match could return
 * another object: the returned id must equal the granted id (S5).
 */
export const readDashboardPreview = async (
  client: HttpSelfScopedClient,
  grantedId: string,
  expectedPathname: string,
  signal: AbortSignal
): Promise<NativeOutcome> => {
  const path = `/api/dashboards/${encodeURIComponent(grantedId)}`;
  const outcome = await selfGetJson(client, path, expectedPathname, signal);
  if (outcome.ok && outcome.result.id !== grantedId) {
    return { ok: false, code: 'app_denied', reason: 'native_denied' };
  }
  return outcome;
};
