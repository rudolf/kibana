/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManifest, readPackage } from './read_package';
import { PackageError } from './package_error';

const bundle = 'export class App {}\n';
const digest = createHash('sha256').update(bundle).digest('hex');
const manifest = (overrides: Record<string, unknown> = {}) => ({
  id: 'alert-digest',
  title: 'Alert digest',
  version: '1.0.0',
  hostApi: 1,
  digest,
  permissions: { indices: ['kbn-apps-prototype-alerts'] },
  routes: [{ method: 'GET', path: '/summary', handler: 'summary' }],
  ...overrides,
});

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PackageError) return error.code;
    throw error;
  }
  return 'ok';
};

describe('readPackage', () => {
  let dir: string;

  const write = async (m: unknown, code: string = bundle, name: string = `${digest}.js`) => {
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(m));
    await writeFile(join(dir, name), code);
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'app-host-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a valid package and returns the bundle as an opaque string', async () => {
    await write(manifest());
    const pkg = await readPackage(dir);
    expect(pkg.manifest.version).toBe('1.0.0');
    expect(pkg.bundle).toBe(bundle);
  });

  it('reads the manifest afresh on every call', async () => {
    await write(manifest());
    expect((await readManifest(dir)).version).toBe('1.0.0');
    await write(manifest({ version: '1.0.1' }));
    expect((await readManifest(dir)).version).toBe('1.0.1');
  });

  it.each([
    ['unknown field', { extra: true }],
    ['unsupported host API', { hostApi: 2 }],
    ['other app id', { id: 'other-app' }],
    ['wildcard grant', { permissions: { indices: ['kbn-apps-*'] } }],
    ['extra grant', { permissions: { indices: ['kbn-apps-prototype-alerts', '.kibana'] } }],
    ['extra route', { routes: [{ method: 'GET', path: '/other', handler: 'summary' }] }],
    ['long title', { title: 't'.repeat(81) }],
    ['long version', { version: '1'.repeat(33) }],
    ['uppercase digest', { digest: digest.toUpperCase() }],
    ['path digest', { digest: '../'.padEnd(64, 'a') }],
  ])('rejects a manifest with %s', async (_name, overrides) => {
    await write(manifest(overrides));
    expect(await codeOf(readPackage(dir))).toBe('manifest_invalid');
  });

  it('rejects malformed JSON and a missing manifest', async () => {
    expect(await codeOf(readPackage(dir))).toBe('package_unavailable');
    await writeFile(join(dir, 'manifest.json'), '{');
    expect(await codeOf(readPackage(dir))).toBe('manifest_invalid');
  });

  it('rejects a digest mismatch', async () => {
    await write(manifest(), `${bundle}// tampered`);
    expect(await codeOf(readPackage(dir))).toBe('digest_mismatch');
  });

  it('rejects a missing bundle', async () => {
    await write(manifest(), bundle, 'other.js');
    expect(await codeOf(readPackage(dir))).toBe('bundle_unavailable');
  });

  it('does not follow symlinks', async () => {
    const target = await mkdtemp(join(tmpdir(), 'app-host-target-'));
    try {
      await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest()));
      await symlink(join(target, 'manifest.json'), join(dir, 'manifest.json'));
      expect(await codeOf(readPackage(dir))).toBe('package_unavailable');
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});
