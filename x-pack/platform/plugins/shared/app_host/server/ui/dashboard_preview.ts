/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { HttpSelfScopedClient } from '@kbn/core/server';
import { UI_LIMITS } from '../../common/ui_protocol';
import type { UiDashboardPreview } from '../../common/ui_protocol';

export const DASHBOARD_API_VERSION = '2023-10-31';

export type DashboardOutcome =
  | { readonly ok: true; readonly result: UiDashboardPreview }
  | {
      readonly ok: false;
      readonly code: 'app_denied' | 'app_unavailable';
      readonly reason: 'native_denied' | 'native_failed' | 'invalid_result';
    };

/** Reads at most `max` bytes; undefined when the body is larger (never parsed). */
export const readCapped = async (response: Response, max: number): Promise<string | undefined> => {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel();
    return undefined;
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

/**
 * Delegates the dashboard preview to the native Dashboard API as the current viewer (local self
 * client, default `prependBasePath`, public access, pinned version), then projects only
 * `{id, title}`. S5: fails closed on any redirect (final URL must equal the initial one), on any
 * non-200 status, on a body over 256 KiB (before parsing) and when the returned id differs from the
 * granted id (the read route uses `resolve`, so an alias match would return another object).
 */
export const readDashboardPreview = async (
  client: HttpSelfScopedClient,
  grantedId: string,
  expectedPathname: string,
  signal: AbortSignal
): Promise<DashboardOutcome> => {
  const path = `/api/dashboards/${encodeURIComponent(grantedId)}`;
  let request: Readonly<Request>;
  let response: Readonly<Response>;
  try {
    ({ request, response } = await client.fetch(path, {
      target: 'local',
      method: 'GET',
      access: 'public',
      version: DASHBOARD_API_VERSION,
      timeout: UI_LIMITS.dashboardTimeoutMs,
      signal,
      asResponse: true,
      rawResponse: true,
    }));
  } catch {
    return { ok: false, code: 'app_unavailable', reason: 'native_failed' };
  }
  const fail = async (outcome: DashboardOutcome): Promise<DashboardOutcome> => {
    await response.body?.cancel().catch(() => undefined);
    return outcome;
  };
  if (new URL(request.url).pathname !== expectedPathname || response.redirected) {
    return fail({ ok: false, code: 'app_unavailable', reason: 'native_failed' });
  }
  // Granted resource: native forbidden/not-found are normalized to the same denial.
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return fail({ ok: false, code: 'app_denied', reason: 'native_denied' });
  }
  if (response.status !== 200) {
    return fail({ ok: false, code: 'app_unavailable', reason: 'native_failed' });
  }
  const text = await readCapped(response as Response, UI_LIMITS.dashboardBodyBytes).catch(
    () => undefined
  );
  if (text === undefined) return { ok: false, code: 'app_unavailable', reason: 'native_failed' };
  let body: { id?: unknown; data?: { title?: unknown } };
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, code: 'app_unavailable', reason: 'invalid_result' };
  }
  if (body.id !== grantedId) return { ok: false, code: 'app_denied', reason: 'native_denied' };
  const title = body.data?.title;
  if (typeof title !== 'string' || title.length > UI_LIMITS.dashboardTitleLength) {
    return { ok: false, code: 'app_unavailable', reason: 'invalid_result' };
  }
  const result = { id: grantedId, title };
  if (Buffer.byteLength(JSON.stringify(result)) > UI_LIMITS.dashboardResultBytes) {
    return { ok: false, code: 'app_unavailable', reason: 'invalid_result' };
  }
  return { ok: true, result };
};
