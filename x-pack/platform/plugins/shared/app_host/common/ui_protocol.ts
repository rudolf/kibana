/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Data-only schemas and constants for the third-party app UI bridge (bridgeApi 1).
// Pure TypeScript: shared by the trusted parent page and the server. The server stays
// authoritative; the parent repeats the checks only to fail early.

import { INSTALLED_APP_ID, SYNTHETIC_INDEX } from './constants';

export const UI_BRIDGE_API = 1;
/** Protocol tag carried by every bootstrap window/port message. */
export const UI_HANDSHAKE_PROTOCOL = 'app_host.ui.v1';

export const API_PRIVILEGE_APP_ALERT_DIGEST = 'read_app_alert_digest';
export const APP_FEATURE_ID = 'appHostAlertDigest';
export const UI_DEEP_LINK_ID = INSTALLED_APP_ID;
export const UI_DEEP_LINK_PATH = `/${INSTALLED_APP_ID}`;

export const UI_SCOPES = [
  'app.summary',
  'es.search',
  'kibana.dashboard.read',
  'kibana.dataViews.read',
  'es.esql',
] as const;
export type UiScope = (typeof UI_SCOPES)[number];

/** Public browser-loadable documents (iframe navigations only). */
export const UI_DOCUMENT_ROUTE = '/api/app_host/ui/{appId}/{releaseDigest}/{document}';
export const UI_DOCUMENT_PREFIX = '/api/app_host/ui/';
export const uiDocumentPath = (
  appId: string,
  releaseDigest: string,
  document: 'guardian' | 'frame'
): string => `/api/app_host/ui/${encodeURIComponent(appId)}/${releaseDigest}/${document}`;

/** Immutable code-only assets. Unknown/unapproved/tampered → 404 (never 401/403). */
export const UI_ASSET_ROUTE = '/api/app_host/ui_assets/{file}';
export const UI_ASSET_PREFIX = '/api/app_host/ui_assets/';
export const GUARDIAN_ASSET_FILE = 'host-guardian.js';
export const CHILD_BOOTSTRAP_ASSET_FILE = 'host-child.js';
export const uiAssetPath = (file: string): string => `/api/app_host/ui_assets/${file}`;

export const UI_INTERNAL_PREFIX = '/internal/app_host/ui/';
export const UI_METADATA_ROUTE = '/internal/app_host/ui/apps/{appId}';
export const uiMetadataPath = (appId: string): string =>
  `/internal/app_host/ui/apps/${encodeURIComponent(appId)}`;
/** Mints the app session (restricted API key) and returns its opaque encrypted handle. */
export const UI_SESSION_PATH = '/internal/app_host/ui/session';
export const UI_EXECUTE_PATH = '/internal/app_host/ui/execute';

export const UI_LIMITS = {
  uiBundleBytes: 512 * 1024,
  hostScriptBytes: 256 * 1024,
  frameHeightPx: 480,
  /** Bounded string-only MessagePort transport (structural memory bounds, not quotas). */
  frameBytes: 1024 * 1024,
  receiveQueueBytes: 4 * 1024 * 1024,
  rpcMaxDepth: 12,
  rpcMaxBigIntDigits: 64,
  liveRpcStubs: 128,
  invalidCallsBeforeTermination: 8,
  operationDeadlineMs: 5000,
  /** App session (restricted API key and its handle) lifetime. */
  sessionTtlMs: 60 * 60 * 1000,
  /** Maximum age of the cached enablement/approval state read on every execute. */
  stateCacheMs: 2000,
  handleBytes: 1024,
  resultBytes: 16 * 1024,
  /** Data view and ES|QL results: below one frame, leaving room for the capnweb envelope. */
  largeResultBytes: 960 * 1024,
  /** Native Data Views API response body read before projection (never parsed when larger). */
  dataViewBodyBytes: 4 * 1024 * 1024,
  dataViewIdLength: 128,
  esqlQueryBytes: 4 * 1024,
  esqlRows: 500,
  esqlColumns: 256,
  dashboardResultBytes: 4 * 1024,
  dashboardTitleLength: 256,
  dashboardBodyBytes: 256 * 1024,
  dashboardTimeoutMs: 2000,
  themeBytes: 1024,
  themeColorLength: 64,
} as const;

