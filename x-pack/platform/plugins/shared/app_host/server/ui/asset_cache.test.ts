/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUiBundle } from '../package/read_package';
import { sha } from '../test/ui_fixtures';
import { VerifiedAssetCache } from './asset_cache';

describe('VerifiedAssetCache (F3)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'app-host-assets-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('1,000 requests hash once per digest; a digest change or a tampered file re-verifies', async () => {
    const v1 = '(function(){document.title="v1";})();\n';
    const v2 = '(function(){document.title="v2";})();\n';
    await writeFile(join(dir, `${sha(v1)}.js`), v1);
    await writeFile(join(dir, `${sha(v2)}.js`), v2);
    const read = jest.fn(readUiBundle);
    const cache = new VerifiedAssetCache(read);
    for (let i = 0; i < 1000; i++) {
      expect((await cache.get(dir, sha(v1))).toString()).toBe(v1);
    }
    expect(read).toHaveBeenCalledTimes(1);
    expect((await cache.get(dir, sha(v2))).toString()).toBe(v2);
    expect(read).toHaveBeenCalledTimes(2);
    // Tamper with v2's bytes under its digest name: re-verified and refused.
    await writeFile(join(dir, `${sha(v2)}.js`), `${v2};document.title="tampered";`);
    const later = new Date(Date.now() + 5000);
    await utimes(join(dir, `${sha(v2)}.js`), later, later);
    await expect(cache.get(dir, sha(v2))).rejects.toThrow();
    await expect(cache.get(dir, sha(v2))).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(4);
  });
});
