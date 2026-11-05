# App Host prototype results

This file has two parts: the third-party UI cut (below, newest) and the earlier backend results.
The backend acceptance was re-run at each UI milestone and after the UI review fixes (`seam` and
`acceptance --local-workerd`: exit 0, verdict PASS, 34 of 37 true, the same three `NOT_ENFORCED_LOCALLY`
CPU checks, no failures).

## Third-party UI cut (U1–U3) — local results

**Synthetic data, local only.** Local ES snapshot 9.7.0, `node scripts/kibana --dev --no-base-path`
(started with `KBN_HMR=false`), local `wrangler dev` 4.157.0. Node 24.22.1. Browsers: the Playwright
browsers already installed for the worktree (Chromium 153.0.8010.12, Firefox 155.0, WebKit 26.6); no browser
was downloaded. No Cloudflare account, deploy, secret write, push or PR. Run date: 2026-11-04/05.

Spec: `kibana-apps-ui-cut-spec.md` §7 (T1–T14) plus the security sign-off conditions S1–S11 and, after the
review fixes, the spec's "Implementation conformance review" (P1 1–3, P2 4–6) and the security review's
follow-ups F1–F7. G1–G6 are production gates and are **not implemented**.

### Verdict

| Question | Result |
|---|---|
| U1 stop gate (final-wire CSP composition, sandbox delivery and script loading through the public post-response hook, three engines) | **PASSED**: no Core or sandbox relaxation was needed |
| Conformance review P1 1–3 (live-stub cap, lease expiry, late lease mount) | **Fixed**; each has a regression test that failed on the pre-fix code (logs below) |
| Conformance review P2 4–6 | **Fixed** (masked PASS paths removed, SameSite=None HTTPS fixture built and run, second-app / boundary / service-spy tests added); remaining limits listed below |
| T1–T14 local acceptance | Final full run: **466 PASS, 0 FAIL**, 12 NOT_VERIFIED, 6 KNOWN_LEAK, 10 DIAGNOSTIC; SameSite=None HTTPS fixture run: 98 PASS, 0 FAIL, 4 NOT_VERIFIED, 3 DIAGNOSTIC |
| Backend acceptance (`seam`, `acceptance --local-workerd`) | **PASS** (CPU checks `NOT_ENFORCED_LOCALLY`, unchanged) |
| Cloudflare remote run | **BLOCKED** (not run; still needs separate approval) |
| Zero-egress / DNS / WebRTC / timing | **NOT VERIFIED** (no DNS/UDP observer); not a containment claim |
| Production | **NOT EVALUATED** (G1–G6 open) |

### Milestones

| Milestone | Commit | Gate run (all three engines unless noted) |
|---|---|---|
| U1 shell (no data capability) | `47d278d100a4` | T1/T6: 121 PASS (incl. HTTP); T5 re-run after a harness fix: 21 PASS, 9 DIAGNOSTIC; Jest 144; seam + acceptance PASS |
| U2 delegation + consent | `624e798dd00c` | T9, T2, T7, T11–T14, T1, T5, T6, T9 browser: 183 PASS, 0 FAIL, 1 NOT_VERIFIED, 12 DIAGNOSTIC; Jest 166; seam + acceptance PASS |
| U3 adversarial + attribution | `7e2a2d2beeb6` | 270 PASS / 0 FAIL (superseded: the conformance review found masked PASS paths in T3/T4/T5) |
| UI review fixes | "[App Host] UI review fixes" (this commit) | **final full run below**; Jest 195; seam + acceptance PASS |

### UI review fixes: what changed and what proves it

Paths are relative to `x-pack/platform/plugins/shared/app_host/`. "Failed on old code" means the test was
run against the pre-fix implementation first; the outputs are kept in `.local/logs/regression-old-p1-*.log`
(git-ignored). For P1 1 the pre-fix wiring was first moved, unchanged, from `FrameHost` into
`public/ui_host/bridge_session.ts` so that the test exercises exactly what `FrameHost` runs.

