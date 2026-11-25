/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { setTimeout as delay } from 'node:timers/promises';
import {
  DEFAULT_BUNDLE_DIR,
  makeAllocDef,
  makeCoordinator,
  makeScenarioADef,
  readSmaps,
  runWorkflow,
  spawnBackend,
  startMockEs,
  stats,
} from './common.mjs';

const MODE = process.argv[2] || 'child_process'; // worker_thread | child_process
const PROFILE = process.argv[3] || 'default'; // default | sweet
const VARIANT = process.argv[4] || 'large_es'; // large_es | alloc_50mb | large_es_capped | alloc_50mb_capped
const RUNS = Number(process.argv[5] || 3);

function profileConfig(mode, profile, capped) {
  const capMb = capped ? 96 : undefined;
  if (mode === 'child_process') {
    const workerFlags = [];
    const workerEnv = {};
    if (profile === 'sweet') {
      workerFlags.push('--max-semi-space-size=4', '--optimize-for-size');
      workerEnv.MALLOC_CONF = 'narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0';
    }
    if (capMb) workerFlags.push(`--max-old-space-size=${capMb}`);
    return { workerFlags, workerEnv, resourceLimits: undefined };
  }
  const resourceLimits = {};
  if (profile === 'sweet') resourceLimits.maxYoungGenerationSizeMb = 4;
  if (capMb) resourceLimits.maxOldGenerationSizeMb = capMb;
  return {
    workerFlags: [],
    workerEnv: {},
    resourceLimits: Object.keys(resourceLimits).length ? resourceLimits : undefined,
  };
}

async function runOnce(iter) {
  const isLargeEs = VARIANT.startsWith('large_es');
  const isCapped = VARIANT.endsWith('_capped');
  const { server: esServer, url: esUrl, payloadBytes } = await startMockEs(
    isLargeEs ? { alertCount: 10_000, esqlRows: 10_000 } : { alertCount: 50, esqlRows: 1 }
  );
  const executions = new Map();
  const stepsMap = new Map();
  const { coordinator } = makeCoordinator(executions, stepsMap);

  global.gc?.();
  global.gc?.();
  const hostBefore = readSmaps(process.pid);

  const cfg = profileConfig(MODE, PROFILE, isCapped);
  const backend = await spawnBackend({
    mode: MODE,
    bundleDir: DEFAULT_BUNDLE_DIR,
    coordinator,
    ...cfg,
  });

  const sampleMem = async () => {
    const smaps = readSmaps(backend.pid);
    let heapUsed = null;
    try {
      const m = await Promise.race([backend.stub.memoryUsage(), delay(500).then(() => null)]);
      if (m?.usage) heapUsed = +(m.usage.heapUsed / 1048576).toFixed(1);
    } catch {}
    return {
      anon: MODE === 'worker_thread' ? +((smaps?.anon ?? 0) - (hostBefore?.anon ?? 0)).toFixed(1) : (smaps?.anon ?? 0),
      rss: MODE === 'worker_thread' ? +((smaps?.rss ?? 0) - (hostBefore?.rss ?? 0)).toFixed(1) : (smaps?.rss ?? 0),
      heapUsed,
    };
  };

  const idle = await sampleMem();

  // Poll peak Anon during execution every 25 ms
  let peakAnon = idle.anon;
  let peakRss = idle.rss;
  let peakHeap = idle.heapUsed ?? 0;
  let polling = true;
  const pollLoop = (async () => {
    while (polling) {
      const smaps = readSmaps(backend.pid);
      if (smaps) {
        const curAnon = MODE === 'worker_thread' ? +(smaps.anon - hostBefore.anon).toFixed(1) : smaps.anon;
        const curRss = MODE === 'worker_thread' ? +(smaps.rss - hostBefore.rss).toFixed(1) : smaps.rss;
        if (curAnon > peakAnon) peakAnon = curAnon;
        if (curRss > peakRss) peakRss = curRss;
      }
      await delay(25);
    }
  })();

  const wfDef = isLargeEs
    ? makeScenarioADef({ alertSize: 10_000, foreachLimit: 50 })
    : makeAllocDef(50, 300);

  let outcome = { status: 'unknown', wallMs: 0 };
  let contained = true;
  try {
    outcome = await Promise.race([
      runWorkflow(backend.stub, executions, stepsMap, esUrl, wfDef, `exp-a-${iter}`),
      delay(30_000).then(() => ({ status: 'timeout', wallMs: 30_000 })),
    ]);
    if (outcome.status === 'timeout') contained = false;
  } catch (err) {
    outcome = { status: 'worker_error', error: err.message, wallMs: 0 };
    contained = backend.isExited?.() ?? false;
  }

  polling = false;
  await pollLoop;

  // Extract peakHeapMb reported by test.bench alloc step if available
  const allocStep = [...stepsMap.values()].find((s) => s.stepType === 'test.bench');
  if (allocStep?.output?.peakHeapMb && allocStep.output.peakHeapMb > peakHeap) {
    peakHeap = allocStep.output.peakHeapMb;
  }

  let settled = null;
  if (!backend.isExited?.() && outcome.status !== 'timeout') {
    await delay(1500);
    global.gc?.();
    global.gc?.();
    settled = await sampleMem();
    if (settled.heapUsed && settled.heapUsed > peakHeap) peakHeap = settled.heapUsed;
  }

  const exitInfo = backend.getExit?.() ?? null;
  await backend.cleanup();
  esServer.close();

  return {
    iter,
    status: outcome.status,
    wallMs: outcome.wallMs,
    contained,
    exitInfo,
    payloadBytes: isLargeEs ? payloadBytes : undefined,
    idle,
    peak: { anon: peakAnon, rss: peakRss, heapUsed: peakHeap },
    settled,
  };
}

async function main() {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    runs.push(await runOnce(i));
  }
  console.log(
    JSON.stringify(
      {
        experiment: 'A_large_data',
        mode: MODE,
        profile: PROFILE,
        variant: VARIANT,
        runs: RUNS,
        summary: {
          statuses: runs.map((r) => r.status),
          containedAll: runs.every((r) => r.contained),
          wallMs: stats(runs.map((r) => r.wallMs)),
          idleAnonMiB: stats(runs.map((r) => r.idle.anon)),
          peakAnonMiB: stats(runs.map((r) => r.peak.anon)),
          settledAnonMiB: stats(runs.map((r) => r.settled?.anon)),
          idleHeapMiB: stats(runs.map((r) => r.idle.heapUsed)),
          peakHeapMiB: stats(runs.map((r) => r.peak.heapUsed)),
          settledHeapMiB: stats(runs.map((r) => r.settled?.heapUsed)),
        },
        raw: runs,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
