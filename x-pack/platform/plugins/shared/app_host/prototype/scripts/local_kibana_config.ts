/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Writes a git-ignored Kibana config (.local/kibana.app_host.yml, mode 0600) for local development.
// It contains the caller secret, so it is never printed. Usage:
//   npm run kibana:config -- [--dispatcher ws://127.0.0.1:8787/rpc] [--package-dir DIR]

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from './lib/args';
import { LOCAL_DIR, readCallerToken } from './lib/secrets';

const args = parseArgs(process.argv.slice(2), ['dispatcher', 'package-dir']);
const dispatcherUrl = args.dispatcher ?? 'ws://127.0.0.1:8787/rpc';
const packagePath = resolve(args['package-dir'] ?? resolve(LOCAL_DIR, 'package'));
mkdirSync(packagePath, { recursive: true });
const file = resolve(LOCAL_DIR, 'kibana.app_host.yml');
writeFileSync(
  file,
  [
    'xpack.app_host.enabled: true',
    `xpack.app_host.packagePath: ${JSON.stringify(packagePath)}`,
    `xpack.app_host.dispatcherUrl: ${JSON.stringify(dispatcherUrl)}`,
    `xpack.app_host.callerToken: ${JSON.stringify(readCallerToken())}`,
    '',
  ].join('\n'),
  { mode: 0o600 }
);
chmodSync(file, 0o600);
process.stdout.write(`${JSON.stringify({ config: file, packagePath, dispatcherUrl })}\n`);
