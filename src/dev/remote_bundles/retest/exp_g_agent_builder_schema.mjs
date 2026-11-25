/**
 * Experiment G (Stretch): Agent Builder-like pure-function offload (INC-3836).
 *
 * Loads the real auto-generated JSON Schema for `cluster.put_component_template`
 * from `@elastic/schemas/es/tools/index.js` + its full `$ref` closure, then
 * compiles and validates params using `@cfworker/json-schema` (current
 * `execute_api` validator) and optionally `ajv` (draft 2020-12).
 *
 * Compares main-thread event-loop delay (p99/max) and wall latency:
 *   - in_process
 *   - worker_thread (one-shot / persistent worker via MessageChannel)
 *   - child_process (IPC)
 *
 * Usage:
 *   node exp_g_agent_builder_schema.mjs [mode] [engine] [runs]
 *     mode:   in_process | worker_thread | child_process (default: in_process)
 *     engine: cfworker | ajv (default: cfworker)
 *     runs:   default 3
 */

import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const readProcMem = (pid) => {
  try {
    const s = readFileSync(`/proc/${pid}/status`, 'utf8');
    const get = (k) => {
      const m = s.match(new RegExp(`^${k}:\\s+(\\d+)\\s+kB`, 'm'));
      return m ? Number((Number(m[1]) / 1024).toFixed(2)) : 0;
    };
    return { rssMiB: get('VmRSS'), anonMiB: get('RssAnon') };
  } catch {
    return { rssMiB: 0, anonMiB: 0 };
  }
};
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? Number(s[Math.floor(s.length / 2)].toFixed(2)) : 0;
};
const maxOf = (arr) => (arr.length ? Number(Math.max(...arr).toFixed(2)) : 0);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MODE = process.argv[2] ?? 'in_process';
const ENGINE = process.argv[3] ?? 'cfworker';
const RUNS = Number(process.argv[4] ?? 3);

const SAMPLE_PARAMS = {
  name: 'my-component-template',
  version: 1,
  template: {
    settings: {
      number_of_shards: 1,
      number_of_replicas: 1,
      refresh_interval: '30s',
    },
    mappings: {
      dynamic: 'strict',
      properties: {
        '@timestamp': { type: 'date' },
        message: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
        host: {
          type: 'object',
          properties: {
            name: { type: 'keyword' },
            ip: { type: 'ip' },
          },
        },
        status_code: { type: 'integer' },
        latency_ms: { type: 'double' },
      },
    },
    aliases: {
      'logs-alias': { is_write_index: false },
    },
  },
  _meta: { description: 'retest component template' },
};

function collectRefs(node, found) {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string') {
      const [file] = v.split('#');
      if (file.length > 0) found.add(file);
    } else {
      collectRefs(v, found);
    }
  }
}

