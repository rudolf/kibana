/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest, OnPreResponseHandler } from '@kbn/core/server';
import { UI_SECURITY_PROFILE } from '../../common/ui_contract';
import {
  appSurfaceHeaders,
  childPolicy,
  guardianPolicy,
  isAppSurface,
  workerPolicy,
  registerSecurityHeadersHook,
  stripReporting,
  SurfaceDecisions,
} from './security_headers';

const CORE =
  "script-src 'report-sample' 'self'; worker-src 'report-sample' 'self' blob:; style-src 'report-sample' 'self' 'unsafe-inline'; object-src 'report-sample' 'none'; form-action 'report-sample' 'self'; frame-src 'report-sample' 'self' kibana.estccdn.com; frame-ancestors 'self'; report-uri http://127.0.0.1:5699/csp-report; report-to csp-endpoint";

const urls = {
  origin: 'http://localhost:5601',
  guardianScript: 'http://localhost:5601/api/app_host/ui_assets/host-guardian.js',
  bootstrapScript: 'http://localhost:5601/api/app_host/ui_assets/host-child.js',
  capnwebScript: 'http://localhost:5601/api/app_host/ui_assets/host-capnweb.js',
  sessionUrl: 'http://localhost:5601/internal/app_host/ui/session',
  executeUrl: 'http://localhost:5601/internal/app_host/ui/execute',
};

describe('stripReporting', () => {
  it('keeps every enforcing restriction and drops only reporting destinations and samples', () => {
    expect(stripReporting(CORE)).toBe(
      "script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; form-action 'self'; frame-src 'self' kibana.estccdn.com; frame-ancestors 'self'"
    );
  });
});

describe('surface policies', () => {
  it('uses exact script URLs, never self, and the exact child document', () => {
    const child = 'http://localhost:5601/api/app_host/ui/alert-digest/' + 'a'.repeat(64) + '/frame';
    expect(guardianPolicy(urls, child)).toBe(
      `default-src 'none'; script-src ${urls.guardianScript}; style-src 'unsafe-inline'; frame-src ${child}; base-uri 'none'; form-action 'none'; frame-ancestors http://localhost:5601`
    );
    const ui = `http://localhost:5601/api/app_host/ui_assets/${'b'.repeat(64)}.js`;
    const policy = childPolicy(urls, ui);
    expect(policy.startsWith('sandbox allow-scripts; ')).toBe(true);
    expect(policy).toContain(`script-src ${urls.bootstrapScript} ${ui};`);
    expect(policy).not.toContain("'self'");
    expect(policy).toContain("connect-src 'none'");
  });

  it('the bridge Worker may import only capnweb and call only the session and execute routes', () => {
    expect(workerPolicy(urls)).toBe(
      `default-src 'none'; script-src ${urls.capnwebScript}; connect-src ${urls.sessionUrl} ${urls.executeUrl}`
    );
  });

  it('refuses to interpolate a source that could inject directives', () => {
    expect(() => childPolicy(urls, "http://x/a.js; script-src 'unsafe-inline'")).toThrow();
    expect(() => guardianPolicy({ ...urls, origin: 'http://a, http://b' }, 'http://x/f')).toThrow();
  });
});

describe('appSurfaceHeaders (S1/S2)', () => {
  it('composes Core (stripped) + strict policy and sets the non-CSP headers post-Core', () => {
    const headers = appSurfaceHeaders(CORE, {
      kind: 'json',
      policy: UI_SECURITY_PROFILE.jsonCsp,
    }) as Record<string, string>;
    expect(headers['Content-Security-Policy']).toBe(
      `${stripReporting(CORE)}, sandbox; default-src 'none'; frame-ancestors 'none'`
    );
    expect(headers['Content-Security-Policy-Report-Only']).toBe('');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Permissions-Policy']).toBe(UI_SECURITY_PROFILE.permissionsPolicy);
    expect(headers['X-DNS-Prefetch-Control']).toBe('off');
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });
});

describe('registerSecurityHeadersHook', () => {
  const setup = () => {
    let handler: OnPreResponseHandler | undefined;
    const http = {
      csp: { header: CORE } as never,
      registerOnPreResponse: (fn: OnPreResponseHandler) => {
        handler = fn;
      },
    };
    const decisions = new SurfaceDecisions();
    registerSecurityHeadersHook(http, decisions);
    const toolkit = { next: jest.fn((extensions?: unknown) => extensions), render: jest.fn() };
    const call = (pathname: string, statusCode = 200, uuid = 'u1') =>
      handler?.(
        { url: new URL(`http://localhost${pathname}`), uuid } as unknown as KibanaRequest,
        // S1: Core hands plugin hooks an empty header set for Boom (4xx/5xx) responses.
        { statusCode, headers: {} },
        toolkit as never
      );
    return { call, decisions, toolkit };
  };

  it('applies the composed JSON policy to 4xx/5xx app responses built from http.csp.header', () => {
    const { call } = setup();
    for (const status of [400, 403, 404, 500]) {
      const result = call('/internal/app_host/ui/leases/x/execute', status) as unknown as {
        headers: Record<string, string>;
      };
      expect(result.headers['Content-Security-Policy']).toContain("script-src 'self'");
      expect(result.headers['Content-Security-Policy']).toContain(
        ", sandbox; default-src 'none'; frame-ancestors 'none'"
      );
    }
  });

  it('uses the per-request decision once, then falls back to JSON', () => {
    const { call, decisions } = setup();
    decisions.set({ uuid: 'g1' } as KibanaRequest, { kind: 'guardian', policy: 'default-src x' });
    const first = call('/api/app_host/ui/a/b/guardian', 200, 'g1') as unknown as {
      headers: Record<string, string>;
    };
    expect(first.headers['Content-Security-Policy'].endsWith(', default-src x')).toBe(true);
    const second = call('/api/app_host/ui/a/b/guardian', 200, 'g1') as unknown as {
      headers: Record<string, string>;
    };
    expect(second.headers['Content-Security-Policy']).toContain('sandbox;');
  });

  it('leaves every other Kibana route untouched', () => {
    const { call, toolkit } = setup();
    expect(call('/app/home')).toBeUndefined();
    expect(call('/api/status')).toBeUndefined();
    expect(toolkit.next).toHaveBeenLastCalledWith();
    expect(isAppSurface('/api/app_hostile')).toBe(false);
    expect(isAppSurface('/api/apps/alert-digest/summary')).toBe(true);
  });
});
