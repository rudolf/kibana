/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * Experiment H: 10 parallel Scenario A workflows across 5 execution topologies:
 *   1. in_process_1      (10 parallel workflows on main thread)
 *   2. worker_thread_1   (10 parallel workflows in 1 shared worker_thread)
 *   3. child_process_1   (10 parallel workflows in 1 shared child_process)
 *   4. worker_thread_10  (10 parallel workflows across 10 worker_threads)
 *   5. child_process_10  (10 parallel workflows across 10 child_processes)
 *
 * Measures:
 *   - Spawn time to ready (1 vs 10 workers)
 *   - Cold batch wall time + warm batch wall time (n=5)
 *   - Per-workflow latency (median & max)
 *   - Memory: peak & settled Anon and RSS (worker-only for child_process;
 *     ΔAnon/ΔRSS above pre-spawn host baseline for worker_thread & in_process)
 *   - Main responsiveness during the 10-parallel batch: /login HTTP p99/max
 *     (via independent HTTP load-generator Worker) & main EL delay p99/max
 *
 * Usage:
 *   node exp_h_parallel10.mjs <topology> <default|sweet> [warmBatches=5]
 */

import { createServer } from 'node:http';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DEFAULT_BUNDLE_DIR,
  makeCoordinator,
  makeScenarioADef,
  percentile,
  readSmaps,
  runWorkflow,
  spawnBackend,
  startMockEs,
  stats,
} from './common.mjs';

