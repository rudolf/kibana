/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// M3 page check: opens /app/appHost as the reader, releases v2 externally, presses Refresh and
// verifies the host-rendered title/version/label/table changed with no foreign scripts or iframes.
// Uses the Kibana workspace's Playwright (resolved from the repo root). Screenshots go to .local/.
// Usage: npm run ui-check -- --kibana http://localhost:5601 [--package-dir DIR]

import { join, resolve } from 'node:path';
import { chromium, selectors } from '@playwright/test';
import { parseArgs } from './lib/args';
import { buildApp } from './lib/build';
import { readRawManifest, releasePackage, writeRawManifest } from './lib/package_dir';
import { LOCAL_DIR, readUsers } from './lib/secrets';

const args = parseArgs(process.argv.slice(2), ['kibana', 'package-dir']);
const kibana = (args.kibana ?? process.env.KB_URL ?? '').replace(/\/$/, '');
if (!kibana) throw new Error('--kibana is required');
const packageDir = resolve(
  args['package-dir'] ?? process.env.APP_PACKAGE_DIR ?? join(LOCAL_DIR, 'package')
);
const { reader } = readUsers();
const original = await readRawManifest(packageDir).catch(() => undefined);

selectors.setTestIdAttribute('data-test-subj');
const browser = await chromium.launch();
try {
  await releasePackage(packageDir, await buildApp('1.0.0', 'Digest v1'));
  const authorization = `Basic ${Buffer.from(`${reader.username}:${reader.password}`).toString(
    'base64'
  )}`;
  const page = await browser.newPage({
    extraHTTPHeaders: { authorization },
    viewport: { width: 1400, height: 900 },
  });
  await page.goto(`${kibana}/app/appHost`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('appHostLabel').waitFor({ timeout: 180_000 });
  const read = async () => ({
    title: (await page.locator('h1').first().textContent())?.trim(),
    version: (await page.getByText(/Installed version/).textContent())?.trim(),
    label: (await page.getByTestId('appHostLabel').textContent())?.trim(),
    rows: (await page.getByTestId('appHostSeverityTable').locator('tbody tr').allInnerTexts()).map(
      (row) => row.replace(/\s+/g, ' ').trim()
    ),
  });
  const before = await read();
  await page.screenshot({ path: join(LOCAL_DIR, 'ui_v1.png') });
  await releasePackage(packageDir, await buildApp('1.0.1', 'Digest v2'));
  await page.getByTestId('appHostRefresh').click();
  await page.getByText('Digest v2').waitFor({ timeout: 10_000 });
  const after = await read();
  await page.screenshot({ path: join(LOCAL_DIR, 'ui_v2.png') });
  const foreignScripts = await page.evaluate(() =>
    Array.from(document.scripts)
      .map(({ src }) => src)
      .filter((src) => src && !src.startsWith(window.location.origin))
  );
  const iframes = await page.locator('iframe').count();
  const ok =
    before.label === 'Digest v1' &&
    before.version === 'Installed version 1.0.0' &&
    after.label === 'Digest v2' &&
    after.version === 'Installed version 1.0.1' &&
    foreignScripts.length === 0 &&
    iframes === 0;
  process.stdout.write(
    `${JSON.stringify({ ok, before, after, foreignScripts, iframes }, null, 2)}\n`
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  if (original !== undefined) await writeRawManifest(packageDir, original);
}
