/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Writes a git-ignored Kibana config (.local/kibana.app_host.yml, mode 0600) for local development.
// It contains the caller secret, so it is never printed. Usage:
//   npm run kibana:config -- [--dispatcher ws://127.0.0.1:8787/rpc] [--package-dir DIR]
//       [--public-base-url http://localhost:5601] [--csp-collector http://127.0.0.1:5699/csp]
// The UI cut needs one initial restart for publicBaseUrl, frame-ancestors 'self', the approval
// path, the synthetic CSP report collector and the JSON audit / HTTP debug log appenders.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from './lib/args';
import { CONSENT_FILE } from './lib/approval';
import { LOCAL_DIR, readCallerToken } from './lib/secrets';

const args = parseArgs(process.argv.slice(2), [
  'dispatcher',
  'package-dir',
  'public-base-url',
  'csp-collector',
]);
const dispatcherUrl = args.dispatcher ?? 'ws://127.0.0.1:8787/rpc';
const packagePath = resolve(args['package-dir'] ?? resolve(LOCAL_DIR, 'package'));
const publicBaseUrl = args['public-base-url'] ?? 'http://localhost:5601';
const cspCollector = args['csp-collector'] ?? 'http://127.0.0.1:5699/csp-report';
const logs = resolve(LOCAL_DIR, 'logs');
mkdirSync(packagePath, { recursive: true });
mkdirSync(logs, { recursive: true });
mkdirSync(resolve(LOCAL_DIR, 'operator'), { recursive: true, mode: 0o700 });
const file = resolve(LOCAL_DIR, 'kibana.app_host.yml');
const q = (value: string) => JSON.stringify(value);
writeFileSync(
  file,
  [
    'xpack.app_host.enabled: true',
    `xpack.app_host.packagePath: ${q(packagePath)}`,
    `xpack.app_host.dispatcherUrl: ${q(dispatcherUrl)}`,
    `xpack.app_host.callerToken: ${q(readCallerToken())}`,
    `xpack.app_host.consentPath: ${q(CONSENT_FILE)}`,
    `server.publicBaseUrl: ${q(publicBaseUrl)}`,
    `csp.frame_ancestors: ["'self'"]`,
    // Synthetic local collector: proves app surfaces send no reports while normal routes keep Core's.
    `csp.report_uri: [${q(cspCollector)}]`,
    // Kibana's own security audit log, to correlate native Dashboard reads with bridge records.
    'xpack.security.audit.enabled: true',
    'xpack.security.audit.appender:',
    '  type: file',
    `  fileName: ${q(resolve(logs, 'kibana_audit.ndjson'))}`,
    '  layout:',
    '    type: json',
    'logging:',
    '  appenders:',
    '    app_host_audit:',
    '      type: file',
    `      fileName: ${q(resolve(logs, 'app_host_audit.ndjson'))}`,
    '      layout:',
    '        type: json',
    '    http_debug:',
    '      type: file',
    `      fileName: ${q(resolve(logs, 'http_debug.ndjson'))}`,
    '      layout:',
    '        type: json',
    '  loggers:',
    '    - name: plugins.appHost.bridge_audit',
    '      level: info',
    '      appenders: [app_host_audit]',
    // S11: prove the lease secret never appears even with response debug logging on.
    '    - name: http.server.response',
    '      level: debug',
    '      appenders: [http_debug]',
    '',
  ].join('\n'),
  { mode: 0o600 }
);
chmodSync(file, 0o600);
process.stdout.write(
  `${JSON.stringify({ config: file, packagePath, dispatcherUrl, publicBaseUrl, cspCollector })}\n`
);
