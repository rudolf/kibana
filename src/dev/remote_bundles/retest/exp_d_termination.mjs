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
  makeOomDef,
  makeSpinDef,
  makeTrivialDef,
  runWorkflow,
  spawnBackend,
  startMockEs,
  stats,
} from './common.mjs';

const SUBTEST = process.argv[2] || 'watchdog_matrix'; // oom_probe | watchdog_matrix
const RUNS = Number(process.argv[3] || 3);

/**
 * Main-thread watchdog: polls worker heartbeat (RPC memoryUsage) and, for worker_thread,
 * eventLoopUtilization(). Terminates the worker if heartbeat misses > K ms OR sustained ELU >= 0.98 for K ms.
 */
function startWatchdog(backend, { pollMs = 250, thresholdMs = 2000 } = {}) {
  let stopped = false;
  let lastHeartbeatOk = performance.now();
  let highEluSince = null;
  let prevElu = backend.worker ? backend.worker.performance.eventLoopUtilization() : null;
  let triggeredReason = null;
  let triggerTime = null;

  const promise = (async () => {
    while (!stopped && !backend.isExited()) {
      const now = performance.now();
      // 1. Check worker_thread ELU (non-blocking, works even when JS event loop is frozen)
      if (backend.worker && prevElu) {
        try {
          const cur = backend.worker.performance.eventLoopUtilization(prevElu);
          prevElu = backend.worker.performance.eventLoopUtilization();
          if (cur.utilization >= 0.98) {
            if (highEluSince === null) highEluSince = now;
            if (now - highEluSince >= thresholdMs) {
              triggeredReason = `sustained_elu_${cur.utilization.toFixed(2)}_for_${Math.round(now - highEluSince)}ms`;
              triggerTime = performance.now();
              await backend.kill();
              return { triggeredReason, terminateMs: +(performance.now() - triggerTime).toFixed(1) };
            }
          } else {
            highEluSince = null;
          }
        } catch {}
      }

      // 2. Heartbeat ping over RPC (short timeout)
      try {
        const pong = await Promise.race([
          backend.stub.memoryUsage().then(() => true),
          delay(pollMs).then(() => false),
        ]);
        if (pong) {
          lastHeartbeatOk = performance.now();
        } else if (performance.now() - lastHeartbeatOk >= thresholdMs) {
          triggeredReason = `heartbeat_timeout_${Math.round(performance.now() - lastHeartbeatOk)}ms`;
          triggerTime = performance.now();
          await backend.kill();
          return { triggeredReason, terminateMs: +(performance.now() - triggerTime).toFixed(1) };
        }
      } catch {
        // Worker likely exited naturally (e.g. OOM)
        return { triggeredReason: 'natural_exit', terminateMs: 0 };
      }

      await delay(pollMs);
    }
    return { triggeredReason: 'natural_exit', terminateMs: 0 };
  })();

  return {
    stop: () => {
      stopped = true;
    },
    promise,
  };
}

async function probeOomReliability() {
  const { server: esServer, url: esUrl } = await startMockEs();
  const executions = new Map();
  const stepsMap = new Map();
  const { coordinator } = makeCoordinator(executions, stepsMap);

  const cases = [
    { label: 'wt_arrays_cap64_y2', mode: 'worker_thread', oomMode: 'arrays', capMb: 64, youngMb: 2 },
    { label: 'wt_strings_cap64_y2', mode: 'worker_thread', oomMode: 'strings', capMb: 64, youngMb: 2 },
    { label: 'wt_objects_cap64_y2', mode: 'worker_thread', oomMode: 'objects', capMb: 64, youngMb: 2 },
    { label: 'wt_strings_cap64_y16', mode: 'worker_thread', oomMode: 'strings', capMb: 64, youngMb: 16 },
    { label: 'cp_strings_cap64', mode: 'child_process', oomMode: 'strings', capMb: 64 },
    { label: 'cp_objects_cap64', mode: 'child_process', oomMode: 'objects', capMb: 64 },
  ];

  const results = [];
  for (const c of cases) {
    const backend = await spawnBackend({
      mode: c.mode,
      bundleDir: DEFAULT_BUNDLE_DIR,
      coordinator,
      workerFlags: c.mode === 'child_process' ? [`--max-old-space-size=${c.capMb}`] : [],
      resourceLimits:
        c.mode === 'worker_thread'
          ? { maxOldGenerationSizeMb: c.capMb, maxYoungGenerationSizeMb: c.youngMb }
          : undefined,
    });
    const t0 = performance.now();
    let outcome = 'stalled_timeout';
    try {
      const r = await Promise.race([
        runWorkflow(backend.stub, executions, stepsMap, esUrl, makeOomDef(220, c.oomMode, 256), `probe-${c.label}`),
        delay(12_000).then(() => ({ status: 'stalled_timeout' })),
      ]);
      outcome = r.status;
    } catch (err) {
      outcome = `rejected:${err.message.slice(0, 60)}`;
    }
    const wallMs = +(performance.now() - t0).toFixed(1);
    const exit = backend.getExit();
    await backend.cleanup();
    results.push({ ...c, outcome, wallMs, exitedNaturally: exit.exitCode !== null || exit.exitSignal !== null, exit });
  }
  esServer.close();
  return results;
}

