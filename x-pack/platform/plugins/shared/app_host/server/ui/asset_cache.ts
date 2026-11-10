/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readUiBundle } from '../package/read_package';

interface Entry {
  readonly digest: string;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly bytes: Buffer;
}

/**
 * F3: the approved UI bundle's verified bytes, cached by digest. The unauthenticated asset route
 * hashes up to 512 KiB only when the approved digest or the file's identity (inode, size, mtime)
 * changes, not on every request. One entry (one approved release at a time) bounds memory; a
 * tampered file is re-verified and fails closed.
 */
export class VerifiedAssetCache {
  #entry: Entry | undefined;
  readonly #read: typeof readUiBundle;

  constructor(read: typeof readUiBundle = readUiBundle) {
    this.#read = read;
  }

  async get(packagePath: string, digest: string): Promise<Buffer> {
    const { ino, size, mtimeMs } = await stat(join(packagePath, `${digest}.js`));
    const entry = this.#entry;
    if (
      entry &&
      entry.digest === digest &&
      entry.ino === ino &&
      entry.size === size &&
      entry.mtimeMs === mtimeMs
    ) {
      return entry.bytes;
    }
    this.#entry = undefined;
    const bytes = await this.#read(packagePath, digest);
    this.#entry = { digest, ino, size, mtimeMs, bytes };
    return bytes;
  }
}
