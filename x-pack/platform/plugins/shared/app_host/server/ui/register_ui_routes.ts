/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type { IBasePath, IRouter, KibanaRequest, Logger } from '@kbn/core/server';
import { API_PRIVILEGE_READ, INSTALLED_APP_ID } from '../../common';
import { UI_SECURITY_PROFILE } from '../../common/ui_contract';
import type { UiAppMetadata } from '../../common/ui_protocol';
import {
  API_PRIVILEGE_APP_ALERT_DIGEST,
  CHILD_BOOTSTRAP_ASSET_FILE,
  GUARDIAN_ASSET_FILE,
  LOCAL_DEMO_PUBLISHER,
  UI_ASSET_ROUTE,
  UI_DOCUMENT_ROUTE,
  UI_METADATA_ROUTE,
  uiDocumentPath,
} from '../../common/ui_protocol';
import { readUiBundle } from '../package/read_package';
import { readUiReleaseState, type UiReleaseState } from './consent';
import { renderFrameDocument, renderGuardianDocument } from './documents';
import { CHILD_BOOTSTRAP_SCRIPT, GUARDIAN_SCRIPT } from './host_scripts';
import { childPolicy, guardianPolicy, type SurfaceDecisions } from './security_headers';
import { isDefaultSpace, type UiUrls } from './ui_context';

export const APP_UI_PRIVILEGES = [API_PRIVILEGE_READ, API_PRIVILEGE_APP_ALERT_DIGEST] as const;

export interface UiRouteDependencies {
  readonly router: IRouter;
  readonly basePath: IBasePath;
  readonly packagePath: string;
  readonly consentPath: string | undefined;
  readonly urls: UiUrls;
  readonly decisions: SurfaceDecisions;
  readonly logger: Logger;
}

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' } as const;
const JS_HEADERS = {
  'content-type': 'application/javascript; charset=utf-8',
  'content-disposition': `${UI_SECURITY_PROFILE.assetDisposition}; filename="app-host-asset.js"`,
} as const;

const hasQuery = (request: KibanaRequest): boolean => request.url.search !== '';

export const registerUiRoutes = ({
  router,
  basePath,
  packagePath,
  consentPath,
  urls,
  decisions,
  logger,
}: UiRouteDependencies): void => {
  const readState = (): Promise<UiReleaseState> => readUiReleaseState(packagePath, consentPath);

  // Guardian and frame documents. Iframe navigations only; response sandboxing is independent.
  router.get(
    {
      path: UI_DOCUMENT_ROUTE,
      security: { authz: { requiredPrivileges: [...APP_UI_PRIVILEGES] } },
      options: { access: 'public', excludeFromOAS: true },
      validate: {
        params: schema.object({
          appId: schema.string({ minLength: 1, maxLength: 64 }),
          releaseDigest: schema.string({ minLength: 1, maxLength: 64 }),
          document: schema.oneOf([schema.literal('guardian'), schema.literal('frame')]),
        }),
      },
    },
    async (_context, request, response) => {
      const { appId, releaseDigest, document } = request.params;
      // Defense in depth only: curl can forge fetch metadata; the response sandbox still applies.
      if (request.headers['sec-fetch-dest'] !== UI_SECURITY_PROFILE.documentFetchDest) {
        return response.forbidden({ body: { message: 'App documents load only in their frame' } });
      }
      if (hasQuery(request) || !isDefaultSpace(basePath, request) || appId !== INSTALLED_APP_ID) {
        return response.notFound();
      }
      const state = await readState();
      if (state.status !== 'approved' || state.manifest.releaseDigest !== releaseDigest) {
        return response.notFound();
      }
      const { manifest } = state;
      if (document === 'guardian') {
        const childUrl = urls.childDocument(manifest.id, manifest.releaseDigest);
        decisions.set(request, { kind: 'guardian', policy: guardianPolicy(urls, childUrl) });
        return response.ok({
          body: renderGuardianDocument({
            guardianScript: urls.guardianScript,
            childUrl,
            parentOrigin: urls.origin,
          }),
          headers: HTML_HEADERS,
        });
      }
      const uiScript = urls.uiScript(manifest.ui.digest);
      decisions.set(request, { kind: 'frame', policy: childPolicy(urls, uiScript) });
      return response.ok({
        body: renderFrameDocument({ bootstrapScript: urls.bootstrapScript, uiScript }),
        headers: HTML_HEADERS,
      });
    }
  );

  // Immutable code-only assets. Public (opaque-origin script loads carry no Lax session cookie),
  // and S6: anything not served is a 404, never 401/403, so no security-plugin redirect page.
  router.get(
    {
      path: UI_ASSET_ROUTE,
      security: {
        authc: { enabled: false, reason: 'Public immutable code-only assets; no data or secrets' },
        authz: { enabled: false, reason: 'Public immutable code-only assets; no data or secrets' },
      },
      options: { access: 'public', excludeFromOAS: true },
      validate: { params: schema.object({ file: schema.string({ maxLength: 80 }) }) },
    },
    async (_context, request, response) => {
      const { file } = request.params;
      if (hasQuery(request) || !isDefaultSpace(basePath, request)) return response.notFound();
      const asset = { kind: 'asset', policy: UI_SECURITY_PROFILE.assetCsp } as const;
      if (file === GUARDIAN_ASSET_FILE || file === CHILD_BOOTSTRAP_ASSET_FILE) {
        decisions.set(request, asset);
        return response.ok({
          body: file === GUARDIAN_ASSET_FILE ? GUARDIAN_SCRIPT : CHILD_BOOTSTRAP_SCRIPT,
          headers: JS_HEADERS,
        });
      }
      const match = /^([0-9a-f]{64})\.js$/.exec(file);
      if (!match) return response.notFound();
      const state = await readState();
      if (state.status !== 'approved' || state.manifest.ui.digest !== match[1]) {
        return response.notFound();
      }
      try {
        const bytes = await readUiBundle(packagePath, match[1]);
        decisions.set(request, asset);
        return response.ok({ body: bytes, headers: JS_HEADERS });
      } catch (error) {
        logger.warn('App UI asset failed its integrity check; not served');
        return response.notFound();
      }
    }
  );

  // Trusted host chrome metadata (consent screen + 2 s approval/enablement poll).
  router.get(
    {
      path: UI_METADATA_ROUTE,
      security: { authz: { requiredPrivileges: [...APP_UI_PRIVILEGES] } },
      options: { access: 'internal' },
      validate: {
        params: schema.object({ appId: schema.string({ minLength: 1, maxLength: 64 }) }),
      },
    },
    async (_context, request, response) => {
      if (request.params.appId !== INSTALLED_APP_ID || !isDefaultSpace(basePath, request)) {
        return response.notFound();
      }
      const state = await readState();
      if (state.status === 'not_installed' || state.status === 'invalid' || !state.manifest) {
        return response.notFound();
      }
      const { manifest } = state;
      const body: UiAppMetadata = {
        appId: manifest.id,
        title: manifest.title,
        publisher: LOCAL_DEMO_PUBLISHER,
        version: manifest.version,
        releaseDigest: manifest.releaseDigest,
        uiDigest: manifest.ui.digest,
        scopes: manifest.ui.scopes,
        indices: manifest.permissions.indices,
        dashboardIds: manifest.permissions.dashboardIds,
        egress: { client: manifest.ui.egress.client, server: manifest.ui.egress.server },
        enabled: state.status !== 'disabled',
        approved: state.status === 'approved' || state.status === 'disabled',
        guardianPath: uiDocumentPath(manifest.id, manifest.releaseDigest, 'guardian'),
      };
      return response.ok({ body });
    }
  );
};
