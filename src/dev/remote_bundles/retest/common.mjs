/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { fork } from 'node:child_process';
import { setPriority } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { MessageChannel, Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcSession, RpcTarget, newMessagePortRpcSession } from '/work/node_modules/capnweb/dist/index.js';

export const DEFAULT_BUNDLE_DIR = process.env.BUNDLE_DIR || '/work/.scratch/retest/bundle-after';

export function readSmaps(pid = process.pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const out = {};
    for (const line of raw.split('\n')) {
      const m = /^(\w+):\s+(\d+)\s+kB/.exec(line);
      if (m) out[m[1]] = Number(m[2]) / 1024;
    }
    return {
      rss: +(out.Rss ?? 0).toFixed(1),
      pss: +(out.Pss ?? 0).toFixed(1),
      privDirty: +(out.Private_Dirty ?? 0).toFixed(1),
      privClean: +(out.Private_Clean ?? 0).toFixed(1),
      anon: +(out.Anonymous ?? 0).toFixed(1),
      sharedClean: +(out.Shared_Clean ?? 0).toFixed(1),
    };
  } catch {
    return null;
  }
}

export function fmtMem(usage, pid = process.pid) {
  const mib = (b) => +(b / 1048576).toFixed(1);
  return {
    rss: mib(usage.rss),
    heapTotal: mib(usage.heapTotal),
    heapUsed: mib(usage.heapUsed),
    external: mib(usage.external),
    arrayBuffers: mib(usage.arrayBuffers),
    smaps: readSmaps(pid),
  };
}

export function stats(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return { n: 0, median: null, max: null, min: null, values: [] };
  const mid = Math.floor(nums.length / 2);
  const median = nums.length % 2 === 1 ? nums[mid] : +((nums[mid - 1] + nums[mid]) / 2).toFixed(2);
  return {
    n: nums.length,
    median: +median.toFixed(2),
    max: +nums[nums.length - 1].toFixed(2),
    min: +nums[0].toFixed(2),
    values: nums.map((v) => +v.toFixed(2)),
  };
}

export function percentile(values, p) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const idx = Math.min(nums.length - 1, Math.ceil((p / 100) * nums.length) - 1);
  return +nums[idx].toFixed(2);
}

export function graphSignature(spec) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: spec.id,
        root: [spec.root.tokenId, spec.root.exportName],
        catalog: spec.catalog ? [spec.catalog.tokenId, spec.catalog.exportName] : null,
        providers: spec.executorProviders.map(({ tokenId, exportName }) => `${tokenId}:${exportName}`).sort(),
        coordinator: [...spec.coordinatorTokenIds].sort(),
        steps: spec.contributions.map(({ kindId, stepType, exportName }) => `${kindId ?? ''}:${stepType}:${exportName}`).sort(),
      })
    )
    .digest('hex');
}

export class IpcTransport {
  encodingLevel = 'string';
  queue = [];
  pending;
  error;
  constructor(channel) {
    this.channel = channel;
    channel.on('message', (msg) => {
      if (!msg || typeof msg !== 'object' || msg.kind !== 'remote-seam') return;
      if (typeof msg.payload !== 'string') {
        this.abort(new Error('Invalid IPC frame'));
        return;
      }
      if (this.pending) {
        const { resolve } = this.pending;
        this.pending = undefined;
        resolve(msg.payload);
      } else {
        this.queue.push(msg.payload);
      }
    });
    channel.on('disconnect', () => this.abort(new Error('IPC disconnected')));
  }
  send(payload) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.channel.send({ kind: 'remote-seam', payload }, (err) => (err ? reject(err) : resolve()));
    });
  }
  receive() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }
  abort(reason) {
    if (this.error) return;
    this.error = reason instanceof Error ? reason : new Error(String(reason));
    if (this.pending) {
      const { reject } = this.pending;
      this.pending = undefined;
      reject(this.error);
    }
  }
}

