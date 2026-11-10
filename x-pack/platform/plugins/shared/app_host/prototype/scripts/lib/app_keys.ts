/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Operator-side revocation of app session keys (restricted API keys named app:{appId}@{release}).
// Runs after the operator has flipped the persisted state (disable, uninstall, new approval).

import { http as defaultHttp } from './http';
import { kibanaSystemAuth } from './secrets';

export const appKeyName = (appId: string, releaseDigest: string): string =>
  `app:${appId}@${releaseDigest}`;

export interface InvalidationResult {
  readonly name: string;
  readonly invalidated: number;
  readonly errors: number;
}

export type InvalidationFailure =
  | InvalidationResult
  | { readonly name: string; readonly status: number | 'transport_error' };

/** Cleanup failed or was partial. The generation already blocks old handles; report it anyway. */
export class AppKeyInvalidationError extends Error {
  readonly result: InvalidationFailure;
  constructor(result: InvalidationFailure) {
    super(`App key invalidation failed for ${result.name}`);
    this.result = result;
  }
}

/**
 * Invalidates by name, as Kibana's internal user (`kibana_system`), every key of one app release
 * (or `*` for all releases). Measured on ES 9.7: `kibana_system` may invalidate by name, including
 * a trailing wildcard, but cannot list other users' keys (`GET /_security/api_key` → 403, the
 * metadata query returns only its own keys), so query-then-invalidate-by-id is not available to it.
 * HTTP errors, transport errors and `error_count > 0` all reject with `AppKeyInvalidationError`.
 */
export const invalidateAppKeys = async ({
  esUrl = process.env.ES_URL ?? 'http://localhost:9200',
  appId,
  releaseDigest = '*',
  http = defaultHttp,
}: {
  readonly esUrl?: string;
  readonly appId: string;
  readonly releaseDigest?: string;
  readonly http?: typeof defaultHttp;
}): Promise<InvalidationResult> => {
  const name = appKeyName(appId, releaseDigest);
  let result: Awaited<ReturnType<typeof defaultHttp>>;
  try {
    result = await http(`${esUrl.replace(/\/$/, '')}/_security/api_key`, {
      method: 'DELETE',
      auth: kibanaSystemAuth(),
      body: { name },
    });
  } catch {
    throw new AppKeyInvalidationError({ name, status: 'transport_error' });
  }
  if (result.status !== 200) throw new AppKeyInvalidationError({ name, status: result.status });
  const body = result.body as { invalidated_api_keys?: string[]; error_count?: number };
  const outcome = {
    name,
    invalidated: body.invalidated_api_keys?.length ?? 0,
    errors: body.error_count ?? 0,
  };
  if (outcome.errors > 0) throw new AppKeyInvalidationError(outcome);
  return outcome;
};
