/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { UI_LIMITS } from '../../common/ui_protocol';

/** The approved-manifest fields the key is derived from (structural, so tooling can reuse it). */
export interface AppKeyManifest {
  readonly id: string;
  readonly releaseDigest: string;
  readonly permissions: { readonly indices: readonly string[] };
  readonly ui: { readonly scopes: readonly string[] };
}

/** Kibana's ES application name for the default `kibana.index` (prototype: not configurable). */
export const KIBANA_APPLICATION = 'kibana-.kibana';
export const DASHBOARD_READ_PRIVILEGE = 'feature_dashboard_v2.read';
export const DATA_VIEWS_READ_PRIVILEGE = 'feature_indexPatterns.read';

/** Restricted API key request; shaped like the security service's `CreateRestAPIKeyParams`. */
export interface AppKeyRequest {
  readonly name: string;
  readonly expiration: string;
  readonly metadata: {
    readonly app_host: true;
    readonly app: string;
    readonly release: string;
    readonly space: string;
  };
  readonly role_descriptors: Record<string, Record<string, unknown>>;
}

/** The app session credential. Server memory only; never logged or sent to the browser. */
export interface AppKey {
  readonly id: string;
  readonly apiKey: string;
}

/** Key name used for revocation: operators invalidate `app:{appId}@{releaseDigest}` (or `@*`). */
export const appKeyName = (appId: string, releaseDigest: string): string =>
  `app:${appId}@${releaseDigest}`;

/**
 * Derives the key's role descriptor from the approved manifest only: `read` and
 * `view_index_metadata` on the granted indices and patterns, Dashboard read (`kibana.dashboard.read`)
 * and Data Views read (`kibana.dataViews.read`) in the session's space only with their scopes, and
 * nothing else (no cluster privileges, so no ES|QL `ENRICH` or inference; no remote indices; no
 * `run_as`). Elasticsearch intersects it with
 * the viewer's own privileges (`limited_by`), so the key can never exceed viewer ∩ app.
 */
export const appKeyRequest = (manifest: AppKeyManifest, spaceId: string): AppKeyRequest => {
  const { id, releaseDigest, permissions, ui } = manifest;
  const kibanaPrivileges = [
    ...(ui.scopes.includes('kibana.dashboard.read') ? [DASHBOARD_READ_PRIVILEGE] : []),
    ...(ui.scopes.includes('kibana.dataViews.read') ? [DATA_VIEWS_READ_PRIVILEGE] : []),
  ];
  return {
    name: appKeyName(id, releaseDigest),
    expiration: `${UI_LIMITS.sessionTtlMs / 1000}s`,
    metadata: { app_host: true, app: id, release: releaseDigest, space: spaceId },
    role_descriptors: {
      app: {
        cluster: [],
        indices:
          permissions.indices.length > 0
            ? [{ names: [...permissions.indices], privileges: ['read', 'view_index_metadata'] }]
            : [],
        applications:
          kibanaPrivileges.length > 0
            ? [
                {
                  application: KIBANA_APPLICATION,
                  privileges: kibanaPrivileges,
                  resources: [`space:${spaceId}`],
                },
              ]
            : [],
        run_as: [],
      },
    },
  };
};
