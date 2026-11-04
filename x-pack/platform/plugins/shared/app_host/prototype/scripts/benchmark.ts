/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Fresh-invocation latency sample. Every sample is a new HTTP request, WebSocket, authentication and
// Dynamic Worker `load()`; nothing is warmed or cached on purpose. These are not cold-isolate,
// warm-cache or scale-to-zero measurements.
// Usage: npm run benchmark -- --kibana http://localhost:5601 --rpc URL [--samples 20]
//          [--local-workerd] [--note TEXT]
//
// --rpc is the dispatcher Kibana is expected to use. Every Kibana sample must carry the matching
// host-owned dispatcher fingerprint in `x-app-host-timing`; local versus remote is derived from
// that evidence. Remote mode needs a non-loopback wss:// URL; --local-workerd needs a loopback URL.
// --note is free text for the report only; it never affects classification or the decision.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from './lib/args';
import { buildFixture } from './lib/build';
import { invokeOnce } from './lib/client';
import {
  TIMING_HEADER,
  parseTimingHeader,
  requestedTarget,
  verifyDispatcher,
  type DispatcherVerification,
  type RequestedTarget,
} from './lib/dispatcher_target';
import { http, userAuth } from './lib/http';
import { latencyDecision } from './lib/latency_decision';
import { LOCAL_DIR, readCallerToken, readUsers } from './lib/secrets';

