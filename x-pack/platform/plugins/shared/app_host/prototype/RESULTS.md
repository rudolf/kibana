# App Host prototype results

This file has two parts: the third-party UI cut (below, newest) and the earlier backend results.
The backend acceptance was re-run at each UI milestone (`seam` and `acceptance --local-workerd`: exit 0,
verdict PASS, 34 of 37 true, the same three `NOT_ENFORCED_LOCALLY` CPU checks, no failures).

## Third-party UI cut (U1–U3) — local results

**Synthetic data, local only.** Local ES snapshot 9.7.0, `node scripts/kibana --dev --no-base-path`
(started with `KBN_HMR=false`), local `wrangler dev` 4.157.0. Node 24.22.1. Browsers: the Playwright
browsers already installed for the worktree (Chromium 153.0.8010.12, Firefox 155.0, WebKit 26.6); no browser
was downloaded. No Cloudflare account, deploy, secret write, push or PR. Run date: 2026-11-04.

Spec: `kibana-apps-ui-cut-spec.md` §7 (T1–T14) plus the security sign-off conditions S1–S11. G1–G6 are
production gates and are **not implemented**.

### Verdict

| Question | Result |
|---|---|
| U1 stop gate (final-wire CSP composition, sandbox delivery and script loading through the public post-response hook, three engines) | **PASSED**: no Core or sandbox relaxation was needed |
| T1–T14 local acceptance | See the table below; **0 FAIL** in the final run. Unverified network channels are reported as `NOT_VERIFIED`, observed leaks as `KNOWN_LEAK` |
| Backend acceptance (`seam`, `acceptance --local-workerd`) | **PASS** at every milestone (CPU checks `NOT_ENFORCED_LOCALLY`, unchanged) |
| Cloudflare remote run | **BLOCKED** (not run; still needs separate approval) |
| Zero-egress / DNS / WebRTC / timing | **NOT VERIFIED** (no network observer); not a containment claim |
| Production | **NOT EVALUATED** (G1–G6 open) |

### Milestones

| Milestone | Commit | Gate run (all three engines unless noted) |
|---|---|---|
| U1 shell (no data capability) | `47d278d100a4` | T1/T6: 121 PASS (incl. HTTP); T5 re-run after a harness fix: 21 PASS, 9 DIAGNOSTIC; Jest 144; seam + acceptance PASS |
| U2 delegation + consent | `624e798dd00c` | T9, T2, T7, T11–T14, T1, T5, T6, T9 browser: 183 PASS, 0 FAIL, 1 NOT_VERIFIED, 12 DIAGNOSTIC; Jest 166; seam + acceptance PASS |
| U3 adversarial + attribution | this commit | **final full run below** |

### Final full run (`npm run ui:security -- --kibana http://localhost:5601 --engines chromium,firefox,webkit`)

All 15 suites, 756 s: **270 PASS, 0 FAIL, 10 NOT_VERIFIED, 4 KNOWN_LEAK, 15 DIAGNOSTIC**
(report: `.local/ui_security-final.json`, git-ignored).

