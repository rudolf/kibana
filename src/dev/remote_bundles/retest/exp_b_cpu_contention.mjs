/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { createServer } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DEFAULT_BUNDLE_DIR,
  makeCoordinator,
  makeGraph1520Def,
  makeSpinDef,
  makeTrivialDef,
  percentile,
  runWorkflow,
  spawnBackend,
  startMockEs,
  stats,
} from './common.mjs';

const MODE = process.argv[2] || 'worker_thread'; // in_process | worker_thread | child_process | child_process_nice19
const WORKLOAD = process.argv[3] || 'spin_10s'; // spin_10s | graph_1520
const PROFILE = process.argv[4] || 'default'; // default | sweet
const RUNS = Number(process.argv[5] || 3);

/** Runs HTTP load generator in a separate Worker so requests keep firing even when main is blocked. */
function startExternalHttpClient(port, intervalMs = 25) {
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

async function main() {
  process.env.KBN_REMOTE_ENABLE_TEST_STEPS = '1';
  const actualMode = MODE === 'child_process_nice19' ? 'child_process' : MODE;
  const nicePriority = MODE === 'child_process_nice19' ? 19 : undefined;

  const loginBody = JSON.stringify({ ok: true, route: '/login', providers: [{ type: 'basic', name: 'basic' }] });
  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(loginBody);
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  const { server: esServer, url: esUrl } = await startMockEs({ alertCount: 50, esqlRows: 1 });
  const executions = new Map();
  const stepsMap = new Map();
  const { coordinator } = makeCoordinator(executions, stepsMap);

  const workerFlags =
    actualMode === 'child_process' && PROFILE === 'sweet'
      ? ['--max-semi-space-size=4', '--optimize-for-size']
      : [];
  const workerEnv =
    actualMode === 'child_process' && PROFILE === 'sweet'
      ? { MALLOC_CONF: 'narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0' }
      : {};
  const resourceLimits =
    actualMode === 'worker_thread' && PROFILE === 'sweet'
      ? { maxYoungGenerationSizeMb: 4 }
      : undefined;

  const backend = await spawnBackend({
    mode: actualMode,
    bundleDir: DEFAULT_BUNDLE_DIR,
    coordinator,
    workerFlags,
    workerEnv,
    resourceLimits,
    nicePriority,
  });

  // Warmup
  await runWorkflow(backend.stub, executions, stepsMap, esUrl, makeTrivialDef(), 'warmup');
  const httpClient = startExternalHttpClient(port, 25);
  const hist = monitorEventLoopDelay({ resolution: 10 });
  hist.enable();

  const wfDef = WORKLOAD === 'graph_1520' ? makeGraph1520Def(190) : makeSpinDef(10_000);

  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    await delay(200);
    hist.reset();
    const elTick = setInterval(() => {}, 20);
    httpClient.start();
    const res = await runWorkflow(backend.stub, executions, stepsMap, esUrl, wfDef, `exp-b-${i}`);
    await delay(40);
    clearInterval(elTick);
    const httpRes = await httpClient.stop();
    const elP99Ms = +(hist.percentile(99) / 1e6).toFixed(2);
    const elMaxMs = +(hist.max / 1e6).toFixed(2);
    runs.push({
      iter: i,
      status: res.status,
      wallMs: res.wallMs,
      elP99Ms,
      elMaxMs,
      httpSamples: httpRes.latencies.length,
      httpErrors: httpRes.errors,
      httpP50Ms: percentile(httpRes.latencies, 50),
      httpP99Ms: percentile(httpRes.latencies, 99),
      httpMaxMs: httpRes.latencies.length ? +Math.max(...httpRes.latencies).toFixed(2) : 0,
    });
  }

  hist.disable();
  await httpClient.close();
  await backend.cleanup();
  esServer.close();
  httpServer.close();

  console.log(
    JSON.stringify(
      {
        experiment: 'B_cpu_contention',
        mode: MODE,
        workload: WORKLOAD,
        profile: PROFILE,
        runs: RUNS,
        summary: {
          wallMs: stats(runs.map((r) => r.wallMs)),
          elP99Ms: stats(runs.map((r) => r.elP99Ms)),
          elMaxMs: stats(runs.map((r) => r.elMaxMs)),
          httpP99Ms: stats(runs.map((r) => r.httpP99Ms)),
          httpMaxMs: stats(runs.map((r) => r.httpMaxMs)),
          totalHttpErrors: runs.reduce((a, b) => a + b.httpErrors, 0),
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