export function makeScenarioADef({ alertSize = 50, foreachLimit = 50 } = {}) {
  return {
    version: '1',
    name: 'big-workflow-linux-retest',
    enabled: true,
    description: 'Triage seeded authentication alerts, persist findings, and notify the response channel.',
    tags: ['big-workflow', 'triage'],
    consts: {
      alertsIndex: 'big_workflow_alerts',
      findingsIndex: 'big_workflow_findings',
      outcomesIndex: 'big_workflow_outcomes',
    },
    triggers: [{ type: 'manual' }],
    steps: [
      {
        name: 'searchAlerts',
        type: 'elasticsearch.search',
        with: { index: '{{ consts.alertsIndex }}', size: alertSize, sort: [{ host: 'asc' }], query: { match_all: {} } },
      },
      {
        name: 'countAlerts',
        type: 'elasticsearch.esql.query',
        with: { query: 'FROM big_workflow_alerts | STATS alert_count = COUNT(*) | KEEP alert_count' },
      },
      {
        name: 'project',
        type: 'data.map',
        items: '${{ steps.searchAlerts.output.hits.hits }}',
        with: { fields: { host: '{{ item._source.host }}', severity: '{{ item._source.severity }}', message: '{{ item._source.message }}' } },
      },
      {
        name: 'highs',
        type: 'data.filter',
        items: '${{ steps.project.output }}',
        with: { condition: 'item.severity: high' },
      },
      {
        name: 'triage',
        type: 'foreach',
        foreach:
          foreachLimit < alertSize
            ? `\${{ steps.project.output | slice: 0, ${foreachLimit} }}`
            : '${{ steps.project.output }}',
        steps: [
          { name: 'label', type: 'data.set', with: { host: '{{ foreach.item.host }}', severity: '{{ foreach.item.severity }}' } },
          {
            name: 'gate',
            type: 'if',
            condition: '${{ foreach.item.severity == "high" }}',
            steps: [{ name: 'prioritise', type: 'data.set', with: { priority: 'p1', host: '{{ foreach.item.host }}' } }],
            else: [{ name: 'defer', type: 'data.set', with: { priority: 'p3', host: '{{ foreach.item.host }}' } }],
          },
          {
            name: 'shape',
            type: 'data.map',
            items: '${{ foreach.item }}',
            with: {
              fields: {
                host: '{{ item.host }}',
                severity: '{{ item.severity }}',
                priority: '{% if item.severity == "high" %}p1{% else %}p3{% endif %}',
              },
            },
          },
        ],
      },
      {
        name: 'recordFindings',
        type: 'elasticsearch.bulk',
        with: {
          index: '{{ consts.findingsIndex }}',
          refresh: 'wait_for',
          operations: [{ kind: 'triage-summary', high_alerts: '{{ steps.highs.output | size }}', source: 'big-workflow' }],
        },
      },
      {
        name: 'notify',
        type: 'slack2.sendMessage',
        'connector-id': 'slack-conn-1',
        with: { channel: 'C123', text: 'Triage complete for {{ steps.highs.output | size }} high alerts' },
      },
      {
        name: 'ask',
        type: 'ai.prompt',
        'connector-id': 'ai-conn-1',
        with: { prompt: 'Summarise the authentication triage in one sentence.' },
      },
      {
        name: 'openCase',
        type: 'cases.createCase',
        with: { title: 'Big workflow authentication triage', description: 'Opened from the kitchen-sink triage workflow.', owner: 'cases' },
      },
      {
        name: 'handoff',
        type: 'workflow.execute',
        with: { 'workflow-id': 'big-workflow-child', inputs: { summary: 'Triage complete for {{ steps.highs.output | size }} high alerts' } },
      },
      {
        name: 'confirmDelivery',
        type: 'slack2.sendMessage',
        'connector-id': 'slack-conn-1',
        with: { channel: 'C123', text: 'confirm-delivery of the triage summary for {{ steps.highs.output | size }} high alerts' },
      },
      {
        name: 'persist',
        type: 'elasticsearch.index',
        with: {
          index: '{{ consts.outcomesIndex }}',
          refresh: 'wait_for',
          document: {
            workflow: 'big-workflow-linux-retest',
            highAlerts: '{{ steps.highs.output | size }}',
            caseTitle: '{{ steps.openCase.output.case.title }}',
            childSummary: '{{ steps.handoff.output.summary }}',
            model: '{{ steps.ask.output.content }}',
            confirmed: '{{ steps.confirmDelivery.output.message.text }}',
          },
        },
      },
    ],
  };
}

