# App Host prototype results

**Every result below is local workerd (`wrangler dev` 4.157.0 / workerd 2026-11-03), not remote
acceptance.** No Cloudflare account was used, and nothing was deployed. Run date: 2026-11-04 (Node
24.22.1, local ES snapshot, `node scripts/kibana --dev`).

## Verdict

| Question | Result |
|---|---|
| Backend prototype GO/NO-GO | **BLOCKED**: remote Cloudflare acceptance has not run. Local results are not GO evidence |
| Latency decision (p95 ≤ 2 s, synthetic) | **NO DECISION**: local p95 is meaningless for the remote topology |
| Production | **NOT EVALUATED** (residency/subprocessor, frontend code, caching economics, scale, availability) |

## M1 seam (`npm run seam -- --url ws://127.0.0.1:8787/rpc --probe-url ws://127.0.0.1:8788/rpc --local-workerd`)

All required assertions are `true`: `result:42`, `callbackCount:1`, `httpWithoutUpgrade426`,
`unauthenticatedInvokeDenied`, `wrongTokenDenied`, `wrongTokenSocketClosed`, `missingTokenDenied`,
`idleUnauthClosed` (closed after ~2009 ms), `replayDenied`, `fetchBlocked`, `connectBlocked`,
`egressCallback`, `digestMismatchDenied`, `oversizedBundleDenied`, `misuseDenied` (unknown method,
wildcard, alias, array index, extra field, bad size, size 101), `callbackBudgetEnforced`,
`oversizedMessageRejected` (257 KiB, 1009 close), `deepMessageRejected`, `deepCallbackResultRejected`,
`freshModuleState`, `concurrentIsolated`, `disconnectRevoked` and `reconnectSucceeded`.

- `loopBounded` / `loopRecovered`: **NOT_ENFORCED_LOCALLY**. OSS workerd ignores Dynamic Worker
  `limits.cpuMs`. Without the flag, an infinite loop hits the 5 s client deadline, then pins workerd at
  ~99% CPU, and later connections time out until `wrangler dev` restarts. This is the main gate for
  the remote run.
- Raw capnweb stub in Loader `env` (diagnostic, not selected): **fails** with
  `DataCloneError: () => {} could not be cloned.`
- `ctx.exports.Greeter({props:{}})` in Loader `env`: **works** (`"hello probe"`). The unspecialised
  `ctx.exports.Greeter` fails with `DataCloneError: Could not serialize object of type
  "LoopbackServiceStub"`.

## M2/M3 Kibana acceptance (`npm run acceptance -- ... --wrangler-log ... --local-workerd`)

26 of 28 assertions pass. The remaining two, the CPU-loop pair, report `NOT_ENFORCED_LOCALLY`:

- unauthenticated → 401;
- reader v1 → `{"appId":"alert-digest","version":"1.0.0","label":"Digest v1","counts":{"high":2,"low":1}}`;
- app list → exactly one `{id,title,version}` entry;
- no-feature user → 403 `read_app_host` from route authz, with **0 dispatcher connections**
  (positive control: +1 for a normal call). The list route also returns 403;
- no-index user → 403 `Current user is not authorized to read the app data` (ES denial normalized);
- unknown app → 404;
- superuser → 200;
- v1.0.1 / `Digest v2` released externally → served immediately, with no Kibana restart and no
  Worker redeploy;
- digest mismatch, hostApi 2, unknown manifest field, wildcard grant, 17 KiB manifest and 70 KiB
  bundle → 500 with a precise code and **0 dispatcher connections**;
- superuser + app requesting `.kibana` → `forbidden-index-denied`; unknown host method →
  `unknown-method-denied`; second callback → `second-callback-denied`;
- invalid app output → 502 `invalid_app_output`; 20 KiB app output → 502 `invalid_app_result`;
- an 8 s app → 504 at 5007 ms; the next call recovers;
- 6 concurrent slow calls → `[200,200,429,200,200,429]`;
- 4 client-aborted calls release their slots; 4 follow-up calls → 200.

`npm run ui-check`: page title `Alert digest`, `Installed version 1.0.0`, label `Digest v1`, table
high 2 / low 1. After an external v2 release and **Refresh**: `Installed version 1.0.1`,
`Digest v2`. No foreign scripts, no iframes.

## Benchmark (`npm run benchmark -- --kibana http://localhost:5601 --samples 20 --rpc ws://127.0.0.1:8787/rpc`)

Fresh-invocation timings: each sample uses a new HTTP request, WebSocket, auth and `LOADER.load`.
They are not cold-isolate, warm-cache or scale-to-zero measurements. 20/20 → 200, 0 exceptions,
0 timeouts.

| Metric (ms) | p50 | p95 |
|---|---|---|
| Kibana end-to-end (client) | 10.2 | 20.6 |
| Host total | 6.7 | 12.7 |
| package read+verify | 0.4 | 0.8 |
| WebSocket connect | 2 | 3 |
| authenticate | 0 | 1 |
| invoke (load + run + callback) | 4 | 5 |
| ES callback | 1.3 | 2.2 |
| Raw seam total (no Kibana/ES) | 4 | 5 |

- Calls per invocation: 1 callback.
- Logical JSON bytes, not wire bytes: invoke request 1133, app result 49, callback request 48,
  callback response 160.
- CPU: **unmeasured** (no account telemetry). The configured cap is 50 CPU-ms per app Worker, so the
  upper bound for 40 fresh Workers is 2000 CPU-ms, about $0.00004 at $0.02 per million CPU-ms.
- Creation pricing (published, estimate only): $0.002 per fresh Dynamic Worker beyond 1,000 a month,
  i.e. **~$2 per 1,000 fresh invocations before allowances**. This run would have been $0.08 before
  allowances, had it been remote.
