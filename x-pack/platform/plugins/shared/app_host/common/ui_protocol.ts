/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Data-only schemas and constants for the third-party app UI bridge (bridgeApi 1).
// Pure TypeScript: shared by the trusted parent page and the server. The server stays
// authoritative; the parent repeats the checks only to fail early.

import { INSTALLED_APP_ID } from './constants';

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
/** The dedicated bridge Worker (one per app frame) and the capnweb build it imports. */
export const BRIDGE_WORKER_ASSET_FILE = 'host-bridge-worker.js';
export const CAPNWEB_ASSET_FILE = 'host-capnweb.js';
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
  /**
   * The bridge Worker's only bound: bytes of guest frames queued before capnweb reads them,
   * counted as 2 bytes per UTF-16 code unit. Overflow ends the session and the Worker.
   */
  receiveQueueBytes: 8 * 1024 * 1024,
  operationDeadlineMs: 5000,
  /** App session (restricted API key and its handle) lifetime. */
  sessionTtlMs: 60 * 60 * 1000,
  /** Maximum age of the cached enablement/approval state read on every execute. */
  stateCacheMs: 2000,
  handleBytes: 1024,
  dataViewIdLength: 128,
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

/** Opaque to the browser: an AES-256-GCM sealed reference to a server-side-only API key. */
export interface CreateSessionResponse {
  readonly handle: string;
}
/** Results: Kibana API response bodies unchanged, the ES|QL `columns` and `values`, or host-built JSON. */
export type ExecuteResponse =
  | { readonly ok: true; readonly result: Record<string, unknown> }
  | { readonly ok: false; readonly code: BridgeErrorCode };

/** Parent → bridge Worker, once, transferring the Worker's end of the bridge MessageChannel. */
export interface BridgeWorkerInit {
  readonly t: 'init';
  readonly appId: string;
  readonly releaseDigest: string;
  readonly theme: UiTheme;
  /** Basepath-prefixed session and execute paths. */
  readonly sessionUrl: string;
  readonly executeUrl: string;
}

/** Bridge Worker → parent: lifecycle only, never a handle, a key or a result. */
export type BridgeWorkerNotice =
  | { readonly t: 'ready' }
  | {
      readonly t: 'end';
      /** `session_failed`, a lifecycle code (`app_disabled`/`app_stale`/`app_expired`) or a transport reason. */
      readonly reason: string;
    };

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

/** ES|QL query input: any non-empty string. No command allowlist and no size cap of its own. */
export const isEsqlQuery = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
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
