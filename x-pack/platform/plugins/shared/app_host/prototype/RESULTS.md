# App Host prototype results

**Every result below is local workerd (`wrangler dev` 4.157.0 / workerd 2026-11-03), not remote
acceptance.** No Cloudflare account was used, and nothing was deployed. Run date: 2026-11-04 (Node
24.22.1, local ES snapshot, `node scripts/kibana --dev`). Rerun after the review fixes
("[App Host] Review fixes").

## Verdict

| Question | Result |
|---|---|
| Backend prototype GO/NO-GO | **BLOCKED**: remote Cloudflare acceptance has not run. Local results are not GO evidence |
| CPU-limit gate (`app_host:app_cpu_limit`) | **NOT RUN**: mandatory remote gate; `NOT_ENFORCED_LOCALLY` on OSS workerd |
| Latency decision (p95 ≤ 2 s, synthetic) | **NO DECISION**: verified local target only; local p95 is meaningless for the remote topology |
| Production | **NOT EVALUATED** (residency/subprocessor, frontend code, caching economics, scale, availability) |

## What the review fixes changed in the evidence

- **Dispatcher target is verified from host-owned evidence.** Kibana reports
  `dispatcher;desc="scheme=ws,class=loopback,fp=731a85aec9305232"` in `x-app-host-timing`; the tools
  recompute it from `--rpc`, stop on mismatch, and derive local/remote from it (never from a label).
- **Regression, live:** `acceptance --rpc wss://kbn-app-host-proto-dispatcher.example.workers.dev/rpc`
  (remote mode) against this locally configured Kibana → exit 1, verdict `STOPPED`,
  `"Kibana uses a local dispatcher, remote was requested"` (expected `scheme=wss,class=remote,
  fp=a2df8e3740afaf0a`, observed the loopback fingerprint). It stopped after **one** dispatcher
  connection, before the CPU gate. `benchmark` with the same `--rpc` → exit 1, 1 attempted sample,
  `latency: "NO DECISION: dispatcher target not verified"`. Mode guards (exit 2): `--local-workerd`
  with a remote URL, remote mode with `ws://` or a loopback URL (acceptance, benchmark and seam).
- **CPU gate:** `cpuLimitEnforced` / `loopCpuLimited` now require `app_host:app_cpu_limit`; the
  wall-clock bound is a separate assertion; the gate runs first and stops the run on failure.
- **No-invocation claims:** reported `NOT_VERIFIED` without an observer (verdict
  `PASS_WITH_NOT_VERIFIED`, exit 3), separately from the HTTP denial.
- **Negative assertions** check the specific code, the receiver-side close code and whether the Node
  handler ran (see below).

## M1 seam (`npm run seam -- --url ws://127.0.0.1:8787/rpc --local-workerd`)

Exit 0. 24 required assertions `true`, 3 `NOT_ENFORCED_LOCALLY`, 0 failures:

- `NOT_ENFORCED_LOCALLY`: **`loopCpuLimited`, `loopWallBounded`, `loopRecovered`**. The loop
  fixture was not run (OSS workerd ignores Dynamic Worker `limits.cpuMs`; an earlier local run hit
  the 5 s client deadline and then pinned workerd at ~99% CPU until restart). This is the main gate
  for the remote run, and a deadline or a generic error does not pass it.
- `result:42`, `callbackCount:1`, `httpWithoutUpgrade426`, `unauthenticatedInvokeDenied`,
  `wrongTokenDenied`, `wrongTokenSocketClosed`, `missingTokenDenied`, `idleUnauthClosed` (2006 ms),
  `replayDenied` (`app_host:capability_used`), `egressCallback`, `freshModuleState`,
  `concurrentIsolated`, `disconnectRevoked`, `reconnectSucceeded`.
- `fetchBlocked` / `connectBlocked`: both denial reasons are workerd's `globalOutbound: null` policy
  message, `This worker is not permitted to access the internet via global functions like fetch()…`,
  not a DNS/network error.
- `digestMismatchDenied` (`app_host:digest_mismatch`, handler not called), `oversizedBundleDenied`
  (`app_host:invalid_bundle`).
- `misuseDenied`, seven fresh invocations, Node handler called **0** times in each:

  | Case | Contract error |
  |---|---|
  | unknown method | `The RPC receiver does not implement the method "deleteIndex".` |
  | wildcard, alias, array index | `app_host:index_not_granted` |
  | extra field, bad size, size 101 | `app_host:invalid_search` |

- `callbackBudgetEnforced`: first call 41, second `app_host:callback_budget`, Node handler called once.
- Transport limits (receiver side, dispatcher):

  | Case | Result |
  |---|---|
  | 257 KiB ASCII frame | socket closed **1009** before parsing |
  | 90,000 × U+6F22 (90,000 code units, 270,000 UTF-8 bytes) | socket closed **1009** (UTF-8 counting) |
  | control: 70 KiB bundle in a valid frame | `app_host:invalid_bundle`, socket stays open |
  | depth-40 invoke argument | `app_host:rpc_limit`, socket closed **1011** |
  | control: same field at depth 2 | `app_host:invalid_request`, socket stays open |
  | depth-40 callback result (handler ran) | `app_host:rpc_limit` |

