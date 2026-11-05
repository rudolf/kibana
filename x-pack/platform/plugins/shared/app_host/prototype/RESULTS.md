# App Host prototype results

**Synthetic data, local only.** ES snapshot 9.7.0 (trial license), `node scripts/kibana --dev
--no-base-path` with `KBN_HMR=false`, local `wrangler dev` 4.157.0, Node 24.22.1, the Playwright browsers
installed for the worktree (Chromium 153.0.8010.12, Firefox 155.0, WebKit 26.6). Run date 2026-11-05. No
Cloudflare account, deploy, secret write or push. Reports and screenshots are git-ignored under `.local/`.

## Verdict

| Question | Result |
|---|---|
| Full `ui:security` (K, T, D and W suites), three engines | **PASS**: 540 PASS, 0 FAIL, 12 NOT_VERIFIED, 6 KNOWN_LEAK, 19 DIAGNOSTIC, 1196 s (`.local/ui_security-2026-11-05T23-06-17-800Z.json`) |
| Bridge Worker (W1, W2), three engines | **PASS**: 31 PASS, 0 FAIL, 3 DIAGNOSTIC (inside the full run) |
| K1 with the dev-only input-schema bypass (Kibana restarted with `-c .local/kibana.app_host.k1.yml`) | **PASS** 9/9 (`--suites k1`) |
| Backend `seam` and `acceptance` (local workerd) | **PASS**: `seam` exit 0, 24 assertions true, the 3 CPU-loop checks `NOT_ENFORCED_LOCALLY`; `acceptance` exit 0, verdict PASS, 34 of 37 true, the 3 CPU checks `NOT_ENFORCED_LOCALLY`, no failures |
| Jest, `type_check`, ESLint, prototype `lint` and `test` | **PASS**: Jest 190/190 (22 suites); `type_check --project …/app_host/tsconfig.json` exit 0; ESLint/oxlint clean on the changed TypeScript files; prototype `lint` (three `tsc` projects + Kibana lint of `prototype/`) clean; prototype `test` 53/53 |
| SameSite=None HTTPS fixture (`--suites t4tls`) | **NOT RUN** for this state (needs Kibana restarted over TLS) |
| Cloudflare remote run (CPU limits, latency) | **NOT RUN** (needs separate approval) |
| Zero egress (DNS, WebRTC, timing) | **NOT VERIFIED** (no DNS/UDP observer); not a containment claim |
| Production | **NOT EVALUATED** (production gates G1–G6 open) |

## Bridge Worker (W1, W2)

The bridge runs in a dedicated Web Worker per app frame (`host-bridge-worker.js`, a fixed host asset;
it `importScripts` only `host-capnweb.js`). The parent page creates the bridge `MessageChannel`, transfers
one end to the Worker with `{appId, releaseDigest, theme, sessionUrl, executeUrl}`, and hands the other
end to the guardian exactly as before once the Worker reports a minted session. The Worker mints the
session, holds the handle, runs the capnweb `RpcSession` and the seven typed methods, and calls the
execute route with `kbn-xsrf` and `x-elastic-internal-origin`. The page keeps consent, Disable,
mount/unmount and `worker.terminate()`. The Worker's only bound is an 8 MiB receive queue (2 bytes per
UTF-16 code unit).

Run inside the full `ui:security` (`--suites w` alone: same checks). Delay = lateness of a 10 ms timer
chain on the Kibana page's main thread, in ms.