| Item | Change (file:line) | Proving test | Failed on old code |
|---|---|---|---|
| **P1 1** live-stub cap on protocol-only traffic | `public/ui_host/port_transport.ts:81,98,103`: an `admit` check runs every time capnweb asks for the next frame (i.e. right after it processed the previous one) and after every send; breach → `live_stubs` termination. `public/ui_host/bridge_session.ts:52` supplies `imports + exports ≤ 128` | `public/ui_host/bridge_session.test.ts:69` (real `MessageChannel`, protocol-only `["push",0]`: exactly 128 live stays open, 129 terminates, no bridge method ever invoked), `:86` (guest-exported stub imports; unknown-method pipelines), `:102` positive control (100 retained pushes, then a normal call resolves) | Yes: `:69` and `:86` failed (no termination); `:102` passed |
| **P1 2** expiry during a pending read | `server/ui/leases.ts:106` per-lease expiry timer (unref'd) revokes and aborts at TTL; `:97,:102` `isLive` / `isExpired`; `server/ui/bridge_service.ts:469,475` recheck expiry and liveness before and after the release recheck, before returning data → `app_expired`, no data | `server/ui/bridge_service.test.ts:214` (fake clock: start at `expiresAt−1 ms`, cross TTL, then resolve: `app_expired`, no data, and the handler's signal was aborted *at* expiry) | Yes: returned 200 with data |
| **P1 2** idle frame teardown | `common/ui_protocol.ts` `CreateLeaseResponse.ttlMs`; `public/ui_host/lease_client.ts:37,48` parent deadline = request time + `ttlMs` (never later than the server's expiry); `public/ui_host/frame_host.ts:112` expiry timer → `end('expired')` | `public/components/app_ui_page.test.tsx:123` (idle bound frame removed, lease released, status `ended: expired`) | Yes: frame stayed |
| **P1 3** late lease after Disable / unmount / release change | `public/components/app_ui_page.tsx:84,98,151–175`: a generation counter bumped by every teardown; after the lease request settles, a stale generation, a disconnected container, or changed/unapproved/disabled metadata releases the lease and returns without mounting | `public/components/app_ui_page.test.tsx:76` (Disable), `:87` (unmount), `:98` (release change), `:113` positive control | Yes: `:76`, `:87`, `:98` failed (frame mounted and/or lease never released); `:113` passed |
| **P2 4** T3 masked PASS | `prototype/scripts/lib/ui_suites/u3_adversarial.ts:272` `runBridgeCorpus`: each named case runs alone (`run.bridgeCase`), its exact code is asserted, batches of ≤6 invalid calls (the auto-run already made 1) end with a live-session positive control and a zero-execute-request check; raw capnweb `stream` frames for `constructor`/`__proto__`/`toString`/`hasOwnProperty`/`valueOf` must be rejected stackless; the 8th invalid call must end the session with `repeated_invalid_calls`. `:187` inline handler needs an observed `script-src-attr` violation. `:223` local-only rejections produce no server failure records while permitted reads do | live, 3 engines: 29 PASS each | n/a (harness) |
| **P2 4** T4 masked PASS | `prototype/ui/fixtures/channels.ts` one channel at a time with per-attempt markers, shared verbatim with an ordinary control page (`ui/fixtures/channel_control.ts`); `prototype/scripts/lib/ui_suites/t4_channels.ts:116` per channel: FAIL on any hit, PASS only with a working control **and** an observed block (attributed violation, thrown error or error event), otherwise NOT_VERIFIED (inert probe / unattributed block). Navigations (`:338`) need a violation or proof the original document still runs | live, 3 engines (table below) | n/a |
| **P2 4** T5 masked PASS | `prototype/scripts/lib/ui_suites/t5_t6_browser.ts:237`: one fresh bound frame per click action, unique marker, the click must succeed and its handler must have run (`app-host-click:<id>` console line from the frame, `ui/fixtures/hostile.ts:422`), each outcome asserted separately | live, 3 engines: 6 click checks PASS each | n/a |
| Other literal PASS rows | T8 "pending read/expiry" now **runs** the named Jest tests (`scripts/lib/ui_suites/context.ts:193` `jestEvidence`, `u3_adversarial.ts:566`); T10 "local-only rejections" moved to a real T3 check; T14 "no durable store" is now a query of ES indices and `.kibana*` saved-object types with a positive control (`u2_authority.ts:1088`) | 8 Jest PASS; T14 PASS | n/a |
| **P2 5** SameSite=None HTTPS fixture | `prototype/scripts/local_kibana_config.ts` `--tls DIR` (server.ssl, `xpack.security.sameSiteCookies: None`, secure cookies, https publicBaseUrl); local self-signed cert in `.local/tls` (git-ignored); `prototype/scripts/lib/receiver.ts` TLS receivers; browser-side login (`scripts/lib/ui_harness.ts` `login({viaBrowser})`); `t4_channels.ts:461` `runT4Tls` | separate run (below) | n/a |
| **P2 6** second-app binding, budgets, service spies | `server/ui/bridge_service.test.ts:655` (valid lease vs another installed app → `app_stale` before any I/O; a lease never revives), `:699` (different apps of one user: independent buckets), `:728` (100 / 101 operations, reason `lease_budget`), `:742` (exactly 16 KiB result / +1 byte), `:768` (deadline: not at 4,999 ms, aborted at 5,000 ms), `:793` (proxy recorders: ES client touched only by `search`, self client only by `fetch(GET /api/dashboards/{granted})`, nothing else). `public/ui_host/bridge_boundaries.test.ts`: frame 32,768/32,769 B (ASCII and multibyte), queue 256 KiB / +1 B, 1,024 / 1,025 frames, depth 10/11 argument levels (= message depth 12) → `depth_exceeded`, BigInt 64/65 → `bigint_too_large`, 100/101 ops, burst 10/11, 7/8 invalid calls. `public/ui_host/bridge_root.test.ts` depth test now requires `depth_exceeded` and no executor call. Live T9 global cap must be **exactly** 32 (`u2_authority.ts:540`); T12 idempotence requires the tool to report `idempotent` (`:842`). `server/ui/capability_registry.test.ts` (source regex) is kept as a static guard only | Jest; live T9/T12 PASS | n/a |
| **F1** frame navigating its parent | `prototype/ui/fixtures/hostile.ts:310` six variants (`parent.location=`, `.href`, `.assign`, `.replace`, `parent.open(_self)`, `open(_parent)`); `t5_t6_browser.ts:343` one fresh frame each | 3 engines × 6 PASS: zero receiver hits, top URL and guardian unchanged (SecurityError, Firefox `InvalidAccessError` for `_parent`; Chromium/WebKit `open(_parent)` returns without navigating) | n/a |
| **F2** history after top navigation | `t5_t6_browser.ts:108` `runHistory`: Kibana `/app/home` precedes the app page; the held lease works before `history.back()`; if the top page changed, the old lease must be refused | Firefox and WebKit: top navigated (**KNOWN_LEAK**, navigation) and the old lease → `app_denied` (PASS). Chromium: top unchanged (DIAGNOSTIC) | n/a |
| **F3** asset hashing (optional, done) | `server/ui/asset_cache.ts` verified bytes cached by digest; re-hash only when the approved digest or the file's inode/size/mtime changes (tamper → re-verify → 404). No rate limit added | `server/ui/asset_cache.test.ts` (1,000 GETs → 1 hash; digest change and tamper re-verify and refuse) | n/a |
| **F4** pinned self-client options | — | `server/ui/bridge_service.test.ts:862` exact options object (`target`, `method`, `access:'public'`, `version`, `timeout`, `asResponse`, `rawResponse`; no `prependBasePath`/`forwardRequestHeaders`/headers) | n/a (code unchanged) |
| **F5** realm-aware approval identity | `prototype/scripts/lib/approval.ts:110,159` username **and** authentication realm (type + name) must match | `prototype/test/approval_test.ts` (4 cross-realm cases + missing realm → `mixed_identities`, nothing written; same-realm positive control); live T12 (`u2_authority.ts:772`): admin via ES basic vs the same admin via a short-lived Kibana API key (realm `_es_api_key`) → `mixed_identities` | Yes: the cross-realm test failed against the old `approval.ts` |
| **F6** preconnect attribution | `hostile.ts:189` preconnect alone, to a receiver port (5697) that no other code references; `t4_channels.ts:292` ordinary-page control, idle window, then the probe | WebKit: 1 socket after the probe, 0 in the idle window → **KNOWN_LEAK**, now exactly attributed. Chromium/Firefox: 0 (and 0 in their controls) → NOT_VERIFIED | n/a |
| **F6** top-window `message` listener | `t5_t6_browser.ts:405` records the registration stack and source of each top-window listener | Identified (see residuals) | n/a |
| **F7** native summary (optional, done) | `server/routes/register_routes.ts`: default space only (404 elsewhere, before any app invocation); one `app_host.bridge` record per call, `event.provider: native`, app attribution from the approved release (none in legacy mode). `server/ui/audit.ts` adds `event.provider` to every record | `server/routes/register_routes.test.ts`; live T14 (`u2_authority.ts:1038`): `/s/app-host-empty/...` → 404 with no dispatcher connection, default space → 200 with one | n/a |
| **New finding, fixed**: stacks sent to the guest in Firefox | `public/ui_host/bridge_root.ts` `bridgeError` shadows `stack` with an own empty value. `delete error.stack` does not remove Firefox's inherited accessor, and capnweb serializes any truthy `stack`, so every rejection the app received in Firefox carried a stack with Kibana bundle URLs (found by the new T3 raw-frame check) | `public/ui_host/bridge_root.test.ts` (inherited `stack` accessor emulated) and live T3 raw frames in Firefox | Yes: the unit test failed against the old `bridge_root.ts` |

### Final full run (`npm run ui:security -- --kibana http://localhost:5601 --engines chromium,firefox,webkit`)

All 15 default suites, 977 s: **466 PASS, 0 FAIL, 12 NOT_VERIFIED, 6 KNOWN_LEAK, 10 DIAGNOSTIC**
(report: `.local/ui_security-final.json`, git-ignored).

| Engine | PASS | FAIL | NOT_VERIFIED | KNOWN_LEAK | DIAGNOSTIC |
|---|---|---|---|---|---|
| HTTP (Node, curl-equivalent) | 90 | 0 | 0 | 0 | 0 |
| Jest (executed by the harness) | 8 | 0 | 0 | 0 | 0 |
| Chromium | 123 | 0 | 3 | 1 | 4 |
| Firefox | 122 | 0 | 5 | 2 | 3 |
| WebKit | 123 | 0 | 3 | 3 | 3 |
| all engines (one row) | 0 | 0 | 1 | 0 | 0 |

| Test | HTTP / Jest | Chromium | Firefox | WebKit | Notes |
|---|---|---|---|---|---|
| T1 shell, direct-open, headers | 31 PASS | 17 PASS | 17 PASS | 17 PASS | unchanged from U3 |
| T2 real scoped delegation | 8 PASS | 2 PASS | 2 PASS | 2 PASS | |
| T3 XSS + compromised UI | — | 29 PASS | 29 PASS | 29 PASS | each abuse case asserted individually; raw prototype-name frames; 8th invalid call terminates |
| T4 egress channels | — | 41 PASS, 3 NV, 1 KL, 1 DIAG | 39 PASS, 5 NV, 1 KL, 1 DIAG | 40 PASS, 3 NV, 2 KL, 1 DIAG | per-channel controls and observations (below) |
| T5 chrome, top nav, popups | — | 19 PASS, 2 DIAG | 20 PASS, 1 KL, 1 DIAG | 20 PASS, 1 KL, 1 DIAG | per-action clicks, F1, F2 |
| T6 bootstrap spoof/replay, S4 flood | — | 7 PASS, 1 DIAG | 7 PASS, 1 DIAG | 7 PASS, 1 DIAG | DIAG = Kibana's own top listener (identified) |
| T7 bypass / cross-app / CSRF | 18 PASS | — | — | — | |
| T8 revoke / update / v2 | 8 Jest PASS | 6 PASS | 6 PASS | 6 PASS | Jest rows are executed by the harness |
| T9 parser / DoS | 4 PASS | 1 PASS | 1 PASS | 1 PASS | global lease cap exactly 32; CPU loop NOT_VERIFIED (all) |
| T10 attribution | 7 PASS | 1 PASS | 1 PASS | 1 PASS | |
| T11 never-delegable corpus | 2 PASS | — | — | — | plus Jest behavioural service spies |
| T12 installer / approval / scope map | 12 PASS | — | — | — | incl. F5 cross-realm |
| T13 uniform errors / oracles | 3 PASS | — | — | — | |
| T14 state / space / buckets | 5 PASS | — | — | — | incl. F7 and the store query |

T4 per channel (resource channels from the hostile frame; each with an ordinary-page control in the same
engine): fetch, fetch no-cors, XHR, WebSocket, beacon, SSE, image, CSS `@import`, CSS background, font,
video, audio, `<object>`, `<embed>`, nested frame, prefetch, stylesheet, worker, shared worker, dynamic
import and script are PASS in every engine except: Firefox CSS `@import` and WebKit prefetch, whose
**controls issued no request** (inert probe, NOT_VERIFIED). Credentialed requests to Kibana (fetch, fetch
no-cors, XHR, beacon, image, script, stylesheet, CSS background, nested frame) never reached Kibana's
access log in any engine (27 PASS). All seven navigations are PASS in every engine except Firefox
`<a ping>` (no request, but Firefox fired no violation for it: NOT_VERIFIED). The opaque-frame cookie
control (DIAGNOSTIC) showed 401 (no session cookie) under the ordinary cookie configuration in all engines.

### SameSite=None HTTPS cookie fixture (`--suites t4tls`, Kibana restarted over local TLS)

Kibana was restarted once with `.local/kibana.app_host.tls.yml` (self-signed `localhost`/`127.0.0.1`
certificate under the git-ignored `.local/tls`, `xpack.security.sameSiteCookies: None`, secure cookies,
`server.publicBaseUrl: https://localhost:5601`), receivers on TLS too, then restored to the HTTP config for
the final full run. 180 s: **98 PASS, 0 FAIL, 4 NOT_VERIFIED, 3 DIAGNOSTIC** (`.local/ui_security-tls-final.json`).

| Check | Chromium | Firefox | WebKit |
|---|---|---|---|
| Session cookie is `SameSite=None; Secure` over HTTPS | PASS | PASS | PASS |
| Cookie-present control: an opaque (sandboxed) frame **inside the Kibana page** without the app policy sends the session (403/404, not 401) | **NOT_VERIFIED**: 401, the engine did not attach the cookie | **NOT_VERIFIED**: 401 | **PASS**: 403 (session sent) |
| Frame's 9 credentialed channels to Kibana never sent | 9 PASS | 9 PASS | 9 PASS |
| Resource channels / Referer (as in T4) | 22 PASS | 21 PASS, 1 NV | 22 PASS, 1 NV |

So the cookie-present condition that A17 is about was reproduced in WebKit, where the app frame's
credentialed requests were still never sent. Chromium and Firefox did not attach the `SameSite=None`
cookie to an opaque frame's request even without the app policy (third-party cookie restrictions), so in
those two engines the fixture shows the requests are blocked but cannot show the cookie-present case:
reported NOT_VERIFIED, not PASS.

### Remaining limits of the review fixes

- T1's header helper still requires exactly two CSP policies (`t1_shell.ts:44`); the review suggested
  replacing the count with preservation/intersection assertions. Not changed in this round.
- F3 caches hashing only; `consent.json` and the manifest are still read per asset request and the
  unauthenticated route has no rate limit.
- F7 records the native call without an app actor in legacy (no approval file) mode, because there is no
  approved release to attribute; `event.provider: native` is present either way. No Origin/fetch-metadata
  check was added to the native GET route.
- Dashboard audit correlation remains coarse (user + object + time), as before.

### Conditions S1–S11

| # | Status | Evidence |
|---|---|---|
| S1 | **Met** | Composed from `http.csp.header` (never the response); T1 403 guardian/frame and T7 400/403/404/413 carry the composed policy, empty report-only and JSON sandbox policy; Jest covers 400/403/404/500 with an empty Boom header set |
| S2 | **Met** | Post-Core `Referrer-Policy`, `Permissions-Policy`, `X-DNS-Prefetch-Control: off`, `Cache-Control: no-store`, `nosniff` on every app surface; `/app/home` and `/api/status` keep Core's values (T1) |
| S3 | **Met** | Attribute snapshots of both iframes (T1, three engines) |
| S4 | **Met** | Source/origin checked before `data`; two handshake messages, then listeners removed; control port for lifecycle; 1,000 × 1 MiB flood ran no guardian handler and caused no rebind (T6); `messageerror` terminates (Jest); the 128 live-stub cap now also covers protocol-only growth (P1 1) |
| S5 | **Met (Jest), live redirect fixture not run** | `asResponse`+`rawResponse`, default `prependBasePath`, final URL must equal the initial path, status 200, 256 KiB cap before parsing, `body.id === grantedId`; Jest: alias match → `app_denied`, followed redirect / redirect error / oversized body (declared and streamed) → `app_unavailable`. No live `server.selfHttp.maxRedirects: 1` restart with a redirecting fixture |
| S6 | **Met** | Assets under `/api/app_host/ui_assets/`, 404 for unknown/unapproved/tampered; top-level bad-digest navigation keeps the session (T1); tamper (T8) |
| S7 | **Met** | appId, approved release digest, no query string, before any HTML; markup canary not reflected (T1) |
| S8 | **Met** | Schema literal + evaluator assertion for the Worker and UI paths; other concrete indices rejected at parse even when approved (Jest, T12); T11 index corpus |
| S9 | **Met** | Worker-path `HostEs` callbacks recorded with the wrapper correlation id (T10, Jest) |
| S10 | **Met** | Title canary literal in chrome (T3); no v1 frame while the v2 prompt is visible (T8) |
| S11 | **Met** | Secret in JSON body, stored as SHA-256, constant-time compare; absent from logs with response debug logging on and from window/port messages (T10); exactly 4 per principal and exactly 32 global accepted, the next refused (T9); non-empty egress rejected (Jest, T12) |


### Deviations from the spec (with reasons)

- **Asset path**: `/api/app_host/ui_assets/{file}` instead of `/plugins/appHost/ui_assets/{uiDigest}.js` (the S6
  option: `/api/` paths are never re-rendered by the security plugin). The two host scripts have fixed names
  (`host-guardian.js`, `host-child.js`) and are served from constants in the plugin.
- **Lease secret** travels in the execute JSON body, not an `x-app-host-lease` header (S11).
- **Ingress pacing**: frames above 60/s (burst 16) wait in the bounded queue instead of terminating the session;
  queue overflow (256 KiB or 1,024 frames), non-string frames, >32 KiB frames, `messageerror`, >128 live
  capnweb imports + exports (checked at the protocol receive/send boundary) and 8 invalid calls still terminate. capnweb sends about three frames per call, so termination broke
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
- **Not built / not run**: the infinite-UI-loop diagnostic and DNS/STUN observers (`NOT_VERIFIED`). The
  SameSite=None HTTPS fixture is built and run (separate `t4tls` run above, Kibana restarted once over local
  TLS); its cookie-present condition is reproduced in WebKit only.
- **Lease response** carries `ttlMs` in addition to `expiresAt`, so the parent derives its teardown deadline
  from its own clock.
- **T5 history** now starts from a Kibana page (`/app/home`) before the app page, so `history.back()` has a
  real previous entry; with that, Firefox navigates the top page as well as WebKit.
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

- **WebKit preconnect (`KNOWN_LEAK`, F6: now exactly attributed)**: `<link rel=preconnect>` is inserted on
  its own, pointing at a receiver port (5697) that nothing else references. WebKit opened 1 TCP connection
  after the probe and 0 in the preceding idle window (its ordinary-page control also opened 1); no HTTP
  request followed. CSP did not stop the socket: a timing/existence channel, and a hostname could carry data.
  Chromium and Firefox opened none, but their ordinary-page controls opened none either, so that absence is
  `NOT_VERIFIED`, not a block.
- **Exact frame path + query (`KNOWN_LEAK`, accepted residual in the sign-off)**: CSP path matching ignores the
  query string, so the child may navigate itself to `<exact frame URL>?<data>`. The request reaches Kibana (and
  its logs); S7 answers 404 JSON (no document) and the guardian revokes on the reload. All three engines.
- **DNS prefetch, WebRTC/STUN: `NOT_VERIFIED`**. ICE gathering produced candidates (2/4/1 host candidates in
  Chromium/Firefox/WebKit) toward `stun:127.0.0.1:3478`; no UDP or DNS observer was provisioned, so packet
  absence is not claimed. Zero Playwright HTTP requests are not treated as proof.
- **Joint session history (`KNOWN_LEAK`, navigation; F2)**: with a Kibana page before the app page in the
  tab's history, `history.back()` from the frame navigated the **top** page in Firefox and WebKit (Chromium
  kept it: DIAGNOSTIC). The app cannot choose the URL, only traverse existing entries. In both engines the
  lease the old page held was refused afterwards (`app_denied`; PASS), after working just before.