function startExternalHttpClient(port, intervalMs = 15) {
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const http = require('node:http');
    const latencies = [];
    let errors = 0;
    let active = false;
    let timer = null;
    const fire = () => {
      const t0 = performance.now();
      const req = http.request({ host: '127.0.0.1', port: workerData.port, path: '/login', timeout: 20000 }, (res) => {
        res.resume();
        res.on('end', () => { if (active) latencies.push(performance.now() - t0); });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => { if (active) errors++; });
      req.end();
    };
    parentPort.on('message', (msg) => {
      if (msg === 'start') {
        latencies.length = 0;
        errors = 0;
        active = true;
        timer = setInterval(fire, workerData.intervalMs);
      } else if (msg === 'stop') {
        active = false;
        if (timer) clearInterval(timer);
        timer = null;
        setTimeout(() => parentPort.postMessage({ latencies: latencies.slice(), errors }), 100);
      }
    });
  `;
  const w = new Worker(code, { eval: true, workerData: { port, intervalMs } });
  return {
    start: () => w.postMessage('start'),
    stop: () =>
      new Promise((resolve) => {
        w.once('message', resolve);
        w.postMessage('stop');
      }),
    close: () => w.terminate(),
  };
}

const TOPOLOGY = process.argv[2] || 'in_process_1';
const PROFILE = process.argv[3] || 'sweet';
const WARM_BATCHES = Number(process.argv[4] || 5);
const CONCURRENCY = 10;

const TOPOLOGIES = {
  in_process_1: { mode: 'in_process', workerCount: 1 },
  worker_thread_1: { mode: 'worker_thread', workerCount: 1 },
  child_process_1: { mode: 'child_process', workerCount: 1 },
  worker_thread_10: { mode: 'worker_thread', workerCount: 10 },
  child_process_10: { mode: 'child_process', workerCount: 10 },
};

const spec = TOPOLOGIES[TOPOLOGY];
if (!spec) {
  throw new Error(`Unknown topology "${TOPOLOGY}". Valid: ${Object.keys(TOPOLOGIES).join(', ')}`);
}

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
  if (mode === 'worker_thread') {
    return profile === 'sweet'
      ? { workerEnv: baseEnv, resourceLimits: { maxYoungGenerationSizeMb: 4 } }
      : { workerEnv: baseEnv };
  }
  // in_process runs in main process; ensure env flag is set for concurrent leases
  process.env.KBN_REMOTE_ALLOW_CONCURRENT_LEASES = '1';
  return {};
}

async function main() {
  const { server: esServer, url: esUrl } = await startMockEs({ alertCount: 50, esqlRows: 1 });
  const loginBody = JSON.stringify({ ok: true, route: '/login', providers: [{ type: 'basic', name: 'basic' }] });
  const loginServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(loginBody);
  });
  await new Promise((resolve) => loginServer.listen(0, '127.0.0.1', resolve));
  const { port } = loginServer.address();
  const httpClient = startExternalHttpClient(port, 15);
  const executions = new Map();
  const stepsMap = new Map();
  const { coordinator } = makeCoordinator(executions, stepsMap);

  const hist = monitorEventLoopDelay({ resolution: 10 });
  hist.enable();

  global.gc?.();
  global.gc?.();
  await delay(100);
  const hostBefore = readSmaps(process.pid);

  const cfg = profileCfg(spec.mode, PROFILE);
  const tSpawn0 = performance.now();
  const workers = [];
  if (spec.workerCount === 1) {
    workers.push(
      await spawnBackend({
        mode: spec.mode,
        bundleDir: DEFAULT_BUNDLE_DIR,
        coordinator,
        ...cfg,
      })
    );
  } else {
    // Spawn all 10 workers concurrently
    const spawned = await Promise.all(
      Array.from({ length: spec.workerCount }, () =>
        spawnBackend({
          mode: spec.mode,
          bundleDir: DEFAULT_BUNDLE_DIR,
          coordinator,
          ...cfg,
        })
      )
    );
    workers.push(...spawned);
  }
  const spawnMs = +(performance.now() - tSpawn0).toFixed(1);

  const measureMem = () => {
    if (spec.mode === 'child_process') {
      let anon = 0;
      let rss = 0;
      for (const w of workers) {
        const s = readSmaps(w.pid);
        anon += s?.anon ?? 0;
        rss += s?.rss ?? 0;
      }
      return {
        scope: 'worker-only (sum of child PIDs)',
        anonMiB: +anon.toFixed(1),
        rssMiB: +rss.toFixed(1),
      };
    }
    const cur = readSmaps(process.pid);
    return {
      scope: spec.mode === 'worker_thread' ? 'combined Δ above pre-spawn host' : 'host Δ above pre-spawn baseline',
      anonMiB: +((cur?.anon ?? 0) - hostBefore.anon).toFixed(1),
      rssMiB: +((cur?.rss ?? 0) - hostBefore.rss).toFixed(1),
    };
  };

  const idleMem = measureMem();
  const wfDef = makeScenarioADef();

  async function runBatch(tag) {
    executions.clear();
    stepsMap.clear();
    await delay(100);
    hist.reset();
    const elTick = setInterval(() => {}, 15);
    httpClient.start();

    let peakAnon = measureMem().anonMiB;
    let peakRss = measureMem().rssMiB;
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const m = measureMem();
        if (m.anonMiB > peakAnon) peakAnon = m.anonMiB;
        if (m.rssMiB > peakRss) peakRss = m.rssMiB;
        await delay(25);
      }
    })();

    const t0 = performance.now();
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => {
        const w = spec.workerCount === 1 ? workers[0] : workers[i];
        return runWorkflow(w.stub, executions, stepsMap, esUrl, wfDef, `h-${tag}-${i}`);
      })
    );
    const batchWallMs = +(performance.now() - t0).toFixed(1);

    polling = false;
    await poll;
    await delay(30);
    clearInterval(elTick);
    const httpRes = await httpClient.stop();

    const perRunMs = results.map((r) => r.wallMs);
    const allCompleted = results.every((r) => r.status === 'completed');

    return {
      tag,
      allCompleted,
      batchWallMs,
      perRunMedianMs: stats(perRunMs).median,
      perRunMaxMs: stats(perRunMs).max,
      peakAnonMiB: peakAnon,
      peakRssMiB: peakRss,
      elP99Ms: +(hist.percentile(99) / 1e6).toFixed(2),
      elMaxMs: +(hist.max / 1e6).toFixed(2),
      httpCount: httpRes.latencies.length,
      httpErrors: httpRes.errors,
      httpP99Ms: +percentile(httpRes.latencies, 99).toFixed(2),
      httpMaxMs: +(httpRes.latencies.length ? Math.max(...httpRes.latencies) : 0).toFixed(2),
    };
  }

  // Batch 0: cold batch (includes lazy step imports)
  const coldBatch = await runBatch('cold');

  // Batches 1..WARM_BATCHES: warm steady-state
  const warmRuns = [];
  for (let b = 0; b < WARM_BATCHES; b++) {
    warmRuns.push(await runBatch(`warm-${b}`));
  }

  // Settle and measure steady-state memory
  executions.clear();
  stepsMap.clear();
  await delay(1000);
  global.gc?.();
  global.gc?.();
  await delay(200);
  const settledMem = measureMem();

  hist.disable();
  await httpClient.close();
  for (const w of workers) await w.cleanup();
  loginServer.close();
  esServer.close();

  console.log(
    JSON.stringify(
      {
        experiment: 'H_parallel10',
        topology: TOPOLOGY,
        mode: spec.mode,
        workerCount: spec.workerCount,
        concurrency: CONCURRENCY,
        profile: PROFILE,
        warmBatches: WARM_BATCHES,
        spawnMs,
        memScope: idleMem.scope,
        idleAnonMiB: idleMem.anonMiB,
        idleRssMiB: idleMem.rssMiB,
        settledAnonMiB: settledMem.anonMiB,
        settledRssMiB: settledMem.rssMiB,
        coldBatch,
        summary: {
          allCompleted: coldBatch.allCompleted && warmRuns.every((r) => r.allCompleted),
          batchWallMs: stats(warmRuns.map((r) => r.batchWallMs)),
          perRunMedianMs: stats(warmRuns.map((r) => r.perRunMedianMs)),
          perRunMaxMs: stats(warmRuns.map((r) => r.perRunMaxMs)),
          peakAnonMiB: stats(warmRuns.map((r) => r.peakAnonMiB)),
          peakRssMiB: stats(warmRuns.map((r) => r.peakRssMiB)),
          elP99Ms: stats(warmRuns.map((r) => r.elP99Ms)),
          elMaxMs: stats(warmRuns.map((r) => r.elMaxMs)),
          httpP99Ms: stats(warmRuns.map((r) => r.httpP99Ms)),
          httpMaxMs: stats(warmRuns.map((r) => r.httpMaxMs)),
          totalHttpErrors: warmRuns.reduce((a, r) => a + r.httpErrors, 0),
        },
        warmRuns,
      },
      null,
      2
    )
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