async function loadClusterPutComponentTemplate() {
  const { esRegistry } = await import('@elastic/schemas/es/tools/index.js');
  const loaded = await esRegistry.loadApi('cluster.put_component_template');
  const schema = loaded.definition.input;

  const closure = new Map();
  const pending = new Set();
  collectRefs(schema, pending);
  while (pending.size > 0) {
    const refs = Array.from(pending);
    pending.clear();
    for (const ref of refs) {
      const file = ref.replace(/^\.\//, '');
      const mod = await import(`@elastic/schemas/es/json/${file}`, { with: { type: 'json' } });
      const doc = mod.default;
      closure.set(ref, doc);
      const nested = new Set();
      collectRefs(doc, nested);
      for (const n of nested) {
        if (!closure.has(n)) pending.add(n);
      }
    }
  }
  return { schema, closure };
}

async function runValidateOnce(engine, loaded, params) {
  const { schema, closure } = loaded;
  if (engine === 'cfworker') {
    const { Validator } = await import('@cfworker/json-schema');
    const t0 = performance.now();
    const validator = new Validator(schema, '2020-12', false);
    for (const [ref, doc] of closure) {
      validator.addSchema(doc, ref);
    }
    const tCompile = performance.now() - t0;
    const t1 = performance.now();
    const res = validator.validate(params);
    const tValidate = performance.now() - t1;
    return {
      valid: res.valid,
      errorCount: res.errors?.length ?? 0,
      compileMs: Number(tCompile.toFixed(2)),
      validateMs: Number(tValidate.toFixed(2)),
      closureFiles: closure.size,
    };
  }
  if (engine === 'ajv') {
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const t0 = performance.now();
    const ajv = new Ajv2020({ strict: false, allErrors: false });
    for (const [ref, doc] of closure) {
      const clean = { ...doc };
      delete clean.$id;
      ajv.addSchema(clean, ref);
      const bare = ref.replace(/^\.\//, '');
      if (bare !== ref) ajv.addSchema(clean, bare);
    }
    const rootClean = { ...schema, $id: 'root.json' };
    const validate = ajv.compile(rootClean);
    const tCompile = performance.now() - t0;
    const t1 = performance.now();
    const valid = validate(params);
    const tValidate = performance.now() - t1;
    return {
      valid: Boolean(valid),
      errorCount: validate.errors?.length ?? 0,
      compileMs: Number(tCompile.toFixed(2)),
      validateMs: Number(tValidate.toFixed(2)),
      closureFiles: closure.size,
    };
  }
  throw new Error(`Unknown engine: ${engine}`);
}

// Worker / child_process entry point when invoked with __WORKER_MODE__
if (process.env.__EXP_G_CHILD__ === '1') {
  const loaded = await loadClusterPutComponentTemplate();
  process.send({ type: 'ready', closureFiles: loaded.closure.size });
  process.on('message', async (msg) => {
    if (msg.type === 'run') {
      try {
        const res = await runValidateOnce(msg.engine, loaded, msg.params);
        process.send({ type: 'result', id: msg.id, res });
      } catch (err) {
        process.send({ type: 'error', id: msg.id, error: String(err?.stack ?? err) });
      }
    }
  });
} else {
  const hist = monitorEventLoopDelay({ resolution: 10 });
  hist.enable();

  let runFn;
  let cleanup;
  let workerPid = null;

  if (MODE === 'in_process') {
    const loaded = await loadClusterPutComponentTemplate();
    runFn = () => runValidateOnce(ENGINE, loaded, SAMPLE_PARAMS);
    cleanup = async () => {};
  } else if (MODE === 'worker_thread') {
    const workerCode = `
      import { parentPort } from 'node:worker_threads';
      import { performance } from 'node:perf_hooks';
      import { readFileSync } from 'node:fs';
      import { resolve } from 'node:path';
      function collectRefs(node, found) {
        if (Array.isArray(node)) { for (const i of node) collectRefs(i, found); return; }
        if (!node || typeof node !== 'object') return;
        for (const [k, v] of Object.entries(node)) {
          if (k === '$ref' && typeof v === 'string') { const [f] = v.split('#'); if (f.length) found.add(f); }
          else collectRefs(v, found);
        }
      }
      const { esRegistry } = await import('@elastic/schemas/es/tools/index.js');
      const loaded = await esRegistry.loadApi('cluster.put_component_template');
      const schema = loaded.definition.input;
      const closure = new Map();
      const pending = new Set();
      collectRefs(schema, pending);
      while (pending.size > 0) {
        const refs = Array.from(pending); pending.clear();
        for (const ref of refs) {
          const mod = await import('@elastic/schemas/es/json/' + ref.replace(/^\\.\\//, ''), { with: { type: 'json' } });
          const doc = mod.default;
          closure.set(ref, doc);
          const nested = new Set(); collectRefs(doc, nested);
          for (const n of nested) if (!closure.has(n)) pending.add(n);
        }
      }
      parentPort.postMessage({ type: 'ready', closureFiles: closure.size });
      parentPort.on('message', async (msg) => {
        if (msg.type === 'run') {
          try {
            let res;
            if (msg.engine === 'cfworker') {
              const { Validator } = await import('@cfworker/json-schema');
              const t0 = performance.now();
              const v = new Validator(schema, '2020-12', false);
              for (const [r, d] of closure) v.addSchema(d, r);
              const tC = performance.now() - t0;
              const t1 = performance.now();
              const out = v.validate(msg.params);
              const tV = performance.now() - t1;
              res = { valid: out.valid, errorCount: out.errors?.length ?? 0, compileMs: Number(tC.toFixed(2)), validateMs: Number(tV.toFixed(2)), closureFiles: closure.size };
            } else {
              const { default: Ajv2020 } = await import('ajv/dist/2020.js');
              const t0 = performance.now();
              const ajv = new Ajv2020({ strict: false, allErrors: false });
              for (const [r, d] of closure) {
                const clean = { ...d }; delete clean.$id;
                ajv.addSchema(clean, r);
                const bare = r.replace(/^\\.\\//, '');
                if (bare !== r) ajv.addSchema(clean, bare);
              }
              const validate = ajv.compile({ ...schema, $id: 'root.json' });
              const tC = performance.now() - t0;
              const t1 = performance.now();
              const valid = validate(msg.params);
              const tV = performance.now() - t1;
              res = { valid: Boolean(valid), errorCount: validate.errors?.length ?? 0, compileMs: Number(tC.toFixed(2)), validateMs: Number(tV.toFixed(2)), closureFiles: closure.size };
            }
            parentPort.postMessage({ type: 'result', id: msg.id, res });
          } catch (err) {
            parentPort.postMessage({ type: 'error', id: msg.id, error: String(err?.stack ?? err) });
          }
        }
      });
    `;
    const w = new Worker(workerCode, { eval: true });
    await new Promise((res, rej) => {
      w.once('message', (m) => (m.type === 'ready' ? res() : rej(m)));
      w.once('error', rej);
    });
    let seq = 0;
    runFn = () =>
      new Promise((res, rej) => {
        const id = ++seq;
        const onMsg = (m) => {
          if (m.id !== id) return;
          w.off('message', onMsg);
          if (m.type === 'result') res(m.res);
          else rej(new Error(m.error));
        };
        w.on('message', onMsg);
        w.postMessage({ type: 'run', id, engine: ENGINE, params: SAMPLE_PARAMS });
      });
    cleanup = () => w.terminate();
  } else if (MODE === 'child_process') {
    const child = fork(__filename, [], {
      env: { ...process.env, __EXP_G_CHILD__: '1' },
      execArgv: process.execArgv,
    });
    workerPid = child.pid;
    await new Promise((res, rej) => {
      child.once('message', (m) => (m.type === 'ready' ? res() : rej(m)));
      child.once('error', rej);
    });
    let seq = 0;
    runFn = () =>
      new Promise((res, rej) => {
        const id = ++seq;
        const onMsg = (m) => {
          if (m.id !== id) return;
          child.off('message', onMsg);
          if (m.type === 'result') res(m.res);
          else rej(new Error(m.error));
        };
        child.on('message', onMsg);
        child.send({ type: 'run', id, engine: ENGINE, params: SAMPLE_PARAMS });
      });
    cleanup = async () => {
      child.kill('SIGKILL');
    };
  } else {
    throw new Error(`Unknown mode: ${MODE}`);
  }

  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    await delay(100);
    hist.reset();
    const elTick = setInterval(() => {}, 10);
    const t0 = performance.now();
    const res = await runFn();
    const wallMs = performance.now() - t0;
    await delay(30);
    clearInterval(elTick);
    runs.push({
      run: i + 1,
      wallMs: Number(wallMs.toFixed(2)),
      ...res,
      elP99Ms: Number((hist.percentile(99) / 1e6).toFixed(2)),
      elMaxMs: Number((hist.max / 1e6).toFixed(2)),
    });
  }

  const memEnd = {
    mainAnonMiB: readProcMem(process.pid).anonMiB,
    workerAnonMiB: workerPid ? readProcMem(workerPid).anonMiB : null,
  };

  hist.disable();
  await cleanup();

  console.log(
    JSON.stringify(
      {
        experiment: 'G_agent_builder_schema',
        mode: MODE,
        engine: ENGINE,
        n: RUNS,
        summary: {
          wallMedianMs: median(runs.map((r) => r.wallMs)),
          wallMaxMs: maxOf(runs.map((r) => r.wallMs)),
          compileMedianMs: median(runs.map((r) => r.compileMs)),
          validateMedianMs: median(runs.map((r) => r.validateMs)),
          elP99MedianMs: median(runs.map((r) => r.elP99Ms)),
          elMaxMedianMs: median(runs.map((r) => r.elMaxMs)),
          elMaxMaxMs: maxOf(runs.map((r) => r.elMaxMs)),
          closureFiles: runs[0]?.closureFiles ?? 0,
        },
        memEnd,
        runs,
      },
      null,
      2
    )
  );
  process.exit(0);
}
