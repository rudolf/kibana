/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '../../common';
import { manifestSchema, type AppManifest } from './manifest_schema';
import { PackageError, type PackageErrorCode } from './package_error';

export interface AppPackage {
  readonly manifest: AppManifest;
  readonly bundle: string;
}

const MANIFEST_FILE = 'manifest.json';

/**
 * Reads at most `maxBytes + 1` bytes from a regular, non-symlink file so that oversized files are
 * detected without buffering them.
 */
const readBounded = async (
  path: string,
  maxBytes: number,
  unavailable: PackageErrorCode,
  tooLarge: PackageErrorCode
): Promise<Buffer> => {
  let handle: fs.FileHandle | undefined;
  try {
    // O_RDONLY is 0, so O_NOFOLLOW alone opens read-only without following a final symlink.
    handle = await fs.open(path, constants.O_NOFOLLOW);
  } catch {
    throw new PackageError(unavailable);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new PackageError(unavailable);
    if (stat.size > maxBytes) throw new PackageError(tooLarge);
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) throw new PackageError(tooLarge);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

/** Reads the manifest only; used by the app list. */
export const readManifest = async (packagePath: string): Promise<AppManifest> => {
  const raw = await readBounded(
    join(packagePath, MANIFEST_FILE),
    LIMITS.manifestBytes,
    'package_unavailable',
    'manifest_too_large'
  );
  try {
    return manifestSchema.validate(JSON.parse(raw.toString('utf8')));
  } catch {
    throw new PackageError('manifest_invalid');
  }
};

/**
 * Loads the manifest afresh, then the immutable `<digest>.js` it names, and verifies the digest.
 * App code is returned as an opaque string; it is never imported or evaluated in Kibana.
 */
export const readPackage = async (packagePath: string): Promise<AppPackage> => {
  const manifest = await readManifest(packagePath);
  // The digest is validated as 64 lowercase hex characters, so it cannot escape the directory.
  const raw = await readBounded(
    join(packagePath, `${manifest.digest}.js`),
    LIMITS.bundleBytes,
    'bundle_unavailable',
    'bundle_too_large'
  );
  const actual = createHash('sha256').update(raw).digest('hex');
  if (actual !== manifest.digest) throw new PackageError('digest_mismatch');
  return { manifest, bundle: raw.toString('utf8') };
};