| Check | Chromium | Firefox | WebKit |
|---|---|---|---|
| Worker loads from the host asset; its response CSP is Core's policy plus `default-src 'none'; script-src <host-capnweb.js>; connect-src <session> <execute>` (headers as seen by the browser) | **PASS** | **PASS** | **PASS** |
| Worker CSP enforced (code evaluated in the Worker): `POST /internal/app_host/ui/execute` answers 400 (control); `GET /api/status`, a fetch to the local receiver (0 receiver hits) and `importScripts(host-guardian.js)` blocked | **PASS** | **PASS** | **PASS** |
| Sampler positive control: a 300 ms busy loop on the page → max delay | **PASS** 291 | **PASS** 294 | **PASS** 296 |
| Idle control (frame bound, 4 s): p50 / p95 / max | 2 / 2 / 3 | 3 / 6 / 6 | 3 / 6 / 6 |
| Flood (4 s; bursts of 8 calls with a 256 KiB argument that the Worker parses and refuses plus 8 valid calls; every call answered): p50 / p95 / max; calls | **PASS** 0 / 1 / 4; 88,384 | **PASS** 3 / 6 / 8; 33,376 | **PASS** 2 / 3 / 11; 81,024 |
| One 10 MiB frame (past the queue bound): status `ended: protocol_error (queue_overflow)`, the Worker closed, the guardian removed; max delay meanwhile | **PASS** 3 | **PASS** 10 | **PASS** 6 |
| After the overflow: `GET /api/status` from the page 200, a new consent binds a fresh Worker and frame | **PASS** | **PASS** | **PASS** |
| W2 control: the Worker's session response carried a handle | **PASS** | **PASS** | **PASS** |
| W2 no handle in any window, port or Worker message (recorded in every frame: window/port/Worker sends, port `onmessage` receipts including the guest's end of the bridge, Worker → page notices) | **PASS** (54 messages) | **PASS** (58) | **PASS** (58) |
| W2 scanner positive control: a value hidden in a DOM expando is found | **PASS** | **PASS** | **PASS** |
| W2 no handle in the page's JS-visible state in any frame (breadth-first over own data properties from `window` and every element, including React fibers and state; storage, cookies, markup) | **PASS** (94,094 objects) | **PASS** (91,028) | **PASS** (91,788) |
| W2 heap snapshot of the page's main isolate (CDP, 678 MB): positive control found, no handle | **PASS** | — | — |
| DIAGNOSTIC: a 2 s CPU-busy loop in the app frame itself → Kibana main-thread max delay | **1990 (blocks)** | **1997 (blocks)** | **1998 (blocks)** |

The flood is answered entirely off the main thread: in every engine the delay during the flood stays
within the idle control. A CPU-busy loop in the **app frame itself** still blocks the Kibana page for its
whole duration in all three engines: the opaque, sandboxed frame is same-site with Kibana and shares the
renderer's main thread. The Worker does not change that; hosting the frame on a separate site would.

Jest (`server/ui/bridge_worker.test.ts`) runs the served Worker script and capnweb asset in their own
realm: one mint, the exact request shape and headers, results forwarded unchanged, plain-data and arity
refusals with no request, only the typed methods callable (raw frames for prototype names rejected with
`app_unavailable`, no stack on the wire), re-mint once on `app_expired`, a lifecycle refusal reaching the
guest before the `end` notice, a failed mint ending before anything binds, queue overflow and a
non-string frame ending the session. `public/components/app_ui_page.test.tsx`: one Worker per consent,
the frame mounts only after `ready`, Disable and unmount terminate the Worker (a session still being
minted never mounts a frame), a server rejection or overflow terminates the Worker and the page stays
usable, a Worker error ends the frame, nothing before consent and no metadata polling.

## Mini Discover (D1–D5)

The sample app's UI (`ui/src/discover.ts`) lists data views, reads one with its fields, and runs ES|QL
(rows plus an hourly count chart), entirely through the bridge; every call runs server-side as the app
session key. Release 2.x grants `kbn-apps-prototype-alerts` and `kbn-apps-demo-logs-*` with `read` and
`view_index_metadata`, plus `feature_dashboard_v2.read` and `feature_indexPatterns.read` on
`space:default`, empty `cluster` and `run_as`. Seed (`ui:seed`): `kbn-apps-demo-logs-a` and `-b` (240
documents each over the last 24 h; the three newest in `-a` carry attacker-style messages),
`kbn-apps-other-secret` (5 documents, outside the grant and the demo prefix; the viewer may read it
directly), data views `kbn-apps-demo-logs` (with one runtime field, `event.hour`, and its field format)
and `kbn-apps-other-secret`.

Inside the full run: **33 PASS, 0 FAIL, 3 DIAGNOSTIC**.

| Test | Result | Evidence |
|---|---|---|
| D1 happy path and pass-through | **PASS** (HTTP 6, browser 2 per engine) | Release flow: an approved release without the Discover scopes refuses `es.esql` (`scope_not_granted`); the Discover release, approved with the same tooling and no Kibana restart, makes the old handle `app_stale` (re-consent). As the key: `listDataViews` returns the Data Views API response **unchanged** (`{data_view: [...]}`, byte-for-byte equal to the viewer's own `GET /api/data_views`); `getDataView` returns `{data_view: {...}}` unchanged and equal to the viewer's own read, including `runtimeFieldMap['event.hour']` (`long`), `fieldFormats['event.hour']` (`number`, pattern `00`) and the field spec with `runtimeField` and `format` (field caps run as the key); `FROM kbn-apps-demo-logs-* \| SORT @timestamp DESC \| LIMIT 50` returns 50 rows **identical to the same query run directly as the superuser**, including the three attacker strings verbatim; the hourly histogram (24 buckets) is identical to the superuser query and sums to 480; `ENRICH` → `app_denied`, `native_denied`. Browser, each engine: picker filled, *Demo logs* selected, 10 fields listed (1 runtime), prefilled query, 50 rows and 24 bars (sum 480), the attacker strings present as table text with **0** `img`/`script`/`svg`/`iframe`/`object` elements and the top page untouched; an edited query via **Run** returns 10 rows; a 1,000-row result of ~2 MB renders; `FROM kbn-apps-other-secret` shows `esql: error app_denied`; the frame stays `bound`. |
| D2 data view outside the grant | **PASS** (9) + 2 DIAGNOSTIC | Control: the viewer reads `kbn-apps-other-secret` directly in ES (5 rows). For the viewer **and** a superuser viewer: the secret data view is listed (saved-object privileges are per type); `FROM kbn-apps-other-secret` → `app_denied`, reason `native_rejected` (ES answers `400 verification_exception: Unknown index`, exactly as for a missing index); `FROM kbn-apps-demo-*,kbn-apps-other-secret` → `app_denied`, `native_denied` (ES 403 `indices:data/read/esql/search_shards` unauthorized for the API key); `FROM kbn-apps-* \| LIMIT 500` → 484 rows, exactly the superuser's count over the granted indices, with **no** `SECRET-ROW` value. DIAGNOSTIC: `getDataView` on the secret view returns its saved-object metadata with 0 fields (Kibana swallows the key's failed field caps), no secret data. |
| D3 viewer ∩ app | **PASS** (4) + 1 DIAGNOSTIC | Viewer without index read: the key grants the pattern, ES refuses (`native_rejected`, `Unknown index`). Viewer without the data view feature (`app_host_ui_no_data_views`): `listDataViews` → an **empty list** (Kibana's saved-object find filters unauthorized types; it does not return 403), `getDataView` → `app_denied`, `native_rejected` (Kibana: `400 Unable to bulk_get index-pattern`), ES|QL still works. Release without `kibana.dataViews.read`: a superuser is refused `listDataViews`/`getDataView` (`scope_not_granted`), ES|QL still granted. Release without `kibana.dataViews.read` **and** `kibana.dashboard.read`: a key with that release's descriptor, granted from the superuser's password, has `applications: []`; Kibana's own Data Views API lists 0 views and refuses the read (400). **Finding** (DIAGNOSTIC): with `kibana.dashboard.read` kept, the same key lists 2 views and reads them (200): `feature_dashboard_v2.read` includes `index-pattern` read. |
| D4 key confinement | **PASS** (7) | The K4 known-key method (a key with the exact manifest descriptor, granted as `kibana_system` from the viewer's password, sealed into a handle with the local handle key). `elasticsearch.query` debug had fresh entries for each path: `_has_privileges` (list), `200 … /_field_caps` (get), `200 … /_query` (ES\|QL), `403 … /_query` (refusal); every `/_query` entry's authorization is `[REDACTED]`. No bare secret, `id:secret` or base64/base64url credential in the responses or any new log output (`es_query_debug`, `kibana_debug`, `http_debug`, security audit, bridge audit, Kibana stdout, `wrangler.log`); an injected secret is caught (negative control). |
| D5 revocation | **PASS** (1) | ES\|QL ok → `ui:operator`-equivalent disable (key invalidated by name, 0 errors) → next `esql` `app_disabled` → re-enable → the old handle `app_stale` → a new consent works. |

Screenshots (one per engine, after selecting *Demo logs*): `.local/discover-chromium.png`,
`.local/discover-firefox.png`, `.local/discover-webkit.png`.

Limits of this cut:

- One result per message, no streaming, and no host result cap: result size is whatever the native API
  returns. ES|QL row limits are Elasticsearch's (the query's `LIMIT`, the cluster's ES|QL limits).
- No command allowlist and no query size cap of the host's own. With an empty `cluster`, ES refuses `ENRICH`
  (tested above) and explicit inference commands (`COMPLETION`/`RERANK`, from the ES source; not tested).
  A `MATCH` on a granted index's `semantic_text` field still runs that field's operator-configured
  inference endpoint (not tested; no seeded semantic field). That is a property of reading the granted
  index, not something the app key can widen.
- A data view outside the grant is listed and its metadata (title, time field) is readable; only data is
  refused. Kibana privileges are per saved-object type and space.
- Native refusals carry two audit reasons: `native_denied` (401/403/404) and `native_rejected` (400:
  ES|QL `Unknown index` or a query ES rejects; Data Views `Unable to bulk_get`). The public code is
  `app_denied` for both. ES|QL syntax errors therefore also read `app_denied`.
- Not verified: other spaces (the cut is default-space only), very large data view field lists,
  `LOOKUP JOIN` and `PROMQL` index resolution.

## App session key (K1–K6)

Consent mints one restricted API key (`grantAsInternalUser`, role descriptor from the approved manifest
only, 1 h, `refresh=false`); only the bridge Worker holds the AES-256-GCM handle; every bridge operation
(ES search, ES|QL, Dashboard and Data Views reads via `selfClient`, `app.summary` → backend Worker →
`HostEs`) runs as that key. ES needs nothing extra (`xpack.security.authc.api_key.enabled` is on by default).

| Check | Result | Evidence |
|---|---|---|
| K1 ES enforces, not Kibana | **PASS** (9/9 with the bypass; the default-config run checks that the bypass is off: 1 PASS, 1 NOT_VERIFIED) | With the input schema bypassed: superuser viewer → `.security`, `.security-7`, `.kibana` each `app_denied` with audit reason `native_denied` (raised only for an Elasticsearch 401/403; the schema's refusal is `resource_not_granted`); `kbn-apps-prototype-viewer-only` (direct ES read as the viewer: 200) → `native_denied` for the viewer and for a superuser; `kbn-apps-prototype-*` → denied, or only granted-index records; the granted index returns its records. The superuser key's descriptor is `indices: [{names: [kbn-apps-prototype-alerts, kbn-apps-demo-logs-*], privileges: [read, view_index_metadata], allow_restricted_indices: false}]`, `cluster: []`, `run_as: []`. Without the bypass, Kibana's schema refuses `.security` first; outside `--dev` the setting fails config validation (Jest). |
| K2 viewer ∩ app | **PASS** (7) | No-index viewer: ES denies although the key grants the index (also on the Worker path); no-dashboard viewer: Kibana's feature authz denies; release without `kibana.dashboard.read`: superuser denied and the key has no Dashboard privilege. The stored descriptor equals the manifest-derived one, and `limited_by` holds exactly the viewer's roles with the same privileges as `GET /_security/role`. |
| K3 handle integrity | **PASS** (HTTP 8, browser 1 per engine, Jest 3) | Tampered ciphertext, GCM tag, release digest and generation (each a well-formed, canonical token differing only in that field) → `app_denied`, audit `bad_handle`, before any key-scoped request; another user's handle with their own basic auth and own cookie, another space → `app_denied`; no credentials → 401; expired → `app_expired` and a single re-mint inside the bridge Worker started by this consent (Jest). |
| K4 key confinement | **PASS** (10) | Known key through the real clients and loggers (es.search, Dashboard read, Worker-path `app.summary`, a native 403), with fresh `elasticsearch.query` entries and `[REDACTED]` authorization; no secret encoding in responses or logs; negative controls FAIL/NOT_VERIFIED as designed (also node:test `leak_scan_test.ts`). Kibana-minted keys in three engines: no key encoding in responses, window/port/Worker messages, frame DOM or logs; the handle appears only in the session response to the bridge Worker. |
| K5 revocation | **PASS** (10) + 1 DIAGNOSTIC | Disable (keys invalidated by name, next call `app_disabled`, re-enable → `app_stale`); mint → immediate disable → enable (name invalidation can miss the unrefreshed key; the handle is dead anyway); partial invalidation (HTTP 200, `error_count: 1`) reported and recoverable; operator CLI HTTP failure exits 1; a 6-run mint/disable race (only current-generation handles work); a release change (`app_stale`, old-release keys invalidated); reset + re-approval of the same release with a frozen and a backward operator clock (old handle `app_stale`, new handle works). |
| K6 cost | **PASS** (2) + 2 DIAGNOSTIC | 30 calls on one handle → exactly 1 new key. Mint latency through `POST /internal/app_host/ui/session`: p50 12 ms, p95 15 ms (20 mints); a direct ES grant as `kibana_system` takes p50 12 ms with `refresh=false` and p50 1,001 ms with the default refresh. |

Invalidation as `kibana_system` on ES 9.7: by **name** works, including a trailing wildcard
(`app:alert-digest@*`); listing by name is refused (403) and a metadata query returns only its own keys,
so query-then-invalidate-by-id is not available to it.

Limits:

- Kept from the backend (not part of the UI path): the 4-invocation process limiter and the
  one-`HostEs`-call budget per backend Worker invocation (`app_rate_limited` comes only from the
  limiter); the backend transport's bounds (256 KiB frames, 1 MiB queue, depth 32, BigInt 64, 8 invalid
  calls); the 5 s deadline. There are no UI-path rate limits or budgets.
- Within the 2 s state cache an execute may still be accepted after a disable (refusals always use a
  fresh read); a read authorized before a disable can finish within its deadline.
- Name invalidation can miss a key minted less than one `.security` refresh (~1 s) earlier; the
  approval generation makes its handle useless. Restoring the exact approved release while the app
  stays enabled revives unexpired handles for it (not a revocation path).
- The bridge does not distinguish an ES 401 from a 403, and the redacted header does not show which
  credential a request carried.
- Expiry and re-mint are fake-clock evidence; held-grant interleavings are Jest evidence.
- The native `GET /api/apps/{appId}/summary` still runs `asCurrentUser` with the exact-index input schema.
- Not verified: auth providers other than basic/token (SAML, OIDC, PKI, Kerberos, UIAM), multi-node,
  cross-node API-key cache invalidation timing.

## Third-party UI shell and adversarial suites (T1–T13)

Results of the full run (`--engines chromium,firefox,webkit`, all default suites). The first table
counts every suite (K, T, W and D); the second lists the T-suites:

| Engine | PASS | FAIL | NOT_VERIFIED | KNOWN_LEAK | DIAGNOSTIC |
|---|---|---|---|---|---|
| HTTP (Node) | 137 | 0 | 1 | 0 | 6 |
| Jest (run by the harness) | 11 | 0 | 0 | 0 | 0 |
| Chromium | 131 | 0 | 3 | 1 | 5 |
| Firefox | 129 | 0 | 5 | 2 | 4 |
| WebKit | 130 | 0 | 3 | 3 | 4 |
| all engines (one row) | 2 | 0 | 0 | 0 | 0 |

| Test | HTTP / Jest | Chromium | Firefox | WebKit |
|---|---|---|---|---|
| T1 shell, direct-open, headers (incl. the Worker and capnweb assets) | 33 PASS | 17 PASS | 17 PASS | 17 PASS |
| T3 XSS + compromised UI + bridge abuse corpus | — | 27 PASS | 27 PASS | 27 PASS |
| T4 egress channels | — | 41 PASS, 3 NV, 1 KL, 1 DIAG | 39 PASS, 5 NV, 1 KL, 1 DIAG | 40 PASS, 3 NV, 2 KL, 1 DIAG |
| T5 chrome, top nav, popups, history | — | 18 PASS, 2 DIAG | 19 PASS, 1 KL, 1 DIAG | 19 PASS, 1 KL, 1 DIAG |
| T6 bootstrap spoof/replay, S4 flood | — | 7 PASS, 1 DIAG | 7 PASS, 1 DIAG | 7 PASS, 1 DIAG |
| T7 bypass / cross-app / CSRF | 18 PASS | — | — | — |
| T8 revoke / update / new release | 6 PASS (Jest) | 6 PASS | 6 PASS | 6 PASS |
| T10 attribution, handle scans | 8 PASS | 1 PASS | 1 PASS | 1 PASS |
| T11 never-delegable corpus | 2 PASS | — | — | — |
| T12 installer / approval / scope map | 12 PASS | — | — | — |
| T13 uniform errors / oracles | 3 PASS | — | — | — |

T3 bridge abuse corpus, each engine: `callAppRoute` other routes, traversal, encoded path, query trick
and `POST`, function and thenable arguments and an unknown method are refused **in the bridge Worker**
(`bridge_invalid_request` / `app_unavailable`, no request); another index, the audit index, a wildcard
and the ungranted dashboard reach the server and are refused before any I/O (`app_denied`, audited as
`resource_not_granted` with the app attributed); an extra field is refused by the server's closed union
(`bridge_invalid_request`). Raw capnweb frames naming `constructor`, `__proto__`, `toString`,
`hasOwnProperty` and `valueOf` → `reject app_unavailable`, no stack, no request. The session stays
bound throughout.

T4 per channel (from the hostile frame, each with an ordinary-page control in the same engine): fetch,
fetch no-cors, XHR, WebSocket, beacon, SSE, image, CSS `@import`, CSS background, font, video, audio,
`<object>`, `<embed>`, nested frame, prefetch, stylesheet, worker, shared worker, dynamic import and script
are blocked in every engine, except Firefox CSS `@import` and WebKit prefetch, whose controls issued no
request (NOT_VERIFIED). Credentialed requests to Kibana never reached its access log. All seven
navigations are blocked, except Firefox `<a ping>` (no request, no violation: NOT_VERIFIED).

SameSite=None HTTPS fixture (`--suites t4tls`, Kibana over local TLS): **NOT RUN** for this state.

### Conditions S1–S11

| # | Status | Evidence |
|---|---|---|
| S1 | **Met** | Composed from `http.csp.header` (never the response); 4xx/5xx carry the composed policy, empty report-only and JSON sandbox policy (T1, T7, Jest) |
| S2 | **Met** | Post-Core `Referrer-Policy`, `Permissions-Policy`, `X-DNS-Prefetch-Control: off`, `Cache-Control: no-store`, `nosniff` on every app surface; other routes keep Core's values (T1) |
| S3 | **Met** | Attribute snapshots of both iframes (T1, three engines) |
| S4 | **Met** | Source/origin checked before `data`; two handshake messages, then listeners removed; a 1,000 × 1 MiB flood ran no guardian handler and caused no rebind (T6); `messageerror`, a non-string frame and a receive-queue overflow end the bridge Worker's session (Jest, W1) |
| S5 | **Met (Jest)**, live redirect fixture not run | Dashboard and Data Views self calls on fixed paths: final URL must equal the requested path, status 200; the returned dashboard id must equal the granted id |
| S6 | **Met** | Assets under `/api/app_host/ui_assets/`, 404 for unknown/unapproved/tampered (T1, T8) |
| S7 | **Met** | appId and approved release digest checked, no query string, before any HTML (T1) |
| S8 | **Met** | Grantable indices are synthetic only: the backend literal plus `kbn-apps-demo-` names or trailing-wildcard patterns, enforced at parse (Jest, T12); `es.search` keeps its exact-literal input check (T11); everything else is enforced by ES through the key (K1, D2) |
| S9 | **Met** | Worker-path `HostEs` callbacks recorded with the wrapper correlation id (T10, Jest) |
| S10 | **Met** | Title canary literal in chrome (T3); no old frame while a new release's prompt is visible (T8) |
| S11 | **Met** | Handle only in the bridge Worker and the execute JSON body; absent from logs, window/port/Worker messages, frames, the page's JS-visible state and (Chromium) the page heap (K4, T10, W2); non-empty egress rejected (Jest, T12) |

### Final-wire headers (synthetic viewer, `Sec-Fetch-Dest: iframe`)

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

Bridge Worker script (`/api/app_host/ui_assets/host-bridge-worker.js`, 200, unauthenticated): same
non-CSP headers as the asset, and

```
content-security-policy: <Core policy without reporting>, default-src 'none'; script-src http://localhost:5601/api/app_host/ui_assets/host-capnweb.js; connect-src http://localhost:5601/internal/app_host/ui/session http://localhost:5601/internal/app_host/ui/execute
content-security-policy-report-only: (empty)
```

`host-capnweb.js` is served with the asset policy (its own CSP does not apply to `importScripts`).

Other Kibana routes (for example `/app/home`) keep Core's headers unchanged, including `report-uri`
and `report-sample` (here pointing at the harness's synthetic local collector).

### Observed leaks and residuals

- **WebKit preconnect (KNOWN_LEAK)**: `<link rel=preconnect>` to a receiver port nothing else references
  opens a TCP connection (0 in the idle window before); no HTTP request follows. A timing/existence
  channel; a hostname could carry data. Chromium and Firefox opened none, but neither did their controls
  (NOT_VERIFIED).
- **Exact frame path + query (KNOWN_LEAK, accepted residual)**: CSP path matching ignores the query, so
  the child can navigate itself to `<frame URL>?<data>`. The request reaches Kibana and its logs; S7
  answers 404 and the guardian revokes on the reload. All engines.
- **Joint session history (KNOWN_LEAK)**: `history.back()` from the frame navigates the top page in
  Firefox and WebKit (Chromium keeps it); the old frame is removed and no further execute call follows.
  Navigation terminates the bridge Worker and with it the handle; it does not revoke the key or change
  the generation.
- **DNS prefetch, WebRTC/STUN, timing: NOT_VERIFIED** (no DNS or UDP observer).
- **WebKit `load` on fragment navigation**: a same-document `#fragment` navigation fires the iframe's
  `load` event in WebKit, which the guardian treats as a reload and revokes (fail closed); hash-routing
  apps would be revoked in WebKit.
- **Structured clone before validation**: the browser clones each port message into the bridge Worker
  before its queue bound sees it; one message larger than the bound is cloned, then ends the session.
- **Monaco's top-window `message` listener** (monaco-editor 0.56.0 `setTimeout0`, in
  `kbn-ui-shared-deps-src`) does not check `event.source`: a frame can post `{vscodeScheduleAsyncWork:
  n}` to run an already-queued Monaco callback early. Scheduling interference, not data access; the fix
  belongs in `@kbn/monaco` or upstream.
- **Tab DoS / CPU**: a CPU-busy loop in the app frame blocks the Kibana main thread for its whole
  duration in Chromium, Firefox and WebKit (W diagnostic: 2 s loop → ~2 s max delay). The opaque frame
  is same-site and shares the renderer's main thread; the bridge Worker does not help. Serving the
  frame from a separate site would.
- Already-delivered data cannot be recalled; a compromised UI holds the app's grant (T3 shows successful
  reads).

### Deviations from the UI-cut spec

- Assets live under `/api/app_host/ui_assets/{file}` (`/api/` paths are never re-rendered by the security
  plugin); the host scripts have fixed names.
- The bridge Worker is a hand-written, fixed host script (like the guardian) that `importScripts`
  capnweb's installed CommonJS build, served as a second host asset. Bundling a Worker with Kibana's
  optimizer (`new Worker(new URL(…, import.meta.url))`) builds, but the chunk depends on modules
  delegated to the shared-deps DLL (`__kbnSharedDeps_npm__`, here the Buffer polyfill capnweb pulls in),
  which does not exist in a Worker. The Worker script carries its own, stricter CSP.
- The Worker checks only arity, plain-data arguments and `callAppRoute`'s fixed route; scope, index,
  dashboard id and operation shape are validated by the server, so those refusals are audited.
- The theme is not pushed at bootstrap; the UI reads it with `getTheme()` (the Worker receives the
  theme once at start).
- `app_expired` is HTTP 403, not 401 (Kibana's browser client treats any 401 as an expired Kibana session).
- `consent.json` carries no index list; the grant fingerprint covers the indices.
- Once an approval file exists the native summary route runs only the enabled, approved UI release;
  `acceptance` therefore needs `ui:operator -- reset` first.
- Kibana must be used through the configured `server.publicBaseUrl` origin (fail closed otherwise), and
  dev mode needs `KBN_HMR=false` for long browser runs.
- The S5 live redirect fixture is not built; redirects and alias matches are Jest-only.

## Backend prototype (M1–M3), local workerd only

| Question | Result |
|---|---|
| Backend GO/NO-GO | **BLOCKED**: remote Cloudflare acceptance has not run |
| CPU-limit gate (`app_host:app_cpu_limit`) | **NOT RUN** remotely; `NOT_ENFORCED_LOCALLY` on OSS workerd |
| Latency decision (p95 ≤ 2 s) | **NO DECISION**: local numbers say nothing about the remote topology |

`seam --url ws://127.0.0.1:8787/rpc --local-workerd`: exit 0, 24 required assertions true, `loopCpuLimited`, `loopWallBounded` and `loopRecovered` `NOT_ENFORCED_LOCALLY` (OSS workerd ignores Dynamic Worker `limits.cpuMs`; the loop fixture is not run), no failures. Required assertions cover `result:42`,
one callback, authentication (wrong, missing token, idle unauthenticated close), replay, egress
(`fetch`/`connect` blocked by workerd's `globalOutbound: null` policy), seven misuse cases each in a
fresh invocation with no Node handler call, the one-call budget, receiver-side transport limits (1009 for a
257 KiB ASCII frame and for 270,000 UTF-8 bytes in 90,000 code units; `app_host:rpc_limit` / 1011 for
depth 40, each with a control), fresh module state, concurrency, disconnect and reconnect.

`acceptance --kibana http://localhost:5601 --rpc ws://127.0.0.1:8787/rpc --wrangler-log <abs> --local-workerd`
(approval reset first): exit 0, verdict **PASS**, 34 of 37 assertions true, `notVerified: []`, `notEnforcedLocally: [cpuLimitEnforced, cpuLoopWallBounded, cpuLoopRecovery]`. It verifies the dispatcher fingerprint from `x-app-host-timing`,
route authz, ES denial for a no-index user, package failures (digest mismatch, hostApi, unknown field,
wildcard grant, oversized manifest and bundle, each with a no-invocation assertion), forbidden index,
unknown method and callback budget, invalid and oversized app output, the 5 s deadline, the 4-invocation
limiter and abort handling, and an external release served without restart.

Benchmark (`benchmark --samples 20 --local-workerd`, 2026-11-04): Kibana end-to-end p50 11.1 ms / p95 14.6 ms, raw seam p50 4 / p95 6 ms. Fresh-invocation
timings on loopback; not cold-isolate or remote measurements. Published creation pricing is about $2
per 1,000 fresh invocations before allowances.