export function makeSpinDef(durationMs = 10000) {
  return {
    version: '1',
    name: `test-spin-${durationMs}`,
    enabled: true,
    triggers: [{ type: 'manual' }],
    steps: [
      {
        name: 'spin',
        type: 'test.bench',
        with: { op: 'spin', durationMs },
      },
    ],
  };
}

export function makeAllocDef(sizeMb = 50, holdMs = 0) {
  return {
    version: '1',
    name: `test-alloc-${sizeMb}mb`,
    enabled: true,
    triggers: [{ type: 'manual' }],
    steps: [
      {
        name: 'alloc',
        type: 'test.bench',
        with: { op: 'alloc', sizeMb, holdMs },
      },
    ],
  };
}

export function makeOomDef(targetMb = 160, mode = 'strings', chunkKb = 256) {
  return {
    version: '1',
    name: `test-oom-${mode}-${targetMb}mb`,
    enabled: true,
    triggers: [{ type: 'manual' }],
    steps: [
      {
        name: 'oom',
        type: 'test.bench',
        with: { op: 'oom', targetMb, mode, chunkKb },
      },
    ],
  };
}

export function makeTrivialDef() {
  return {
    version: '1',
    name: 'test-trivial',
    enabled: true,
    triggers: [{ type: 'manual' }],
    steps: [{ name: 'ok', type: 'data.set', with: { ok: true } }],
  };
}

export function makeGraph1520Def(blocks = 190) {
  const steps = [];
  for (let i = 0; i < blocks; i++) {
    steps.push({
      name: `gate_${i}`,
      type: 'if',
      condition: '${{ true }}',
      steps: [{ name: `t_${i}`, type: 'data.set', with: { v: i } }],
      else: [{ name: `f_${i}`, type: 'data.set', with: { v: -i } }],
    });
  }
  return {
    version: '1',
    name: `test-graph-${blocks * 8}-nodes`,
    enabled: true,
    triggers: [{ type: 'manual' }],
    steps,
  };
}

