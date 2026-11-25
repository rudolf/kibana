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
  runWorkflow,
  spawnBackend,
  startMockEs,
  stats,
} from './common.mjs';

const MODE = process.argv[2] || 'in_process'; // in_process | worker_thread | child_process
const PROFILE = process.argv[3] || 'default'; // default | sweet
const WARM_RUNS = Number(process.argv[4] || 5);

async function main() {
  const { server: esServer, url: esUrl } = await startMockEs({ alertCount: 50, esqlRows: 1 });
  const executions = new Map();
  const stepsMap = new Map();
  const { coordinator, timing, resetTiming } = makeCoordinator(executions, stepsMap, { trackTimings: true });

  const workerFlags =
    MODE === 'child_process' && PROFILE === 'sweet'
      ? ['--max-semi-space-size=4', '--optimize-for-size']
      : [];
  const workerEnv =
    MODE === 'child_process' && PROFILE === 'sweet'
      ? { MALLOC_CONF: 'narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0' }
      : {};
  const resourceLimits =
    MODE === 'worker_thread' && PROFILE === 'sweet'
      ? { maxYoungGenerationSizeMb: 4 }
      : undefined;

  const backend = await spawnBackend({
    mode: MODE,
    bundleDir: DEFAULT_BUNDLE_DIR,
    coordinator,
    workerFlags,
    workerEnv,
    resourceLimits,
  });

  const wfDef = makeScenarioADef();

  // 1 cold warmup run (populates lazy chunks & JIT)
  const cold = await runWorkflow(backend.stub, executions, stepsMap, esUrl, wfDef, 'f-cold');
  await delay(100);

  const warm = [];
  for (let i = 0; i < WARM_RUNS; i++) {
    resetTiming();
    const res = await runWorkflow(backend.stub, executions, stepsMap, esUrl, wfDef, `f-warm-${i}`);
    const rpcHandlerMs = +timing.rpcMs.toFixed(2);
    // Engine time approximated as wallMs minus coordinator-side RPC handler time (includes worker-side serialization/IPC)
    const enginePlusTransportMs = +(res.wallMs - rpcHandlerMs).toFixed(2);
    warm.push({
      iter: i,
      status: res.status,
      stepCount: res.stepCount,
      wallMs: res.wallMs,
      rpcCalls: timing.rpcCalls,
      coordinatorRpcMs: rpcHandlerMs,
      enginePlusTransportMs,
    });
  }

  await backend.cleanup();
  esServer.close();

  console.log(
    JSON.stringify(
      {
        experiment: 'F_overhead',
        mode: MODE,
        profile: PROFILE,
        warmRuns: WARM_RUNS,
        spawnReadyMs: backend.spawnReadyMs,
        coldWallMs: cold.wallMs,
        summary: {
          wallMs: stats(warm.map((r) => r.wallMs)),
          coordinatorRpcMs: stats(warm.map((r) => r.coordinatorRpcMs)),
          enginePlusTransportMs: stats(warm.map((r) => r.enginePlusTransportMs)),
          rpcCallsPerRun: warm[0]?.rpcCalls ?? 0,
          stepCount: warm[0]?.stepCount ?? 0,
        },
        raw: warm,
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
