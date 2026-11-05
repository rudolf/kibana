/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// UI-cut acceptance harness (K1–K6 app session key plus the surviving T-suites) against local Kibana/ES/Wrangler with synthetic data only.
// Usage: npm run ui:security -- --kibana http://localhost:5601 --engines chromium,firefox,webkit
//          [--suites t1,t5,...] [--es http://localhost:9200]
// Env: ES_AUTH (local admin user:pass; also the local superuser installer). Results are written to
// .local/ui_security-<timestamp>.json; credentials, handles and API keys are never printed.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { parseArgs } from './lib/args';
import { CONSENT_FILE } from './lib/approval';
import { readRawManifest, writeRawManifest } from './lib/package_dir';
import { LOCAL_DIR } from './lib/secrets';
import { readUiSeed } from './lib/ui_seed_state';
import { Receiver, Report, readUiUsers } from './lib/ui_harness';
import { PACKAGE_DIR, type SuiteContext } from './lib/ui_suites/context';
import { DEFAULT_SUITES, SUITES } from './lib/ui_suites/registry';
import { headerDumps } from './lib/ui_suites/t1_shell';

const args = parseArgs(process.argv.slice(2), ['kibana', 'engines', 'suites', 'es', 'tls']);
const kibana = (args.kibana ?? process.env.KB_URL ?? 'http://localhost:5601').replace(/\/$/, '');
const es = (args.es ?? process.env.ES_URL ?? 'http://localhost:9200').replace(/\/$/, '');
const adminAuth = process.env.ES_AUTH;
if (!adminAuth) throw new Error('ES_AUTH (local superuser user:pass) is required');
const engines = (args.engines ?? 'chromium,firefox,webkit').split(',').filter(Boolean);
const selected = (args.suites ?? DEFAULT_SUITES.join(',')).split(',').filter(Boolean);

// --tls <dir>: the SameSite=None HTTPS fixture. <dir> holds the local self-signed key.pem/cert.pem
// (git-ignored); receivers then use TLS too, so no result depends on mixed-content blocking. Run
// with NODE_EXTRA_CA_CERTS=<dir>/cert.pem so Node trusts the same certificate.
const tlsDir = args.tls;
const tls = tlsDir
  ? { key: readFileSync(join(tlsDir, 'key.pem')), cert: readFileSync(join(tlsDir, 'cert.pem')) }
  : undefined;
const report = new Report();
const receiver = new Receiver(5698, { tls });
const collector = new Receiver(5699, { tls });
const preconnect = new Receiver(5697, { tls });
await receiver.start();
await collector.start();
await preconnect.start();
const originalManifest = await readRawManifest(PACKAGE_DIR).catch(() => undefined);
// Fresh operator state for this run: the previous approval history is uninstalled.
rmSync(CONSENT_FILE, { force: true });
let minor = 0;
const ctx: SuiteContext = {
  kibana,
  es,
  adminAuth,
  packageDir: PACKAGE_DIR,
  engines,
  users: readUiUsers(),
  seed: readUiSeed(),
  report,
  receiver,
  collector,
  preconnect,
  tls: Boolean(tls),
  current: undefined,
  currentEntry: undefined,
  nextVersion: () => `1.${minor++}.0`,
};

const started = Date.now();
try {
  for (const name of selected) {
    const suite = SUITES[name];
    if (!suite) throw new Error(`Unknown suite ${name}`);
    process.stderr.write(`== ${name}\n`);
    await report.guard(name.toUpperCase(), 'suite', 'all', () => suite(ctx));
  }
} finally {
  await receiver.stop();
  await collector.stop();
  await preconnect.stop();
  rmSync(CONSENT_FILE, { force: true });
  if (originalManifest !== undefined) await writeRawManifest(PACKAGE_DIR, originalManifest);
}

const summary = report.summary();
const out = join(LOCAL_DIR, `ui_security-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(
  out,
  JSON.stringify(
    {
      kibana,
      engines,
      suites: selected,
      seconds: Math.round((Date.now() - started) / 1000),
      summary,
      headerDumps,
      results: report.results,
    },
    null,
    2
  )
);
process.stdout.write(`${JSON.stringify({ summary, report: out })}\n`);
process.exitCode = summary.fail > 0 ? 1 : 0;