/** Bounded, stackless public error codes (§4 uniform errors). */
export const BRIDGE_ERROR_CODES = [
  'app_denied',
  'app_unavailable',
  'app_stale',
  'app_disabled',
  'app_expired',
  'app_rate_limited',
  'app_timeout',
  'app_cpu_limit',
  'bridge_invalid_request',
  'bridge_protocol_error',
] as const;
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];
export const isBridgeErrorCode = (value: unknown): value is BridgeErrorCode =>
  typeof value === 'string' && (BRIDGE_ERROR_CODES as readonly string[]).includes(value);

/** Server execute operations (closed discriminated union). */
export type UiOperation =
  | { readonly op: 'app.summary' }
  | { readonly op: 'es.search'; readonly params: { readonly index: string; readonly size: number } }
  | { readonly op: 'kibana.dashboard.read'; readonly params: { readonly id: string } }
  /** Without `id`: list the data views; with `id`: read one data view and its fields. */
  | { readonly op: 'kibana.dataViews.read'; readonly params: { readonly id?: string } }
  | { readonly op: 'es.esql'; readonly params: { readonly query: string } };

export interface UiSummaryResult {
  readonly appId: string;
  readonly version: string;
  readonly label: string;
  readonly counts: { readonly high: number; readonly low: number };
}
export interface UiSearchResult {
  readonly total: number;
  readonly records: ReadonlyArray<{ readonly severity: string; readonly rule: string }>;
}
export interface UiDashboardPreview {
  readonly id: string;
  readonly title: string;
}
export interface UiDataViewListItem {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly timeFieldName: string | null;
}
export interface UiDataViewField {
  readonly name: string;
  readonly type: string;
  readonly esTypes: readonly string[];
  readonly aggregatable: boolean;
  readonly searchable: boolean;
}
export interface UiDataView extends UiDataViewListItem {
  readonly fields: readonly UiDataViewField[];
}
/** An ES|QL cell: a JSON scalar or, for multi-valued fields, an array of scalars. */
export type UiEsqlValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<string | number | boolean | null>;
export interface UiEsqlResult {
  readonly columns: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  readonly values: ReadonlyArray<readonly UiEsqlValue[]>;
}
export interface UiTheme {
  readonly mode: 'light' | 'dark';
  readonly colors: {
    readonly background: string;
    readonly text: string;
    readonly border: string;
    readonly primary: string;
    readonly danger: string;
  };
}

export interface CreateSessionRequest {
  readonly appId: string;
  readonly releaseDigest: string;
}
/** Opaque to the browser: an AES-256-GCM sealed reference to a server-side-only API key. */
export interface CreateSessionResponse {
  readonly handle: string;
}
export type ExecuteRequest = { readonly handle: string } & UiOperation;
export type ExecuteResponse =
  | {
      readonly ok: true;
      readonly result:
        | UiSummaryResult
        | UiSearchResult
        | UiDashboardPreview
        | { readonly dataViews: readonly UiDataViewListItem[] }
        | UiDataView
        | UiEsqlResult;
    }
  | { readonly ok: false; readonly code: BridgeErrorCode };

export interface UiAppMetadata {
  readonly appId: string;
  readonly title: string;
  readonly publisher: string;
  readonly version: string;
  readonly releaseDigest: string;
  readonly uiDigest: string;
  readonly scopes: readonly UiScope[];
  readonly indices: readonly string[];
  readonly dashboardIds: readonly string[];
  readonly egress: { readonly client: readonly string[]; readonly server: readonly string[] };
  readonly enabled: boolean;
  readonly approved: boolean;
  readonly guardianPath: string;
}

/** Fixed local demo publisher identity (no publisher URL or package-supplied identity). */
export const LOCAL_DEMO_PUBLISHER = 'Local synthetic demo publisher';

const HEX64 = /^[0-9a-f]{64}$/;
/** Data view ids: no `/` and no leading dot, so a path segment can never be `.` or `..`. */
const DATA_VIEW_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:*-]*$/;

export const isDataViewId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= UI_LIMITS.dataViewIdLength &&
  DATA_VIEW_ID.test(value);

/** UTF-8 byte length (lone surrogates count as 3 bytes, like U+FFFD). */
const utf8Length = (value: string): number => {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
};

/** ES|QL query input bound: a non-empty string of at most 4 KiB UTF-8. No command allowlist. */
export const isEsqlQuery = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= UI_LIMITS.esqlQueryBytes &&
  utf8Length(value) <= UI_LIMITS.esqlQueryBytes;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isHex64 = (value: unknown): value is string =>
  typeof value === 'string' && HEX64.test(value);
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && UUID.test(value);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.getOwnPropertyNames(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
};

/**
 * Strictly parses an execute operation. Unknown ops, extra fields, non-plain objects and
 * out-of-range values return undefined; there is no partial acceptance.
 */