export function startMockEs({ alertCount = 50, esqlRows = 1 } = {}) {
  const alerts = Array.from({ length: alertCount }, (_, index) => {
    const host = `host-${String(index).padStart(5, '0')}`;
    const severity = index % 2 === 0 ? 'high' : 'low';
    return { host, severity, message: `${severity} authentication failure on ${host}` };
  });
  const searchPayload = JSON.stringify({
    took: 1,
    timed_out: false,
    _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
    hits: {
      total: { value: alerts.length, relation: 'eq' },
      hits: alerts.map((a, i) => ({ _index: 'big_workflow_alerts', _id: `alert-${i}`, _source: a })),
    },
  });
  const esqlPayload = JSON.stringify(
    esqlRows <= 1
      ? { columns: [{ name: 'alert_count', type: 'long' }], values: [[alerts.length]] }
      : {
          columns: [
            { name: 'host', type: 'keyword' },
            { name: 'severity', type: 'keyword' },
            { name: 'alert_count', type: 'long' },
          ],
          values: Array.from({ length: esqlRows }, (_, i) => [
            `host-${String(i).padStart(5, '0')}`,
            i % 2 === 0 ? 'high' : 'low',
            i + 1,
          ]),
        }
  );

  const esDocs = new Map();
  let esRequestCount = 0;

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      esRequestCount++;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString('utf8');
        const pathOnly = (req.url || '/').split('?')[0];
        const sendRaw = (status, jsonStr) => {
          res.writeHead(status, {
            'content-type': 'application/json',
            'x-elastic-product': 'Elasticsearch',
          });
          res.end(jsonStr);
        };
        const send = (status, obj) => sendRaw(status, JSON.stringify(obj));

        if (pathOnly.endsWith('/_search')) return sendRaw(200, searchPayload);
        if (pathOnly === '/_query') return sendRaw(200, esqlPayload);
        if (pathOnly.endsWith('/_bulk')) {
          const lines = bodyStr.split('\n').filter(Boolean);
          const items = [];
          for (let i = 0; i < lines.length; i += 2) {
            const action = JSON.parse(lines[i]);
            const op = Object.keys(action)[0];
            const meta = action[op] || {};
            const id = meta._id || `bulk-${i}`;
            const idx = meta._index || pathOnly.split('/')[1] || 'default';
            items.push({ [op]: { _index: idx, _id: id, _version: 1, result: 'created', status: 201 } });
          }
          return send(200, { took: 1, errors: false, items });
        }
        if (pathOnly.endsWith('/_doc')) {
          const idx = pathOnly.split('/').filter(Boolean)[0];
          const id = `auto-${esRequestCount}`;
          esDocs.set(`${idx}/${id}`, bodyStr ? JSON.parse(bodyStr) : {});
          return send(201, { _index: idx, _id: id, _version: 1, result: 'created' });
        }
        return send(200, { acknowledged: true });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        payloadBytes: { search: Buffer.byteLength(searchPayload), esql: Buffer.byteLength(esqlPayload) },
        getRequestCount: () => esRequestCount,
      });
    });
  });
}

