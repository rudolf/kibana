/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { IBasePath, KibanaRequest } from '@kbn/core/server';
import {
  CAPNWEB_ASSET_FILE,
  CHILD_BOOTSTRAP_ASSET_FILE,
  GUARDIAN_ASSET_FILE,
  UI_EXECUTE_PATH,
  UI_SESSION_PATH,
  uiAssetPath,
  uiDocumentPath,
} from '../../common/ui_protocol';
import type { UiPolicyUrls } from './security_headers';

/**
 * Absolute URLs built from the configured `server.publicBaseUrl`, never from request Host/Origin
 * headers. `publicBaseUrl` already includes any server base path.
 */
export class UiUrls implements UiPolicyUrls {
  readonly origin: string;
  readonly guardianScript: string;
  readonly bootstrapScript: string;
  readonly capnwebScript: string;
  readonly sessionUrl: string;
  readonly executeUrl: string;
  readonly #base: string;

  constructor(publicBaseUrl: string) {
    const url = new URL(publicBaseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('App Host UI requires an http(s) server.publicBaseUrl');
    }
    this.origin = url.origin;
    this.#base = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
    this.guardianScript = this.absolute(uiAssetPath(GUARDIAN_ASSET_FILE));
    this.bootstrapScript = this.absolute(uiAssetPath(CHILD_BOOTSTRAP_ASSET_FILE));
    this.capnwebScript = this.absolute(uiAssetPath(CAPNWEB_ASSET_FILE));
    this.sessionUrl = this.absolute(UI_SESSION_PATH);
    this.executeUrl = this.absolute(UI_EXECUTE_PATH);
  }

  absolute(path: string): string {
    return `${this.#base}${path}`;
  }

  childDocument(appId: string, releaseDigest: string): string {
    return this.absolute(uiDocumentPath(appId, releaseDigest, 'frame'));
  }

  uiScript(uiDigest: string): string {
    return this.absolute(uiAssetPath(`${uiDigest}.js`));
  }
}

/**
 * True only in the default space. The space is derived from the authenticated scoped request's
 * base path; non-default spaces fail closed rather than being treated as default.
 */
export const isDefaultSpace = (basePath: IBasePath, request: KibanaRequest): boolean =>
  basePath.get(request) === basePath.serverBasePath;

/** Space id for attribution only (`default` or the URL space prefix). */
export const spaceIdOf = (basePath: IBasePath, request: KibanaRequest): string => {
  const suffix = basePath.get(request).slice(basePath.serverBasePath.length);
  const match = /^\/s\/([a-z0-9_-]{1,64})$/.exec(suffix);
  if (suffix === '') return 'default';
  return match ? match[1] : 'unknown';
};
