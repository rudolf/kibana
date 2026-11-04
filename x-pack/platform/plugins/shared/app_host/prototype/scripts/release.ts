/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Builds the sample app and releases it into an operator package directory without touching Kibana
// or the dispatcher. Usage: npm run release -- --version 1.0.1 [--label 'Digest v2'] [--out DIR]

import { parseArgs } from './lib/args';
import { buildApp } from './lib/build';
import { releasePackage } from './lib/package_dir';

const args = parseArgs(process.argv.slice(2), ['version', 'label', 'out']);
const version = args.version;
const out = args.out ?? process.env.APP_PACKAGE_DIR;
if (!version) throw new Error('--version is required');
if (!out) throw new Error('--out (or APP_PACKAGE_DIR) is required');

const pkg = await buildApp(version, args.label ?? 'Digest v1');
const released = await releasePackage(out, pkg);
process.stdout.write(
  `${JSON.stringify({ released: { id: pkg.manifest.id, version, ...released } })}\n`
);
