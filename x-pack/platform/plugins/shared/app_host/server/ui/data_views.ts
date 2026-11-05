/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { HttpSelfScopedClient } from '@kbn/core/server';
import { UI_LIMITS } from '../../common/ui_protocol';

export const KIBANA_API_VERSION = '2023-10-31';

export interface NativeFailure {
  readonly ok: false;
  readonly code: 'app_denied' | 'app_unavailable' | 'app_timeout';
  readonly reason:
    | 'native_denied'
    | 'native_rejected'
    | 'native_failed'
    | 'invalid_result'
    | 'deadline';
}

export type NativeOutcome =
  | { readonly ok: true; readonly result: Record<string, unknown> }
  | NativeFailure;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * GET of a fixed native Kibana API path as the app session key (local self client, pinned
 * version, public access). Fails closed on any redirect: the final URL must equal the requested
 * one (S5). 401/403/404 are a native denial; 400 is a native rejection (the Data Views API reports
 * an unauthorized saved-object read as `400 Unable to bulk_get index-pattern`). The body is
 * returned unchanged.
 */
export const selfGetJson = async (
  client: HttpSelfScopedClient,
  path: string,
  expectedPathname: string,
  signal: AbortSignal
): Promise<NativeOutcome> => {
  let request: Readonly<Request>;
  let response: Readonly<Response>;
  try {
    ({ request, response } = await client.fetch(path, {
      target: 'local',
      method: 'GET',
      access: 'public',
      version: KIBANA_API_VERSION,
      timeout: UI_LIMITS.operationDeadlineMs,
      signal,
      asResponse: true,
      rawResponse: true,
    }));
  } catch {
    return { ok: false, code: 'app_unavailable', reason: 'native_failed' };
  }
  const fail = async (outcome: NativeFailure): Promise<NativeFailure> => {
    await response.body?.cancel().catch(() => undefined);
    return outcome;
  };
  if (new URL(request.url).pathname !== expectedPathname || response.redirected) {
    return fail({ ok: false, code: 'app_unavailable', reason: 'native_failed' });
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return fail({ ok: false, code: 'app_denied', reason: 'native_denied' });
  }
  if (response.status === 400) {
    return fail({ ok: false, code: 'app_denied', reason: 'native_rejected' });
  }
  if (response.status !== 200) {
    return fail({ ok: false, code: 'app_unavailable', reason: 'native_failed' });
  }
  const body: unknown = await response.json().catch(() => undefined);
  return isRecord(body)
    ? { ok: true, result: body }
    : { ok: false, code: 'app_unavailable', reason: 'invalid_result' };
};

/** `GET /api/data_views` as the key; the response body unchanged. */
export const listDataViews = (
  client: HttpSelfScopedClient,
  selfPathname: (path: string) => string,
  signal: AbortSignal
): Promise<NativeOutcome> => {
  const path = '/api/data_views';
  return selfGetJson(client, path, selfPathname(path), signal);
};

/** `GET /api/data_views/data_view/{id}` as the key; the response body unchanged. */
export const getDataView = (
  client: HttpSelfScopedClient,
  id: string,
  selfPathname: (path: string) => string,
  signal: AbortSignal
): Promise<NativeOutcome> => {
  const path = `/api/data_views/data_view/${encodeURIComponent(id)}`;
  return selfGetJson(client, path, selfPathname(path), signal);
};