export function makeCoordinator(executions, stepsMap, { trackTimings = false } = {}) {
  const timing = { rpcCalls: 0, rpcMs: 0 };
  const timed = async (fn) => {
    if (!trackTimings) return fn();
    const t0 = performance.now();
    timing.rpcCalls++;
    try {
      return await fn();
    } finally {
      timing.rpcMs += performance.now() - t0;
    }
  };

  class StorageStub extends RpcTarget {
    whereAmI() {
      return { threadId: 0, isMainThread: true };
    }
    async getExecution(_scopeId, workflowRunId) {
      return timed(async () => {
        const ex = executions.get(workflowRunId);
        if (!ex) throw new Error(`Execution not found: ${workflowRunId}`);
        return structuredClone(ex);
      });
    }
    async markRunning(_scopeId, workflowRunId) {
      return timed(async () => {
        const ex = executions.get(workflowRunId);
        if (ex) ex.status = 'running';
      });
    }
    async recordStep(_scopeId, step) {
      return timed(async () => {
        stepsMap.set(step.id, structuredClone(step));
        const ex = executions.get(step.workflowRunId);
        if (ex && !ex.stepExecutionIds.includes(step.id)) ex.stepExecutionIds.push(step.id);
      });
    }
    async updateExecution(_scopeId, partial) {
      return timed(async () => {
        const ex = executions.get(partial.id);
        if (ex) Object.assign(ex, partial);
      });
    }
    async getCancelState() {
      return timed(async () => ({ cancelRequested: false }));
    }
    async upsertSteps(_scopeId, steps) {
      return timed(async () => {
        for (const s of steps) {
          if (!s.id) continue;
          const prev = stepsMap.get(s.id) || {};
          stepsMap.set(s.id, { ...prev, ...structuredClone(s) });
        }
      });
    }
    async getSteps(_scopeId, ids) {
      return timed(async () =>
        ids.map((id) => stepsMap.get(id)).filter(Boolean).map((s) => structuredClone(s))
      );
    }
    async scheduleResume() {
      return timed(async () => ({ taskId: 'mock-resume' }));
    }
    async executeConnector(_scopeId, params) {
      return timed(async () => {
        if (params.connectorType === '.slack_api' || params.connectorNameOrId === 'slack-conn-1') {
          return { ok: true, message: { text: params.input?.text ?? 'ok' } };
        }
        return { ok: true, content: 'Mock model summary.' };
      });
    }
    async complete(_scopeId, update) {
      return timed(async () => {
        const ex = executions.get(update.id);
        if (ex) Object.assign(ex, update);
      });
    }
  }
  const storageStub = new StorageStub();

  class ControlStub extends RpcTarget {
    async persistence() {
      return storageStub;
    }
    info() {}
    async initializeLogs() {}
    async scheduleResume() {
      return { taskId: 'mock-resume' };
    }
    async executeConnector(scopeId, params) {
      return storageStub.executeConnector(scopeId, params);
    }
  }

  class CredentialsStub extends RpcTarget {
    async refreshRunCredential() {
      return { headers: { authorization: 'Basic ZWxhc3RpYzpjaGFuZ2VtZQ==' }, expiresAt: Date.now() + 60000 };
    }
    async getConnector() {
      return {
        id: 'slack-conn-1',
        connector_type_id: '.slack_api',
        name: 'mock-slack',
        config: { apiUrl: 'http://127.0.0.1:1' },
        secrets: { token: 'mock-token' },
      };
    }
  }

  class ChildStub extends RpcTarget {
    async getWorkflow(_scopeId, _parentId, _spaceId, workflowId) {
      return {
        id: workflowId,
        name: `${workflowId}-child`,
        enabled: true,
        valid: true,
        yaml: 'name: big-workflow-child\nenabled: true\ntriggers:\n  - type: manual\nsteps:\n  - name: ack\n    type: data.set\n    with:\n      handled_by: triage-child\n',
        definition: {
          version: '1',
          name: `${workflowId}-child`,
          enabled: true,
          triggers: [{ type: 'manual', inputs: { properties: { summary: { type: 'string' } } } }],
          steps: [{ name: 'acknowledge', type: 'data.set', with: { handled_by: 'triage-child' } }],
        },
      };
    }
    async start() {
      return { workflowExecutionId: 'child-exec-1' };
    }
    async getExecution() {
      return {
        id: 'child-exec-1',
        status: 'completed',
        output: { summary: 'Triage complete for 25 high alerts', handled_by: 'triage-child' },
        stepExecutionIds: [],
      };
    }
    async getSteps() {
      return [];
    }
    async cancel() {}
  }

  class ActionsNativeStub extends RpcTarget {
    async prepare(_scopeId, _invId, req) {
      return {
        status: 'ready',
        connector: {
          id: req.connectorNameOrId,
          connector_type_id: req.connectorType || '.slack_api',
          name: 'mock-connector',
          config: { apiUrl: 'http://127.0.0.1:1' },
          secrets: { token: 'mock-token' },
        },
        input: req.input,
      };
    }
    async relay() {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, message: { text: 'confirm-delivery ok' } }) };
    }
    async finalize() {}
    async finalizeRetry() {}
  }

  class StepRunnerStub extends RpcTarget {
    async describe(stepTypes) {
      const esDefs = {
        'elasticsearch.search': {
          methods: ['POST'],
          patterns: ['/{index}/_search', '/_search'],
          parameterTypes: { urlParams: ['size'], bodyParams: ['query', 'sort'] },
        },
        'elasticsearch.esql.query': {
          methods: ['POST'],
          patterns: ['/_query'],
          parameterTypes: { bodyParams: ['query'] },
        },
        'elasticsearch.bulk': {
          methods: ['POST'],
          patterns: ['/{index}/_bulk', '/_bulk'],
          parameterTypes: { urlParams: ['refresh'], bodyParams: ['operations'] },
        },
        'elasticsearch.index': {
          methods: ['POST'],
          patterns: ['/{index}/_doc'],
          parameterTypes: { urlParams: ['refresh'], bodyParams: ['document'] },
        },
      };
      const nativeConfigKeys = {
        'data.map': ['items'],
        'data.filter': ['items'],
      };
      const unique = [...new Set(stepTypes)];
      const out = [];
      for (const type of unique) {
        if (esDefs[type]) {
          out.push({ type, mode: 'native', elasticsearch: esDefs[type], configKeys: [], hasStart: false, hasOnCancel: false, digest: `mock-${type}` });
        } else if (nativeConfigKeys[type]) {
          out.push({ type, mode: 'handler', configKeys: nativeConfigKeys[type], hasStart: false, hasOnCancel: false, digest: `mock-${type}` });
        } else if (['slack2.sendMessage', 'ai.prompt', 'cases.createCase', 'workflow.execute', 'test.bench'].includes(type)) {
          out.push({ type, mode: 'handler', configKeys: [], hasStart: false, hasOnCancel: false, digest: `mock-${type}` });
        }
      }
      return out;
    }
    async invoke(req) {
      const type = req.description?.type || req.connectorType;
      if (type === 'slack2.sendMessage') return { output: { ok: true, message: { text: 'confirm-delivery ok' } } };
      if (type === 'ai.prompt') return { output: { content: '25 high alerts triaged.' } };
      if (type === 'cases.createCase') return { output: { case: { id: 'case-1', title: 'Big workflow authentication triage' } } };
      if (type === 'workflow.execute') return { output: { summary: 'Triage complete for 25 high alerts', handled_by: 'triage-child' } };
      return { output: { ok: true } };
    }
    async cancel() {}
  }

  class CasesStub extends RpcTarget {
    async createCase(_scopeId, input) {
      return { id: 'case-1', title: input?.title ?? 'Big workflow authentication triage' };
    }
    async caseCreate(_scopeId, input) {
      return { id: 'case-1', title: input?.title ?? 'Big workflow authentication triage', owner: 'cases' };
    }
  }

  class InferencePolicyStub extends RpcTarget {
    async read() {
      return null;
    }
  }

  class GenericStub extends RpcTarget {}

  const map = new Map([
    ['workflows.control', new ControlStub()],
    ['workflows.credentials', new CredentialsStub()],
    ['workflows.child', new ChildStub()],
    ['workflows.stepRunner', new StepRunnerStub()],
    ['actions.native', new ActionsNativeStub()],
    ['cases.clientOperations', new CasesStub()],
    ['inference.policy', new InferencePolicyStub()],
  ]);

  class CoordinatorApi extends RpcTarget {
    getCapability(tokenId) {
      return map.get(tokenId) ?? new GenericStub();
    }
  }
  const api = new CoordinatorApi();
  return { coordinator: api, timing, resetTiming: () => { timing.rpcCalls = 0; timing.rpcMs = 0; } };
}

