/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { HttpServiceSetup, KibanaRequest, ResponseHeaders } from '@kbn/core/server';
import { UI_SECURITY_PROFILE } from '../../common/ui_contract';

/** Response surfaces owned by App Host; every one of them gets composed headers. */
export const APP_SURFACE_PREFIXES = [
  '/api/app_host/',
  '/internal/app_host/',
  '/api/apps/',
] as const;

export const isAppSurface = (pathname: string): boolean =>
  APP_SURFACE_PREFIXES.some((prefix) => pathname.startsWith(prefix));

export type SurfaceKind = 'guardian' | 'frame' | 'worker' | 'asset' | 'json';

export interface UiPolicyUrls {
  /** Configured Kibana origin, never derived from Host/Origin request headers. */
  readonly origin: string;
  readonly guardianScript: string;
  readonly bootstrapScript: string;
  readonly capnwebScript: string;
  readonly sessionUrl: string;
  readonly executeUrl: string;
}

const REPORTING_DIRECTIVES = new Set(['report-uri', 'report-to']);

/**
 * Core's enforcing policy minus reporting destinations and sample tokens. Every other directive
 * and source restriction is kept, so the composed header can only be stricter than Core's.
 */
export const stripReporting = (corePolicy: string): string =>
  corePolicy
    .split(';')
    .map((directive) => directive.trim())
    .filter(Boolean)
    .filter((directive) => !REPORTING_DIRECTIVES.has(directive.split(/\s+/)[0].toLowerCase()))
    .map((directive) =>
      directive
        .split(/\s+/)
        .filter((token) => token.toLowerCase() !== "'report-sample'")
        .join(' ')
    )
    .join('; ');

/** A CSP source expression we interpolate must be a plain absolute http(s) URL or origin. */
const assertSource = (value: string): string => {
  if (!/^https?:\/\/[A-Za-z0-9.:[\]-]+(\/[A-Za-z0-9._~/-]*)?$/.test(value)) {
    throw new Error('App Host: refusing to interpolate an unsafe CSP source');
  }
  return value;
};

const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{([A-Za-z]+)\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`App Host: missing CSP placeholder ${key}`);
    return assertSource(value);
  });

export const guardianPolicy = (urls: UiPolicyUrls, childDocument: string): string =>
  fill(UI_SECURITY_PROFILE.guardianCsp, {
    origin: urls.origin,
    guardianScript: urls.guardianScript,
    childDocument,
  });

export const childPolicy = (urls: UiPolicyUrls, uiScript: string): string =>
  fill(UI_SECURITY_PROFILE.childCsp, {
    origin: urls.origin,
    bootstrapScript: urls.bootstrapScript,
    uiScript,
  });

/** The bridge Worker may import only capnweb and call only the session and execute routes. */
export const workerPolicy = (urls: UiPolicyUrls): string =>
  fill(UI_SECURITY_PROFILE.workerCsp, {
    capnwebScript: urls.capnwebScript,
    sessionUrl: urls.sessionUrl,
    executeUrl: urls.executeUrl,
  });

export interface SurfaceDecision {
  readonly kind: SurfaceKind;
  /** The strict surface policy appended after Core's (reporting-stripped) policy. */
  readonly policy: string;
}

/**
 * Remembers the surface policy chosen by a route handler for one request, so the post-Core hook
 * can apply it. Requests without a decision (errors, 404s, JSON) get the JSON policy. Bounded.
 */
export class SurfaceDecisions {
  readonly #decisions = new Map<string, SurfaceDecision>();
  readonly #max: number;

  constructor(max = 1024) {
    this.#max = max;
  }

  set(request: KibanaRequest, decision: SurfaceDecision): void {
    if (this.#decisions.size >= this.#max) {
      const oldest = this.#decisions.keys().next().value;
      if (oldest !== undefined) this.#decisions.delete(oldest);
    }
    this.#decisions.set(request.uuid, decision);
  }

  take(request: KibanaRequest): SurfaceDecision | undefined {
    const decision = this.#decisions.get(request.uuid);
    this.#decisions.delete(request.uuid);
    return decision;
  }
}

/** Headers for one app surface response. S1: built from Core's configured header, not the response. */
export const appSurfaceHeaders = (
  coreEnforcingPolicy: string,
  decision: SurfaceDecision
): ResponseHeaders => {
  const core = stripReporting(coreEnforcingPolicy);
  return {
    'Content-Security-Policy': core ? `${core}, ${decision.policy}` : decision.policy,
    // A public hook cannot delete a header; an empty report-only header is inert.
    'Content-Security-Policy-Report-Only': '',
    // S2: Core's security/custom header handler overwrites route-set values; set them post-Core.
    'Referrer-Policy': UI_SECURITY_PROFILE.referrerPolicy,
    'Permissions-Policy': UI_SECURITY_PROFILE.permissionsPolicy,
    'X-DNS-Prefetch-Control': UI_SECURITY_PROFILE.dnsPrefetch,
    'Cache-Control': UI_SECURITY_PROFILE.cacheControl,
    'X-Content-Type-Options': 'nosniff',
  } as ResponseHeaders;
};

const JSON_DECISION: SurfaceDecision = { kind: 'json', policy: UI_SECURITY_PROFILE.jsonCsp };

/**
 * Registers the post-Core `onPreResponse` hook (plugins' handlers run after Core's, which is
 * registered during HTTP setup). Only App Host paths are touched; every other route keeps Core's
 * headers unchanged. Applies to 4xx/5xx too: Core hands plugin hooks an empty header set for those,
 * which is why the policy is rebuilt from `http.csp.header`.
 */
export const registerSecurityHeadersHook = (
  http: Pick<HttpServiceSetup, 'registerOnPreResponse' | 'csp'>,
  decisions: SurfaceDecisions
): void => {
  const coreEnforcingPolicy = http.csp.header;
  http.registerOnPreResponse((request, _preResponse, toolkit) => {
    if (!isAppSurface(request.url.pathname)) return toolkit.next();
    const decision = decisions.take(request) ?? JSON_DECISION;
    return toolkit.next({ headers: appSurfaceHeaders(coreEnforcingPolicy, decision) });
  });
};
