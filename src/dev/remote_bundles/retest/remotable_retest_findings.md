# `@remotable` (`core.remote`) Realistic Workload Retest Findings

**Date:** 2026-11-25  
**Scope:** Reproducible evaluation of `core.remote` / `@remotable` isolation backends (`in_process`, `worker_thread`, `child_process`) against Jean-Louis's 889-step workflow runner PoC (`jloleysens/kibana#12`, stacked on `elastic/kibana#301233`) with V8 pointer compression enabled (`v8_enable_pointer_compression: 1`, matching production serverless Kibana). Covers cold/warm start, Linux `Anon` memory (small-payload fixed cost and 10k-doc large-data workloads), cgroup CPU contention (`--cpus=1 / 0.5 / 0.25`), multi-workflow packing vs. noisy-neighbour isolation, watchdog-based termination of GC-stalled and spinning workers, uncapped CPU spins, warm execution overhead, and an Agent Builder schema-validation offload (INC-3836).

---

## Executive Summary

1. **Cold start is well under 1 s** (`[ENV-MAC-FULL]`, `[ENV-LIN-PC1-JE]`): Standalone spawn-to-ready for the optimized 889-step lazy bundle (`17.52 MiB` / 572 chunks, down 48% from `33.59 MiB`) is **62.1 ms** (`worker_thread`) / **77.7 ms** (`child_process`) on macOS and **35.0–38.8 ms** on Linux Docker. End-to-end in-Kibana dispatch-to-first-step for Scenario A (264 steps) is **126 ms cold / 22 ms warm** (`worker_thread`) and **144 ms cold / 17 ms warm** (`child_process`) vs. **26 ms / 17 ms** `in_process`.
2. **Tuned per-worker memory is ~59 MiB `Anon` (`worker_thread`) and 61.3 MiB `Anon` (`child_process`) on small-payload workflows** (`[ENV-LIN-PC1-JE]`): Under Elastic serverless Node `v24.22.1` (`pc=1`) + tuned `jemalloc` (`narenas:2`, aggressive decay) + V8 `--optimize-for-size` and 4 MiB young-gen cap, settled **worker-only `Anon`** drops by ~51% from untuned defaults (`~149 MiB` / `125.9 MiB` → **`~59 MiB`** / **`61.3 MiB`**; aggressive tuning reaches `~42 MiB` / `53.1 MiB`). *(Correction from prior revision: the earlier `+65.5 MiB` `worker_thread` figure was combined host+worker `ΔAnon` and included `+6.3 MiB` of host coordinator growth; worker-only `Anon` is `~59 MiB`.)* Note that these Linux Scenario A runs use the real `@elastic/elasticsearch` client against a mock ES server returning small payloads (50 docs), so they measure fixed client/code cost rather than large-data workloads.
3. **Large-data workloads (10k `/_search` hits + 10k ES|QL rows) peak at 74.0–86.1 MiB worker `Anon` tuned and stay contained under a 96 MiB V8 heap cap** (`[ENV-LIN-PC1-JE]`, Exp A): Peak **worker-only `Anon`** for 10k-doc ES + ES|QL + `data.map`/`data.filter` is **`74.0 MiB` (`worker_thread`, median; `75.4 MiB` max)** and **`86.1 MiB` (`child_process`, median; `91.2 MiB` max)** with sweet-spot tuning, settling back to `45.8` / `64.2 MiB` (`heapUsed` `19.1–20.9 MiB`), vs. `105.7` / `166.6 MiB` untuned. All 16 configurations (including a 50 MiB intermediate object variant) completed and stayed contained under a 96 MiB cap.
4. **Main stays responsive even on a 0.25 vCPU pod budget — bounded by the Linux CFS throttling floor, never by the workflow duration** (`[ENV-LIN-PC1-JE]`, Exp B): Under a 10 s sync busy loop or 1,520-node CPU-heavy graph (`INC-3773`), `in_process` freezes main for **9.9 s** (`spin_10s`) or causes **8,311–9,330 HTTP errors (100% `/login` timeout failure at 0.5 and 0.25 vCPU)** on `graph_1520`. Both `worker_thread` and `child_process` keep **0 HTTP errors** across all CPU limits, with `/login` p99 at **0.30–0.82 ms** (`--cpus=1`), **33.8–49.6 ms** (`--cpus=0.5`), and **72.1–74.9 ms** (`--cpus=0.25`). Running `child_process` at `nice 19` does not remove the ~50 ms / ~75 ms cgroup-wide CFS quota floor, but trims worst-case `/login` max on `graph_1520` at `0.25` vCPU from `176.0 ms` (`worker_thread`) to **`81.8 ms`**.
5. **Packing 10 concurrent workflows into 1 shared worker saves 7.7–8.5× RAM, but one 5 s busy loop stalls every co-located neighbour by +5.3 s (~8.4×)** (`[ENV-LIN-PC1-JE]`, Exp C): In sweet-spot mode, 10 packed workflows use **`41.1 MiB` (`worker_thread`) / `69.3 MiB` (`child_process`)** settled worker `Anon` vs. **`315.1 MiB` / `592.6 MiB`** across 10 separate workers. However, adding one 5 s spin to a shared worker degrades 5 co-located normal runs from `~720 ms` to **`6,048–6,079 ms`**, whereas separate workers keep normal runs at **`736–770 ms`** (1.06×). *(Architectural note: JL's PoC `ExecutorDataPlane` currently enforces 1 lease per worker; packing required an opt-in override.)*
6. **A main-thread heartbeat watchdog makes `worker_thread` termination deterministic (~2.0 s) for both GC-stalled OOMs and sync busy loops** (`[ENV-LIN-PC1-JE]`, Exp D): While `worker_thread` `resourceLimits` reliably throws `ERR_WORKER_OUT_OF_MEMORY` on rapid contiguous allocations (`364–421 ms`), near-cliff GC thrashing stalls without exiting. A main-thread watchdog (`250 ms` heartbeat RPC, `K = 2,000 ms` threshold) detects and terminates both GC-stalled and spinning workers in **`2,020–2,033 ms` median** (`kill` `2.0–4.8 ms`), with **100% main survival (3/3)** and fresh-worker recovery in **`191–217 ms`**.
7. **Warm 262-step execution overhead is +8.5% (`worker_thread` default) and +8.1% (`child_process` sweet) vs. `in_process`; JL's ~30% `in_process` engine-time gap does not exist on the same compiled bundle** (`[ENV-LIN-PC1-JE]`, Exp F): Default `worker_thread` (`155.3 ms`) is within **+8.5%** of `in_process` (`143.2 ms`), while sweet-spot `worker_thread` (`214.9 ms`, **+26.6%** vs. `in_process` sweet `169.8 ms`) pays V8 `--optimize-for-size` + 4 MiB young-gen GC overhead. `in_process` and worker modes show identical engine+transport scaling once running the same bundle (`coordinatorRpcMs` is only `3.7–6.7 ms` across 35 RPCs).
8. **Uncapped busy loops (10 s and 60 s without Liquid's 2 s cap) confirm full event-loop isolation; Agent Builder's `cluster.put_component_template` schema validation is fast under `@cfworker/json-schema` (`39.9 ms`) and `272.7 ms` under `ajv`** (`[ENV-LIN-PC1-JE]`, Exp E & G): During a 60 s pure-JS spin, `in_process` stalls `/login` to **`91.0 s` p99** while `worker_thread` and `child_process` hold **`0.57–0.61 ms` p99**. For INC-3836 (`cluster.put_component_template`, 18-file `$ref` closure), current Kibana (`@cfworker/json-schema`) compiles+validates in `39.9 ms` (`ajv` takes `272.7 ms`), and worker offload keeps main EL max at `12.5–14.7 ms` with ~3–27 ms IPC overhead.

---

## Environment Matrix

Every table in this document is tagged with one of the environment IDs below.

| Env Tag | OS & Arch | Node.js Binary & Pointer Compression | Native Allocator | Elasticsearch & Payload Size | Kibana Mode | Typical Sample Count (`n`) |
| --- | --- | --- | --- | --- | --- | --- |
| **`[ENV-MAC-FULL]`** | macOS 25.6.0 (`darwin` arm64, Apple Silicon, 18 CPUs) | Custom `v28.0.0-pre` (`v8_enable_pointer_compression=1`, `v8_enable_sandbox=0`) | macOS system `malloc` (libmalloc) | **Real** single-node ES `9.7.0-SNAPSHOT` (`127.0.0.1:9235`), Scenario A real indices | Full Kibana (`scripts/kibana --no-base-path --no-watch`, no `--dev`, Task Manager `500 ms`) | Spawn: `n = 5`; Scenario A: `1 cold + 3 warm`; Isolation: `1 run` (33–973 HTTP polls); Failure: `1 boot/case` |
| **`[ENV-LIN-PC1-JE]`** | Linux `aarch64` Docker (`ubuntu:24.04` on Docker Desktop VM) | Elastic production serverless Node `v24.22.1` (`v8_enable_pointer_compression=1`) | `libjemalloc.so.2` (`LD_PRELOAD`; default or tuned `MALLOC_CONF`) | **Mock** in-container HTTP ES server called via **real `@elastic/elasticsearch` client**: `50` docs for Scenario A small-payload matrix & Exp C/F; `10,000` `/_search` hits + `10,000` ES|QL rows for Exp A | Standalone coordinator harness (`bundle-after` `17.52 MiB`, `capnweb` RPC, loopback `/login` HTTP server in Exp B/E) | Exp A/B(`spin_10s`)/C/D/E/G: **`n = 3`**; Exp F: **`n = 5`**; Exp B(`graph_1520`): `n = 3` (`--cpus=1`), `n = 1` (`0.5`, `0.25`) |
| **`[ENV-LIN-PC1-GLIBC]`** | Linux `aarch64` Docker (`ubuntu:24.04`) | Elastic production serverless Node `v24.22.1` (`pc=1`) | `glibc` `malloc` (control) | **Mock** ES via real `@elastic/elasticsearch` client (`50` docs) | Standalone coordinator harness (`bundle-after`) | `1 cold + 3 warm` (`1,048` steps) |
| **`[ENV-LIN-PC0-JE]`** | Linux `aarch64` Docker (`ubuntu:24.04`) | Stock upstream Node `v24.22.1` (`v8_enable_pointer_compression=0`) | `libjemalloc.so.2` (default) | **Mock** ES via real `@elastic/elasticsearch` client (`50` docs) | Standalone coordinator harness (`bundle-after`) | `1 cold + 3 warm` (`1,048` steps) |
| **`[ENV-LIN-V28-JE]`** | Linux `aarch64` Docker (`ubuntu:24.04`) | Node PR #67288 `v28.0.0-pre` (`pc=1`, `IsolateGroup.supported=true`) | `libjemalloc.so.2` (default / sweet / aggressive) | **Mock** ES via real `@elastic/elasticsearch` client (`50` docs) for `worker_thread`; empty isolates for floor test | Standalone harness (`bundle-after` & empty isolate bench) | `1 cold + 3 warm` (`1,048` steps); `1×` and `10×` isolates |

**Important scope & metric conventions:**
- **Metric names:** Every memory number explicitly states `RSS` (resident set size, includes shared file-backed `.text`/`.rodata` pages), `PSS` (proportional set size), `Anon` (non-reclaimable anonymous RAM from `/proc/<pid>/status` `RssAnon` or `smaps_rollup` `Anonymous`), or `heapUsed` / `heapTotal` (V8 JS heap).
- **Scope:** Every memory number states `worker-only` (single worker PID or worker-only delta), `host-only` (coordinator/main PID), or `combined` (main + worker(s)).
- **Why `Anon` is the pod-sizing metric:** `RSS` double-counts ~55 MiB of shared `node` binary/library pages across *N* `child_process` workers; `PSS` shifts with *N* and mixes reclaimable page cache with non-reclaimable RAM. `Anon` is independent of *N* and non-reclaimable without swap, so pod capacity planning is `main_RSS + N × worker_Anon`.

---

## Baseline: Full-Kibana E2E & Linux Small-Payload Memory Matrix

### Question
What are the cold/warm start times, per-worker `Anon` memory costs (under production pointer compression + `jemalloc`), baseline event-loop isolation, and failure recovery behaviours across `in_process`, `worker_thread`, and `child_process`?

### Setup
- **Full-Kibana E2E (`[ENV-MAC-FULL]`):** Production-like Kibana (`scripts/kibana --no-base-path --no-watch`) with real Elasticsearch `9.7.0-SNAPSHOT` running Scenario A (264 steps), pathological workloads, and destructive worker kill/OOM tests against `bundle-before` (`33.59 MiB`) and `bundle-after` (`17.52 MiB`, minified, ASCII-escaped RegExps, `lodash-es`, `sideEffects: false`).
- **Linux Small-Payload Memory Matrix (`[ENV-LIN-PC1-JE]`, `[ENV-LIN-PC1-GLIBC]`, `[ENV-LIN-PC0-JE]`):** Pre-built `bundle-before` / `bundle-after` run inside Linux `aarch64` Docker across 4 Scenario A runs (262 steps × 4 = 1,048 steps, 11 chunks loaded) using the **real `@elastic/elasticsearch` client** against an in-container mock ES server returning **small payloads (`50` docs)**. Consequently, these Linux matrix numbers reflect **fixed client, runtime, and code cost**, not large-data memory pressure (see Experiment A for 10k-doc workloads).

### Commands
```bash
# Full-Kibana macOS memory & dispatch latency [ENV-MAC-FULL]
node scripts/measure_big_workflow.js --phase memory --warm 3

# Linux Docker small-payload memory & jemalloc tuning [ENV-LIN-PC1-JE]
docker run --rm -v "$WORK:/work:ro" \
  -e LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libjemalloc.so.2 \
  -e MALLOC_CONF="narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0" \
  kibana-remotable-bench:node24-pc \
  node --expose-gc --optimize-for-size /work/.scratch/retest/linux_jemalloc_bench.mjs
```

### Results — Table 1A: Full-Kibana E2E Comparison (`[ENV-MAC-FULL]`)

| Metric (Scope) | `in_process` (Baseline) | `worker_thread` (Bundled) | `child_process` (JL PoC) |
| --- | ---: | ---: | ---: |
| **Bundle size (before → after)** | 33.59 → 17.52 MiB (–48%) | 33.59 → 17.52 MiB (–48%) | 33.59 → 17.52 MiB (–48%) |
| **Standalone spawn-to-ready (cold / warm med, `n=5`)** | — | **62.1 ms / 58.8 ms** | **77.7 ms / 77.6 ms** |
| **In-Kibana dispatch → 1st step (cold / warm)** | 26 ms / 17 ms | **126 ms / 22 ms** | **144 ms / 17 ms** |
| **Worker-only RSS / `heapUsed`: idle** | N/A (shared PID) | N/A (shared PID) | **63 / 4 MiB** |
| **Worker-only RSS / `heapUsed`: settled after +3 warm (1,056 steps)** | N/A | N/A | **185 / 41 MiB** |
| **Combined RSS / `heapUsed`: idle** | 1,423 / 504 MiB | 1,440 / 504 MiB | 1,534 / 508 MiB *(host-only: 1,472 / 504)* |
| **Combined RSS / `heapUsed`: settled after +3 warm** | 1,059 / 513 MiB | **1,093 / 505 MiB** | 1,294 / 547 MiB *(host-only: 1,109 / 506)* |
| **Isolation — Idle `/login` p99 / main EL max** | 15.1 ms / 19.4 ms | 32.5 ms / 25.3 ms | 25.6 ms / 21.2 ms |
| **Isolation — 10 s Liquid busy loop: `/login` p99 / EL max (errs)** | **9,571 ms / 9,571 ms** (0) | **21.7 ms / 18.9 ms** (0)¹ | **12.7 ms / 20.2 ms** (0) |
| **Isolation — 10k `data.map` in `foreach` *(non-repro of INC-3619)***² | **238.5 ms / 283.6 ms** (0) | **23.2 ms / 19.3 ms** (0) | **18.2 ms / 16.5 ms** (0) |
| **Isolation — 1,520-node graph (INC-3773): `/login` p99 / EL max (errs)** | **30,001 ms / 57,814 ms** (**1 timeout**) | **16.2 ms / 56.9 ms** (0, 973 reqs) | **7.9 ms / 51.1 ms** (0, 889 reqs) |
| **Failure — Kill stuck worker: main survives / recovery** | N/A (kills main) | **Yes** / **1,845 ms** (`worker.terminate()`)³ | **Yes** / **1,878 ms** (`SIGKILL`) |
| **Failure — Worker V8 heap cap: main survives / recovery** | N/A (OOMs main) | **Yes** / **GC-thrashed >60 s** (64–96 MiB)⁴ | **Yes** / **2,136 ms** (96 MiB OOM → respawn) |

¹ On `worker_thread`, Liquid's 2,000 ms per-template render limit tripped at `3.6 s`; see Experiment E for uncapped 10 s and 60 s pure-JS spins.  
² **INC-3619 non-reproduction explained:** Commit `12a091bf4751` (`[Workflows] Reuse rendering context in data.map (#290833)`) is already present in this base branch, reducing 1,000-item `data.map` from `72.4 s` to `54–90 ms`. Thus 10k `data.map` blocked main for only `0.28 s` in-process and is a **non-reproduction** of the original INC-3619 stall.  
³ Required calling `stub[Symbol.dispose]()` on worker exit in `RemoteService.startBundledWorker()` so `capnweb`'s `MessagePort` session rejects in-flight RPCs instead of hanging.  
⁴ See Experiment D for OOM probe and main-thread heartbeat watchdog termination (`~2.0 s`).

### Results — Table 1B: Linux Small-Payload Memory Matrix (50-doc Mock ES, 4× Scenario A = 1,048 steps)

| Env Tag | Mode & Config | Spawn → ready | Idle: RSS / PSS / `Anon` (`heapUsed`) [Scope] | Settled (+3 warm): RSS / PSS / `Anon` (`heapUsed` / `heapTotal`) [Scope] |
| --- | --- | ---: | ---: | ---: |
| `[ENV-LIN-PC1-JE]` | `child_process` · `bundle-before` · `jemalloc` (1s decay) | 40.1 ms | 71.5 / 48.6 / **22.7** (5.8) [worker-only] | 191.9 / 165.8 / **133.3** (26.2 / 31.5) [worker-only] |
| `[ENV-LIN-PC1-JE]` | `child_process` · `bundle-after` · `jemalloc` (default, 11s) | 35.0 ms | 63.3 / 40.4 / **19.4** (5.3) [worker-only] | **184.5 / 158.3 / 125.9** (21.3 / 26.4) [worker-only] |
| `[ENV-LIN-PC1-GLIBC]` | `child_process` · `bundle-after` · `glibc` (control) | 32.1 ms | 59.3 / 36.8 / **15.9** (5.3) [worker-only] | 188.5 / 162.7 / **130.4** (21.3 / 27.2) [worker-only] |
| `[ENV-LIN-PC1-JE]` | `worker_thread` · `bundle-after` · `jemalloc` (default) | 38.8 ms | +16.4 / +16.4 / **+14.6** (5.9) [combined Δ] | **+151.5 / +151.6 / +136.1** (22.0 / 26.9) [combined Δ]¹ |
| `[ENV-LIN-PC0-JE]` | `child_process` · `bundle-after` · `jemalloc` (default, 11s) | 32.2 ms | 66.4 / 43.6 / 22.7 (8.3) [worker-only] | 222.8 / 196.9 / **165.7** (30.1 / 35.6) [worker-only] |
| `[ENV-LIN-PC0-JE]` | `worker_thread` · `bundle-after` · `jemalloc` (default) | 35.9 ms | +21.5 / +21.5 / +19.6 (9.2) [combined Δ] | +194.5 / +194.6 / **+180.1** (31.1 / 36.8) [combined Δ]² |

¹ `[ENV-LIN-PC1-JE]` host-only baseline before spawn: `65.4 MiB` RSS / `21.3 MiB` `Anon` (`4.5 MiB` `heapUsed`).  
² `[ENV-LIN-PC0-JE]` host-only baseline before spawn: `65.1 MiB` RSS / `21.3 MiB` `Anon` (`7.2 MiB` `heapUsed`).

### Results — Table 1C: `jemalloc` + V8 Tuning on Serverless Node 24 (`[ENV-LIN-PC1-JE]`, 50-doc Mock ES, 4× Scenario A)

| Mode & Tuning Profile | Settled `Anon` [Scope] | Est. Worker-Only `Anon` | `ΔAnon` After `terminate()` / Exit | Worker `heapUsed` / `heapTotal` | Warm 262-step Wall |
| --- | ---: | ---: | ---: | ---: | ---: |
| `child_process` · Default (`jemalloc` default, 11s settle) | **125.9 MiB** [worker-only] | 125.9 MiB | 0 MiB | 21.3 / 26.4 MiB | 174–217 ms |
| `child_process` · **Sweet spot** (`narenas:2,decay:1000` + `--max-semi-space-size=4 --optimize-for-size`) | **61.3 MiB** [worker-only] | **61.3 MiB** (–51%) | 0 MiB | 20.4 / 23.2 MiB | 255–324 ms |
| `child_process` · Aggressive (`narenas:1,decay:0,tcache:false` + `--max-semi-space-size=2 --max-old-space-size=96 --optimize-for-size`) | **53.1 MiB** [worker-only] | **53.1 MiB** (–58%) | 0 MiB | 21.3 / 23.4 MiB | 290–332 ms |
| `worker_thread` · Default (`jemalloc` default, no flags) | **+155.3 MiB** [combined Δ] | ~149 MiB | +55.9 MiB [combined Δ] | 22.0 / 27.4 MiB | 165–208 ms |
| `worker_thread` · **Sweet spot** (`narenas:2,decay:0` + `--optimize-for-size` + `resourceLimits(young=4,old=96)`) | **+65.5 MiB** [combined Δ] | **~59 MiB** (–60%)³ | +17.4 MiB [combined Δ] | 22.0 / 24.2 MiB | 178–213 ms |
| `worker_thread` · Aggressive (`narenas:1,decay:0,tcache:false` + `--optimize-for-size` + `resourceLimits(young=2,old=96)`) | **+48.4 MiB** [combined Δ] | **~42 MiB** (–72%)³ | +13.2 MiB [combined Δ] | 21.1 / 23.2 MiB | 219–250 ms |

³ Subtracting `+6.3 MiB` host-only `Anon` growth (storing 1,048 step records + mock ES traffic) from combined `ΔAnon` gives **`~59 MiB`** worker-only (`worker_thread` sweet spot) vs. **`61.3–68.0 MiB`** (`child_process` sweet spot) — a `~9–15 MiB` `Anon` advantage for `worker_thread` apples-to-apples, traded against `~11–15 MiB` reusable allocator residue after `terminate()` (`0 MiB` on `child_process` exit).

### Interpretation & Caveats
- **Why JL's report saw ~+600 MiB RSS on main even in `in_process`:** Reproduced in `baseline` (runner disabled) as a transient Kibana boot `external` buffer spike (`482 MiB` → `26 MiB` after settle, `1,990 → 1,118 MiB` RSS on macOS); main `heapUsed` is identical (`505` vs. `504 MiB`).
- **Pointer compression (`pc=1`)** cuts settled worker `Anon` by **~40 MiB (–24%)** vs. `pc=0` (`125.9` vs. `165.7 MiB`).
- **Caveat:** Table 1B/1C reflects fixed code + `@elastic/elasticsearch` client memory under 50-doc mock responses; see Experiment A for large-payload memory.

---

## Experiment A: Large Data Workloads & Heap Cap Containment (`[ENV-LIN-PC1-JE]`)

### Question
How much worker `Anon` and `heapUsed` (idle, peak, settled) does a worker consume when processing realistic large payloads — `10,000` `/_search` hits plus `10,000` ES|QL rows, or a `~50 MiB` intermediate JS object — and does a 96 MiB V8 heap cap contain it without crashing or leaking?

### Setup
- **Environment:** `[ENV-LIN-PC1-JE]` (Linux `aarch64` Docker, serverless Node `v24.22.1` `pc=1`, `libjemalloc2`, `n = 3` runs per configuration).
- **Workloads:**
  - `large_es`: `elasticsearch.search` returning **10,000 hits** (`~3.4 MiB` JSON) → `elasticsearch.esql.query` returning **10,000 rows** (`~2.8 MiB` JSON) → `data.map` + `data.filter` over the hits.
  - `alloc_50mb`: test-only step `test.bench` (`op: 'alloc'`, `mb: 50`) building a ~50 MiB intermediate object/string structure in one step, followed by a summary step.
- **Matrix:** `worker_thread` vs. `child_process` × `default` vs. `sweet` (`MALLOC_CONF="narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0"`, `--optimize-for-size`, 4 MiB young-gen) × `uncapped` vs. `cap96` (`96 MiB` old-space cap).
- **Scope:** `child_process` reports direct worker-only PID `Anon` & `heapUsed`; `worker_thread` reports worker-only `ΔAnon` (process `Anon` minus pre-spawn host baseline) and worker `heapUsed`.

### Command
```bash
docker run --rm -v "$WORK:/work:ro" \
  -e LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libjemalloc.so.2 \
  -e MALLOC_CONF="narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0" \
  kibana-remotable-bench:node24-pc \
  node --expose-gc --optimize-for-size \
  /work/src/dev/remote_bundles/retest/exp_a_large_data.mjs <mode> <profile> <workload> <capMb> 3
```

### Results — Table A (`[ENV-LIN-PC1-JE]`, `n = 3`, median / max)

| Workload | Cap | Mode & Profile | Contained? | Idle `Anon` (worker) | Peak `Anon` med / max (worker) | Settled `Anon` med / max (worker) | `heapUsed` idle / peak / settled (worker) | Wall med / max |
| --- | --- | --- | :---: | ---: | ---: | ---: | ---: | ---: |
| `large_es` (10k hits + 10k ES|QL) | uncapped | `worker_thread` · default | Yes (3/3) | +9.1 MiB | +105.7 / +165.3 MiB | +116.6 / +165.3 MiB | 5.9 / 20.9 / 20.9 MiB | 664.5 / 672.3 ms |
| `large_es` (10k hits + 10k ES|QL) | uncapped | `worker_thread` · **sweet** | Yes (3/3) | +9.9 MiB | **+74.0 / +75.4 MiB** | **+45.8 / +58.0 MiB** | 5.9 / 20.9 / 20.9 MiB | 629.4 / 638.4 ms |
| `large_es` (10k hits + 10k ES|QL) | uncapped | `child_process` · default | Yes (3/3) | 45.1 MiB | 166.6 / 173.8 MiB | 173.7 / 173.8 MiB | 5.3 / 20.2 / 20.2 MiB | 550.0 / 581.6 ms |
| `large_es` (10k hits + 10k ES|QL) | uncapped | `child_process` · **sweet** | Yes (3/3) | 26.3 MiB | **86.1 / 91.2 MiB** | **64.2 / 64.8 MiB** | 5.3 / 19.1 / 19.1 MiB | 628.3 / 646.0 ms |
| `large_es` (10k hits + 10k ES|QL) | **96 MiB** | `worker_thread` · default | Yes (3/3) | +10.7 MiB | +101.1 / +147.5 MiB | +109.3 / +158.0 MiB | 5.9 / 20.9 / 20.9 MiB | 607.1 / 721.7 ms |
| `large_es` (10k hits + 10k ES|QL) | **96 MiB** | `worker_thread` · **sweet** | Yes (3/3) | +9.0 MiB | **+73.6 / +75.1 MiB** | **+42.2 / +57.6 MiB** | 5.9 / 20.0 / 20.0 MiB | 614.9 / 641.2 ms |
| `large_es` (10k hits + 10k ES|QL) | **96 MiB** | `child_process` · default | Yes (3/3) | 47.1 MiB | 163.0 / 165.3 MiB | 165.3 / 171.9 MiB | 5.3 / 20.2 / 20.2 MiB | 564.8 / 575.5 ms |
| `large_es` (10k hits + 10k ES|QL) | **96 MiB** | `child_process` · **sweet** | Yes (3/3) | 26.1 MiB | **93.6 / 94.3 MiB** | **64.8 / 65.2 MiB** | 5.3 / 19.1 / 19.1 MiB | 621.8 / 646.3 ms |
| `alloc_50mb` | uncapped | `worker_thread` · **sweet** | Yes (3/3) | +7.9 MiB | **+33.9 / +35.6 MiB** | **+32.0 / +38.9 MiB** | 5.9 / 26.1 / 16.0 MiB | 460.0 / 534.3 ms |
| `alloc_50mb` | uncapped | `child_process` · **sweet** | Yes (3/3) | 28.4 MiB | **55.0 / 56.5 MiB** | **57.9 / 58.4 MiB** | 5.3 / 25.2 / 15.2 MiB | 466.0 / 499.2 ms |
| `alloc_50mb` | **96 MiB** | `worker_thread` · **sweet** | Yes (3/3) | +9.5 MiB | **+31.4 / +34.0 MiB** | **+31.3 / +36.4 MiB** | 5.9 / 25.9 / 16.0 MiB | 493.0 / 512.9 ms |
| `alloc_50mb` | **96 MiB** | `child_process` · **sweet** | Yes (3/3) | 28.1 MiB | **55.2 / 57.4 MiB** | **57.1 / 59.6 MiB** | 5.3 / 25.4 / 15.2 MiB | 474.6 / 480.6 ms |

### Interpretation & Caveats
- **Sweet-spot tuning cuts large-data peak `Anon` by 30–48% and settled `Anon` by 61–63%:** Even after ingesting 10k search hits + 10k ES|QL rows, tuned `worker_thread` settles at **`45.8 MiB`** `Anon` (peak `74.0 MiB`) and tuned `child_process` settles at **`64.2 MiB`** `Anon` (peak `86.1 MiB`), compared to `116.6` / `173.7 MiB` untuned.
- **96 MiB V8 heap cap containment:** All 16 combinations completed cleanly under the 96 MiB cap (`containedAll: true`). Note that `Anon` can still transiently approach `~94 MiB` on `child_process` (`165 MiB` untuned) because native `jemalloc` slabs and JSON parse buffers live outside V8's old-space limit — making `MALLOC_CONF` decay tuning essential alongside V8 caps.
- **Caveat on `alloc_50mb`:** Under `pc=1` (4-byte pointers + V8 one-byte `SeqOneByteString`/ConsString layout), allocating 50 MiB of ASCII string/array data peaked at `~25–27 MiB` `heapUsed` rather than `50 MiB` due to V8's compact internal representation.

---

## Experiment B: CPU Contention Under Cgroup Quotas (`[ENV-LIN-PC1-JE]`)

### Question
**Worker threads isolate the event loop, not CPU.** On a small ECH / serverless pod where main and worker share one constrained CPU budget (`--cpus=1`, `--cpus=0.5`, `--cpus=0.25`), does main stay responsive while a worker runs a 10 s busy loop or a 1,520-node graph? Does lowering `child_process` OS priority (`nice 19`) help?

### Setup
- **Environment:** `[ENV-LIN-PC1-JE]` inside Docker containers constrained with `--cpus=1`, `--cpus=0.5`, and `--cpus=0.25` (Linux CFS bandwidth control: 100 ms period with `100 ms` / `50 ms` / `25 ms` quota per period).
- **Harness:** Coordinator + loopback `/login`-like HTTP endpoint on main thread, polled every 25 ms by an **independent `worker_thread` load generator** (so client-side timers are unaffected if main stalls), plus `monitorEventLoopDelay({ resolution: 10 })` on main.
- **Workloads:**
  - `spin_10s` (`n = 3`): 10 s pure-JS synchronous CPU burn (`test.bench` `op: 'spin'`, no Liquid).
  - `graph_1520` (`n = 3` at `--cpus=1`; `n = 1` at `--cpus=0.5` and `--cpus=0.25` because each run takes `~165–338 s` of fixed CPU work): 190 `if/else` blocks = 1,520 non-I/O nodes (INC-3773).
- **Modes:** `in_process`, `worker_thread`, `child_process`, and `child_process_nice19` (`os.setPriority(child.pid, 19)`), all with sweet-spot tuning.

### Command
```bash
docker run --rm --cpus=<1|0.5|0.25> -v "$WORK:/work:ro" \
  -e LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libjemalloc.so.2 \
  -e MALLOC_CONF="narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0" \
  kibana-remotable-bench:node24-pc \
  node --expose-gc --optimize-for-size \
  /work/src/dev/remote_bundles/retest/exp_b_cpu_contention.mjs <mode> <spin_10s|graph_1520> sweet <runs>
```

### Results — Table B1: `spin_10s` under Cgroup CPU Limits (`[ENV-LIN-PC1-JE]`, `n = 3`, median / max)

| `--cpus` | Mode | Wall med / max | Main EL p99 med / max | Main EL max med / max | `/login` HTTP p99 med / max | `/login` HTTP max med / max | HTTP Errors |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `1.0` | `in_process` | 10,011 / 10,016 ms | *(blocked 10 s)*¹ | *(blocked 10 s)*¹ | **9,883 / 9,951 ms** | **9,976 / 9,983 ms** | 0 |
| `1.0` | `worker_thread` | 10,007 / 10,010 ms | 12.8 / 12.9 ms | 13.3 / 17.9 ms | **0.42 / 1.14 ms** | 2.45 / 3.51 ms | 0 |
| `1.0` | `child_process` | 10,008 / 10,012 ms | 12.7 / 12.8 ms | 13.2 / 13.3 ms | **0.30 / 1.74 ms** | 0.49 / 8.82 ms | 0 |
| `1.0` | `child_process_nice19` | 10,007 / 10,026 ms | 12.7 / 12.8 ms | 13.3 / 27.8 ms | **0.36 / 1.06 ms** | 0.75 / 18.51 ms | 0 |
| `0.5` | `in_process` | 10,010 / 10,013 ms | *(blocked 10 s)*¹ | *(blocked 10 s)*¹ | **9,933 / 10,027 ms** | **9,975 / 10,027 ms** | 0 |
| `0.5` | `worker_thread` | 10,012 / 10,069 ms | 22.2 / 24.0 ms | 57.5 / 62.7 ms | **37.2 / 47.5 ms** | 51.3 / 57.7 ms | 0 |
| `0.5` | `child_process` | 10,008 / 10,073 ms | 13.1 / 57.1 ms | 57.2 / 64.1 ms | **40.5 / 48.1 ms** | 48.4 / 53.8 ms | 0 |
| `0.5` | `child_process_nice19` | 10,014 / 10,057 ms | 18.2 / 54.7 ms | 57.4 / 73.9 ms | **33.8 / 47.8 ms** | 53.0 / 53.8 ms | 0 |
| `0.25` | `in_process` | 10,098 / 10,099 ms | *(blocked 10 s)*¹ | *(blocked 10 s)*¹ | **9,933 / 10,059 ms** | **9,970 / 10,059 ms** | 0 |
| `0.25` | `worker_thread` | 10,089 / 10,094 ms | 79.5 / 81.4 ms | 90.2 / 94.8 ms | **74.9 / 75.1 ms** | 77.6 / 77.8 ms | 0 |
| `0.25` | `child_process` | 10,092 / 10,101 ms | 81.5 / 82.1 ms | 84.9 / 106.7 ms | **72.1 / 73.3 ms** | 75.4 / 76.2 ms | 0 |
| `0.25` | `child_process_nice19` | 10,096 / 10,098 ms | 80.2 / 81.3 ms | 104.6 / 109.4 ms | **73.7 / 75.2 ms** | 78.9 / 98.8 ms | 0 |

### Results — Table B2: `graph_1520` (INC-3773) under Cgroup CPU Limits (`[ENV-LIN-PC1-JE]`, `n = 3` at `1.0`, `n = 1` at `0.5` / `0.25`)

| `--cpus` (`n`) | Mode | Wall med / max | Main EL p99 med / max | Main EL max med / max | `/login` HTTP p99 med / max | `/login` HTTP max med / max | HTTP Errors |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `1.0` (`n=3`) | `in_process` | 79.1 / 83.3 s | *(blocked)*¹ | *(blocked)*¹ | **11,254 / 19,507 ms** | **11,254 / 19,507 ms** | **8,311** |
| `1.0` (`n=3`) | `worker_thread` | 79.1 / 85.9 s | 12.0 / 12.4 ms | 28.4 / 45.6 ms | **0.69 / 1.11 ms** | 29.4 / 36.9 ms | **0** |
| `1.0` (`n=3`) | `child_process` | 80.8 / 86.5 s | 11.9 / 12.4 ms | 40.7 / 41.5 ms | **0.80 / 1.79 ms** | 29.7 / 32.2 ms | **0** |
| `1.0` (`n=3`) | `child_process_nice19` | 83.4 / 84.5 s | 11.9 / 12.4 ms | 34.7 / 37.2 ms | **0.82 / 1.70 ms** | 24.3 / 28.7 ms | **0** |
| `0.5` (`n=1`) | `in_process` | 165.1 s | *(blocked 165 s)*¹ | *(blocked 165 s)*¹ | **N/A (100% failed)** | **N/A (100% failed)** | **5,181** |
| `0.5` (`n=1`) | `worker_thread` | 168.3 s | 50.0 ms | 77.3 ms | **48.96 ms** | 68.5 ms | **0** |
| `0.5` (`n=1`) | `child_process` | 164.9 s | 49.7 ms | 88.9 ms | **48.91 ms** | 74.6 ms | **0** |
| `0.5` (`n=1`) | `child_process_nice19` | 173.0 s | 51.0 ms | 77.1 ms | **49.59 ms** | 73.3 ms | **0** |
| `0.25` (`n=1`) | `in_process` | 307.5 s | *(blocked 307 s)*¹ | *(blocked 307 s)*¹ | **N/A (100% failed)** | **N/A (100% failed)** | **9,330** |
| `0.25` (`n=1`) | `worker_thread` | 338.3 s | 77.1 ms | 191.9 ms | **74.56 ms** | 176.0 ms | **0** |
| `0.25` (`n=1`) | `child_process` | 318.6 s | 76.8 ms | 102.0 ms | **74.55 ms** | 99.6 ms | **0** |
| `0.25` (`n=1`) | `child_process_nice19` | 309.4 s | 76.7 ms | 102.4 ms | **74.37 ms** | **81.8 ms** | **0** |

¹ In `in_process` mode, `monitorEventLoopDelay` under-reports single-callback synchronous stalls (raw `25.6–100.4 ms`) because `hist.reset()` runs immediately before the synchronous spin enters a single tick; the independent HTTP load-generator Worker measures the true main-thread freeze (`9.9 s` on `spin_10s`, `11.3–19.5 s` + `8,311` errors on `graph_1520` at `1.0` vCPU, and 100% HTTP failure at `0.5`/`0.25` vCPU).

### Interpretation & Caveats
- **The physics of the 50 ms / 75 ms floor:** Linux CFS bandwidth throttling (`cpu.max`) enforces a **100 ms period**. At `--cpus=0.5`, the container gets 50 ms of CPU per 100 ms; once the spinning worker exhausts that 50 ms quota, the kernel throttles the **entire container cgroup** (both main and worker) for the remaining **50 ms** — capping `/login` p99 at `~34–49 ms`. At `--cpus=0.25`, quota is 25 ms and throttle is **75 ms** — capping `/login` p99 at `~72–75 ms`. Main **never** freezes for 10 s or 300 s, and serves 100% of requests with 0 errors.
- **Why `nice 19` does not remove the p99 floor — but helps tail max:** `nice 19` only affects *intra-period* CFS scheduling while the cgroup still has quota; it cannot prevent the worker from consuming the 25 ms/50 ms quota when main is briefly idle between requests. However, when the next 100 ms period opens, `nice 19` ensures main preempts the worker immediately, cutting worst-case `/login` max on `graph_1520` at `0.25` vCPU from `176.0 ms` (`worker_thread`) and `99.6 ms` (`child_process`) down to **`81.8 ms`**.
- **Caveat:** A real Kibana pod under heavy concurrent main-thread HTTP traffic (not just a single 40 RPS `/login` probe) will share the 25–50 ms/period quota between main and worker; a separate worker cgroup (`cpu.max` sub-cgroup for `child_process`) or a per-worker CPU cap would be needed if main itself needs guaranteed >0.2 vCPU during a worker spin.

---

## Experiment C: Packing vs. Noisy-Neighbour Isolation (`[ENV-LIN-PC1-JE]`)

### Question
How do worker `Anon` memory and per-run latency scale when packing `N = 1, 5, 10` concurrent workflows into **1 shared worker** vs. **N separate workers**? And what happens to 5 normal workflows when 1 pathological 5 s busy loop runs in the same shared worker vs. a separate worker?

### Setup
- **Environment:** `[ENV-LIN-PC1-JE]` (`n = 3` per configuration, 50-doc mock ES, Scenario A-like normal workflows).
- **Architectural finding:** JL's PoC `ExecutorDataPlane` intentionally rejects concurrent leases (`Worker already has an active workflow lease`). To measure packing, we added an opt-in override (`KBN_REMOTE_ALLOW_CONCURRENT_LEASES=1`) in `executor_data_plane.ts`.
- **Scenarios:** `pack_1`, `pack_5`, `pack_10` (1 shared worker); `sep_5`, `sep_10` (5 or 10 separate workers); `noisy_shared` (5 normal + 1 × 5 s spin in 1 worker); `noisy_sep` (5 normal + 1 × 5 s spin in 6 separate workers).
- **Scope:** Worker-only `Anon` summed across all active workers (`child_process`: sum of child PIDs; `worker_thread`: combined `ΔAnon` above pre-spawn host baseline).

### Command
```bash
docker run --rm -v "$WORK:/work:ro" \
  -e LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libjemalloc.so.2 \
  -e MALLOC_CONF="narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0" \
  -e KBN_REMOTE_ALLOW_CONCURRENT_LEASES=1 \
  kibana-remotable-bench:node24-pc \
  node --expose-gc --optimize-for-size \
  /work/src/dev/remote_bundles/retest/exp_c_packing.mjs <mode> <profile> <scenario> 3
```

### Results — Table C1: Packing Density (`N = 1, 5, 10`, `[ENV-LIN-PC1-JE]`, `n = 3`, median / max)

| Mode & Profile | Scenario | Peak Worker `Anon` med / max | Settled Worker `Anon` med / max | Normal Run Latency (med / max) |
| --- | --- | ---: | ---: | ---: |
| `worker_thread` · default | `pack_1` / `pack_5` / `pack_10` | 80.2 / 121.8 / 134.1 MiB | 82.5 / 125.2 / 138.9 MiB | 383 / 1,076 / 1,716 ms |
| `worker_thread` · default | `sep_5` / `sep_10` | 425.7 / 817.6 MiB | 430.5 / 818.2 MiB | 697 / 1,108 ms |
| `worker_thread` · **sweet** | `pack_1` / `pack_5` / `pack_10` | **34.1 / 51.7 / 42.4 MiB** | **33.0 / 37.6 / 41.1 MiB** | 468 / 1,107 / 1,877 ms |
| `worker_thread` · **sweet** | `sep_5` / `sep_10` | **159.0 / 316.5 MiB** | **159.6 / 315.1 MiB** *(7.7×)* | 723 / 1,164 ms |
| `child_process` · default | `pack_1` / `pack_5` / `pack_10` | 139.1 / 192.9 / 217.6 MiB | 141.0 / 191.9 / 217.6 MiB | 411 / 1,102 / 1,843 ms |
| `child_process` · default | `sep_5` / `sep_10` | 691.2 / 1,396.2 MiB | 694.2 / 1,397.4 MiB | 702 / 810 ms |
| `child_process` · **sweet** | `pack_1` / `pack_5` / `pack_10` | **58.5 / 91.3 / 92.1 MiB** | **58.5 / 66.8 / 69.3 MiB** | 438 / 1,157 / 1,959 ms |
| `child_process` · **sweet** | `sep_5` / `sep_10` | **292.9 / 594.8 MiB** | **292.3 / 592.6 MiB** *(8.5×)* | 682 / 859 ms |

### Results — Table C2: Noisy Neighbour (5 Normal + 1 × 5 s Spin, Sweet Spot, `[ENV-LIN-PC1-JE]`, `n = 3`)

| Mode (Sweet Spot) | Topology | Settled Worker `Anon` (med / max) | Normal Run Latency (med / max) | Slowdown vs. `sep_5` | Spin Run Wall (med) |
| --- | --- | ---: | ---: | ---: | ---: |
| `worker_thread` | **Shared (1 worker)** | **36.4 / 45.9 MiB** | **6,048 / 6,080 ms** | **8.37× (+5.33 s)** | 5,171 ms |
| `worker_thread` | **Separate (6 workers)** | 178.5 / 206.0 MiB | **770 / 776 ms** | **1.06×** | 5,204 ms |
| `child_process` | **Shared (1 worker)** | **65.8 / 66.1 MiB** | **6,079 / 6,084 ms** | **8.91× (+5.40 s)** | 5,970 ms |
| `child_process` | **Separate (6 workers)** | 340.6 / 343.1 MiB | **736 / 874 ms** | **1.08×** | 5,294 ms |

### Interpretation & Caveats
- **Memory vs. blast-radius trade-off:** Packing 10 normal workflows into 1 sweet-spot worker saves **7.7–8.5× `Anon` RAM** (`41.1` vs. `315.1 MiB` for `worker_thread`; `69.3` vs. `592.6 MiB` for `child_process`), with marginal per-workflow RAM near zero (`+0.9–1.2 MiB`). However, **packing destroys tenant/run isolation**: a single 5 s synchronous loop in a shared worker head-of-line-blocks every co-located workflow by the full 5+ s (and a watchdog kill on that worker aborts all co-located leases).
- **Architectural takeaway:** On memory-constrained pods, packing is viable for **trusted / same-tenant / low-priority** workflows, or with a small pool (e.g., 2–4 workers) where a watchdog-killed worker only affects its own shard — while untrusted or latency-sensitive workloads need dedicated workers (or JL's 1-lease-per-worker default).

---

## Experiment D: `worker_thread` Termination & Main-Thread Watchdog (`[ENV-LIN-PC1-JE]`)

### Question
1. Can `ERR_WORKER_OUT_OF_MEMORY` be made reliable via `resourceLimits`?
2. Can a main-thread watchdog (heartbeat RPC + `eventLoopUtilization()`) deterministically terminate both GC-stalled and sync-spinning workers, keep main alive, and recover cleanly?

### Setup
- **Environment:** `[ENV-LIN-PC1-JE]` (`n = 3` per watchdog case; `n = 1` per OOM probe variant).
- **D1 (OOM Reliability Probe):** Tests `worker_thread` (`resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 2 | 16 }`) and `child_process` (`--max-old-space-size=64`) against `arrays`, `strings`, and `objects` allocations.
- **D2 (Main-Thread Watchdog Prototype):** Sends a lightweight `ping()` heartbeat RPC every `250 ms` and reads `worker.performance.eventLoopUtilization()` (for `worker_thread`). If no heartbeat arrives for **`K = 2,000 ms`**, main disposes the `capnweb` stub, calls `worker.terminate()` / `child.kill('SIGKILL')`, spawns a fresh worker, and runs a recovery workflow. Tested against:
  - `oom_gc_stall`: holds `38 MiB` live under a `64 MiB` cap and continuously churns garbage to induce real GC thrashing.
  - `sync_spin`: infinite synchronous CPU spin.

### Command
```bash
docker run --rm -v "$WORK:/work:ro" \
  -e LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libjemalloc.so.2 \
  -e MALLOC_CONF="narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0" \
  kibana-remotable-bench:node24-pc \
  node --expose-gc --optimize-for-size \
  /work/src/dev/remote_bundles/retest/exp_d_termination.mjs <d1|d2> 3
```

### Results — Table D1: OOM Reliability Probe (`[ENV-LIN-PC1-JE]`)

| Variant | Cap / Young-Gen | Pattern | Outcome | Wall | Natural Exit Error |
| --- | --- | --- | --- | ---: | --- |
| `worker_thread` | 64 MiB / 2 MiB | `arrays` | Rejected (OOM) | 420.8 ms | **`ERR_WORKER_OUT_OF_MEMORY`** |
| `worker_thread` | 64 MiB / 2 MiB | `objects` | Rejected (OOM) | 363.9 ms | **`ERR_WORKER_OUT_OF_MEMORY`** |
| `worker_thread` | 64 MiB / 2 MiB | `strings` | Completed (ConsString fit under cap) | 182.8 ms | — |
| `worker_thread` | 64 MiB / 16 MiB | `strings` | Completed | 239.6 ms | — |
| `child_process` | 64 MiB | `objects` | Rejected (IPC disconnected / OOM) | 361.8 ms | Process aborted |

### Results — Table D2: Main-Thread Watchdog (`K = 2,000 ms`, `[ENV-LIN-PC1-JE]`, `n = 3`, median / max)

| Mode | Fault | Trigger Reason | Time-to-Terminate med / max | Kill Latency med / max | Main Survived? | Fresh-Worker Recovery med / max |
| --- | --- | --- | ---: | ---: | :---: | ---: |
| `worker_thread` | `oom_gc_stall` | `heartbeat_timeout` | **2,033.2 / 2,035.7 ms** | 3.3 / 3.6 ms | **Yes (3/3)** | **192.1 / 242.8 ms** |
| `worker_thread` | `sync_spin` | `heartbeat_timeout` | **2,029.9 / 2,034.7 ms** | 2.0 / 2.1 ms | **Yes (3/3)** | **216.9 / 219.9 ms** |
| `child_process` | `oom_gc_stall` | `heartbeat_timeout` | **2,020.4 / 2,020.8 ms** | 4.8 / 6.4 ms | **Yes (3/3)** | **191.5 / 195.3 ms** |
| `child_process` | `sync_spin` | `heartbeat_timeout` | **2,023.1 / 2,027.6 ms** | 3.6 / 3.7 ms | **Yes (3/3)** | **191.1 / 199.0 ms** |

### Interpretation & Caveats
- **Why a watchdog is required for BOTH `worker_thread` and `child_process`:** V8's `ERR_WORKER_OUT_OF_MEMORY` (and `--max-old-space-size` fatal OOM) only fires when an allocation fails *after* last-resort GC; workloads hovering just below the heap cliff can GC-thrash indefinitely without triggering OOM. A simple main-thread heartbeat watchdog closes both failure modes (GC thrashing *and* infinite sync spins) in **`K + ~20–33 ms`** with `~2–5 ms` kill latency and `~191–217 ms` recovery (respawn + run a new workflow, excluding Task Manager poll delay).
- **Important implementation detail:** Disposing the `capnweb` stub (`stub[Symbol.dispose]()`) on termination is mandatory for `worker_thread` so in-flight RPCs reject immediately instead of leaking promises.
- **Caveat:** `K = 2,000 ms` was chosen for fast test cycles; in production, `K` should exceed legitimate synchronous step bursts (e.g., `5–15 s`) or combine missed heartbeats with sustained `ELU > 0.98`.

---

## Experiment E: Uncapped Busy Loop Without Liquid's 2 s Limit (`[ENV-LIN-PC1-JE]`)

### Question
In the earlier macOS test, `worker_thread` stopped at `3.6 s` due to Liquid's 2 s per-template render cap. Using a test-only step (`test.bench` `op: 'spin'`) that spins pure JS without Liquid, what is main's `/login` latency during full **10 s** and **60 s** CPU spins in every mode?

### Setup
- **Environment:** `[ENV-LIN-PC1-JE]` (unconstrained container CPU, sweet-spot tuning, `n = 3` for both `10 s` and `60 s` across `in_process`, `worker_thread`, `child_process`).
- **Probe:** Independent HTTP load-generator Worker polling `/login` on main every 25 ms, plus `monitorEventLoopDelay({ resolution: 10 })` on main.

### Command
```bash
docker run --rm -v "$WORK:/work:ro" \
  -e LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libjemalloc.so.2 \
  -e MALLOC_CONF="narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0" \
  kibana-remotable-bench:node24-pc \
  node --expose-gc --optimize-for-size \
  /work/src/dev/remote_bundles/retest/exp_e_spin_uncapped.mjs <mode> <10000|60000> 3
```

### Results — Table E (`[ENV-LIN-PC1-JE]`, `n = 3`, median / max)

| Spin Target | Mode | Wall med / max | Main EL p99 med / max | Main EL max med / max | `/login` HTTP p99 med / max | `/login` HTTP max med / max |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| `10 s` | `in_process` | 10,010 / 10,016 ms | *(blocked 10 s)*¹ | *(blocked 10 s)*¹ | **9,891 / 9,913 ms** | **9,944 / 9,962 ms** |
| `10 s` | `worker_thread` | 10,007 / 10,015 ms | 13.2 / 14.6 ms | 15.6 / 15.6 ms | **1.18 / 1.25 ms** | 2.24 / 3.03 ms |
| `10 s` | `child_process` | 10,007 / 10,014 ms | 13.5 / 13.6 ms | 15.6 / 15.7 ms | **1.18 / 1.21 ms** | 1.28 / 3.82 ms |
| `60 s` | `in_process` | 60,009 / 60,018 ms | *(blocked 60 s)*¹ | *(blocked 60 s)*¹ | **91,043 / 95,752 ms**² | **91,338 / 96,041 ms**² |
| `60 s` | `worker_thread` | 60,008 / 60,012 ms | 15.1 / 15.1 ms | 15.6 / 15.8 ms | **0.61 / 0.67 ms** | 3.10 / 3.42 ms |
| `60 s` | `child_process` | 60,007 / 60,011 ms | 15.1 / 15.1 ms | 15.8 / 15.9 ms | **0.57 / 0.64 ms** | 1.90 / 3.06 ms |

¹ Same `monitorEventLoopDelay` single-tick artifact on `in_process` noted in Table B; HTTP probes directly measure the full block.  
² Exceeds 60 s because queued TCP connections and keep-alive backlogs accumulate across the 60 s freeze before draining.

### Interpretation & Caveats
- Without Liquid's 2 s cap, both `worker_thread` and `child_process` execute the full 10 s and 60 s synchronous spins while keeping main's `/login` p99 at **`0.57–1.18 ms`** and main EL max ≤ **`15.9 ms`**, vs. a **9.9 s / 91.0 s** outage in `in_process`.

---

## Experiment F: Warm Execution Overhead (`[ENV-LIN-PC1-JE]`)

### Question
What is the warm 262-step wall time and engine+transport time across `in_process`, `worker_thread`, and `child_process` (default vs. sweet-spot tuning, `n = 5`)? Does JL's ~30% engine-time gap in `in_process` mode still exist?

### Setup
- **Environment:** `[ENV-LIN-PC1-JE]` (50-doc mock ES, `bundle-after`, 1 cold warmup + **`n = 5`** measured warm runs of 262-step Scenario A).
- **Fair `in_process` baseline:** Exported `createInProcess` (`createInProcessExecutor` in `remote_process_entry.ts`) so `in_process` executes the exact same compiled `graph.mjs` bundle directly on the main thread with zero IPC serialization.
- **Breakdown:** Measures total `wallMs`, host-side `coordinatorRpcMs` (time spent in coordinator stub methods across 35 RPC calls/run), and `enginePlusTransportMs = wallMs - coordinatorRpcMs`.

### Command
```bash
docker run --rm -v "$WORK:/work:ro" \
  -e LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libjemalloc.so.2 \
  [-e MALLOC_CONF="narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0"] \
  kibana-remotable-bench:node24-pc \
  node --expose-gc [--optimize-for-size] \
  /work/src/dev/remote_bundles/retest/exp_f_overhead.mjs <mode> <default|sweet> 5
```

### Results — Table F (`[ENV-LIN-PC1-JE]`, `n = 5`, 262 steps warm, median / max)

| Profile | Mode | Wall med / max | Delta vs. `in_process` (same profile) | `enginePlusTransportMs` med / max | `coordinatorRpcMs` med (35 calls) |
| --- | --- | ---: | ---: | ---: | ---: |
| `default` | `in_process` | **143.2 / 174.9 ms** | baseline | 137.5 / 169.3 ms | 5.62 ms |
| `default` | `worker_thread` | **155.3 / 191.3 ms** | **+8.5%** | 151.6 / 187.6 ms | 3.67 ms |
| `default` | `child_process` | **178.2 / 200.1 ms** | **+24.4%** | 174.4 / 196.0 ms | 3.89 ms |
| `sweet` | `in_process` | **169.8 / 193.4 ms** | baseline (+18.6% vs. default) | 163.7 / 187.0 ms | 6.66 ms |
| `sweet` | `worker_thread` | **214.9 / 276.7 ms** | **+26.6%** | 209.5 / 272.3 ms | 4.42 ms |
| `sweet` | `child_process` | **183.6 / 196.7 ms** | **+8.1%** | 179.7 / 193.0 ms | 3.71 ms |

### Interpretation & Caveats
- **Explaining every gap > 10%:**
  1. **`child_process` default (+24.4% vs. `in_process` default):** Pure `capnweb` IPC serialization + kernel pipe/socket round-trips across 35 coordinator RPCs (`+35 ms` / `~1 ms` per RPC + startup JIT tiering on separate process).
  2. **`sweet` profile overhead (`+18.6%` on `in_process`, `+26.6%` on `worker_thread` sweet):** `--optimize-for-size` disables aggressive TurboFan inlining and forces more frequent mark-compact GCs; combining it with `resourceLimits: { maxYoungGenerationSizeMb: 4 }` on `worker_thread` adds extra minor-GC pauses during the 262-step burst (`214.9 ms` med, `276.7 ms` max).
  3. **`child_process` sweet (+8.1% vs. `in_process` sweet):** Almost disappears relative to `in_process` sweet (`183.6` vs. `169.8 ms`) because `--optimize-for-size` adds ~26 ms to `in_process` while `child_process` runs in parallel with the mock ES server on a separate core.
- **JL's ~30% `in_process` engine-time gap:** **Does not exist** when `in_process` runs the same compiled bundle (`137.5 ms` `in_process` vs. `151.6 ms` `worker_thread` vs. `174.4 ms` `child_process`). In JL's earlier benchmark, `in_process` ran unbundled TypeScript/Kibana plugin code inside the full Kibana process while remote modes ran the pre-bundled ESM graph.

---

## Experiment G (Stretch): Agent Builder Schema Offload — INC-3836 (`[ENV-LIN-PC1-JE]`)

### Question
For an Agent Builder-like pure-function offload reproducing INC-3836 (compiling and validating params against the auto-generated JSON Schema for `cluster.put_component_template` as `execute_api` does), how much main-thread blocking occurs `in_process` vs. `worker_thread` vs. `child_process`?

### Setup
- **Environment:** `[ENV-LIN-PC1-JE]` (`n = 3`, sweet-spot tuning).
- **Schema:** Loads the real `cluster.put_component_template` input schema from `@elastic/schemas/es/tools/index.js` plus its full recursive `$ref` closure (**18 shared JSON Schema files**).
- **Validators tested:**
  - `cfworker`: `@cfworker/json-schema` (`new Validator(schema, '2020-12', false)`) — the validator currently used in `x-pack/.../agent_builder/server/services/execution/run_agent/api/validate_params.ts`.
  - `ajv`: `ajv/dist/2020.js` (`new Ajv2020({ strict: false })` + `ajv.compile(schema)`), which does full JS code generation.

### Command
```bash
docker run --rm -w /work -v "$WORK:/work:ro" \
  -e LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libjemalloc.so.2 \
  -e MALLOC_CONF="narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0" \
  -e NODE_PATH=/work/node_modules \
  kibana-remotable-bench:node24-pc \
  node --expose-gc --optimize-for-size \
  /work/src/dev/remote_bundles/retest/exp_g_agent_builder_schema.mjs <mode> <cfworker|ajv> 3
```

### Results — Table G (`[ENV-LIN-PC1-JE]`, `n = 3`, 18-file `$ref` closure, median / max)

| Validator | Mode | Compile med | Validate med | Total Wall med / max | Main EL p99 med | Main EL max med / max |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `@cfworker/json-schema` | `in_process` | 11.6 ms | 22.0 ms | **39.9 / 47.2 ms** | *(33.6 ms sync)* | *(33.6 ms sync)* |
| `@cfworker/json-schema` | `worker_thread` | 11.8 ms | 20.6 ms | **42.6 / 44.6 ms** (+2.7 ms) | 14.6 ms | 14.6 / 14.8 ms |
| `@cfworker/json-schema` | `child_process` | 11.7 ms | 21.5 ms | **41.4 / 48.6 ms** (+1.5 ms) | 14.7 ms | 14.7 / 15.0 ms |
| `ajv` (draft 2020-12) | `in_process` | **260.4 ms** | 12.1 ms | **272.7 / 341.8 ms** | *(272.7 ms sync)* | *(272.7 ms sync)* |
| `ajv` (draft 2020-12) | `worker_thread` | 268.6 ms | 12.4 ms | **285.8 / 323.8 ms** (+13.1 ms) | 12.5 ms | 12.5 / 13.0 ms |
| `ajv` (draft 2020-12) | `child_process` | 279.6 ms | 12.0 ms | **299.0 / 324.9 ms** (+26.3 ms) | 12.5 ms | 12.5 / 12.6 ms |

### Interpretation & Caveats
- **Current Kibana (`@cfworker/json-schema`)** avoids `ajv`'s codegen spike (`11.6 ms` setup + `22.0 ms` validate = `39.9 ms` total), while **`ajv.compile()`** on the 18-file `cluster.put_component_template` closure blocks synchronously for **`260–342 ms`** on main. Offloading to a persistent `worker_thread` or `child_process` eliminates the main-thread stall (`EL max 12.5–15.0 ms`) for just **`1.5–13.1 ms`** of IPC overhead.
- **Caveat:** `validate_params.ts` memoizes the compiled validator per API schema, so `ajv`'s `260–342 ms` cost is a cold-compile spike per distinct large ES API rather than a per-request cost.

---

## Experiment H: 10 Parallel Workflows — 1 Shared vs. 10 Dedicated vs. `in_process` (`[ENV-LIN-PC1-JE]`)

### Question
When executing **10 Scenario A workflows in parallel** (2,620 total steps per batch), how do all five topologies compare on throughput, per-workflow latency, `Anon` memory, and main-thread `/login` responsiveness — both with **unconstrained multi-core CPU** (`default` and `sweet` tuning) and on a **1 vCPU pod (`--cpus=1`)**?
1. `in_process` (10 parallel on main)
2. `1 worker_thread` (10 parallel packed)
3. `1 child_process` (10 parallel packed)
4. `10 worker_threads` (1 workflow each, parallel)
5. `10 child_processes` (1 workflow each, parallel)

### Setup
- **Environment:** `[ENV-LIN-PC1-JE]` (50-doc mock ES, `bundle-after`, `KBN_REMOTE_ALLOW_CONCURRENT_LEASES=1` for packed & `in_process`).
- **Protocol:** Spawns 1 or 10 workers concurrently, runs 1 cold 10-parallel batch (lazy imports), then **`n = 5` warm 10-parallel batches** while an independent HTTP load-generator Worker polls `/login` on main every 15 ms (`monitorEventLoopDelay({ resolution: 10 })` on main).
- **Memory scope:** `child_process` reports direct worker-only `Anon` summed across child PIDs; `worker_thread` and `in_process` report process `ΔAnon` above pre-spawn host baseline.

### Command
```bash
docker run --rm [--cpus=1] -v "$WORK:/work:ro" \
  -e LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libjemalloc.so.2 \
  [-e MALLOC_CONF="narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0"] \
  kibana-remotable-bench:node24-pc \
  node --expose-gc [--optimize-for-size] \
  /work/src/dev/remote_bundles/retest/exp_h_parallel10.mjs <topology> <default|sweet> 5
```

### Results — Table H1: Unconstrained Multi-Core CPU (`[ENV-LIN-PC1-JE]`, `n = 5` warm batches, median / max)

| Profile | Topology | Spawn | Cold Batch | Warm Batch med / max | Per-Run med | Peak `Anon` med / max | Settled `Anon` | Main EL max med / max | `/login` HTTP p99 med / max |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `default` | `in_process` (10×) | 20.3 ms | 1,759 ms | 1,342.7 / 1,427.2 ms | 1,338.6 ms | 228.7 / 256.8 MiB | 193.0 MiB | 142.2 / 161.6 ms | **134.1 / 156.4 ms** |
| `default` | `1 worker_thread` | 43.6 ms | 1,807 ms | 1,422.7 / 1,489.6 ms | 1,422.2 ms | 329.6 / 380.0 MiB | 370.3 MiB | 45.6 / 51.8 ms | **38.8 / 40.9 ms** |
| `default` | `1 child_process` | 48.2 ms | 1,809 ms | 1,473.9 / 1,524.2 ms | 1,472.8 ms | 308.4 / 309.3 MiB | 302.6 MiB | **16.1 / 21.6 ms** | **3.90 / 9.25 ms** |
| `default` | `10 worker_threads` | 67.4 ms | 1,213 ms | 754.4 / 826.8 ms | 749.7 ms | 1,601.3 / 1,777.4 MiB | 1,747.5 MiB | 19.4 / 22.6 ms | 24.8 / 26.8 ms |
| `default` | `10 child_processes` | 86.6 ms | 843 ms | **378.3 / 399.5 ms** | **372.3 ms** | 1,905.5 / 2,256.7 MiB | 2,181.9 MiB | 18.0 / 20.6 ms | 18.8 / 21.8 ms |
| `sweet` | `in_process` (10×) | 18.9 ms | 1,801 ms | 1,515.2 / 1,518.3 ms | 1,510.8 ms | **74.0 / 87.6 MiB** | **53.9 MiB** | 165.8 / 176.3 ms | **160.1 / 162.7 ms** |
| `sweet` | `1 worker_thread` | 43.1 ms | 1,796 ms | 1,576.8 / 1,653.0 ms | 1,573.9 ms | 100.7 / 106.2 MiB | **70.2 MiB** | 52.2 / 58.2 ms | **38.7 / 42.7 ms** |
| `sweet` | `1 child_process` | 48.5 ms | 1,973 ms | 1,734.6 / 1,769.4 ms | 1,733.1 ms | 107.9 / 130.1 MiB | **71.9 MiB** | **15.6 / 22.1 ms** | **7.46 / 8.27 ms** |
| `sweet` | `10 worker_threads` | 70.6 ms | 1,224 ms | 825.5 / 852.9 ms | 818.8 ms | 461.5 / 477.3 MiB | 429.3 MiB | 26.4 / 33.0 ms | 27.5 / 32.5 ms |
| `sweet` | `10 child_processes` | 79.6 ms | 884 ms | **441.0 / 451.9 ms** | **433.3 ms** | 789.5 / 848.2 MiB | 793.3 MiB | 19.3 / 23.4 ms | **12.6 / 17.3 ms** |

### Results — Table H2: Constrained 1 vCPU Pod (`--cpus=1`, Sweet Spot, `[ENV-LIN-PC1-JE]`, `n = 5` warm batches, median / max)

| Topology (`--cpus=1`, sweet) | Spawn | Cold Batch | Warm Batch med / max | Per-Run med | Peak `Anon` med / max | Settled `Anon` | Main EL max med / max | `/login` HTTP p99 med / max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `in_process` (10×) | 18.0 ms | 2,515 ms | **1,863.6 / 1,969.6 ms** | 1,860.0 ms | 54.7 / 69.0 MiB | **43.0 MiB** | 214.2 / 231.9 ms | **206.0 / 392.0 ms** |
| `1 worker_thread` | 44.2 ms | 2,702 ms | **2,068.6 / 2,321.3 ms** | 2,065.2 ms | 86.1 / 109.5 MiB | **69.1 MiB** | 87.4 / 156.9 ms | **63.8 / 132.5 ms** |
| `1 child_process` | 49.4 ms | 2,759 ms | **2,254.1 / 2,309.9 ms** | 2,251.6 ms | 89.6 / 111.0 MiB | **65.7 MiB** | **59.9 / 67.3 ms** | **41.6 / 53.9 ms** |
| `10 worker_threads` | 632.1 ms | 23,884 ms | **14,230.9 / 15,029.3 ms** *(7.6× slower)* | 13,503.1 ms | 370.6 / 375.9 MiB | 361.9 MiB | 206.2 / 297.8 ms | **287.1 / 440.4 ms** |
| `10 child_processes` | 927.9 ms | 25,485 ms | **13,310.0 / 13,871.5 ms** *(7.1× slower)* | 13,037.8 ms | 604.3 / 609.4 MiB | 599.8 MiB | 381.9 / 468.5 ms | **363.4 / 741.1 ms** |

*(0 HTTP errors across all 15 runs.)*

### Results — Table H3: Serverless Pod Envelope (`--cpus=0.125` request vs. `--cpus=2` burst limit, `100 ms` ES latency, Sweet Spot, `[ENV-LIN-PC1-JE]`)

| Topology | Peak Anonymous memory | Batch wall time (`0.125 vCPU`) | Batch wall time (`2 vCPU`) | Main responsiveness (`/login` p99: `0.125` / `2 vCPU`) |
| --- | ---: | ---: | ---: | ---: |
| **In process (today, 10 parallel)** | **53–63 MiB** *(host Δ)* | **29.0 s** | **2.2 s** | **20,675 ms / 1,367 ms** |
| **1 worker thread (10 parallel)** | **73–100 MiB** *(combined Δ)* | **34.7 s** | **1.9 s** | **499 ms / 27.6 ms** |
| **1 child process (10 parallel)** | **75–110 MiB** *(worker-only)* | **36.0 s** | **2.0 s** | **199 ms / 4.9 ms** |
| **10 worker threads (1 each)** | **364–396 MiB** *(combined Δ)* | **328.1 s** *(~5.5 min)* | **4.2 s** | **7,957 ms / 102.4 ms** |
| **10 child processes (1 each)** | **584–612 MiB** *(sum of 10 PIDs)* | **266.7 s** *(~4.4 min)* | **4.8 s** | **20,277 ms / 136.2 ms** |

> **Workload & environment footnote:** Each batch executes **10 concurrent Scenario A workflows** (262 steps/workflow = 2,620 total steps per batch: ES search of 50 alerts, ES|QL query, `data.map`/`data.filter`, 50-item `foreach` with `if`/`data.set`/`data.map`, ES bulk/index, and mocked Slack/AI/Cases/child-workflow steps) against the pre-built 889-step lazy ESM bundle (`17.52 MiB`, 572 chunks, minified, ASCII-escaped, `lodash-es`, `sideEffects: false`). The worker runs the real `@elastic/elasticsearch` client against an in-container mock ES server with a fixed **100 ms** response latency (no jitter) to simulate realistic I/O wait reproducibly; an independent HTTP load-generator Worker polls `/login` on main every 15 ms. Measured in Linux `aarch64` Docker (`ubuntu:24.04`) with `--cpus=0.125` (K8s request floor) and `--cpus=2` (burst limit) on **Elastic production serverless Node `v24.22.1` with V8 pointer compression enabled (`v8_enable_pointer_compression=1`)**, `LD_PRELOAD=libjemalloc.so.2`, and sweet-spot memory tuning (`MALLOC_CONF="narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0"`, V8 `--optimize-for-size`, and a `4 MiB` young-generation cap via `--max-semi-space-size=4` for `child_process` or `resourceLimits.maxYoungGenerationSizeMb: 4` for `worker_thread`). Values are warm-batch medians (`n = 3`, except `n = 1` for 10-worker topologies at `0.125 vCPU` after 1 cold warmup batch); Peak Anonymous memory is total pod `Anon` (`/proc/<pid>/smaps_rollup` `Anonymous`, reported as the `0.125`–`2 vCPU` range).

### Results — Table H4: CPU Cost of Memory Tuning (`default` vs. `sweet`, `--cpus=2`, `100 ms` ES latency, `[ENV-LIN-PC1-JE]`)

Total container CPU time (`user + sys` from `/sys/fs/cgroup/cpu.stat`) across all processes/threads for **40 Scenario A workflows** (1 cold + 3 warm batches of 10 parallel runs = 10,480 steps, idle host load `0.82`):

| Topology (10 parallel) | Untuned (`default`) CPU | Tuned (`sweet`) CPU | CPU saved without tuning | Peak `Anon` (Untuned → Tuned) | Warm Batch Wall (Untuned → Tuned) |
| --- | ---: | ---: | ---: | ---: | ---: |
| **In process (10 parallel)** | **7.72 s** *(7.30u / 0.42s)* | **8.54 s** *(8.06u / 0.48s)* | **–9.6%** *(–0.82 s)* | 238 → **54 MiB** *(4.4×)* | 2.12 → 2.19 s |
| **1 worker thread (10 parallel)** | **8.06 s** *(7.51u / 0.54s)* | **9.41 s** *(8.77u / 0.65s)* | **–14.3%** *(–1.35 s)* | 293 → **109 MiB** *(2.7×)* | 1.77 → 1.95 s |
| **1 child process (10 parallel)** | **8.39 s** *(7.76u / 0.62s)* | **9.97 s** *(9.33u / 0.64s)* | **–15.8%** *(–1.58 s)* | 308 → **106 MiB** *(2.9×)* | 1.84 → 2.01 s |
| **10 worker threads (1 each)** | **28.71 s** *(25.10u / 3.60s)* | **37.86 s** *(34.09u / 3.77s)* | **–24.2%** *(–9.15 s)* | 1,251 → **395 MiB** *(3.2×)* | 3.41 → 4.42 s |
| **10 child processes (1 each)** | **36.60 s** *(32.31u / 4.29s)* | **43.19 s** *(38.83u / 4.37s)* | **–15.3%** *(–6.59 s)* | 1,651 → **625 MiB** *(2.6×)* | 3.78 → 4.63 s |

- **Where the CPU delta comes from:** Kernel `sys` CPU is nearly identical between untuned and tuned (`0.62 → 0.64 s` on `1 child_process`, `4.29 → 4.37 s` on `10 child_processes`), showing that `jemalloc`'s `narenas:2,dirty_decay_ms:0` `madvise()` purging has negligible CPU cost. Almost all of the ~10–16% (24% on `10 worker_threads`) extra CPU is user-space V8 GC from `--optimize-for-size` and the `4 MiB` young-gen cap, trading ~15% CPU for **2.6–4.4× less peak `Anon` RAM**.
- **Topology dominates tuning:** 10 dedicated workers burn **3.5–4.5× more total CPU** than 1 packed worker (`28.7–43.2 s` vs. `8.1–10.0 s`) for the same 40 workflows (10× cold-load/JIT/GC across 10 isolates).

### Interpretation & Caveats
- **Even 10 *normal* workflows degrade `in_process` `/login` latency by ~20×:** On multi-core, `in_process` hits **`160.1 ms`** `/login` p99 (`206.0 ms` on 1 vCPU), whereas `1 child_process` keeps `/login` p99 at **`7.46 ms`** (`41.6 ms` on 1 vCPU) — **21× better** on multi-core and **5× better** on 1 vCPU.
- **Why `10 child_processes` beats `10 worker_threads` by ~1.9× on multi-core (`441 ms` vs. `826 ms` sweet; `378 ms` vs. `754 ms` default):** All 10 `worker_threads` share one Node process's `jemalloc` arenas (`narenas:2` in sweet spot), `libuv` threadpool, and V8 platform threads, whereas 10 `child_processes` get independent allocators and V8 platforms (at ~1.8× higher settled `Anon`: `793` vs. `429 MiB` sweet).
- **Critical pod-sizing rule from `--cpus=1`:** Oversubscribing worker count past the pod's vCPU budget is **catastrophic**. On `--cpus=1`, running 10 parallel workers (`worker_thread` or `child_process`) causes 25–40 runnable OS threads (V8 isolates + GC/TurboFan threads) to thrash 1 vCPU, **slowing batch completion by 7.1–7.6×** (`13.3–14.2 s` vs. `1.86–2.25 s`) and making main `/login` p99 **worse than `in_process`** (`287–363 ms` vs. `206 ms`), while consuming 6–9× more RAM. Worker pool size should be bounded to **`≈ max(1, floor(pod_vcpu))`**.

---

## `node:green_threads` (PR #67288) Verdict (`[ENV-LIN-V28-JE]`)

In our audit of Node PR #67288 (`v28.0.0-pre`, `pc=1`, `IsolateGroup.supported=true`, detailed in `green-threads-remotable-findings.md`), `GreenThread` was dropped for the workflow runner because JL's 889-step bundle actively loads **31 `node:*` built-ins** at runtime in Scenario A (38 across all 572 chunks, including `node:http`, `node:https`, `node:net`, `node:tls`, `node:http2`, `node:dns`, `node:stream`, `node:zlib`, `node:crypto`, and `node:module` for `@elastic/elasticsearch` and `undici`), whereas `GreenThread` hard-blocks all `node:*` imports, exposes only 19 minimal globals, and omits `node::Environment` + `libuv`. On the exact same binary with tuned `jemalloc`, an empty `GreenThread` saves only **~4.3 MiB `Anon`** over an empty `worker_thread` (`+3.2` vs. `+7.5 MiB` at 1×; `2.72` vs. `7.02 MiB` at 10×), which is minor beside Scenario A's **`~49–54 MiB`** workload `ΔAnon` and would vanish if Node I/O built-ins were added back; `GreenThread` is only compelling for high fan-out of tiny pure-JS isolates.

---

## Open Questions

1. **Sub-cgroup CPU isolation for `child_process`:** On `0.25–0.5` vCPU pods (Exp B), `nice 19` cuts tail max spikes but cannot beat the container-wide 50–75 ms CFS throttle floor once a worker burns the pod's quota. Should serverless/ECH pods give `child_process` workers a nested cgroup (`cpu.max`) capped below the pod's total CPU budget so main always retains reserved quota?
2. **Per-worker `resourceLimits` alongside main `--max-old-space-size`:** Currently, setting `--max-old-space-size` on main constrains `worker_thread` `resourceLimits` tuning on Node 24 (fix in progress upstream/internally); confirm exact Node version rollout before relying on `worker_thread` heap caps in production.
3. **Watchdog threshold & lease policy:** What is the right production heartbeat timeout `K` (and/or sustained `ELU > 0.98` window) so legitimate CPU-heavy workflows are not falsely killed while stuck workers are reaped within seconds?
4. **Packing policy in `ExecutorDataPlane`:** JL's PoC enforces 1 lease per worker (`Worker already has an active workflow lease`). Should production keep 1:1 leases for tenant/fault isolation (accepting `~59–61 MiB` `Anon` per concurrent workflow) or introduce a bounded shard pool (`M` workers × `P` leases) for low-priority/same-tenant runs?
5. **Real-world large-data streaming:** Experiment A tested 10k-doc ES/ES|QL responses (`~3.4 MiB` JSON). Workloads pulling 100+ MiB payloads or multiple concurrent 10k-doc steps in one worker will still exceed a 96 MiB V8 cap unless responses are streamed or truncated at the connector boundary.

---

## How to Reproduce

- **Repository & Branch:** `elastic/kibana` worktree on branch **`experiment/remotable-retest`**, commit **`db25b46b7b75d2b30d5e98daecfc92d5417a1835`** (`db25b46b7b75`).
- **Pre-built bundle:**
  ```bash
  node -r @kbn/setup-node-env src/dev/remote_bundles/cli.ts workflows .scratch/retest/bundle-after
  ```
- **Docker image (`kibana-remotable-bench:node24-pc`):**
  Built from tracked `src/dev/remote_bundles/retest/Dockerfile` (`ubuntu:24.04` + `libjemalloc2` + Elastic serverless Node `v24.22.1` `pc=1` copied into `/opt/node24-pc`):
  ```bash
  # Place Elastic serverless Node v24.22.1 linux-arm64 tarball at src/dev/remote_bundles/retest/node-v24.22.1-pc-linux-arm64.tar.gz
  docker build -t kibana-remotable-bench:node24-pc src/dev/remote_bundles/retest
  ```
- **Tracked harness scripts (`src/dev/remote_bundles/retest/`):**
  - `common.mjs`: mock ES server (50-doc or 10k-doc), `capnweb` `RpcTarget` storage/coordinator stubs, worker/child spawners, `/proc/<pid>/status` memory reader.
  - `exp_a_large_data.mjs` · `exp_b_cpu_contention.mjs` · `exp_c_packing.mjs` · `exp_d_termination.mjs` · `exp_e_spin_uncapped.mjs` · `exp_f_overhead.mjs` · `exp_g_agent_builder_schema.mjs` · `exp_h_parallel10.mjs`.
- **Test-only workflow step:** `src/platform/plugins/shared/workflows_extensions/server/steps/data/test_bench_runtime.ts` (gated behind `KBN_REMOTE_ENABLE_TEST_STEPS=1`).

---

## Appendix: Exact Configs & Raw Run Numbers

### A1. Exact Tuning Configurations (`[ENV-LIN-PC1-JE]`)
- **Default:** `LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libjemalloc.so.2`, no `MALLOC_CONF`, `node --expose-gc`, no V8 size caps.
- **Sweet spot:**
  - `LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libjemalloc.so.2`
  - `MALLOC_CONF="narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0"` (or `dirty_decay_ms:1000,muzzy_decay_ms:1000` in Table 1C `child_process` row)
  - V8 flags: `--expose-gc --optimize-for-size` (`child_process` adds `--max-semi-space-size=4`; `worker_thread` adds `resourceLimits: { maxYoungGenerationSizeMb: 4 }`, plus `maxOldGenerationSizeMb: 96` when capped).
- **Aggressive (Table 1C):** `MALLOC_CONF="narenas:1,dirty_decay_ms:0,muzzy_decay_ms:0,tcache:false"`, `--optimize-for-size`, `2 MiB` young-gen, `96 MiB` old-space.
- **Docker CPU limits (Exp B):** `--cpus=1`, `--cpus=0.5`, `--cpus=0.25`.

### A2. Raw Per-Run Values (`[ENV-LIN-PC1-JE]`)

- **Exp F (`wallMs`, `n = 5`):**
  - `default` `in_process`: `[138.1, 140.9, 143.2, 148.0, 174.9]` · `worker_thread`: `[152.8, 155.2, 155.3, 162.4, 191.3]` · `child_process`: `[161.0, 170.7, 178.2, 193.2, 200.1]`
  - `sweet` `in_process`: `[159.4, 160.3, 169.8, 189.6, 193.4]` · `worker_thread`: `[190.9, 210.8, 214.9, 218.7, 276.7]` · `child_process`: `[168.1, 178.1, 183.6, 192.8, 196.7]`
- **Exp A (`large_es` sweet, `peakAnonMiB` / `settledAnonMiB`, `n = 3`):**
  - `worker_thread` uncapped: peak `[72.3, 74.0, 75.4]`, settled `[42.6, 45.8, 58.0]` · cap96: peak `[63.6, 73.6, 75.1]`, settled `[40.4, 42.2, 57.6]`
  - `child_process` uncapped: peak `[84.4, 86.1, 91.2]`, settled `[63.7, 64.2, 64.8]` · cap96: peak `[85.3, 93.6, 94.3]`, settled `[64.1, 64.8, 65.2]`
- **Exp B (`spin_10s` HTTP p99 ms, `n = 3`):**
  - `--cpus=1`: `in_process` `9,882.8 / 9,951.5` · `worker_thread` `0.42 / 1.14` · `child_process` `0.30 / 1.74` · `nice19` `0.36 / 1.06`
  - `--cpus=0.5`: `in_process` `9,933.1 / 10,027.5` · `worker_thread` `37.17 / 47.48` · `child_process` `40.45 / 48.07` · `nice19` `33.79 / 47.80`
  - `--cpus=0.25`: `in_process` `9,933.4 / 10,059.2` · `worker_thread` `74.94 / 75.09` · `child_process` `72.12 / 73.29` · `nice19` `73.74 / 75.23`
- **Exp C (`sweet` noisy neighbour, `normalMedianMs`, `n = 3`):**
  - `worker_thread` shared: `[6039.3, 6047.6, 6080.3]` (`Anon` `[31.6, 36.4, 45.9]`) · separate: `[726.6, 769.7, 775.5]` (`Anon` `[176.4, 178.5, 206.0]`)
  - `child_process` shared: `[6075.1, 6079.2, 6084.0]` (`Anon` `med 65.8 / max 66.1`) · separate: `[735.7, 873.9]` (`Anon` `med 340.6 / max 343.1`)
- **Exp D (Watchdog `timeToTerminateMs` / `recoveryMs`, `n = 3`):**
  - `worker_thread` `oom_gc_stall`: term `[2031.2, 2033.2, 2035.7]`, recov `[189.0, 192.1, 242.8]`
  - `worker_thread` `sync_spin`: term `[2025.4, 2029.9, 2034.7]`, recov `[187.3, 216.9, 219.9]`
  - `child_process` `oom_gc_stall`: term `[2018.1, 2020.4, 2020.8]`, recov `[190.0, 191.5, 195.3]`
  - `child_process` `sync_spin`: term `[2016.7, 2023.1, 2027.6]`, recov `[190.3, 191.1, 199.0]`
- **Exp E (Uncapped spin HTTP p99 ms, `n = 3`, med / max):**
  - `10 s`: `in_process` `9,890.7 / 9,913.0` · `worker_thread` `1.18 / 1.25` · `child_process` `1.18 / 1.21`
  - `60 s`: `in_process` `91,043.2 / 95,751.7` · `worker_thread` `0.61 / 0.67` · `child_process` `0.57 / 0.64`
- **Exp G (`cluster.put_component_template`, `n = 3`, wall med / max):**
  - `cfworker`: `in_process` `39.9 / 47.2 ms` · `worker_thread` `42.6 / 44.6 ms` · `child_process` `41.4 / 48.6 ms`
  - `ajv`: `in_process` `272.7 / 341.8 ms` · `worker_thread` `285.8 / 323.8 ms` · `child_process` `299.0 / 324.9 ms`