| Test | HTTP / Jest | Chromium | Firefox | WebKit | Notes |
|---|---|---|---|---|---|
| T1 shell, direct-open, headers | 31 PASS | 17 PASS | 17 PASS | 17 PASS | S1/S2/S3/S6/S7; eval/Function/WASM/dynamic import/script injection/inline script+handler blocked; 0 app-surface CSP reports with a positive collector control |
| T2 real scoped delegation | 8 PASS | 2 PASS | 2 PASS | 2 PASS | positive / global-only / no-index / no-dashboard / superuser matrix; dispatcher observer positive control |
| T3 XSS + compromised UI | Jest | 7 PASS | 7 PASS | 7 PASS | literal rendering; **successful permitted reads by hostile code**, audited; S10 title canary |
| T4 egress channels | — | 12 PASS | 12 PASS | 12 PASS | + per engine: 3/3/2 NOT_VERIFIED, 1/1/2 KNOWN_LEAK, 1 DIAGNOSTIC; SameSite=None fixture NOT_VERIFIED |
| T5 chrome, top nav, popups | — | 7 PASS | 7 PASS | 7 PASS | 3 DIAGNOSTIC each (history, fragment, click reloads) |
| T6 bootstrap spoof/replay, S4 flood | Jest (`messageerror`) | 7 PASS | 7 PASS | 7 PASS | correct-child positive control; 1 DIAGNOSTIC each (Kibana's own top listener) |
| T7 bypass / cross-app / CSRF | 18 PASS | — | — | — | incl. S1 headers on 400/403/404/413 |
| T8 revoke / update / v2 | Jest (pending read, expiry) | 6 PASS | 6 PASS | 6 PASS | disable, tamper, unapproved v2, S10, approved v2 (UI + server label, 0 Kibana restarts, 0 Wrangler reloads), logout |
| T9 parser / DoS | 4 PASS + Jest | 1 PASS | 1 PASS | 1 PASS | S11 lease caps; bucket shared across leases; 4 KiB body; real 33 KiB frame terminates; CPU loop NOT_VERIFIED |
| T10 attribution | 8 PASS | 1 PASS | 1 PASS | 1 PASS | S9, S11 (secret absent from window/port messages and from audit, Kibana, security-audit and `http.server.response` debug logs) |
| T11 never-delegable corpus | 2 PASS + Jest | — | — | — | 39 non-delegable ops / ES\|QL / DSL-field probes unsupported; 14 system/audit/pattern/CCS indices denied (S8) |
| T12 installer / approval / scope map | 11 PASS | — | — | — | non-superuser, mixed identities, unavailable ES, unreadable dashboard, downgrade; scope-map/egress/scope/index changes refused even if approved |
| T13 uniform errors / oracles | 3 PASS + Jest | — | — | — | real ES and Kibana 403s; existing vs missing ungranted id identical; Jest fault injection with canaries |
| T14 state / space / buckets | 4 PASS | — | — | — | superuser in empty space refused before service I/O |

### Conditions S1–S11

| # | Status | Evidence |
|---|---|---|
| S1 | **Met** | Composed from `http.csp.header` (never the response); T1 403 guardian/frame and T7 400/403/404/413 carry the composed policy, empty report-only and JSON sandbox policy; Jest covers 400/403/404/500 with an empty Boom header set |
| S2 | **Met** | Post-Core `Referrer-Policy`, `Permissions-Policy`, `X-DNS-Prefetch-Control: off`, `Cache-Control: no-store`, `nosniff` on every app surface; `/app/home` and `/api/status` keep Core's values (T1) |
| S3 | **Met** | Attribute snapshots of both iframes (T1, three engines) |
| S4 | **Met** | Source/origin checked before `data`; two handshake messages, then listeners removed; control port for lifecycle; 1,000 × 1 MiB flood ran no guardian handler and caused no rebind (T6); `messageerror` terminates (Jest) |
| S5 | **Met (Jest), live redirect fixture not run** | `asResponse`+`rawResponse`, default `prependBasePath`, final URL must equal the initial path, status 200, 256 KiB cap before parsing, `body.id === grantedId`; Jest: alias match → `app_denied`, followed redirect / redirect error / oversized body (declared and streamed) → `app_unavailable`. No live `server.selfHttp.maxRedirects: 1` restart with a redirecting fixture |
| S6 | **Met** | Assets under `/api/app_host/ui_assets/`, 404 for unknown/unapproved/tampered; top-level bad-digest navigation keeps the session (T1); tamper (T8) |
| S7 | **Met** | appId, approved release digest, no query string, before any HTML; markup canary not reflected (T1) |
| S8 | **Met** | Schema literal + evaluator assertion for the Worker and UI paths; other concrete indices rejected at parse even when approved (Jest, T12); T11 index corpus |
| S9 | **Met** | Worker-path `HostEs` callbacks recorded with the wrapper correlation id (T10, Jest) |
| S10 | **Met** | Title canary literal in chrome (T3); no v1 frame while the v2 prompt is visible (T8) |
| S11 | **Met** | Secret in JSON body, stored as SHA-256, constant-time compare; absent from logs with response debug logging on and from window/port messages (T10); 5th/33rd lease refused (T9); non-empty egress rejected (Jest, T12) |


### Deviations from the spec (with reasons)

- **Asset path**: `/api/app_host/ui_assets/{file}` instead of `/plugins/appHost/ui_assets/{uiDigest}.js` (the S6
  option: `/api/` paths are never re-rendered by the security plugin). The two host scripts have fixed names
  (`host-guardian.js`, `host-child.js`) and are served from constants in the plugin.
- **Lease secret** travels in the execute JSON body, not an `x-app-host-lease` header (S11).
- **Ingress pacing**: frames above 60/s (burst 16) wait in the bounded queue instead of terminating the session;
  queue overflow (256 KiB or 1,024 frames), non-string frames, >32 KiB frames, `messageerror`, >128 live stubs
  and 8 invalid calls still terminate. capnweb sends about three frames per call, so termination broke
  ordinary sequential use.
- **Theme** is not pushed at bootstrap; the UI reads it with `getTheme()`.
- **`app_expired` is HTTP 403**, not 401: Kibana's browser client treats any 401 as an expired Kibana session.
- **consent.json carries no index list** (the spec fixes its keys). S8's "consent naming another index" case is
  covered by the grant fingerprint (which includes the indices) and the manifest parse, which rejects any other
  index even when approved.
- **Native summary semantics**: once an approval file exists only the enabled, approved UI release runs; without
  one only legacy backend-only manifests run. `acceptance` therefore needs `ui:operator -- reset` first.
- **S5 live redirect fixture** (`server.selfHttp.maxRedirects: 1` restart plus a redirecting route) was not run;
  the redirect/alias/oversize paths are covered by Jest with a fake self client.
- **Not built / not run**: the SameSite=None HTTPS cookie fixture, the infinite-UI-loop diagnostic, DNS/STUN
  observers. All reported as `NOT_VERIFIED`.
- **Dashboard correlation** with Kibana's own security audit is by user + dashboard id in the URL + time (the
  native record is an `http_request` event); there is no shared request id.