export async function spawnBackend({
  mode,
  bundleDir = DEFAULT_BUNDLE_DIR,
  coordinator,
  workerFlags = [],
  workerEnv = {},
  resourceLimits,
  nicePriority,
}) {
  const spec = JSON.parse(readFileSync(`${bundleDir}/spec.json`, 'utf8'));
  const signature = graphSignature(spec);
  const t0 = performance.now();

  if (mode === 'in_process') {
    const mod = await import(`${bundleDir}/graph.mjs`);
    const { executor, loaded } = await mod.createInProcess((tokenId) => coordinator.getCapability(tokenId));
    const spawnReadyMs = +(performance.now() - t0).toFixed(1);
    const stub = {
      run: (req) => executor.run(req),
      memoryUsage: async () => ({ usage: process.memoryUsage() }),
      loadedModules: async () => loaded,
    };
    return {
      mode,
      stub,
      pid: process.pid,
      spawnReadyMs,
      worker: null,
      child: null,
      cleanup: async () => {
        await executor[Symbol.asyncDispose]?.();
      },
    };
  }

  if (mode === 'child_process') {
    const child = fork(`${bundleDir}/graph.mjs`, [], {
      execArgv: ['--expose-gc', ...workerFlags],
      env: { ...process.env, KBN_REMOTE_ENABLE_TEST_STEPS: '1', ...workerEnv },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    if (typeof nicePriority === 'number') {
      try {
        setPriority(child.pid, nicePriority);
      } catch (err) {
        process.stderr.write(`[warn] setPriority(${child.pid}, ${nicePriority}) failed: ${err.message}\n`);
      }
    }
    const transport = new IpcTransport(child);
    const session = new RpcSession(transport, coordinator);
    const stub = session.getRemoteMain();
    let exited = false;
    let exitCode = null;
    let exitSignal = null;
    const exitPromise = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        exited = true;
        exitCode = code;
        exitSignal = signal;
        try { stub[Symbol.dispose]?.(); } catch {}
        resolve({ code, signal });
      });
    });

    await new Promise((resolve, reject) => {
      const onMsg = (msg) => {
        if (msg?.kind === 'ready') {
          child.off('message', onMsg);
          resolve();
        } else if (msg?.kind === 'boot-error') {
          child.off('message', onMsg);
          reject(new Error(`boot-error: ${msg.message}`));
        }
      };
      child.on('message', onMsg);
      child.once('exit', (code, signal) => reject(new Error(`child exited early: code=${code} signal=${signal}`)));
      child.send({ kind: 'init', signature });
    });

    const spawnReadyMs = +(performance.now() - t0).toFixed(1);
    return {
      mode,
      stub,
      pid: child.pid,
      spawnReadyMs,
      child,
      worker: null,
      isExited: () => exited,
      getExit: () => ({ exitCode, exitSignal }),
      exitPromise,
      kill: async () => {
        try { stub[Symbol.dispose]?.(); } catch {}
        try { child.kill('SIGKILL'); } catch {}
        await exitPromise;
      },
      cleanup: async () => {
        if (exited) return;
        try { stub[Symbol.dispose]?.(); } catch {}
        try { child.disconnect(); } catch {}
        await delay(50);
        if (!exited) {
          try { child.kill('SIGKILL'); } catch {}
          await exitPromise;
        }
      },
    };
  }

  if (mode === 'worker_thread') {
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(`${bundleDir}/graph.mjs`, {
      workerData: { __kbnRemoteBundlePort: port2, signature },
      transferList: [port2],
      env: { ...process.env, KBN_REMOTE_ENABLE_TEST_STEPS: '1', ...workerEnv },
      ...(resourceLimits ? { resourceLimits } : {}),
    });
    const stub = newMessagePortRpcSession(port1, coordinator);
    let exited = false;
    let exitCode = null;
    let lastError = null;
    worker.on('error', (err) => {
      lastError = err;
    });
    const exitPromise = new Promise((resolve) => {
      worker.once('exit', (code) => {
        exited = true;
        exitCode = code;
        try { stub[Symbol.dispose]?.(); } catch {}
        try { port1.close(); } catch {}
        resolve({ code, error: lastError });
      });
    });

    await new Promise((resolve, reject) => {
      const onMsg = (msg) => {
        if (msg?.kind === 'ready') {
          worker.off('message', onMsg);
          resolve();
        } else if (msg?.kind === 'boot-error') {
          worker.off('message', onMsg);
          reject(new Error(`boot-error: ${msg.message}`));
        }
      };
      worker.on('message', onMsg);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`worker exited early: code=${code}`)));
    });

    const spawnReadyMs = +(performance.now() - t0).toFixed(1);
    return {
      mode,
      stub,
      pid: process.pid,
      spawnReadyMs,
      worker,
      child: null,
      isExited: () => exited,
      getExit: () => ({ exitCode, error: lastError?.code || lastError?.message || null }),
      exitPromise,
      kill: async () => {
        try { stub[Symbol.dispose]?.(); } catch {}
        try { port1.close(); } catch {}
        await worker.terminate();
        await exitPromise;
      },
      cleanup: async () => {
        if (exited) return;
        try { stub[Symbol.dispose]?.(); } catch {}
        try { port1.close(); } catch {}
        await worker.terminate();
        await exitPromise;
      },
    };
  }

  throw new Error(`Unknown mode: ${mode}`);
}

