/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Builds the sample app and releases it into an operator package directory without touching Kibana
// or the dispatcher. Usage:
//   npm run release -- --version 1.0.1 [--label 'Digest v2'] [--out DIR]
//   npm run release -- --with-ui --version 2.0.0 [--label L] [--ui-entry ui/src/main.ts]
//       [--approve-local-synthetic]   (needs ES_URL, KB_URL and INSTALLER_AUTH or ES_AUTH)

import { parseArgs } from './lib/args';
import { approveRelease } from './lib/approval';
import { buildApp } from './lib/build';
import { releasePackage } from './lib/package_dir';
import { readUiSeed } from './lib/ui_seed_state';
import { buildUiRelease, releaseUiPackage } from './lib/ui_release';

const args = parseArgs(
  process.argv.slice(2),
  ['version', 'label', 'out', 'with-ui', 'approve-local-synthetic', 'ui-entry'],
  ['with-ui', 'approve-local-synthetic']
);
const version = args.version;
const out = args.out ?? process.env.APP_PACKAGE_DIR;
if (!version) throw new Error('--version is required');
if (!out) throw new Error('--out (or APP_PACKAGE_DIR) is required');

if (!args['with-ui']) {
  if (args['approve-local-synthetic']) throw new Error('--approve-local-synthetic needs --with-ui');
  const pkg = await buildApp(version, args.label ?? 'Digest v1');
  const released = await releasePackage(out, pkg);
  process.stdout.write(
    `${JSON.stringify({ released: { id: pkg.manifest.id, version, ...released } })}\n`
  );
} else {
  const { dashboardId } = readUiSeed();
  const release = await buildUiRelease({
    version,
    label: args.label ?? `Digest ${version}`,
    dashboardId,
    uiEntry: args['ui-entry'],
  });
  const released = await releaseUiPackage(out, release);
  let approval: unknown = 'not requested';
  if (args['approve-local-synthetic']) {
    const auth = process.env.INSTALLER_AUTH ?? process.env.ES_AUTH;
    const esUrl = process.env.ES_URL;
    const kbUrl = process.env.KB_URL;
    if (!auth || !esUrl || !kbUrl)
      throw new Error('ES_URL, KB_URL and INSTALLER_AUTH are required');
    const result = await approveRelease({
      manifest: release.manifest,
      esUrl: esUrl.replace(/\/$/, ''),
      kbUrl: kbUrl.replace(/\/$/, ''),
      esAuth: auth,
      kbAuth: auth,
    });
    approval = {
      written: result.written,
      idempotent: result.idempotent,
      approvedBy: result.approvedBy,
    };
  }
  process.stdout.write(`${JSON.stringify({ released: { version, ...released }, approval })}\n`);
}