- **Origin**: Kibana must be used through the configured `server.publicBaseUrl` origin (here
  `http://localhost:5601`); another origin fails the guardian's parent-origin check and the lease `Origin`
  check (fail closed).
- **Dev mode**: Kibana runs with `KBN_HMR=false`; with HMR the rspack watcher reloads open pages whenever files
  under `prototype/.local` change.
- No paths outside `x-pack/platform/plugins/shared/app_host/` were changed.

### Final-wire headers (curl-equivalent, synthetic viewer, `Sec-Fetch-Dest: iframe`)

Guardian (`/api/app_host/ui/alert-digest/<releaseDigest>/guardian`, 200):

```
content-security-policy: script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; form-action 'self'; frame-src 'self' kibana.estccdn.com play.vidyard.com videos.elastic.co ela.st; frame-ancestors 'self', default-src 'none'; script-src http://localhost:5601/api/app_host/ui_assets/host-guardian.js; style-src 'unsafe-inline'; frame-src http://localhost:5601/api/app_host/ui/alert-digest/<releaseDigest>/frame; base-uri 'none'; form-action 'none'; frame-ancestors http://localhost:5601
content-security-policy-report-only: (empty)
referrer-policy: no-referrer
permissions-policy: accelerometer=(), autoplay=(), bluetooth=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), web-share=(), xr-spatial-tracking=()
x-dns-prefetch-control: off
cache-control: no-store
x-content-type-options: nosniff
content-type: text/html; charset=utf-8
```

Frame (`…/frame`, 200): same non-CSP headers, and

```
content-security-policy: script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; form-action 'self'; frame-src 'self' kibana.estccdn.com play.vidyard.com videos.elastic.co ela.st; frame-ancestors 'self', sandbox allow-scripts; default-src 'none'; script-src http://localhost:5601/api/app_host/ui_assets/host-child.js http://localhost:5601/api/app_host/ui_assets/<uiDigest>.js; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors http://localhost:5601
content-security-policy-report-only: (empty)
```

Asset (`/api/app_host/ui_assets/<uiDigest>.js`, 200, unauthenticated): same non-CSP headers, and

```
content-type: application/javascript; charset=utf-8
content-disposition: attachment; filename="app-host-asset.js"
content-security-policy: <Core policy without reporting>, sandbox; default-src 'none'; frame-ancestors 'none'
content-security-policy-report-only: (empty)
```

