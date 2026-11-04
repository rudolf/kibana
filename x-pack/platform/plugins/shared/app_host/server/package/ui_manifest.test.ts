/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PackageError } from './package_error';
import { readManifest, readUiBundle } from './read_package';
import { compareUiVersions, parseUiVersion, projectWorkerManifest } from './manifest_schema';
import { sha, uiManifest, UI_BUNDLE, writeUiPackage } from '../test/ui_fixtures';

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PackageError) return error.code;
    throw error;
  }
  return 'ok';
};

describe('UI release manifests', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'app-host-ui-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const check = async (manifest: Record<string, unknown>) => {
    await writeUiPackage(dir, manifest);
    return codeOf(readManifest(dir));
  };

  it('accepts the exact envelope', async () => {
    expect(await check(uiManifest())).toBe('ok');
  });

  it('S11: rejects non-empty client or server egress, even when re-digested', async () => {
    const ui = uiManifest().ui as Record<string, unknown>;
    expect(
      await check(uiManifest({ ui: { ...ui, egress: { client: ['https://x'], server: [] } } }))
    ).toBe('manifest_invalid');
    expect(await check(uiManifest({ ui: { ...ui, egress: { client: [], server: ['x'] } } }))).toBe(
      'manifest_invalid'
    );
  });

  it('S8: any index other than the synthetic literal is rejected at parse', async () => {
    for (const index of ['other-index', '.security-7', 'logs-kibana.audit-default', 'kbn-*']) {
      const manifest = uiManifest({
        permissions: {
          indices: [index],
          dashboardIds: [(uiManifest().permissions as { dashboardIds: string[] }).dashboardIds[0]],
        },
      });
      expect(await check(manifest)).toBe('manifest_invalid');
    }
  });

  it('rejects unknown, non-delegable or duplicate scopes and wildcard dashboards', async () => {
    const ui = uiManifest().ui as Record<string, unknown>;
    expect(
      await check(uiManifest({ ui: { ...ui, scopes: ['app.summary', 'security.apiKey.create'] } }))
    ).toBe('manifest_invalid');
    expect(await check(uiManifest({ ui: { ...ui, scopes: ['app.summary', 'app.summary'] } }))).toBe(
      'manifest_invalid'
    );
    expect(
      await check(
        uiManifest({ permissions: { indices: ['kbn-apps-prototype-alerts'], dashboardIds: ['*'] } })
      )
    ).toBe('manifest_invalid');
    expect(await check(uiManifest({ extra: true }))).toBe('manifest_invalid');
  });

  it('pins the bridge contract digest, the full release digest and the entry name', async () => {
    const ui = uiManifest().ui as Record<string, unknown>;
    expect(await check(uiManifest({ ui: { ...ui, scopeMapDigest: 'f'.repeat(64) } }))).toBe(
      'scope_map_mismatch'
    );
    expect(await check({ ...uiManifest(), title: 'Changed after digest' })).toBe(
      'release_digest_mismatch'
    );
    expect(await check(uiManifest({ ui: { ...ui, entry: `${'0'.repeat(64)}.js` } }))).toBe(
      'ui_invalid'
    );
    expect(await check(uiManifest({ version: '2.0.0-beta' }))).toBe('ui_invalid');
  });

  it('keeps legacy backend-only manifests free of UI fields', async () => {
    const legacy = uiManifest({}, { rehash: false });
    delete legacy.ui;
    delete legacy.releaseDigest;
    expect(await check(legacy)).toBe('ui_invalid');
    delete (legacy.permissions as Record<string, unknown>).dashboardIds;
    legacy.version = '1.0.0-legacy';
    expect(await check(legacy)).toBe('ok');
  });

  it('reads the UI bundle with a size bound and recomputes its digest (tamper → fail)', async () => {
    await writeUiPackage(dir, uiManifest());
    expect((await readUiBundle(dir, sha(UI_BUNDLE))).toString()).toBe(UI_BUNDLE);
    await writeFile(join(dir, `${sha(UI_BUNDLE)}.js`), `${UI_BUNDLE}// tampered`);
    expect(await codeOf(readUiBundle(dir, sha(UI_BUNDLE)))).toBe('ui_digest_mismatch');
    const big = 'x'.repeat(512 * 1024 + 1);
    await writeFile(join(dir, `${sha(big)}.js`), big);
    expect(await codeOf(readUiBundle(dir, sha(big)))).toBe('ui_bundle_too_large');
    expect(await codeOf(readUiBundle(dir, '../manifest'))).toBe('ui_bundle_unavailable');
  });
});

describe('versions', () => {
  it('compares numerically, never lexically', () => {
    expect(compareUiVersions(parseUiVersion('1.10.0')!, parseUiVersion('1.9.0')!)).toBeGreaterThan(
      0
    );
    expect(parseUiVersion('65536.0.0')).toBeUndefined();
    expect(parseUiVersion('01.0.0')).toBeUndefined();
  });
});

describe('projectWorkerManifest (Worker wire schema)', () => {
  it('projects exactly the backend fields; ui, releaseDigest and dashboardIds never reach the Worker', () => {
    const projected = projectWorkerManifest(uiManifest() as never);
    expect(Object.keys(projected).sort()).toEqual(
      ['digest', 'hostApi', 'id', 'permissions', 'routes', 'title', 'version'].sort()
    );
    expect(Object.keys(projected.permissions)).toEqual(['indices']);
    expect(JSON.stringify(projected)).not.toMatch(/releaseDigest|dashboardIds|"ui"|scopeMapDigest/);
  });
});
