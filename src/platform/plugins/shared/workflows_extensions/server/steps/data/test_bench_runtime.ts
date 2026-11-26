/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { remotable } from '@kbn/core-remote-common';
import type { RemoteWorkflowStep } from '../../remote/tokens';

interface TestBenchInput {
  op?: 'spin' | 'alloc' | 'oom' | 'gc_stall';
  durationMs?: number;
  sizeMb?: number;
  holdMs?: number;
  targetMb?: number;
  chunkKb?: number;
  mode?: 'strings' | 'arrays' | 'objects';
}

/** Test-only workflow step for CPU-spin, large-allocation, and OOM benchmarks. */
@remotable()
export class TestBenchStep {
  async run(...args: Parameters<RemoteWorkflowStep['run']>): ReturnType<RemoteWorkflowStep['run']> {
    if (process.env.KBN_REMOTE_ENABLE_TEST_STEPS !== '1') {
      return {
        error: new Error('test.bench is disabled (set KBN_REMOTE_ENABLE_TEST_STEPS=1 to enable)'),
      };
    }
    const [, , { handlerContext }] = args;
    const raw = (handlerContext as { input?: TestBenchInput; rawInput?: TestBenchInput }) ?? {};
    const input: TestBenchInput = raw.input ?? raw.rawInput ?? {};
    const op = input.op ?? 'spin';

    if (op === 'spin') {
      const durationMs = Number(input.durationMs ?? 1000);
      const t0 = performance.now();
      const end = t0 + durationMs;
      let acc = 0x9e3779b9;
      while (performance.now() < end) {
        for (let i = 0; i < 10_000; i++) {
          acc = (Math.imul(acc, 1664525) + 1013904223) >>> 0;
        }
      }
      return {
        output: {
          op: 'spin',
          requestedMs: durationMs,
          actualMs: +(performance.now() - t0).toFixed(1),
          checksum: acc,
        },
      };
    }

    if (op === 'alloc') {
      const sizeMb = Number(input.sizeMb ?? 50);
      const holdMs = Number(input.holdMs ?? 0);
      const t0 = performance.now();
      const records: Array<{ id: number; payload: string; tags: string[] }> = [];
      // Each record is ~1 KiB of unique JS object + 1-byte string data.
      const count = Math.max(1, Math.floor(sizeMb * 1024));
      const pad = 'a'.repeat(850);
      let checksum = 0;
      for (let i = 0; i < count; i++) {
        const payload = `${i}:${pad}:${i.toString(36)}`;
        records.push({ id: i, payload, tags: [`t-${i & 63}`, `g-${i & 255}`] });
        checksum = (checksum + payload.length) >>> 0;
      }
      if (holdMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, holdMs));
      }
      const peakHeapMb = +(process.memoryUsage().heapUsed / 1048576).toFixed(1);
      return {
        output: {
          op: 'alloc',
          requestedMb: sizeMb,
          recordCount: records.length,
          checksum,
          peakHeapMb,
          wallMs: +(performance.now() - t0).toFixed(1),
        },
      };
    }

    if (op === 'oom') {
      const targetMb = Number(input.targetMb ?? 160);
      const mode = input.mode ?? 'strings';
      const chunkKb = Number(input.chunkKb ?? 256);
      const t0 = performance.now();
      const kept: unknown[] = [];
      const chunks = Math.max(1, Math.ceil((targetMb * 1024) / chunkKb));
      if (mode === 'arrays') {
        const elems = Math.max(1, Math.floor((chunkKb * 1024) / 8));
        for (let i = 0; i < chunks; i++) {
          kept.push(new Array(elems).fill(i));
        }
      } else if (mode === 'objects') {
        for (let i = 0; i < chunks; i++) {
          const batch: Array<{ k: number; v: string }> = [];
          const perBatch = Math.max(1, Math.floor(chunkKb * 4));
          for (let j = 0; j < perBatch; j++) {
            batch.push({ k: i * perBatch + j, v: `val-${i}-${j}-${'x'.repeat(200)}` });
          }
          kept.push(batch);
        }
      } else {
        // Incremental string churn (mimics Liquid rendering large strings)
        const base = '0123456789abcdef'.repeat(64); // 1 KiB
        for (let i = 0; i < chunks; i++) {
          let s = `${i}:`;
          for (let j = 0; j < chunkKb; j++) {
            s += base;
          }
          kept.push({ idx: i, data: s });
        }
      }
      return {
        output: {
          op: 'oom',
          mode,
          chunks: kept.length,
          wallMs: +(performance.now() - t0).toFixed(1),
        },
      };
    }

    if (op === 'gc_stall') {
      // Hold ~targetMb of live unique objects near the old-space cap, then churn garbage to induce GC thrashing
      const liveMb = Number(input.targetMb ?? 38);
      const durationMs = Number(input.durationMs ?? 20_000);
      const t0 = performance.now();
      const retained: Array<{ id: number; s: string }> = [];
      const pad = 'x'.repeat(900);
      const count = Math.floor(liveMb * 1024);
      for (let i = 0; i < count; i++) {
        retained.push({ id: i, s: `${i}:${pad}:${i.toString(36)}` });
      }
      let rounds = 0;
      const end = t0 + durationMs;
      while (performance.now() < end) {
        const tmp: string[] = [];
        for (let j = 0; j < 2000; j++) {
          tmp.push(`${rounds}-${j}-${pad}`);
        }
        rounds += tmp.length > 0 ? 1 : 0;
      }
      return {
        output: {
          op: 'gc_stall',
          retainedCount: retained.length,
          rounds,
          wallMs: +(performance.now() - t0).toFixed(1),
        },
      };
    }

    return { error: new Error(`Unknown test.bench op: ${String(op)}`) };
  }
}
