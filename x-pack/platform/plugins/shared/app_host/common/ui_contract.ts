/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// The immutable bridgeApi 1 contract: capability descriptors plus the UI security profile.
// Its canonical SHA-256 is the manifest's `ui.scopeMapDigest`. Any semantic expansion or policy
// relaxation changes the digest, so existing approvals stop matching (fail closed). The digest is
// pinned by a snapshot test; changing it requires a new contract identity and security review.
// Pure data, no imports beyond constants: the prototype release tool hashes the same object.

import { UI_BRIDGE_API, UI_LIMITS } from './ui_protocol';

export interface CapabilityDescriptor {
  readonly id: string;
  readonly bridgeMethod: string;
  readonly kind: 'server' | 'parent';
  readonly description: string;
  readonly input: string;
  readonly output: string;
  readonly mintsCredential: boolean;
  readonly executesLater: boolean;
  readonly egressSideEffect: boolean;
  readonly acceptsReferences: boolean;
}

/** Closed registry of bridgeApi 1 capabilities. Additions require security review. */
export const BRIDGE_V1_CAPABILITIES: readonly CapabilityDescriptor[] = [
  {
    id: 'app.summary',
    bridgeMethod: 'callAppRoute',
    kind: 'server',
    description: 'Run the approved app release GET /summary route as the app session key',
    input: "{method:'GET',path:'/summary'}",
    output: '{appId,version,label,counts:{high,low}}',
    mintsCredential: false,
    executesLater: false,
    egressSideEffect: false,
    acceptsReferences: false,
  },
  {
    id: 'es.search',
    bridgeMethod: 'search',
    kind: 'server',
    description: 'Host-built match_all over the synthetic index, as the app session key',
    input: '{index:<granted literal>,size:1..100}',
    output: '{total,records:[{severity,rule}]}<=100,<=16KiB',
    mintsCredential: false,
    executesLater: false,
    egressSideEffect: false,
    acceptsReferences: false,
  },
  {
    id: 'kibana.dashboard.read',
    bridgeMethod: 'getDashboardPreview',
    kind: 'server',
    description:
      'App-session-key GET /api/dashboards/{grantedId} (2023-10-31); returned id must equal the granted id',
    input: '{id:<granted UUID>}',
    output: 'Dashboard API response body, unchanged',
    mintsCredential: false,
    executesLater: false,
    egressSideEffect: false,
    acceptsReferences: false,
  },
  {
    id: 'kibana.dataViews.read',
    bridgeMethod: 'listDataViews,getDataView',
    kind: 'server',
    description:
      'App-session-key GET /api/data_views and /api/data_views/data_view/{id} (2023-10-31)',
    input: '() | {id}',
    output: 'Data Views API response body, unchanged',
    mintsCredential: false,
    executesLater: false,
    egressSideEffect: false,
    acceptsReferences: false,
  },
  {
    id: 'es.esql',
    bridgeMethod: 'esql',
    kind: 'server',
    description: 'App-authored ES|QL query (no command allowlist) as the app session key',
    input: '{query}',
    output: '{columns,values} from the ES|QL response',
    mintsCredential: false,
    executesLater: false,
    egressSideEffect: false,
    acceptsReferences: false,
  },
  {
    id: 'host.theme',
    bridgeMethod: 'getTheme',
    kind: 'parent',
    description: 'Fixed EUI color tokens and mode; no HTTP authority',
    input: '()',
    output: '{mode,colors:{background,text,border,primary,danger}}',
    mintsCredential: false,
    executesLater: false,
    egressSideEffect: false,
    acceptsReferences: false,
  },
];

/** Normalized security profile; placeholders avoid digest cycles with origin and artifact URLs. */
export const UI_SECURITY_PROFILE = {
  guardianIframe: {
    attributes: { referrerpolicy: 'no-referrer' },
    forbiddenAttributes: ['sandbox', 'allow', 'allowfullscreen', 'srcdoc'],
  },
  childIframe: {
    attributes: { sandbox: 'allow-scripts', referrerpolicy: 'no-referrer' },
    forbiddenAttributes: ['allow', 'allowfullscreen', 'srcdoc'],
  },
  guardianCsp:
    "default-src 'none'; script-src {guardianScript}; style-src 'unsafe-inline'; frame-src {childDocument}; base-uri 'none'; form-action 'none'; frame-ancestors {origin}",
  childCsp:
    "sandbox allow-scripts; default-src 'none'; script-src {bootstrapScript} {uiScript}; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors {origin}",
  jsonCsp: "sandbox; default-src 'none'; frame-ancestors 'none'",
  assetCsp: "sandbox; default-src 'none'; frame-ancestors 'none'",
  workerCsp:
    "default-src 'none'; script-src {capnwebScript}; connect-src {sessionUrl} {executeUrl}",
  corePolicy: 'core enforcing policy retained; report-uri, report-to and report-sample removed',
  reportOnly: 'empty',
  referrerPolicy: 'no-referrer',
  permissionsPolicy:
    'accelerometer=(), autoplay=(), bluetooth=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), web-share=(), xr-spatial-tracking=()',
  dnsPrefetch: 'off',
  cacheControl: 'no-store',
  documentFetchDest: 'iframe',
  assetDisposition: 'attachment',
  protocol: {
    transport: 'string-only MessagePort to a dedicated host Worker',
    receiveQueueBytes: UI_LIMITS.receiveQueueBytes,
    deadlineMs: UI_LIMITS.operationDeadlineMs,
    guestCallbacks: false,
  },
} as const;

export const UI_CONTRACT_V1 = {
  bridgeApi: UI_BRIDGE_API,
  capabilities: BRIDGE_V1_CAPABILITIES,
  securityProfile: UI_SECURITY_PROFILE,
} as const;

/** Deterministic JSON: object keys sorted recursively, no whitespace. Data-only input. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('canonicalJson: unsupported value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
};