The optional raw-stub probe was not rerun. Earlier result (diagnostic, not selected): a raw capnweb
stub in Loader `env` fails with `DataCloneError`; `ctx.exports.Greeter({props:{}})` works.

## M2/M3 Kibana acceptance

`npm run acceptance -- --kibana http://localhost:5601 --rpc ws://127.0.0.1:8787/rpc --wrangler-log <abs path> --local-workerd`:
exit 0, verdict **`PASS`**, mode `local workerd (verified loopback dispatcher fingerprint), not
remote acceptance`. 34 of 37 assertions `true`, 0 failures, `notVerified: []`, and
**`notEnforcedLocally: [cpuLimitEnforced, cpuLoopWallBounded, cpuLoopRecovery]`**.

The same run without `--wrangler-log`: exit 3, verdict **`PASS_WITH_NOT_VERIFIED`**, 26 `true`,
0 failures, **`notVerified: [dispatcherCounterPositiveControl, noFeatureNoInvocation,
package_{digestMismatch,unsupportedHostApi,unknownManifestField,wildcardGrant,oversizedManifest,oversizedBundle}_noInvocation]`**
(`"No dispatcher connection observer …; the invocation count was not measured. The HTTP denial is
asserted separately."`), and the same three `NOT_ENFORCED_LOCALLY`. A remote run has no observer,
so these stay `NOT_VERIFIED` there.

With the observer:

- `dispatcherTargetVerified`: expected = observed `scheme=ws,class=loopback,fp=731a85aec9305232`;
- `dispatcherCounterPositiveControl`: +1 connection for a normal call;
- unauthenticated → 401; reader v1 → `{"appId":"alert-digest","version":"1.0.0","label":"Digest v1","counts":{"high":2,"low":1}}`;
  app list → exactly one `{id,title,version}`;
- `noFeatureDenied403` (route authz, `read_app_host`) and, separately, `noFeatureNoInvocation`
  (0 connections); the list route also returns 403;
- no-index user → 403 `Current user is not authorized to read the app data`; unknown app → 404;
  superuser → 200;
- v1.0.1 / `Digest v2` released externally → served immediately, with no Kibana restart and no
  Worker redeploy;
- digest mismatch, hostApi 2, unknown manifest field, wildcard grant, 17 KiB manifest and 70 KiB
  bundle → 500 with the precise code, each with a separate `_noInvocation` assertion (0 connections);
- superuser + app requesting `.kibana` → `forbidden-index-denied:app_host:index_not_granted`, host
  callbacks 0; unknown host method → `unknown-method:The RPC receiver does not implement the method
  "deleteIndex".`, host callbacks 0; second callback →
  `second-callback-denied:app_host:callback_budget`, host callbacks 1;
- invalid app output → 502 `invalid_app_output`; 20 KiB app output → 502 `invalid_app_result`;
- an 8 s app → 504 at 5006 ms; the next call recovers;
- 6 concurrent slow calls → `[200,200,429,200,429,200]`;
- 4 client-aborted calls release their slots; 4 follow-up calls → 200.

`npm run ui-check` was not rerun (the page and its API are unchanged). Earlier result: page title
`Alert digest`, v1.0.0 / `Digest v1` / high 2 / low 1, then v1.0.1 / `Digest v2` after Refresh; no
foreign scripts, no iframes.

## Benchmark (`npm run benchmark -- --kibana http://localhost:5601 --samples 20 --rpc ws://127.0.0.1:8787/rpc --local-workerd`)

Exit 0. Dispatcher verified on all 20 responses (loopback fingerprint, 0 mismatches). 20/20 Kibana
samples valid (200, verified dispatcher, 1 callback), 20/20 seam samples valid, 0 exceptions.
Fresh-invocation timings: each sample uses a new HTTP request, WebSocket, auth and `LOADER.load`.
They are not cold-isolate, warm-cache or scale-to-zero measurements.

| Metric (ms) | p50 | p95 |
|---|---|---|
| Kibana end-to-end (client) | 11.1 | 14.6 |
| Host total | 7.1 | 8.9 |
| package read+verify | 0.4 | 0.5 |
| WebSocket connect | 2 | 3 |
| authenticate | 0 | 1 |
| invoke (load + run + callback) | 4 | 5 |
| ES callback | 1.6 | 2.0 |
| Raw seam total (no Kibana/ES) | 4 | 6 |

- Decision: `NO DECISION: local workerd p95 14.6 ms says nothing about the remote topology`;
  remote acceptance `BLOCKED`; production `NOT EVALUATED`.
- Calls per invocation: 1 callback.
- Logical JSON bytes, not wire bytes: invoke request 1133, app result 49, callback request 48,
  callback response 160.
- CPU: **unmeasured** (no account telemetry). The configured cap is 50 CPU-ms per app Worker, so the
  upper bound for 40 fresh Workers is 2000 CPU-ms, about $0.00004 at $0.02 per million CPU-ms.
- Creation pricing (published, estimate only): $0.002 per fresh Dynamic Worker beyond 1,000 a month,
  i.e. **~$2 per 1,000 fresh invocations before allowances**. This run would have been $0.08 before
  allowances, had it been remote.
