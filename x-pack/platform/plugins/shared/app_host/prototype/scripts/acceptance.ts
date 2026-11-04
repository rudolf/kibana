/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// M2/M3 acceptance against a running local Kibana with App Host enabled.
// Usage: npm run acceptance -- --kibana http://localhost:5601 --rpc ws://127.0.0.1:8787/rpc
//          [--package-dir DIR] [--wrangler-log FILE] [--local-workerd]
// Env: ES_AUTH (local superuser user:pass). Test users come from .local/users.json (npm run seed).
// The package directory is mutated during the run and restored to its original manifest at the end.

import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from './lib/args';
import { buildApp, buildVariant, type BuiltPackage } from './lib/build';
import { http, requireEnv, userAuth, type HttpResult } from './lib/http';
import { readRawManifest, releasePackage, writeRawFile, writeRawManifest } from './lib/package_dir';
import { LOCAL_DIR, readUsers } from './lib/secrets';
import { sha256Hex } from '../shared/protocol';

const args = parseArgs(
  process.argv.slice(2),
  ['kibana', 'rpc', 'package-dir', 'wrangler-log', 'local-workerd'],
  ['local-workerd']
);
const kibana = (args.kibana ?? process.env.KB_URL ?? '').replace(/\/$/, '');
if (!kibana) throw new Error('--kibana is required');
const rpc = args.rpc ?? process.env.CF_RPC_URL ?? 'unknown';
const packageDir = resolve(
  args['package-dir'] ?? process.env.APP_PACKAGE_DIR ?? join(LOCAL_DIR, 'package')
);
const wranglerLog = args['wrangler-log'];
const localWorkerd = args['local-workerd'] === 'true';
const superuser = requireEnv('ES_AUTH');
const users = readUsers();
const reader = userAuth(users.reader);
const noIndex = userAuth(users.noIndex);
const noFeature = userAuth(users.noFeature);

const SUMMARY = `${kibana}/api/apps/alert-digest/summary`;
const APPS = `${kibana}/internal/app_host/apps`;
const INTERNAL = { 'x-elastic-internal-origin': 'kibana' };

const results: Record<string, unknown> = {};
const details: Record<string, unknown> = {};
const failures: string[] = [];

const assert = (name: string, ok: boolean, detail?: unknown) => {
  results[name] = ok;
  if (detail !== undefined) details[name] = detail;
  if (!ok) failures.push(name);
};

/** Counts dispatcher WebSocket upgrades in the local wrangler log, if provided. */
const dispatcherConnections = (): number | undefined => {
  if (!wranglerLog) return undefined;
  return (readFileSync(wranglerLog, 'utf8').match(/GET \/rpc 101/g) ?? []).length;
};

const summary = (auth?: string, signal?: AbortSignal) => http(SUMMARY, { auth, signal });
const bodyOf = (result: HttpResult) => result.body as Record<string, unknown>;
const codeOf = (result: HttpResult) =>
  (bodyOf(result)?.attributes as { code?: string } | undefined)?.code;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const release = (pkg: BuiltPackage) => releasePackage(packageDir, pkg);

const original = await readRawManifest(packageDir).catch(() => undefined);
const junk: string[] = [];