Guardian without iframe fetch metadata (403 JSON, Boom path, S1): `content-security-policy: <Core policy without
reporting>, sandbox; default-src 'none'; frame-ancestors 'none'`, empty report-only, `referrer-policy:
no-referrer`, the deny-all `permissions-policy`, `x-dns-prefetch-control: off`, `cache-control: private, no-cache,
no-store, must-revalidate` (Kibana's error value; contains `no-store`).

Control, a normal Kibana route (`/app/home`, 200) — unchanged Core headers:

```
content-security-policy: script-src 'report-sample' 'self'; worker-src 'report-sample' 'self' blob:; style-src 'report-sample' 'self' 'unsafe-inline'; object-src 'report-sample' 'none'; form-action 'report-sample' 'self'; frame-src 'report-sample' 'self' kibana.estccdn.com play.vidyard.com videos.elastic.co ela.st; frame-ancestors 'self'; report-uri http://127.0.0.1:5699/csp-report
content-security-policy-report-only: default-src 'report-sample' 'none'; font-src 'report-sample' 'self'; img-src 'report-sample' 'self' data: tiles.maps.elastic.co; connect-src 'report-sample' 'self' telemetry.elastic.co …; report-uri http://127.0.0.1:5699/csp-report
referrer-policy: strict-origin-when-cross-origin
permissions-policy: camera=(), display-capture=(), fullscreen=(self "https://play.vidyard.com"), geolocation=(self), microphone=(), web-share=()
(no x-dns-prefetch-control)
```

`report-uri` points at the harness's synthetic local collector (configured for this run only).

### Observed leaks, residuals and unverified channels (reported, not hidden)

- **WebKit TCP connection (`KNOWN_LEAK`)**: during the hostile probe window (which includes
  `<link rel=preconnect href=receiver>`), the local receiver accepted one TCP connection with **no** HTTP
  request in WebKit (0 in Chromium and Firefox). Most likely the preconnect; the harness does not attribute
  sockets to elements. CSP did not stop the socket: treat it as a timing/existence channel.
- **Exact frame path + query (`KNOWN_LEAK`, accepted residual in the sign-off)**: CSP path matching ignores the
  query string, so the child may navigate itself to `<exact frame URL>?<data>`. The request reaches Kibana (and
  its logs); S7 answers 404 JSON (no document) and the guardian revokes on the reload. All three engines.
- **DNS prefetch, WebRTC/STUN: `NOT_VERIFIED`**. ICE gathering produced candidates (2/4/1 host candidates in
  Chromium/Firefox/WebKit) toward `stun:127.0.0.1:3478`; no UDP or DNS observer was provisioned, so packet
  absence is not claimed. Zero Playwright HTTP requests are not treated as proof.
- **Joint session history (diagnostic)**: `history.back()` from the frame navigated the **top** Kibana page in
  WebKit; Chromium and Firefox kept the top URL. Not claimed as blocked.
- **WebKit iframe `load` on fragment navigation (diagnostic)**: a same-document `#fragment` navigation in the
  child fires the iframe element's `load` event in WebKit, which the guardian treats as a reload and revokes
  (fail closed). Hash-routing apps would be revoked in WebKit. Some blocked click actions (download / `_top`
  link / form) also end in a child reload in WebKit; no popup, download, top navigation or form submission
  happened in any engine.
- **Structured clone before validation**: the browser clones every incoming port message before the bounded
  transport sees it; the S4 flood (1,000 × 1 MiB to the guardian and to top) never ran a guardian handler after
  the handshake, but Kibana's own single top-window `message` listener ran ~1,000 times (diagnostic).
- **Tab DoS / CPU**: an iframe is not a CPU quota; no infinite-loop diagnostic was run (`NOT_VERIFIED`).
- **SameSite=None HTTPS fixture: `NOT_VERIFIED`** (not built). Blocked channels sent no request at all
  (receiver and Kibana counters), independent of cookie attributes; credentialed `fetch` to Kibana with
  `credentials:'include'` never reached Kibana.
- **Lease ids in Kibana's access logs**: `http.server.response` debug logs contain execute URLs, so lease ids
  (not secrets) appear there. The bridge audit records contain neither ids nor secrets; the secret never
  appears in any log (checked with debug logging on).
- Already-delivered data cannot be recalled; a compromised UI holds the app's grant (T3 shows successful reads).

## Backend prototype results

**Every result below is local workerd (`wrangler dev` 4.157.0 / workerd 2026-11-03), not remote
acceptance.** No Cloudflare account was used, and nothing was deployed. Run date: 2026-11-04 (Node
24.22.1, local ES snapshot, `node scripts/kibana --dev`). Rerun after the review fixes
("[App Host] Review fixes").

### Verdict

| Question | Result |
|---|---|
| Backend prototype GO/NO-GO | **BLOCKED**: remote Cloudflare acceptance has not run. Local results are not GO evidence |
| CPU-limit gate (`app_host:app_cpu_limit`) | **NOT RUN**: mandatory remote gate; `NOT_ENFORCED_LOCALLY` on OSS workerd |
| Latency decision (p95 ≤ 2 s, synthetic) | **NO DECISION**: verified local target only; local p95 is meaningless for the remote topology |
| Production | **NOT EVALUATED** (residency/subprocessor, frontend code, caching economics, scale, availability) |

### What the review fixes changed in the evidence

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

### M1 seam (`npm run seam -- --url ws://127.0.0.1:8787/rpc --local-workerd`)

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

### M2/M3 Kibana acceptance

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

### Benchmark (`npm run benchmark -- --kibana http://localhost:5601 --samples 20 --rpc ws://127.0.0.1:8787/rpc --local-workerd`)

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