export async function runWorkflow(stub, executions, stepsMap, esUrl, workflowDef, runId) {
  const scopeId = `scope-${runId}`;
  const defHash = createHash('sha256').update(JSON.stringify(workflowDef)).digest('hex');
  executions.set(runId, {
    id: runId,
    workflowId: workflowDef.name,
    workflowName: workflowDef.name,
    spaceId: 'default',
    status: 'pending',
    startedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workflowDefinition: workflowDef,
    stepExecutionIds: [],
    context: { inputs: {} },
    trigger: { type: 'manual' },
  });
  const runReq = {
    dependencyPlan: { definitionHash: defHash, nodes: {}, loops: {} },
    scopeId,
    workflowRunId: runId,
    spaceId: 'default',
    credentials: {
      node: esUrl,
      internalHeaders: { authorization: 'Basic a2liYW5hX3N5c3RlbTpjaGFuZ2VtZQ==' },
      userHeaders: { authorization: 'Basic ZWxhc3RpYzpjaGFuZ2VtZQ==' },
    },
    facts: {
      kibanaUrl: esUrl,
      maxResponseSizeBytes: 50 * 1024 * 1024,
      evictionMinBytes: 50 * 1024 * 1024,
      maxWorkflowDepth: 5,
    },
  };
  const t0 = performance.now();
  let outcome = await stub.run(runReq);
  if (outcome.status === 'waiting_for_child') {
    outcome = await stub.run(runReq);
  }
  const wallMs = +(performance.now() - t0).toFixed(1);
  const runSteps = [...stepsMap.values()].filter((s) => s.workflowRunId === runId);
  const failedStep = runSteps.find((s) => s.status === 'failed');
  const ex = executions.get(runId);
  return {
    runId,
    status: outcome.status,
    wallMs,
    stepCount: runSteps.length,
    error: outcome.status === 'completed' ? undefined : (ex?.error ?? failedStep?.error),
  };
}