const args = parseArgs(
  process.argv.slice(2),
  ['kibana', 'samples', 'rpc', 'note', 'local-workerd'],
  ['local-workerd']
);
const kibana = (args.kibana ?? process.env.KB_URL ?? '').replace(/\/$/, '');
if (!kibana) throw new Error('--kibana is required');
const samples = Number(args.samples ?? 20);
if (!Number.isInteger(samples) || samples < 1 || samples > 200) {
  throw new Error(
    '--samples must be an integer 1-200 (approved remote budget is <=200 invocations)'
  );
}
let target: RequestedTarget;
try {
  target = requestedTarget(args.rpc ?? process.env.CF_RPC_URL, args['local-workerd'] === 'true');
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: (error as Error).message }, null, 2)}\n`);
  process.exit(2);
}
const reader = userAuth(readUsers().reader);

const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, index)] * 10) / 10;
};
const stats = (values: number[]) => ({
  n: values.length,
  p50: percentile(values, 50),
  p95: percentile(values, 95),
  max: percentile(values, 100),
});

const endToEnd: number[] = [];
const phases: Record<string, number[]> = {};
const statuses: Record<string, number> = {};
const bytes = {
  req: [] as number[],
  res: [] as number[],
  cbReq: [] as number[],
  cbRes: [] as number[],
};
const callbacks: number[] = [];
let exceptions = 0;

const invalid: Record<string, number> = {};
const markInvalid = (reason: string) => {
  invalid[reason] = (invalid[reason] ?? 0) + 1;
};
let firstVerification: DispatcherVerification | undefined;
let mismatches = 0;
let verifiedResponses = 0;
let validSamples = 0;
let attempted = 0;

for (let i = 0; i < samples; i++) {
  attempted += 1;
  try {
    const result = await http(`${kibana}/api/apps/alert-digest/summary`, { auth: reader });
    statuses[result.status] = (statuses[result.status] ?? 0) + 1;
    const header = result.headers.get(TIMING_HEADER);
    const verification = verifyDispatcher(target, header);
    if (verification.observed === null && result.status !== 200) {
      // Failed before reaching the dispatcher (e.g. 429/500): no target evidence either way.
      markInvalid(`status ${result.status} (no dispatcher evidence)`);
      continue;
    }
    firstVerification ??= verification;
    if (!verification.verified) {
      mismatches += 1;
      markInvalid(`dispatcher not verified: ${verification.reason}`);
      // Do not spend further (possibly remote) invocations against an unverified target.
      break;
    }
    verifiedResponses += 1;
    if (result.status !== 200) {
      markInvalid(`status ${result.status}`);
      continue;
    }
    const { durations, descriptions } = parseTimingHeader(header);
    const callbackCount = Number(descriptions.callbacks ?? NaN);
    if (!Number.isFinite(durations.total) || callbackCount !== 1) {
      markInvalid('invalid timing evidence');
      continue;
    }
    validSamples += 1;
    endToEnd.push(result.ms);
    for (const [name, value] of Object.entries(durations)) (phases[name] ??= []).push(value);
    callbacks.push(callbackCount);
    const logical = Object.fromEntries(
      (descriptions.logical_bytes ?? '')
        .split(',')
        .map((pair) => pair.split('=') as [string, string])
    );
    bytes.req.push(Number(logical.req));
    bytes.res.push(Number(logical.res));
    bytes.cbReq.push(Number(logical.cb_req));
    bytes.cbRes.push(Number(logical.cb_res));
  } catch {
    exceptions += 1;
  }
}
const verified = mismatches === 0 && verifiedResponses > 0;
const verifiedMode = verified ? firstVerification?.observedMode ?? null : null;
const failedSamples = samples - validSamples;

// Direct seam sample against the same verified endpoint (Node -> dispatcher -> Dynamic Worker ->
// Node callback), no Kibana/ES. Skipped when the Kibana target was not verified.
let seam: Record<string, unknown> | undefined;
let seamValid = 0;
const seamRequested = verified ? samples : 0;
if (verified) {
  const token = readCallerToken();
  const pkg = await buildFixture('adder');
  const connectAuth: number[] = [];
  const invoke: number[] = [];
  const total: number[] = [];
  let failed = 0;
  for (let i = 0; i < samples; i++) {
    const outcome = await invokeOnce({
      url: target.url,
      token,
      pkg,
      handler: async () => ({ total: 41, records: [] }),
    });
    if (!outcome.ok || outcome.value !== 42) {
      failed += 1;
      continue;
    }
    seamValid += 1;
    connectAuth.push(outcome.timing.connectAuthMs);
    invoke.push(outcome.timing.invokeMs);
    total.push(outcome.timing.totalMs);
  }
  seam = {
    connectAndAuthMs: stats(connectAuth),
    invokeIncludingLoadAndCallbackMs: stats(invoke),
    totalMs: stats(total),
    requested: samples,
    valid: seamValid,
    failed,
  };
}

const freshInvocations = attempted + seamRequested;
const p95 = percentile(endToEnd, 95);
const environment =
  verifiedMode === 'remote'
    ? 'remote dispatcher (verified wss:// fingerprint)'
    : verifiedMode === 'local'
    ? 'local workerd (verified loopback fingerprint), not remote acceptance'
    : 'UNVERIFIED dispatcher target';
const report = {
  environment,
  note: args.note,
  dispatcher: {
    requested: target.url,
    requestedMode: target.mode,
    expected: target.expected,
    observed: firstVerification?.observed ?? null,
    verified,
    verifiedResponses,
    mismatches,
    reason: firstVerification?.verified ? undefined : firstVerification?.reason,
  },
  measurement: 'fresh-invocation (new HTTP request, WebSocket, auth and LOADER.load per sample)',
  samples,
  attempted,
  validSamples,
  failedSamples,
  invalid,
  statuses,
  exceptions,
  kibanaEndToEndMs: stats(endToEnd),
  hostPhasesMs: Object.fromEntries(Object.entries(phases).map(([name, v]) => [name, stats(v)])),
  callbacksPerInvocation: stats(callbacks),
  logicalJsonBytesPerInvocation: {
    note: 'JSON payload sizes measured in Kibana; not wire bytes (no framing, TLS or capnweb overhead)',
    invokeRequest: stats(bytes.req),
    appResult: stats(bytes.res),
    callbackRequest: stats(bytes.cbReq),
    callbackResponse: stats(bytes.cbRes),
  },
  seamDirect: seam,
  cpu: {
    measured: false,
    note: 'Dynamic Worker CPU is unmeasured here (no account telemetry). Configured cap: 50 CPU-ms per app Worker.',
    upperBoundCpuMsForRun: freshInvocations * 50,
  },
  pricingEstimate: {
    note: 'Published Dynamic Workers pricing (creation billing since 2026-05-26); estimate, not a bill',
    freshDynamicWorkersCreatedThisRun: freshInvocations,
    creationUsdPer1000FreshInvocationsBeforeAllowances: 2.0,
    creationUsdThisRunBeforeAllowances: Math.round(freshInvocations * 0.002 * 1000) / 1000,
    includedCreationsPerMonth: 1000,
    cpuUsdUpperBoundThisRun: (freshInvocations * 50 * 0.02) / 1_000_000,
    requestUsdThisRun: (freshInvocations * 2 * 0.3) / 1_000_000,
  },
  decision: {
    threshold:
      'p95 end-to-end <= 2000 ms for the tiny synthetic summary (prototype threshold, not an SLO)',
    latency: latencyDecision({
      verifiedMode,
      requestedSamples: samples,
      validSamples,
      failedSamples,
      seamRequestedSamples: samples,
      seamValidSamples: seamValid,
      p95,
    }),
    remoteAcceptance:
      verifiedMode === 'remote'
        ? 'see acceptance output'
        : 'BLOCKED: no verified remote dispatcher; remote Cloudflare acceptance not run',
    production: 'NOT EVALUATED',
  },
};

mkdirSync(LOCAL_DIR, { recursive: true });
const file = resolve(LOCAL_DIR, `benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...report, savedTo: file }, null, 2)}\n`);
process.exit(verified && failedSamples === 0 && seamValid === samples ? 0 : 1);
