/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { HttpSelfScopedClient } from '@kbn/core/server';
import type { UiDataView, UiDataViewField, UiDataViewListItem } from '../../common/ui_protocol';
import { UI_LIMITS, isDataViewId } from '../../common/ui_protocol';
import { readCapped } from './dashboard_preview';

export const DATA_VIEWS_API_VERSION = '2023-10-31';

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

export type DataViewsOutcome =
  | {
      readonly ok: true;
      readonly result: { readonly dataViews: UiDataViewListItem[] } | UiDataView;
    }
  | NativeFailure;

const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * GET of a native Kibana API as the app session key (local self client, pinned version, public
 * access). Like the dashboard read (S5): fails closed on any redirect, non-200 status and bodies
 * over the cap (before parsing); 400/401/403/404 are a native refusal.
 */
const selfGetJson = async (
  client: HttpSelfScopedClient,
  path: string,
  expectedPathname: string,
  signal: AbortSignal
): Promise<{ readonly ok: true; readonly body: unknown } | NativeFailure> => {
  let request: Readonly<Request>;
  let response: Readonly<Response>;
  try {
    ({ request, response } = await client.fetch(path, {
      target: 'local',
      method: 'GET',
      access: 'public',
      version: DATA_VIEWS_API_VERSION,
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
  // The Data Views API reports a saved-object authorization failure as 400 ("Unable to bulk_get
  // index-pattern"); the request itself was validated above, so this is Kibana refusing the key.
  if (response.status === 400) {
    return fail({ ok: false, code: 'app_denied', reason: 'native_rejected' });
  }
  if (response.status !== 200) {
    return fail({ ok: false, code: 'app_unavailable', reason: 'native_failed' });
  }
  const text = await readCapped(response as Response, UI_LIMITS.dataViewBodyBytes).catch(
    () => undefined
  );
  if (text === undefined) return { ok: false, code: 'app_unavailable', reason: 'native_failed' };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, code: 'app_unavailable', reason: 'invalid_result' };
  }
};

interface NativeDataView {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly title?: unknown;
  readonly timeFieldName?: unknown;
  readonly fields?: unknown;
}

const listItem = (view: NativeDataView): UiDataViewListItem | undefined => {
  const { id, name, title, timeFieldName } = view;
  if (!isDataViewId(id) || !isString(title)) return undefined;
  return {
    id,
    name: isString(name) && name.length > 0 ? name : title,
    title,
    timeFieldName: isString(timeFieldName) && timeFieldName.length > 0 ? timeFieldName : null,
  };
};

/** `GET /api/data_views` as the key, projected to `{id, name, title, timeFieldName}`. */
export const listDataViews = async (
  client: HttpSelfScopedClient,
  selfPathname: (path: string) => string,
  signal: AbortSignal
): Promise<DataViewsOutcome> => {
  const path = '/api/data_views';
  const fetched = await selfGetJson(client, path, selfPathname(path), signal);
  if (!fetched.ok) return fetched;
  const list = (fetched.body as { data_view?: unknown } | null)?.data_view;
  if (!Array.isArray(list)) return { ok: false, code: 'app_unavailable', reason: 'invalid_result' };
  // Ids the bridge cannot address (e.g. containing `/`) are omitted rather than failing the list.
  const dataViews = (list as NativeDataView[])
    .map(listItem)
    .filter((item): item is UiDataViewListItem => item !== undefined);
  return { ok: true, result: { dataViews } };
};

const field = (spec: Record<string, unknown>): UiDataViewField | undefined => {
  const { name, type, esTypes, aggregatable, searchable } = spec;
  if (!isString(name) || !isString(type)) return undefined;
  return {
    name,
    type,
    esTypes: Array.isArray(esTypes) ? esTypes.filter(isString) : [],
    aggregatable: aggregatable === true,
    searchable: searchable === true,
  };
};

/**
 * `GET /api/data_views/data_view/{id}` as the key, projected to `{id, name, title, timeFieldName,
 * fields:[{name, type, esTypes, aggregatable, searchable}]}`. The returned id must equal the
 * requested one.
 */
export const getDataView = async (
  client: HttpSelfScopedClient,
  id: string,
  selfPathname: (path: string) => string,
  signal: AbortSignal
): Promise<DataViewsOutcome> => {
  const path = `/api/data_views/data_view/${encodeURIComponent(id)}`;
  const fetched = await selfGetJson(client, path, selfPathname(path), signal);
  if (!fetched.ok) return fetched;
  const view = (fetched.body as { data_view?: NativeDataView } | null)?.data_view;
  const base = view ? listItem(view) : undefined;
  if (!view || !base) return { ok: false, code: 'app_unavailable', reason: 'invalid_result' };
  if (base.id !== id) return { ok: false, code: 'app_denied', reason: 'native_denied' };
  const specs =
    view.fields && typeof view.fields === 'object'
      ? (Object.values(view.fields) as Array<Record<string, unknown>>)
      : [];
  const fields = specs
    .map((spec) => (spec && typeof spec === 'object' ? field(spec) : undefined))
    .filter((item): item is UiDataViewField => item !== undefined)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, result: { ...base, fields } };
};