try {
  // 1. v1 release, unauthenticated, reader, list, no-feature, no-index, unknown app, superuser.
  await release(await buildApp('1.0.0', 'Digest v1'));
  const anonymous = await summary();
  assert('unauthenticatedRejected', [401, 302].includes(anonymous.status), anonymous.status);

  const beforeV1 = dispatcherConnections();
  const v1 = await summary(reader);
  const afterV1 = dispatcherConnections();
  if (wranglerLog) {
    // Positive control for the connection counter used by the "before invocation" checks.
    assert('dispatcherCounterPositiveControl', (afterV1 ?? 0) - (beforeV1 ?? 0) === 1, {
      delta: (afterV1 ?? 0) - (beforeV1 ?? 0),
    });
  }
  assert(
    'readerV1',
    v1.status === 200 &&
      JSON.stringify(v1.body) ===
        JSON.stringify({
          appId: 'alert-digest',
          version: '1.0.0',
          label: 'Digest v1',
          counts: { high: 2, low: 1 },
        }),
    v1.body
  );
  details.readerV1Timing = v1.headers.get('x-app-host-timing');

  const apps = await http(APPS, { auth: reader, headers: INTERNAL });
  const appsText = JSON.stringify(apps.body);
  assert(
    'appsListOneEntry',
    apps.status === 200 &&
      appsText ===
        JSON.stringify({ apps: [{ id: 'alert-digest', title: 'Alert digest', version: '1.0.0' }] }),
    apps.body
  );

  const beforeDenied = dispatcherConnections();
  const featureDenied = await summary(noFeature);
  const afterDenied = dispatcherConnections();
  assert(
    'noFeatureDeniedBeforeInvocation',
    featureDenied.status === 403 &&
      String(bodyOf(featureDenied)?.message).includes('read_app_host') &&
      beforeDenied === afterDenied,
    {
      status: featureDenied.status,
      dispatcherConnectionsDelta: (afterDenied ?? 0) - (beforeDenied ?? 0),
    }
  );
  const featureDeniedApps = await http(APPS, { auth: noFeature, headers: INTERNAL });
  assert('noFeatureDeniedAppsList', featureDeniedApps.status === 403, featureDeniedApps.status);

  const esDenied = await summary(noIndex);
  assert(
    'currentUserEsDenied403',
    esDenied.status === 403 &&
      String(bodyOf(esDenied)?.message).includes('not authorized to read the app data'),
    { status: esDenied.status, message: bodyOf(esDenied)?.message }
  );

  const unknown = await http(`${kibana}/api/apps/other-app/summary`, { auth: reader });
  assert('unknownApp404', unknown.status === 404, unknown.status);

  const asSuperuser = await summary(superuser);
  assert('superuserSummary', asSuperuser.status === 200, asSuperuser.status);

  // 2. External code replacement: v2 with no Kibana restart or dispatcher redeploy.
  await release(await buildApp('1.0.1', 'Digest v2'));
  const v2 = await summary(reader);
  assert(
    'readerV2NoRestart',
    v2.status === 200 &&
      bodyOf(v2).version === '1.0.1' &&
      bodyOf(v2).label === 'Digest v2' &&
      JSON.stringify(bodyOf(v2).counts) === JSON.stringify({ high: 2, low: 1 }),
    v2.body
  );
  const appsV2 = await http(APPS, { auth: reader, headers: INTERNAL });
  assert(
    'appsListV2',
    (appsV2.body as { apps?: Array<{ version: string }> })?.apps?.[0]?.version === '1.0.1'
  );

  // 3. Package failures fail closed before remote execution.
  const good = await buildApp('1.0.2', 'Digest v1');
  const packageCases: Array<[string, () => Promise<void>, string]> = [
    [
      'digestMismatch',
      async () => {
        const fake = await sha256Hex('not the bundle');
        junk.push(`${fake}.js`);
        await writeRawFile(packageDir, `${fake}.js`, good.bundle);
        await writeRawManifest(packageDir, JSON.stringify({ ...good.manifest, digest: fake }));
      },
      'digest_mismatch',
    ],
    [
      'unsupportedHostApi',
      () => writeRawManifest(packageDir, JSON.stringify({ ...good.manifest, hostApi: 2 })),
      'manifest_invalid',
    ],
    [
      'unknownManifestField',
      () => writeRawManifest(packageDir, JSON.stringify({ ...good.manifest, entry: 'x.js' })),
      'manifest_invalid',
    ],
    [
      'wildcardGrant',
      () =>
        writeRawManifest(
          packageDir,
          JSON.stringify({ ...good.manifest, permissions: { indices: ['kbn-apps-*'] } })
        ),
      'manifest_invalid',
    ],
    [
      'oversizedManifest',
      () =>
        writeRawManifest(
          packageDir,
          JSON.stringify({ ...good.manifest, title: 'x'.repeat(17 * 1024) })
        ),
      'manifest_too_large',
    ],
    [
      'oversizedBundle',
      async () => {
        const bundle = `${good.bundle}\n//${'a'.repeat(70 * 1024)}`;
        const digest = await sha256Hex(bundle);
        junk.push(`${digest}.js`);
        await writeRawFile(packageDir, `${digest}.js`, bundle);
        await writeRawManifest(packageDir, JSON.stringify({ ...good.manifest, digest }));
      },
      'bundle_too_large',
    ],
  ];
  for (const [name, mutate, expected] of packageCases) {
    await mutate();
    const before = dispatcherConnections();
    const result = await summary(reader);
    const after = dispatcherConnections();
    assert(
      `package_${name}`,
      result.status === 500 && codeOf(result) === expected && before === after,
      {
        status: result.status,
        code: codeOf(result),
        dispatcherConnectionsDelta: (after ?? 0) - (before ?? 0),
      }
    );
  }

  // 4. Host contract enforced on the remote path, even as superuser.
  await release(await buildVariant('forbidden_index', '9.0.0-forbidden'));
  const forbidden = await summary(superuser);
  assert('forbiddenIndexDeniedAsSuperuser', bodyOf(forbidden)?.label === 'forbidden-index-denied', {
    status: forbidden.status,
    label: bodyOf(forbidden)?.label,
  });

  await release(await buildVariant('unknown_method', '9.0.0-unknown'));
  const unknownMethod = await summary(reader);
  assert('unknownMethodDenied', bodyOf(unknownMethod)?.label === 'unknown-method-denied', {
    status: unknownMethod.status,
    label: bodyOf(unknownMethod)?.label,
  });

  await release(await buildVariant('double_callback', '9.0.0-double'));
  const double = await summary(reader);
  assert(
    'callbackBudgetOne',
    bodyOf(double)?.label === 'second-callback-denied' &&
      JSON.stringify(bodyOf(double)?.counts) === JSON.stringify({ high: 2, low: 1 }),
    double.body
  );

  await release(await buildVariant('bad_output', '9.0.0-bad'));
  const badOutput = await summary(reader);
  assert(
    'invalidAppOutputRejected',
    badOutput.status === 502 && codeOf(badOutput) === 'invalid_app_output',
    { status: badOutput.status, code: codeOf(badOutput) }
  );

  await release(await buildVariant('big_output', '9.0.0-big'));
  const bigOutput = await summary(reader);
  assert('oversizedAppOutputRejected', bigOutput.status === 502, {
    status: bigOutput.status,
    code: codeOf(bigOutput),
  });

  // 5. Deadline (5s) then recovery.
  await release(await buildVariant('slow', '9.0.0-slow8000', { __DELAY_MS__: '8000' }));
  const deadlineStart = performance.now();
  const deadline = await summary(reader);
  const deadlineMs = Math.round(performance.now() - deadlineStart);
  assert('deadline504', deadline.status === 504 && deadlineMs < 6500, {
    status: deadline.status,
    ms: deadlineMs,
  });
  await release(await buildApp('1.0.0', 'Digest v1'));
  const afterDeadline = await summary(reader);
  assert('recoveryAfterDeadline', afterDeadline.status === 200);

  // 6. Concurrency: at most four in flight per Kibana process; excess gets 429.
  await release(await buildVariant('slow', '9.0.0-slow1500', { __DELAY_MS__: '1500' }));
  const burst = await Promise.all(Array.from({ length: 6 }, () => summary(reader)));
  const statuses = burst.map(({ status }) => status);
  assert(
    'concurrencyLimit429',
    statuses.filter((s) => s === 200).length === 4 &&
      statuses.filter((s) => s === 429).length === 2,
    statuses
  );

  // 7. Client abort releases the slot and revokes; later invocations proceed.
  await release(await buildVariant('slow', '9.0.0-slow3000', { __DELAY_MS__: '3000' }));
  const aborts = Array.from({ length: 4 }, () => new AbortController());
  const aborted = aborts.map((controller) =>
    summary(reader, controller.signal).catch(() => undefined)
  );
  await sleep(500);
  aborts.forEach((controller) => controller.abort());
  await Promise.all(aborted);
  await sleep(300);
  await release(await buildApp('1.0.0', 'Digest v1'));
  const afterAbort = await Promise.all(Array.from({ length: 4 }, () => summary(reader)));
  assert(
    'abortReleasesSlots',
    afterAbort.every(({ status }) => status === 200),
    afterAbort.map(({ status }) => status)
  );

  // 8. CPU loop (remote only: OSS workerd does not enforce Dynamic Worker cpuMs).
  if (localWorkerd) {
    results.cpuLoopBounded = 'NOT_ENFORCED_LOCALLY';
    results.cpuLoopRecovery = 'NOT_ENFORCED_LOCALLY';
  } else {
    await release(await buildVariant('loop', '9.0.0-loop'));
    const loopStart = performance.now();
    const loopResult = await summary(reader);
    const loopMs = Math.round(performance.now() - loopStart);
    assert('cpuLoopBounded', [502, 504].includes(loopResult.status) && loopMs < 6500, {
      status: loopResult.status,
      code: codeOf(loopResult),
      ms: loopMs,
    });
    await release(await buildApp('1.0.0', 'Digest v1'));
    const loopRecovery = await summary(reader);
    assert('cpuLoopRecovery', loopRecovery.status === 200);
  }
} finally {
  if (original !== undefined) await writeRawManifest(packageDir, original);
  await Promise.all(junk.map((name) => rm(join(packageDir, name), { force: true })));
}

process.stdout.write(
  `${JSON.stringify(
    {
      mode: localWorkerd ? 'local workerd, not remote acceptance' : 'full',
      kibana,
      rpc,
      results,
      failures,
      details,
    },
    null,
    2
  )}\n`
);
process.exit(failures.length === 0 ? 0 : 1);
