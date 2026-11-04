/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Wire protocol shared by the dispatcher Worker and the standalone Node tools.
// Pure TypeScript: no Node, Workers or capnweb imports, so both runtimes can bundle it.
// Kibana keeps its own independent copy of these checks (validate both ends).

export const SYNTHETIC_INDEX = 'kbn-apps-prototype-alerts';
export const HOST_API_VERSION = 1;
export const COMPATIBILITY_DATE = '2026-11-04';
export const APP_CPU_MS = 50;
export const APP_SUBREQUESTS = 5;

export const MAX_MANIFEST_BYTES = 16 * 1024;
export const MAX_BUNDLE_BYTES = 64 * 1024;
export const MAX_CALLBACK_RESULT_BYTES = 16 * 1024;
export const MAX_CALLBACK_RECORDS = 100;
export const MAX_APP_RESULT_BYTES = 16 * 1024;
export const MAX_CALLBACKS_PER_INVOCATION = 1;
export const UNAUTHENTICATED_IDLE_MS = 2000;
export const MAX_RULE_LENGTH = 128;

export const RPC_LIMITS = {
  maxMessageSize: 256 * 1024,
  maxDepth: 32,
  maxBigIntDigits: 64,
} as const;

/** Upper bound on bytes buffered by a transport before the session is aborted. */
export const MAX_QUEUED_TRANSPORT_BYTES = 4 * RPC_LIMITS.maxMessageSize;

const encoder = new TextEncoder();

/**
 * An `Error` with no stack. capnweb serializes a replacement error's `stack` when `onSendError`
 * returns one that has it, which would disclose source paths to the peer.
 */
export const stacklessError = (message: string): Error => {
  const error = new Error(message);
  delete error.stack;
  return error;
};

export class ProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export interface Manifest {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly hostApi: 1;
  readonly digest: string;
  readonly permissions: { readonly indices: readonly [typeof SYNTHETIC_INDEX] };
  readonly routes: readonly [
    { readonly method: 'GET'; readonly path: '/summary'; readonly handler: 'summary' }
  ];
}

export interface InvokeRequest {
  readonly manifest: Manifest;
  readonly bundle: string;
  readonly invocationId: string;
}

export interface SearchParams {
  readonly index: typeof SYNTHETIC_INDEX;
  readonly size: number;
}

export interface SearchRecord {
  readonly severity: string;
  readonly rule: string;
}