export const parseUiOperation = (value: unknown): UiOperation | undefined => {
  if (!isPlainRecord(value) || typeof value.op !== 'string') return undefined;
  switch (value.op) {
    case 'app.summary':
      return hasExactKeys(value, ['op']) ? { op: 'app.summary' } : undefined;
    case 'es.search': {
      if (!hasExactKeys(value, ['op', 'params']) || !isPlainRecord(value.params)) return undefined;
      const { params } = value;
      if (!hasExactKeys(params, ['index', 'size'])) return undefined;
      const { index, size } = params;
      if (typeof index !== 'string' || index.length > 255) return undefined;
      if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > 100) {
        return undefined;
      }
      return { op: 'es.search', params: { index, size } };
    }
    case 'kibana.dashboard.read': {
      if (!hasExactKeys(value, ['op', 'params']) || !isPlainRecord(value.params)) return undefined;
      const { params } = value;
      if (!hasExactKeys(params, ['id']) || !isUuid(params.id)) return undefined;
      return { op: 'kibana.dashboard.read', params: { id: params.id } };
    }
    case 'kibana.dataViews.read': {
      if (!hasExactKeys(value, ['op', 'params']) || !isPlainRecord(value.params)) return undefined;
      const { params } = value;
      if (hasExactKeys(params, [])) return { op: 'kibana.dataViews.read', params: {} };
      if (!hasExactKeys(params, ['id']) || !isDataViewId(params.id)) return undefined;
      return { op: 'kibana.dataViews.read', params: { id: params.id } };
    }
    case 'es.esql': {
      if (!hasExactKeys(value, ['op', 'params']) || !isPlainRecord(value.params)) return undefined;
      const { params } = value;
      if (!hasExactKeys(params, ['query']) || !isEsqlQuery(params.query)) return undefined;
      return { op: 'es.esql', params: { query: params.query } };
    }
    default:
      return undefined;
  }
};

/** Bridge method argument validators (guest → parent). */
export const parseCallAppRouteArgs = (
  value: unknown
): { method: 'GET'; path: '/summary' } | undefined =>
  isPlainRecord(value) &&
  hasExactKeys(value, ['method', 'path']) &&
  value.method === 'GET' &&
  value.path === '/summary'
    ? { method: 'GET', path: '/summary' }
    : undefined;

export const parseSearchArgs = (value: unknown): { index: string; size: number } | undefined => {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['index', 'size'])) return undefined;
  const { index, size } = value;
  if (index !== SYNTHETIC_INDEX) return undefined;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > 100) {
    return undefined;
  }
  return { index, size };
};

export const parseDashboardArgs = (value: unknown): { id: string } | undefined =>
  isPlainRecord(value) && hasExactKeys(value, ['id']) && isUuid(value.id)
    ? { id: value.id }
    : undefined;

export const parseGetDataViewArgs = (value: unknown): { id: string } | undefined =>
  isPlainRecord(value) && hasExactKeys(value, ['id']) && isDataViewId(value.id)
    ? { id: value.id }
    : undefined;

export const parseEsqlArgs = (value: unknown): { query: string } | undefined =>
  isPlainRecord(value) && hasExactKeys(value, ['query']) && isEsqlQuery(value.query)
    ? { query: value.query }
    : undefined;

export const parseExecuteResponse = (
  value: unknown
):
  | { readonly ok: true; readonly result: Record<string, unknown> }
  | { readonly ok: false; readonly code: BridgeErrorCode }
  | undefined => {
  if (!isPlainRecord(value)) return undefined;
  if (value.ok === false) {
    return hasExactKeys(value, ['ok', 'code']) && isBridgeErrorCode(value.code)
      ? { ok: false, code: value.code }
      : undefined;
  }
  if (value.ok === true && hasExactKeys(value, ['ok', 'result']) && isPlainRecord(value.result)) {
    return { ok: true, result: value.result };
  }
  return undefined;
};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000;

const boundedText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/** Result validators: the parent forwards only these exact shapes to the guest. */
export const parseSummaryResult = (value: Record<string, unknown>): UiSummaryResult | undefined => {
  if (!hasExactKeys(value, ['appId', 'version', 'label', 'counts'])) return undefined;
  const { appId, version, label, counts } = value;
  if (!boundedText(appId, 64) || !boundedText(version, 32) || !boundedText(label, 80)) {
    return undefined;
  }
  if (!isPlainRecord(counts) || !hasExactKeys(counts, ['high', 'low'])) return undefined;
  const { high, low } = counts;
  if (!isCount(high) || !isCount(low)) return undefined;
  return { appId, version, label, counts: { high, low } };
};