- **WebKit iframe `load` on fragment navigation (diagnostic)**: a same-document `#fragment` navigation in the
  child fires the iframe element's `load` event in WebKit, which the guardian treats as a reload and revokes
  (fail closed). Hash-routing apps would be revoked in WebKit. Some blocked click actions (download / `_top`
  link / form) also end in a child reload in WebKit; no popup, download, top navigation or form submission
  happened in any engine.
- **Structured clone before validation**: the browser clones every incoming port message before the bounded
  transport sees it; the S4 flood (1,000 × 1 MiB to the guardian and to top) never ran a guardian handler after
  the handshake, but Kibana's own single top-window `message` listener ran 1,001 times (diagnostic).
- **That top-window listener (F6, identified)**: monaco-editor 0.56.0 `esm/vs/base/common/platform.js`,
  `setTimeout0` (bundled into `kbn-ui-shared-deps-src`; registration stack and source recorded in T6 in all
  three engines). Its handler is
  `e => { if (e.data && e.data.vscodeScheduleAsyncWork) { /* find pending id, splice, run its callback */ } }`.
  It ignores every message without a `vscodeScheduleAsyncWork` property that equals one of its own pending
  ids, so the flood's strings did nothing. It does **not** check `event.source` or origin: any frame,
  including an app frame, can post `{vscodeScheduleAsyncWork: n}` to `top` and, if `n` is a pending id, make
  Monaco run its own already-queued callback early (and the real message later finds nothing). That is
  scheduling interference with Kibana-owned code, not data access or attacker-chosen code. It is outside
  App Host; the fix belongs upstream or in `@kbn/monaco` (check `e.source === window`).
- **Firefox stack traces to the guest (found and fixed in this round)**: before the fix every bridge
  rejection received by app code in Firefox carried a stack with Kibana bundle URLs (see the table above).
- **Tab DoS / CPU**: an iframe is not a CPU quota; no infinite-loop diagnostic was run (`NOT_VERIFIED`).
- **SameSite=None HTTPS fixture**: built and run. In WebKit an opaque frame inside the Kibana page sends the
  `SameSite=None` session cookie, and the app frame's credentialed channels to Kibana were still never sent
  (PASS). Chromium and Firefox did not attach the cookie to an opaque frame's request even without the app
  policy, so the cookie-present case is `NOT_VERIFIED` there (their frame requests were blocked as well).
- **Inert or unattributed probes (`NOT_VERIFIED`)**: Firefox CSS `@import` and WebKit `<link rel=prefetch>`
  issued no request even from an ordinary page, so no block is claimed for them. Firefox fires no CSP
  violation for `<a ping>`; no ping request reached the receiver, but the block is not attributed.
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
