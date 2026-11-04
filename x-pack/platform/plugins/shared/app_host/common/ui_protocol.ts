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

export const UI_SCOPES = ['app.summary', 'es.search', 'kibana.dashboard.read'] as const;
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
export const UI_LEASES_PATH = '/internal/app_host/ui/leases';
export const UI_LEASE_EXECUTE_ROUTE = '/internal/app_host/ui/leases/{leaseId}/execute';
export const UI_LEASE_REVOKE_ROUTE = '/internal/app_host/ui/leases/{leaseId}/revoke';
export const uiLeaseExecutePath = (leaseId: string): string =>
  `/internal/app_host/ui/leases/${encodeURIComponent(leaseId)}/execute`;
export const uiLeaseRevokePath = (leaseId: string): string =>
  `/internal/app_host/ui/leases/${encodeURIComponent(leaseId)}/revoke`;

export const UI_LIMITS = {
  uiBundleBytes: 512 * 1024,
  hostScriptBytes: 256 * 1024,
  frameHeightPx: 480,
  /** Bounded string-only MessagePort transport. */
  frameBytes: 32 * 1024,
  receiveQueueBytes: 256 * 1024,
  rpcMaxDepth: 12,
  rpcMaxBigIntDigits: 64,
  liveRpcStubs: 128,
  invalidCallsBeforeTermination: 8,
  /** Ingress window messages on the port: 60/s, burst 16. */
  ingressPerSecond: 60,
  ingressBurst: 16,
  /** Accepted operations, shared by every lease of one (app, user, space): 5/s, burst 10. */
  operationsPerSecond: 5,
  operationsBurst: 10,
  operationsPerLease: 100,
  inFlightPerLease: 2,
  uiServerOperationsPerProcess: 4,
  operationDeadlineMs: 5000,
  leaseTtlMs: 5 * 60 * 1000,
  leasesGlobal: 32,
  leasesPerPrincipal: 4,
  pollIntervalMs: 2000,
  resultBytes: 16 * 1024,
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
  | { readonly op: 'kibana.dashboard.read'; readonly params: { readonly id: string } };

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

export interface CreateLeaseRequest {
  readonly appId: string;
  readonly releaseDigest: string;
}
export interface CreateLeaseResponse {
  readonly leaseId: string;
  readonly secret: string;
  readonly expiresAt: number;
}
export interface ExecuteRequest {
  readonly secret: string;
  readonly operation: UiOperation;
}
export type ExecuteResponse =
  | { readonly ok: true; readonly result: UiSummaryResult | UiSearchResult | UiDashboardPreview }
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEASE_ID = /^[A-Za-z0-9_-]{22,64}$/;

export const isHex64 = (value: unknown): value is string =>
  typeof value === 'string' && HEX64.test(value);
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && UUID.test(value);
export const isLeaseId = (value: unknown): value is string =>
  typeof value === 'string' && LEASE_ID.test(value);

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