async function runWatchdogCase({ mode, fault, thresholdMs = 2000, iter }) {
  const { server: esServer, url: esUrl } = await startMockEs();
  const executions = new Map();
  const stepsMap = new Map();
  const { coordinator } = makeCoordinator(executions, stepsMap);

  const backend = await spawnBackend({
    mode,
    bundleDir: DEFAULT_BUNDLE_DIR,
    coordinator,
    workerFlags: mode === 'child_process' && fault === 'oom_gc_stall' ? ['--max-old-space-size=64'] : [],
    resourceLimits:
      mode === 'worker_thread' && fault === 'oom_gc_stall'
        ? { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 2 }
        : undefined,
  });

  // Warmup
  await runWorkflow(backend.stub, executions, stepsMap, esUrl, makeTrivialDef(), `wd-warm-${iter}`);

  const wd = startWatchdog(backend, { pollMs: 250, thresholdMs });
  const tFault = performance.now();
  const wfDef =
    fault === 'oom_gc_stall'
      ? {
          version: '1',
          name: 'test-gc-stall',
          enabled: true,
          triggers: [{ type: 'manual' }],
          steps: [{ name: 'stall', type: 'test.bench', with: { op: 'gc_stall', targetMb: 38, durationMs: 20_000 } }],
        }
      : makeSpinDef(30_000);

  let inFlightStatus = 'unknown';
  try {
    const r = await runWorkflow(backend.stub, executions, stepsMap, esUrl, wfDef, `wd-fault-${iter}`);
    inFlightStatus = r.status;
  } catch (err) {
    inFlightStatus = `aborted:${err.message.slice(0, 50)}`;
  }
  const timeToTerminateMs = +(performance.now() - tFault).toFixed(1);
  wd.stop();
  const wdInfo = await wd.promise;
  await backend.cleanup();

  // Recovery: spawn fresh worker and run a trivial workflow
  const tRec = performance.now();
  const fresh = await spawnBackend({
    mode,
    bundleDir: DEFAULT_BUNDLE_DIR,
    coordinator,
  });
  const recRes = await runWorkflow(fresh.stub, executions, stepsMap, esUrl, makeTrivialDef(), `wd-rec-${iter}`);
  const recoveryMs = +(performance.now() - tRec).toFixed(1);
  await fresh.cleanup();
  esServer.close();

  return {
    iter,
    mode,
    fault,
    mainSurvived: true,
    inFlightStatus,
    watchdogReason: wdInfo.triggeredReason,
    killLatencyMs: wdInfo.terminateMs,
    timeToTerminateMs,
    recoveryStatus: recRes.status,
    recoveryMs,
  };
}

async function main() {
  if (SUBTEST === 'oom_probe') {
    const probe = await probeOomReliability();
    console.log(JSON.stringify({ experiment: 'D1_oom_probe', results: probe }, null, 2));
    return;
  }

  const matrix = [
    { mode: 'worker_thread', fault: 'oom_gc_stall' },
    { mode: 'worker_thread', fault: 'sync_spin' },
    { mode: 'child_process', fault: 'oom_gc_stall' },
    { mode: 'child_process', fault: 'sync_spin' },
  ];

  const out = {};
  for (const m of matrix) {
    const key = `${m.mode}:${m.fault}`;
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      runs.push(await runWatchdogCase({ ...m, thresholdMs: 2000, iter: i }));
    }
    out[key] = {
      summary: {
        mainSurvivedAll: runs.every((r) => r.mainSurvived),
        recoveredAll: runs.every((r) => r.recoveryStatus === 'completed'),
        reasons: runs.map((r) => r.watchdogReason),
        timeToTerminateMs: stats(runs.map((r) => r.timeToTerminateMs)),
        killLatencyMs: stats(runs.map((r) => r.killLatencyMs)),
        recoveryMs: stats(runs.map((r) => r.recoveryMs)),
      },
      raw: runs,
    };
  }
  console.log(JSON.stringify({ experiment: 'D2_watchdog', thresholdMs: 2000, runs: RUNS, results: out }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