export const parseSearchResult = (value: Record<string, unknown>): UiSearchResult | undefined => {
  if (!hasExactKeys(value, ['total', 'records'])) return undefined;
  const { total, records } = value;
  if (!isCount(total) || !Array.isArray(records) || records.length > 100) return undefined;
  const parsed: Array<{ severity: string; rule: string }> = [];
  for (const record of records) {
    if (!isPlainRecord(record) || !hasExactKeys(record, ['severity', 'rule'])) return undefined;
    const { severity, rule } = record;
    if (!boundedText(severity, 16) || !boundedText(rule, 128)) return undefined;
    parsed.push({ severity, rule });
  }
  return { total, records: parsed };
};

export const parseDashboardPreview = (
  value: Record<string, unknown>
): UiDashboardPreview | undefined => {
  if (!hasExactKeys(value, ['id', 'title'])) return undefined;
  const { id, title } = value;
  if (!isUuid(id) || typeof title !== 'string' || title.length > UI_LIMITS.dashboardTitleLength) {
    return undefined;
  }
  return { id, title };
};

const boundedName = (value: unknown, max = 1024): value is string =>
  typeof value === 'string' && value.length <= max;

const parseListItem = (value: unknown): UiDataViewListItem | undefined => {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['id', 'name', 'title', 'timeFieldName'])) {
    return undefined;
  }
  const { id, name, title, timeFieldName } = value;
  if (!isDataViewId(id) || !boundedName(name) || !boundedName(title)) return undefined;
  if (timeFieldName !== null && !boundedName(timeFieldName)) return undefined;
  return { id, name, title, timeFieldName };
};

export const parseDataViewList = (
  value: Record<string, unknown>
): UiDataViewListItem[] | undefined => {
  if (!hasExactKeys(value, ['dataViews']) || !Array.isArray(value.dataViews)) return undefined;
  const items: UiDataViewListItem[] = [];
  for (const item of value.dataViews) {
    const parsed = parseListItem(item);
    if (!parsed) return undefined;
    items.push(parsed);
  }
  return items;
};

export const parseDataView = (value: Record<string, unknown>): UiDataView | undefined => {
  const { fields, ...rest } = value;
  const base = parseListItem(rest);
  if (!base || !Array.isArray(fields)) return undefined;
  const parsed: UiDataViewField[] = [];
  for (const field of fields) {
    if (
      !isPlainRecord(field) ||
      !hasExactKeys(field, ['name', 'type', 'esTypes', 'aggregatable', 'searchable'])
    ) {
      return undefined;
    }
    const { name, type, esTypes, aggregatable, searchable } = field;
    if (!boundedName(name) || !boundedName(type, 64)) return undefined;
    if (!Array.isArray(esTypes) || !esTypes.every((esType) => boundedName(esType, 64))) {
      return undefined;
    }
    if (typeof aggregatable !== 'boolean' || typeof searchable !== 'boolean') return undefined;
    parsed.push({ name, type, esTypes: [...esTypes], aggregatable, searchable });
  }
  return { ...base, fields: parsed };
};

const isScalar = (value: unknown): value is string | number | boolean | null =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

export const parseEsqlResult = (value: Record<string, unknown>): UiEsqlResult | undefined => {
  if (!hasExactKeys(value, ['columns', 'values'])) return undefined;
  const { columns, values } = value;
  if (!Array.isArray(columns) || columns.length > UI_LIMITS.esqlColumns) return undefined;
  if (!Array.isArray(values) || values.length > UI_LIMITS.esqlRows) return undefined;
  const parsedColumns: Array<{ name: string; type: string }> = [];
  for (const column of columns) {
    if (!isPlainRecord(column) || !hasExactKeys(column, ['name', 'type'])) return undefined;
    const { name, type } = column;
    if (!boundedName(name) || !boundedName(type, 64)) return undefined;
    parsedColumns.push({ name, type });
  }
  const rows: UiEsqlValue[][] = [];
  for (const row of values) {
    if (!Array.isArray(row) || row.length !== parsedColumns.length) return undefined;
    const cells: UiEsqlValue[] = [];
    for (const cell of row) {
      if (isScalar(cell)) cells.push(cell);
      else if (Array.isArray(cell) && cell.every(isScalar)) cells.push([...cell]);
      else return undefined;
    }
    rows.push(cells);
  }
  return { columns: parsedColumns, values: rows };
};
