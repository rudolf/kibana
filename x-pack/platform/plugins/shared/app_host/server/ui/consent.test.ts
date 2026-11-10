/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUiReleaseState } from './consent';
import { uiManifest, writeConsentFile, writeUiPackage } from '../test/ui_fixtures';

describe('readUiReleaseState', () => {
  let dir: string;
  let consent: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'app-host-consent-'));
    consent = join(dir, 'consent.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('approved only for the exact enabled release, version and grant fingerprint', async () => {
    const manifest = uiManifest();
    await writeUiPackage(dir, manifest);
    await writeConsentFile(consent, manifest);
    expect((await readUiReleaseState(dir, consent)).status).toBe('approved');
    await writeConsentFile(consent, manifest, { enabled: false });
    expect((await readUiReleaseState(dir, consent)).status).toBe('disabled');
    await writeConsentFile(consent, manifest, { approvedVersion: '1.0.0' });
    expect((await readUiReleaseState(dir, consent)).status).toBe('not_approved');
    await writeConsentFile(consent, manifest, { installerGrantDigest: 'e'.repeat(64) });
    expect((await readUiReleaseState(dir, consent)).status).toBe('not_approved');
  });

  it('a new release (even same scopes) is not approved by the old record', async () => {
    const v1 = uiManifest();
    await writeUiPackage(dir, v1);
    await writeConsentFile(consent, v1);
    const v2 = uiManifest({ version: '2.0.1' }, { uiBundle: '(function(){})();\n' });
    await writeUiPackage(dir, v2, { uiBundle: '(function(){})();\n' });
    expect((await readUiReleaseState(dir, consent)).status).toBe('not_approved');
  });

  it('fails closed on missing config, missing file, bad JSON, extra keys, writable mode or symlink', async () => {
    const manifest = uiManifest();
    await writeUiPackage(dir, manifest);
    expect((await readUiReleaseState(dir, undefined)).status).toBe('not_installed');
    expect((await readUiReleaseState(dir, consent)).status).toBe('not_installed');
    await writeFile(consent, '{');
    expect((await readUiReleaseState(dir, consent)).status).toBe('invalid');
    await writeConsentFile(consent, manifest, { indices: ['other-index'] });
    expect((await readUiReleaseState(dir, consent)).status).toBe('invalid');
    await writeConsentFile(consent, manifest, {}, 0o666);
    expect((await readUiReleaseState(dir, consent)).status).toBe('invalid');
    await writeConsentFile(join(dir, 'real.json'), manifest);
    await rm(consent);
    await symlink(join(dir, 'real.json'), consent);
    expect((await readUiReleaseState(dir, consent)).status).toBe('invalid');
  });
});
