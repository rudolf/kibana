/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { UI_LIMITS } from '../../common/ui_protocol';
import type { UiAppManifest } from '../package/manifest_schema';

/** Kibana's ES application name for the default `kibana.index` (prototype: not configurable). */
export const KIBANA_APPLICATION = 'kibana-.kibana';
export const DASHBOARD_READ_PRIVILEGE = 'feature_dashboard_v2.read';

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
 * Derives the key's role descriptor from the approved manifest only: read on the granted indices,
 * Dashboard read in the session's space only with the `kibana.dashboard.read` scope, and nothing
 * else (no cluster privileges, no remote indices, no `run_as`). Elasticsearch intersects it with
 * the viewer's own privileges (`limited_by`), so the key can never exceed viewer ∩ app.
 */
export const appKeyRequest = (manifest: UiAppManifest, spaceId: string): AppKeyRequest => {
  const { id, releaseDigest, permissions, ui } = manifest;
  return {
    name: appKeyName(id, releaseDigest),
    expiration: `${UI_LIMITS.sessionTtlMs / 1000}s`,
    metadata: { app_host: true, app: id, release: releaseDigest, space: spaceId },
    role_descriptors: {
      app: {
        cluster: [],
        indices:
          permissions.indices.length > 0
            ? [{ names: [...permissions.indices], privileges: ['read'] }]
            : [],
        applications: ui.scopes.includes('kibana.dashboard.read')
          ? [
              {
                application: KIBANA_APPLICATION,
                privileges: [DASHBOARD_READ_PRIVILEGE],
                resources: [`space:${spaceId}`],
              },
            ]
          : [],
        run_as: [],
      },
    },
  };
};
