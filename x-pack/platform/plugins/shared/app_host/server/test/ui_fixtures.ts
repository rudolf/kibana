/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Test-only builders for UI-release manifests and approval records (not imported by runtime code).

import { createHash } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../../common/ui_contract';
import { SCOPE_MAP_DIGEST_V1 } from '../ui/contract';

export const SERVER_BUNDLE = 'export class App {}\n';
export const UI_BUNDLE = '(function(){document.title="ui";})();\n';
export const DASHBOARD_ID = '78a07dab-f7e4-4bdf-b155-da929711312c';

export const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export const uiManifest = (
  overrides: Record<string, unknown> = {},
  { uiBundle = UI_BUNDLE, rehash = true }: { uiBundle?: string; rehash?: boolean } = {}
): Record<string, unknown> => {
  const uiDigest = sha(uiBundle);
  const draft: Record<string, unknown> = {
    id: 'alert-digest',
    title: 'Alert digest',
    version: '2.0.0',
    hostApi: 1,
    digest: sha(SERVER_BUNDLE),
    permissions: { indices: ['kbn-apps-prototype-alerts'], dashboardIds: [DASHBOARD_ID] },
    routes: [{ method: 'GET', path: '/summary', handler: 'summary' }],
    ui: {
      entry: `${uiDigest}.js`,
      digest: uiDigest,
      bridgeApi: 1,
      scopeMapDigest: SCOPE_MAP_DIGEST_V1,
      scopes: ['app.summary', 'es.search', 'kibana.dashboard.read'],
      egress: { client: [], server: [] },
    },
    ...overrides,
  };
  if (rehash) {
    const { releaseDigest: _omitted, ...rest } = draft;
    draft.releaseDigest = sha(canonicalJson(rest));
  }
  return draft;
};

export const writeUiPackage = async (
  dir: string,
  manifest: Record<string, unknown>,
  { uiBundle = UI_BUNDLE }: { uiBundle?: string } = {}
) => {
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(dir, `${sha(SERVER_BUNDLE)}.js`), SERVER_BUNDLE);
  await writeFile(join(dir, `${sha(uiBundle)}.js`), uiBundle);
};

export const grantDigest = (manifest: Record<string, unknown>, approvedBy: string) => {
  const permissions = manifest.permissions as { indices: string[]; dashboardIds: string[] };
  const ui = manifest.ui as { scopes: string[] };
  return sha(
    canonicalJson({
      appId: manifest.id,
      releaseDigest: manifest.releaseDigest,
      indices: permissions.indices,
      dashboardIds: permissions.dashboardIds,
      scopes: ui.scopes,
      approvedBy,
    })
  );
};

export const writeConsentFile = async (
  path: string,
  manifest: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
  mode = 0o600
) => {
  await writeFile(
    path,
    JSON.stringify({
      appId: 'alert-digest',
      enabled: true,
      approvedReleaseDigest: manifest.releaseDigest,
      approvedVersion: manifest.version,
      approvedBy: 'elastic',
      installerGrantDigest: grantDigest(manifest, 'elastic'),
      generation: 'GenerationToken0000001',
      ...overrides,
    })
  );
  await chmod(path, mode);
};
