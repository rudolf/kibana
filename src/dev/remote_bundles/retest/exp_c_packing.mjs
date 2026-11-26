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
  makeCoordinator,
  makeScenarioADef,
  makeSpinDef,
  readSmaps,
  runWorkflow,
  spawnBackend,
  startMockEs,
  stats,
} from './common.mjs';

const MODE = process.argv[2] || 'worker_thread'; // worker_thread | child_process
const PROFILE = process.argv[3] || 'default'; // default | sweet
const SUBTEST = process.argv[4] || 'pack_5'; // pack_1 | pack_5 | pack_10 | sep_5 | sep_10 | noisy_shared | noisy_sep
const RUNS = Number(process.argv[5] || 3);

function profileCfg(mode, profile) {
  const baseEnv = { KBN_REMOTE_ALLOW_CONCURRENT_LEASES: '1' };
  if (mode === 'child_process') {
    return profile === 'sweet'
      ? {
          workerFlags: ['--max-semi-space-size=4', '--optimize-for-size'],
          workerEnv: { ...baseEnv, MALLOC_CONF: 'narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0' },
        }
      : { workerFlags: [], workerEnv: baseEnv };
  }
  return profile === 'sweet'
    ? { workerEnv: baseEnv, resourceLimits: { maxYoungGenerationSizeMb: 4 } }
    : { workerEnv: baseEnv };
}

async function runOneIter(iter) {
  const { server: esServer, url: esUrl } = await startMockEs({ alertCount: 50, esqlRows: 1 });
  const executions = new Map();
  const stepsMap = new Map();
  const { coordinator } = makeCoordinator(executions, stepsMap);

  global.gc?.();
  global.gc?.();
  const hostBefore = readSmaps(process.pid);

  const isShared = SUBTEST.startsWith('pack_') || SUBTEST === 'noisy_shared';
  const isNoisy = SUBTEST.startsWith('noisy_');
  const normalCount = isNoisy ? 5 : Number(SUBTEST.split('_')[1]);
  const workerCount = isShared ? 1 : normalCount + (isNoisy ? 1 : 0);

  const cfg = profileCfg(MODE, PROFILE);
  const workers = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      await spawnBackend({
        mode: MODE,
        bundleDir: DEFAULT_BUNDLE_DIR,
        coordinator,
        ...cfg,
      })
    );
  }

  const measureTotalAnon = () => {
    if (MODE === 'child_process') {
      let sum = 0;
      for (const w of workers) sum += readSmaps(w.pid)?.anon ?? 0;
      return +sum.toFixed(1);
    }
    const cur = readSmaps(process.pid)?.anon ?? 0;
    return +(cur - hostBefore.anon).toFixed(1);
  };

  const wfNormal = makeScenarioADef();
  const wfSpin = makeSpinDef(5_000); // 5s busy loop keeps n=3 runs fast while clearly demonstrating head-of-line blocking

  // Warmup all workers with 1 normal run? No — measure steady-state after 1 warmup if not noisy, or direct batch
  const tasks = [];
  if (isNoisy) {
    // Launch the pathological spin first (by 20ms) so it occupies the shared worker
    const spinWorker = isShared ? workers[0] : workers[normalCount];
    tasks.push(
      runWorkflow(spinWorker.stub, executions, stepsMap, esUrl, wfSpin, `c-${iter}-spin`).then((r) => ({
        kind: 'spin',
        ...r,
      }))
    );
    await delay(20);
  }
  for (let i = 0; i < normalCount; i++) {
    const w = isShared ? workers[0] : workers[i];
    tasks.push(
      runWorkflow(w.stub, executions, stepsMap, esUrl, wfNormal, `c-${iter}-n${i}`).then((r) => ({
        kind: 'normal',
        ...r,
      }))
    );
  }

  let peakAnon = measureTotalAnon();
  let polling = true;
  const poll = (async () => {
    while (polling) {
      const a = measureTotalAnon();
      if (a > peakAnon) peakAnon = a;
      await delay(30);
    }
  })();

  const results = await Promise.all(tasks);
  polling = false;
  await poll;

  await delay(1000);
  global.gc?.();
  global.gc?.();
  const settledAnon = measureTotalAnon();

  for (const w of workers) await w.cleanup();
  esServer.close();

  const normalLatencies = results.filter((r) => r.kind === 'normal').map((r) => r.wallMs);
  const spinResult = results.find((r) => r.kind === 'spin');
  return {
    iter,
    workerCount,
    normalCount,
    peakAnonMiB: peakAnon,
    settledAnonMiB: settledAnon,
    normalMedianMs: stats(normalLatencies).median,
    normalMaxMs: stats(normalLatencies).max,
    spinWallMs: spinResult?.wallMs ?? null,
    allCompleted: results.every((r) => r.status === 'completed'),
  };
}

async function main() {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    runs.push(await runOneIter(i));
  }
  console.log(
    JSON.stringify(
      {
        experiment: 'C_packing',
        mode: MODE,
        profile: PROFILE,
        subtest: SUBTEST,
        runs: RUNS,
        summary: {
          allCompleted: runs.every((r) => r.allCompleted),
          peakAnonMiB: stats(runs.map((r) => r.peakAnonMiB)),
          settledAnonMiB: stats(runs.map((r) => r.settledAnonMiB)),
          normalMedianMs: stats(runs.map((r) => r.normalMedianMs)),
          normalMaxMs: stats(runs.map((r) => r.normalMaxMs)),
          spinWallMs: stats(runs.map((r) => r.spinWallMs)),
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