/** Starts a lightweight /login-like HTTP endpoint on main and an interval probe measuring HTTP latency & main event-loop delay. */
export async function startMainHttpAndElProbe() {
  const loginBody = JSON.stringify({
    ok: true,
    route: '/login',
    providers: [{ type: 'basic', name: 'basic' }],
  });
  const server = createServer((req, res) => {
    // Small realistic JSON response mimicking Kibana /login
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(loginBody);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const hist = monitorEventLoopDelay({ resolution: 10 });
  hist.enable();

  let active = false;
  let latencies = [];
  let errors = 0;
  let timer = null;

  const fireOne = () => {
    const t0 = performance.now();
    const req = httpRequest({ host: '127.0.0.1', port, path: '/login', timeout: 15000 }, (res) => {
      res.resume();
      res.on('end', () => {
        if (active) latencies.push(performance.now() - t0);
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', () => {
      if (active) errors++;
    });
    req.end();
  };

  return {
    startWindow(intervalMs = 25) {
      hist.reset();
      latencies = [];
      errors = 0;
      active = true;
      timer = setInterval(fireOne, intervalMs);
    },
    async stopWindow() {
      active = false;
      if (timer) clearInterval(timer);
      timer = null;
      await delay(50);
      const elP99 = +(hist.percentile(99) / 1e6).toFixed(2);
      const elMax = +(hist.max / 1e6).toFixed(2);
      const httpP50 = percentile(latencies, 50);
      const httpP99 = percentile(latencies, 99);
      const httpMax = latencies.length ? +Math.max(...latencies).toFixed(2) : 0;
      return {
        samples: latencies.length,
        errors,
        elP99Ms: elP99,
        elMaxMs: elMax,
        httpP50Ms: httpP50,
        httpP99Ms: httpP99,
        httpMaxMs: httpMax,
      };
    },
    close() {
      if (timer) clearInterval(timer);
      hist.disable();
      server.close();
    },
  };
}
