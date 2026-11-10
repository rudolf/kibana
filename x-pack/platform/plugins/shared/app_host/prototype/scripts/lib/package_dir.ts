/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BuiltPackage } from './build';

export const MANIFEST_FILE = 'manifest.json';

const atomicWrite = async (dir: string, name: string, content: string) => {
  const tmp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, content, { mode: 0o644 });
  await rename(tmp, join(dir, name));
};

/** Writes the immutable `<digest>.js` (if absent) first, then atomically replaces the manifest. */
export const releasePackage = async (dir: string, { manifest, bundle }: BuiltPackage) => {
  const target = resolve(dir);
  await mkdir(target, { recursive: true });
  const bundleName = `${manifest.digest}.js`;
  const existing = await readFile(join(target, bundleName), 'utf8').catch(() => undefined);
  if (existing === undefined) {
    await atomicWrite(target, bundleName, bundle);
  } else if (existing !== bundle) {
    throw new Error(`Refusing to overwrite immutable bundle ${bundleName} with different content`);
  }
  await atomicWrite(target, MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir: target, digest: manifest.digest, bundleBytes: Buffer.byteLength(bundle) };
};

/** Replaces only the manifest with arbitrary content (acceptance tampering tests). */
export const writeRawManifest = async (dir: string, content: string) =>
  atomicWrite(resolve(dir), MANIFEST_FILE, content);

/** Writes an arbitrary file into the package directory (acceptance tampering tests). */
export const writeRawFile = async (dir: string, name: string, content: string) =>
  atomicWrite(resolve(dir), name, content);

export const readRawManifest = async (dir: string) =>
  readFile(join(resolve(dir), MANIFEST_FILE), 'utf8');