export interface SearchResult {
  readonly total: number;
  readonly records: readonly SearchRecord[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const exactKeys = (value: Record<string, unknown>, keys: readonly string[], what: string): void => {
  const actual = Object.keys(value);
  for (const key of actual) {
    if (!keys.includes(key)) throw new ProtocolError('invalid_request', `${what}: unknown field`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new ProtocolError('invalid_request', `${what}: missing field`);
  }
};

export const byteLength = (value: string): number => encoder.encode(value).byteLength;

const boundedString = (value: unknown, max: number, what: string, pattern?: RegExp): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ProtocolError('invalid_request', `${what}: invalid string`);
  }
  if (pattern && !pattern.test(value)) {
    throw new ProtocolError('invalid_request', `${what}: invalid format`);
  }
  return value;
};

const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const INVOCATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validates the manifest shape. The dispatcher accepts any well-formed app id; Kibana pins it. */
export const parseManifest = (value: unknown): Manifest => {
  if (!isPlainObject(value)) throw new ProtocolError('invalid_manifest', 'manifest: not an object');
  try {
    exactKeys(
      value,
      ['id', 'title', 'version', 'hostApi', 'digest', 'permissions', 'routes'],
      'manifest'
    );
    boundedString(value.id, 64, 'manifest.id', APP_ID_PATTERN);
    boundedString(value.title, 80, 'manifest.title');
    boundedString(value.version, 32, 'manifest.version', VERSION_PATTERN);
    if (value.hostApi !== HOST_API_VERSION) {
      throw new ProtocolError('invalid_manifest', 'manifest.hostApi: unsupported');
    }
    boundedString(value.digest, 64, 'manifest.digest', DIGEST_PATTERN);
    const { permissions, routes } = value;
    if (!isPlainObject(permissions))
      throw new ProtocolError('invalid_manifest', 'manifest.permissions');
    exactKeys(permissions, ['indices'], 'manifest.permissions');
    const { indices } = permissions;
    if (!Array.isArray(indices) || indices.length !== 1 || indices[0] !== SYNTHETIC_INDEX) {
      throw new ProtocolError(
        'invalid_manifest',
        'manifest.permissions.indices: unsupported grant'
      );
    }
    if (!Array.isArray(routes) || routes.length !== 1 || !isPlainObject(routes[0])) {
      throw new ProtocolError('invalid_manifest', 'manifest.routes: unsupported');
    }
    const [route] = routes;
    exactKeys(route, ['method', 'path', 'handler'], 'manifest.routes[0]');
    if (route.method !== 'GET' || route.path !== '/summary' || route.handler !== 'summary') {
      throw new ProtocolError('invalid_manifest', 'manifest.routes[0]: unsupported');
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw new ProtocolError('invalid_manifest', error.message);
    throw error;
  }
  return value as unknown as Manifest;
};

export const parseInvokeRequest = (value: unknown): InvokeRequest => {
  if (!isPlainObject(value)) throw new ProtocolError('invalid_request', 'invoke: not an object');
  exactKeys(value, ['manifest', 'bundle', 'invocationId'], 'invoke');
  const manifest = parseManifest(value.manifest);
  if (byteLength(JSON.stringify(manifest)) > MAX_MANIFEST_BYTES) {
    throw new ProtocolError('invalid_manifest', 'manifest: too large');
  }
  const { bundle, invocationId } = value;
  if (typeof bundle !== 'string' || bundle.length === 0 || byteLength(bundle) > MAX_BUNDLE_BYTES) {
    throw new ProtocolError('invalid_bundle', 'bundle: missing or too large');
  }
  boundedString(invocationId, 36, 'invocationId', INVOCATION_ID_PATTERN);
  return { manifest, bundle, invocationId: invocationId as string };
};

export const parseSearchParams = (value: unknown): SearchParams => {
  if (!isPlainObject(value)) throw new ProtocolError('invalid_search', 'search: not an object');
  try {
    exactKeys(value, ['index', 'size'], 'search');
  } catch {
    throw new ProtocolError('invalid_search', 'search: unknown or missing field');
  }
  const { index, size } = value;
  if (index !== SYNTHETIC_INDEX) {
    throw new ProtocolError('index_not_granted', 'search: index not granted');
  }
  if (
    typeof size !== 'number' ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > MAX_CALLBACK_RECORDS
  ) {
    throw new ProtocolError('invalid_search', 'search: size must be an integer 1-100');
  }
  return { index, size };
};

export const parseSearchResult = (value: unknown): SearchResult => {
  if (!isPlainObject(value))
    throw new ProtocolError('invalid_result', 'search result: not an object');
  try {
    exactKeys(value, ['total', 'records'], 'search result');
  } catch {
    throw new ProtocolError('invalid_result', 'search result: unknown or missing field');
  }
  const { total, records } = value;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0 || total > 1_000_000_000) {
    throw new ProtocolError('invalid_result', 'search result: invalid total');
  }
  if (!Array.isArray(records) || records.length > MAX_CALLBACK_RECORDS) {
    throw new ProtocolError('invalid_result', 'search result: invalid records');
  }
  const parsed: SearchRecord[] = records.map((record) => {
    if (!isPlainObject(record))
      throw new ProtocolError('invalid_result', 'search result: invalid record');
    try {
      exactKeys(record, ['severity', 'rule'], 'record');
    } catch {
      throw new ProtocolError('invalid_result', 'search result: invalid record');
    }
    const severity = boundedString(record.severity, 16, 'record.severity', /^[a-z]+$/);
    const rule = boundedString(record.rule, MAX_RULE_LENGTH, 'record.rule');
    return { severity, rule };
  });
  const result = { total, records: parsed };
  if (byteLength(JSON.stringify(result)) > MAX_CALLBACK_RESULT_BYTES) {
    throw new ProtocolError('invalid_result', 'search result: too large');
  }
  return result;
};

/** Checks that an app result is plain JSON data within size and depth bounds. */
export const parseAppResult = (value: unknown): unknown => {
  const check = (node: unknown, depth: number): void => {
    if (depth > 8) throw new ProtocolError('invalid_app_result', 'app result: too deep');
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return;
    if (typeof node === 'number') {
      if (!Number.isFinite(node))
        throw new ProtocolError('invalid_app_result', 'app result: number');
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child) => check(child, depth + 1));
      return;
    }
    if (isPlainObject(node)) {
      Object.values(node).forEach((child) => check(child, depth + 1));
      return;
    }
    throw new ProtocolError('invalid_app_result', 'app result: unsupported type');
  };
  check(value, 0);
  const encoded = JSON.stringify(value);
  if (encoded === undefined || byteLength(encoded) > MAX_APP_RESULT_BYTES) {
    throw new ProtocolError('invalid_app_result', 'app result: too large');
  }
  return JSON.parse(encoded);
};

export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
};
