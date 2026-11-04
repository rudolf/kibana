/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  HOST_API_VERSION,
  MAX_BUNDLE_BYTES,
  SYNTHETIC_INDEX,
  byteLength,
  sha256Hex,
  type Manifest,
} from '../../shared/protocol';

export const PROTOTYPE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const APP_ID = 'alert-digest';
export const APP_TITLE = 'Alert digest';

const execFileAsync = promisify(execFile);

/** Bundles one Worker module with the pinned esbuild CLI, leaving `cloudflare:*` external. */
export const bundleModule = async (
  entry: string,
  define: Record<string, string> = {}
): Promise<string> => {
  const esbuild = resolve(PROTOTYPE_ROOT, 'node_modules/.bin/esbuild');
  const args = [
    resolve(PROTOTYPE_ROOT, entry),
    '--bundle',
    '--format=esm',
    '--platform=neutral',
    '--target=es2022',
    '--external:cloudflare:workers',
    '--external:cloudflare:sockets',
    '--legal-comments=none',
    '--log-level=error',
    ...Object.entries(define).map(([key, value]) => `--define:${key}=${value}`),
  ];
  const { stdout } = await execFileAsync(esbuild, args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

export interface BuiltPackage {
  readonly manifest: Manifest;
  readonly bundle: string;
}

export const packageBundle = async (
  bundle: string,
  version: string,
  title: string = APP_TITLE,
  id: string = APP_ID
): Promise<BuiltPackage> => {
  if (byteLength(bundle) > MAX_BUNDLE_BYTES) throw new Error('bundle exceeds 64 KiB');
  const manifest: Manifest = {
    id,
    title,
    version,
    hostApi: HOST_API_VERSION,
    digest: await sha256Hex(bundle),
    permissions: { indices: [SYNTHETIC_INDEX] },
    routes: [{ method: 'GET', path: '/summary', handler: 'summary' }],
  };
  return { manifest, bundle };
};

export const buildApp = async (version: string, label: string): Promise<BuiltPackage> =>
  packageBundle(
    await bundleModule('app/src/entry.ts', { __APP_LABEL__: JSON.stringify(label) }),
    version
  );

export const buildFixture = async (
  name: string,
  define: Record<string, string> = {}
): Promise<BuiltPackage> =>
  packageBundle(
    await bundleModule(`fixtures/${name}.ts`, define),
    '0.0.0-fixture',
    `Fixture ${name}`
  );

/** Builds a Kibana acceptance variant packaged as the installed app id. */
export const buildVariant = async (
  name: string,
  version: string,
  define: Record<string, string> = {}
): Promise<BuiltPackage> =>
  packageBundle(
    await bundleModule(`fixtures/kibana/${name}.ts`, define),
    version,
    `Variant ${name}`
  );
