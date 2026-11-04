/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Fresh-invocation latency sample. Every sample is a new HTTP request, WebSocket, authentication and
// Dynamic Worker `load()`; nothing is warmed or cached on purpose. These are not cold-isolate,
// warm-cache or scale-to-zero measurements.
// Usage: npm run benchmark -- --kibana http://localhost:5601 [--samples 20] [--rpc URL] [--label TEXT]

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from './lib/args';
import { buildFixture } from './lib/build';
import { invokeOnce } from './lib/client';
import { http, userAuth } from './lib/http';
import { LOCAL_DIR, readCallerToken, readUsers } from './lib/secrets';

const args = parseArgs(process.argv.slice(2), ['kibana', 'samples', 'rpc', 'label']);
const kibana = (args.kibana ?? process.env.KB_URL ?? '').replace(/\/$/, '');
if (!kibana) throw new Error('--kibana is required');
const samples = Number(args.samples ?? 20);
if (!Number.isInteger(samples) || samples < 1 || samples > 200) {
  throw new Error(
    '--samples must be an integer 1-200 (approved remote budget is <=200 invocations)'
  );
}
const rpc = args.rpc;
const environment =
  args.label ??
  (rpc && !rpc.startsWith('wss://')
    ? 'local workerd, not remote acceptance'
    : 'unspecified (pass --label)');
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

/** Parses `name;dur=1.0` and `name;desc="a=1,b=2"` entries of the host-owned timing header. */
const parseTiming = (header: string | null) => {
  const durations: Record<string, number> = {};
  const descriptions: Record<string, string> = {};
  for (const entry of (header ?? '').split(/,\s*(?=[a-z_]+;)/)) {
    const [name, ...params] = entry.split(';');
    for (const param of params) {
      const separator = param.indexOf('=');
      const key = param.slice(0, separator);
      const raw = param.slice(separator + 1);
      if (key === 'dur') durations[name] = Number(raw);
      if (key === 'desc') descriptions[name] = raw.replace(/^"|"$/g, '');
    }
  }
  return { durations, descriptions };
};

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

for (let i = 0; i < samples; i++) {
  try {
    const result = await http(`${kibana}/api/apps/alert-digest/summary`, { auth: reader });
    statuses[result.status] = (statuses[result.status] ?? 0) + 1;
    if (result.status !== 200) continue;
    endToEnd.push(result.ms);
    const { durations, descriptions } = parseTiming(result.headers.get('x-app-host-timing'));
    for (const [name, value] of Object.entries(durations)) (phases[name] ??= []).push(value);
    callbacks.push(Number(descriptions.callbacks ?? NaN));
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

// Optional direct seam sample (Node -> dispatcher -> Dynamic Worker -> Node callback), no Kibana/ES.
let seam: Record<string, unknown> | undefined;
if (rpc) {
  const token = readCallerToken();
  const pkg = await buildFixture('adder');
  const connectAuth: number[] = [];
  const invoke: number[] = [];
  const total: number[] = [];
  let failed = 0;
  for (let i = 0; i < samples; i++) {
    const outcome = await invokeOnce({
      url: rpc,
      token,
      pkg,
      handler: async () => ({ total: 41, records: [] }),
    });
    if (!outcome.ok || outcome.value !== 42) {
      failed += 1;
      continue;
    }
    connectAuth.push(outcome.timing.connectAuthMs);
    invoke.push(outcome.timing.invokeMs);
    total.push(outcome.timing.totalMs);
  }
  seam = {
    connectAndAuthMs: stats(connectAuth),
    invokeIncludingLoadAndCallbackMs: stats(invoke),
    totalMs: stats(total),
    failed,
  };
}

const isLocal = environment.startsWith('local');
const latencyDecision = (value: number | null): string => {
  if (value === null) return 'NO DATA';
  if (isLocal)
    return `NO DECISION: local workerd p95 ${value} ms says nothing about the remote topology`;
  if (value <= 2000) return 'GO (latency)';
  return 'NO-GO for the chosen topology pending investigation';
};

const freshInvocations = samples + (rpc ? samples : 0);
const p95 = percentile(endToEnd, 95);
const report = {
  environment,
  measurement: 'fresh-invocation (new HTTP request, WebSocket, auth and LOADER.load per sample)',
  samples,
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
    latency: latencyDecision(p95),
    remoteAcceptance: isLocal
      ? 'BLOCKED: local workerd only; remote Cloudflare acceptance not run'
      : 'see acceptance output',
    production: 'NOT EVALUATED',
  },
};

mkdirSync(LOCAL_DIR, { recursive: true });
const file = resolve(LOCAL_DIR, `benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...report, savedTo: file }, null, 2)}\n`);
