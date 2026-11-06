/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Builds and releases a full app release with a UI envelope (bridgeApi 1). The bridge contract
// object is imported from the plugin's own `common/ui_contract.ts`, so the scope-map digest is the
// one Kibana computes; a mismatch fails closed in Kibana.

import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { UI_CONTRACT_V1, canonicalJson } from '../../../common/ui_contract';
import { HOST_API_VERSION, SYNTHETIC_INDEX } from '../../shared/protocol';
import { APP_ID, APP_TITLE, PROTOTYPE_ROOT, bundleModule } from './build';
import { MANIFEST_FILE } from './package_dir';

const execFileAsync = promisify(execFile);

export const MAX_UI_BUNDLE_BYTES = 512 * 1024;
export const UI_SCOPES = [
  'app.summary',
  'es.search',
  'kibana.dashboard.read',
  'kibana.dataViews.read',
  'es.esql',
] as const;
/** Mini Discover grant: the synthetic demo log indices (ES enforces it through the app key). */
export const DEMO_INDEX_PATTERN = 'kbn-apps-demo-logs-*';

export const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export const scopeMapDigest = (): string => sha256(canonicalJson(UI_CONTRACT_V1));

export const releaseDigestOf = (manifest: Record<string, unknown>): string => {
  const { releaseDigest: _omitted, ...rest } = manifest;
  return sha256(canonicalJson(rest));
};

export interface UiManifest {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly hostApi: 1;
  readonly digest: string;
  readonly permissions: {
    readonly indices: readonly string[];
    readonly dashboardIds: readonly string[];
  };
  readonly routes: ReadonlyArray<{ method: 'GET'; path: '/summary'; handler: 'summary' }>;
  readonly ui: {
    readonly entry: string;
    readonly digest: string;
    readonly bridgeApi: 1;
    readonly scopeMapDigest: string;
    readonly scopes: readonly string[];
    readonly egress: { readonly client: readonly string[]; readonly server: readonly string[] };
  };
  readonly releaseDigest: string;
}

export interface UiRelease {
  readonly manifest: UiManifest;
  readonly serverBundle: string;
  readonly uiBundle: string;
}

/** One classic IIFE (no module loader, no source map, no remote dependency). */
export const bundleUi = async (
  entry: string,
  define: Record<string, string>,
  { adversarial = false }: { adversarial?: boolean } = {}
): Promise<string> => {
  const esbuild = resolve(PROTOTYPE_ROOT, 'node_modules/.bin/esbuild');
  const { stdout } = await execFileAsync(
    esbuild,
    [
      resolve(PROTOTYPE_ROOT, entry),
      '--bundle',
      '--format=iife',
      '--platform=browser',
      '--target=es2020',
      '--legal-comments=none',
      '--log-level=error',
      ...Object.entries(define).map(([key, value]) => `--define:${key}=${value}`),
    ],
    { maxBuffer: 8 * 1024 * 1024 }
  );
  if (Buffer.byteLength(stdout) > MAX_UI_BUNDLE_BYTES) throw new Error('UI bundle exceeds 512 KiB');
  // Honest releases: no module loader or source maps. Adversarial fixtures deliberately try them.
  if (!adversarial && /\bimport\s*\(|sourceMappingURL/.test(stdout)) {
    throw new Error('UI bundle must not use dynamic import or source maps');
  }
  return stdout;
};

export interface BuildUiReleaseOptions {
  readonly version: string;
  readonly label: string;
  readonly dashboardId: string;
  /** `ui/src/main.ts` (default) or a fixture under `ui/fixtures/`. */
  readonly uiEntry?: string;
  readonly title?: string;
  /** Test-only overrides to produce deliberately invalid manifests. */
  readonly mutate?: (manifest: Record<string, unknown>) => void;
  /** Extra build-time constants for adversarial fixtures (receiver/Kibana URLs). */
  readonly extraDefine?: Record<string, string>;
  /** Server label override (defaults to `label`). */
  readonly serverLabel?: string;
  /** Server app entry (default `app/src/entry.ts`; a variant under `fixtures/kibana/`) and its constants. */
  readonly serverEntry?: string;
  readonly serverDefine?: Record<string, string>;
}

export const buildUiRelease = async ({
  version,
  label,
  dashboardId,
  uiEntry = 'ui/src/main.ts',
  title = APP_TITLE,
  mutate,
  extraDefine = {},
  serverLabel,
  serverEntry = 'app/src/entry.ts',
  serverDefine = {},
}: BuildUiReleaseOptions): Promise<UiRelease> => {
  const serverBundle = await bundleModule(serverEntry, {
    __APP_LABEL__: JSON.stringify(serverLabel ?? label),
    ...serverDefine,
  });
  const uiBundle = await bundleUi(
    uiEntry,
    {
      __UI_VERSION__: JSON.stringify(version),
      __UI_LABEL__: JSON.stringify(label),
      __DASHBOARD_ID__: JSON.stringify(dashboardId),
      ...extraDefine,
    },
    { adversarial: uiEntry.startsWith('ui/fixtures/') }
  );
  const uiDigest = sha256(uiBundle);
  const draft: Record<string, unknown> = {
    id: APP_ID,
    title,
    version,
    hostApi: HOST_API_VERSION,
    digest: sha256(serverBundle),
    permissions: { indices: [SYNTHETIC_INDEX, DEMO_INDEX_PATTERN], dashboardIds: [dashboardId] },
    routes: [{ method: 'GET', path: '/summary', handler: 'summary' }],
    ui: {
      entry: `${uiDigest}.js`,
      digest: uiDigest,
      bridgeApi: 1,
      scopeMapDigest: scopeMapDigest(),
      scopes: [...UI_SCOPES],
      egress: { client: [], server: [] },
    },
  };
  mutate?.(draft);
  const manifest = { ...draft, releaseDigest: releaseDigestOf(draft) } as unknown as UiManifest;
  return { manifest, serverBundle, uiBundle };
};

const atomicWrite = async (dir: string, name: string, content: string, mode = 0o644) => {
  const tmp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, content, { mode });
  await rename(tmp, join(dir, name));
};

const writeImmutable = async (dir: string, name: string, content: string) => {
  const existing = await readFile(join(dir, name), 'utf8').catch(() => undefined);
  if (existing === undefined) await atomicWrite(dir, name, content);
  else if (existing !== content) {
    throw new Error(`Refusing to overwrite immutable bundle ${name} with different content`);
  }
};

/** Writes both immutable bundles first, then atomically replaces the manifest. */
export const releaseUiPackage = async (dir: string, release: UiRelease) => {
  const target = resolve(dir);
  await mkdir(target, { recursive: true });
  await writeImmutable(target, `${release.manifest.digest}.js`, release.serverBundle);
  await writeImmutable(target, release.manifest.ui.entry, release.uiBundle);
  await atomicWrite(target, MANIFEST_FILE, `${JSON.stringify(release.manifest, null, 2)}\n`);
  return {
    dir: target,
    releaseDigest: release.manifest.releaseDigest,
    uiDigest: release.manifest.ui.digest,
    serverDigest: release.manifest.digest,
    uiBundleBytes: Buffer.byteLength(release.uiBundle),
  };
};

export { atomicWrite };
