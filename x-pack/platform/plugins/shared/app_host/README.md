# App Host (prototype)

Prototype plugin that runs one operator-installed backend app bundle in a fresh Cloudflare Dynamic
Worker. It gives the app a request-scoped, read-only Elasticsearch capability for the current user,
and renders the app's result on a static host page. With an operator approval file it also hosts the
app's own UI in a guardian-wrapped, opaque-origin iframe with a typed bridge whose calls run as a
restricted, short-lived Elasticsearch API key (the synthetic, local-only UI cut below). The bridge runs
in a dedicated Web Worker per app frame, off the Kibana UI thread. The sample
app's UI includes a **Mini Discover** tile that lists and reads Kibana data views and runs ES|QL, all as
that key. It is **disabled by default**, is not production code, and does not offer an SDK, install API,
saved objects or tasks. App-authored browser code never runs in Kibana's origin.

## What it does

- `GET /api/apps/{appId}/summary` (public, requires `read_app_host` **and** `read_app_alert_digest`):
  1. reads `manifest.json` from `xpack.app_host.packagePath` **on every request** (regular files
     only, no symlinks), parses it against the schema, then reads `<digest>.js` and verifies the
     SHA-256 digest. An invalid package fails closed with `500` before any remote call. There is no
     size cap of the host's own; Cloudflare enforces its script size limits;
  2. opens a **fresh** WebSocket to the dispatcher, sends the caller token to `authenticate`, and
     only then calls `invoke({manifest, bundle, invocationId}, host)`. Nothing on the Node side is
     reachable before authentication;
  3. `host` is a fresh `@remotable` `HostEs` facade exposed with `@kbn/core-remote-common`'s
     `expose`. Its only method is `search({index, size})`: exact index `kbn-apps-prototype-alerts`
     and an integer size (Elasticsearch applies its own limits), run with the route's
     `asCurrentUser` client. Results are `{total, records: [{severity, rule}]}`;
  4. has no invocation limiter, callback budget or host deadline: like any API client, an app gets
     Kibana's and Elasticsearch's own limits; the Dynamic Worker keeps Cloudflare's CPU and
     subrequest limits. In `finally`, and immediately on request abort or a dispatcher disconnect,
     it revokes the capability, aborts in-flight Elasticsearch work, closes the socket and disposes
     stubs. Nothing is replayed;
  5. validates the app output as exactly `{label, counts: {high, low}}`, and returns host-owned JSON
     `{appId, version, label, counts}`. An Elasticsearch authorization failure is a `403`, whatever
     the app returned. Other remote failures are a sanitized `502`.
- Responses that reached the dispatcher carry a host-owned `x-app-host-timing` header. It starts
  with `dispatcher;desc="scheme=<ws|wss>,class=<loopback|remote>,fp=<16 hex>"`: a SHA-256
  fingerprint of the normalized dispatcher URL this Kibana process actually uses (never the URL or
  token). Successful responses add phase durations, the callback count and logical JSON byte counts.
  The prototype tooling recomputes the fingerprint from `--rpc` and refuses to run against a
  different dispatcher.
- `GET /internal/app_host/apps` (same privileges): `{apps: [{id, title, version}]}`.
- `/app/appHost`: a static, host-rendered page with title, version, refresh button and severity
  table. App-provided text is rendered as text.

## Third-party app UI (synthetic, local-only cut)

Spec: `kibana-apps-ui-cut-spec.md` (design docs) and its security sign-off (conditions S1–S11). This is
a synthetic-data prototype, **not** approval to expose customer data to third-party browser code, and
not production-ready (production gates G1–G6 are not implemented).

U1 — browser shell (no data capability):

- Static deep link `alert-digest` → `/app/appHost/alert-digest`: trusted host chrome (title, fixed
  publisher, approved version, release fingerprint, scopes, resources, declared egress, the required
  consent copy, **Allow this version** and **Disable**) outside the frame. Package-supplied text renders
  as text. Nothing is framed before the viewer clicks Allow.
- Topology: trusted parent → trusted same-origin **guardian** iframe (`referrerpolicy=no-referrer`, no
  `sandbox`/`allow`/`allowfullscreen`) → opaque app iframe with exactly `sandbox="allow-scripts"` and
  `referrerpolicy="no-referrer"`.
- Documents `GET /api/app_host/ui/{appId}/{releaseDigest}/{guardian|frame}`: both privileges, approved and
  enabled release only, default space only, `Sec-Fetch-Dest: iframe` only (else 403 JSON), no query
  string, fixed generated HTML with server-derived values in a JSON data block.
- Assets `GET /api/app_host/ui_assets/{file}`: the fixed host scripts (`host-guardian.js`,
  `host-child.js`, the bridge Worker `host-bridge-worker.js` and `host-capnweb.js`, capnweb's installed
  CommonJS build wrapped to define `self.capnweb` for the Worker's `importScripts`) and the approved UI
  bundle `<uiDigest>.js` (≤512 KiB; its verified bytes are cached by digest and re-hashed only when the
  approved digest or the file's inode/size/mtime changes, F3). Public, `application/javascript`,
  `Content-Disposition: attachment`, `nosniff`; response sandbox on all but the Worker script, which gets
  the Worker policy instead. Anything else (unknown, unapproved, disabled, tampered) is **404**, never
  401/403 (S6).
- A post-Core `onPreResponse` hook composes the final-wire headers on every App Host path (`/api/app_host/`,
  `/internal/app_host/`, `/api/apps/`), including 4xx/5xx: Core's enforcing policy rebuilt from
  `http.csp.header` minus `report-uri`/`report-to`/`'report-sample'` (S1), then the strict surface policy
  (guardian, child, Worker, asset or JSON), an empty `Content-Security-Policy-Report-Only`, and post-Core
  `Referrer-Policy: no-referrer`, a deny-all `Permissions-Policy`, `X-DNS-Prefetch-Control: off`,
  `Cache-Control: no-store` and `nosniff` (S2). Other Kibana routes are untouched.
- Handshake: the parent creates one RPC `MessageChannel`, transfers one end to its bridge Worker and,
  once the Worker reports a minted session, posts the other end and one control channel to the
  guardian (exact Kibana origin). The guardian accepts exactly two handshake messages, checking
  `event.source`/origin before reading data (S4): the parent's init and the child's echo of a one-time
  challenge it sends on the child's first load. It then transfers the RPC port once and removes its
  listeners. Any later child or guardian load revokes; nothing is rebound. The host child bootstrap
  clears `window.name`, answers the challenge, then loads only the verified UI bundle. Lifecycle notices
  use the control port; the parent has no window `message` listener.
- **Bridge Worker** (`server/ui/host_scripts.ts`, served as `host-bridge-worker.js`): one dedicated
  Worker per app frame, owned by the parent page, which Kibana's CSP already permits (`worker-src
  'self'`). Its response policy is Core's plus `default-src 'none'; script-src <host-capnweb.js>;
  connect-src <session URL> <execute URL>`, so it can import only capnweb and call only those two
  routes. It takes exactly one init message (`{appId, releaseDigest, theme, sessionUrl, executeUrl}`
  and its port), mints the app session, then runs the capnweb `RpcSession` and the typed methods
  (below), calling `/internal/app_host/ui/execute` with `kbn-xsrf` and `x-elastic-internal-origin:
  Kibana` (internal routes are not versioned; the URLs carry the base path). The handle exists only in
  the Worker and in the request bodies it sends. The parent keeps lifecycle only: consent, Disable,
  mount and unmount, and `worker.terminate()` on teardown, on a server rejection (`app_disabled`,
  `app_stale`, `app_expired`, a failed mint) and on a Worker error. Worker → parent messages are
  `{t: 'ready'}` and `{t: 'end', reason}` only.
- The Worker's one bound is its receive queue: bytes of guest frames waiting for capnweb (2 bytes per
  UTF-16 code unit), 8 MiB. Overflow, a non-string frame or `messageerror` ends the session; the parent
  terminates the Worker and removes the frame. capnweb's own deserialization defaults apply (depth 256,
  BigInt 16,384 digits, 32 Mi code units per message). There is no frame cap, stub cap or
  invalid-call counter, and no rate limits. Errors sent to the guest carry only a fixed code and no
  stack (an own empty `stack` shadows Firefox's inherited accessor). No global message dispatcher.
- A CPU-busy loop in the app frame itself still blocks the Kibana main thread in all three tested
  engines (same-site frames share the renderer thread; see `prototype/RESULTS.md`). Separate-site
  hosting would fix that; the Worker does not.

U2 — delegation and consent:

- Manifest UI envelope `{entry, digest, bridgeApi: 1, scopeMapDigest, scopes, egress: {client: [],
  server: []}}`, `permissions.dashboardIds` (one UUID) and `releaseDigest` (canonical SHA-256 of every
  other manifest field). Scopes: `app.summary`, `es.search`, `kibana.dashboard.read`,
  `kibana.dataViews.read`, `es.esql`. `permissions.indices` is a list that must contain the backend
  literal `kbn-apps-prototype-alerts` (the Worker's only index) and may add `kbn-apps-demo-` names or
  trailing-wildcard patterns (the release uses `kbn-apps-demo-logs-*`); anything else is rejected (S8,
  synthetic data only; Elasticsearch enforces the grant through the key). Non-empty egress,
  unknown/duplicate scopes, other indices, a scope-map digest other than the host's pinned bridgeApi 1 contract (capabilities + UI security
  profile, `common/ui_contract.ts`), non-numeric versions and digest mismatches are rejected at parse.
  Legacy backend-only manifests stay valid and carry none of these fields.
- Operator approval `consent.json` (`xpack.app_host.consentPath`, mode 0600, exact keys `appId, enabled,
  approvedReleaseDigest, approvedVersion, approvedBy, installerGrantDigest, generation`), re-read on every
  request. `generation` is a fresh random token (16 bytes, base64url) written on every approval
  (including the first one after a `reset`, which deletes the record) and every disable. Execute only
  compares it for equality; no clock or ordering is involved.
  Written only by the local approval tool (`release --with-ui --approve-local-synthetic`), which checks the
  installer is a `superuser` in ES, the same principal in Kibana, has ES `_has_privileges` `read` and
  `view_index_metadata` on every granted index and pattern and can natively GET the exact dashboard; it refuses downgrades and is idempotent for the same
  digest. Once an approval file exists, the native `/api/apps/{appId}/summary` also runs only the enabled,
  approved release; without one, only legacy manifests run. The approval tool's same-principal check
  compares username **and** authentication realm (type and name) in ES and Kibana (F5).
- Fixed per-app privilege `read_app_alert_digest` (feature `appHostAlertDigest`), required **with**
  `read_app_host` for metadata, documents, sessions, execution and the native summary.
- **App session = restricted API key** (spec `kibana-apps-key-session-spec.md`). When the viewer clicks
  **Allow this version**, the parent starts the bridge Worker, which calls `POST
  /internal/app_host/ui/session` `{appId, releaseDigest}`
  (authenticated, both privileges, Kibana XSRF, exact configured `Origin`, default space, no run_as; the
  release must be enabled and approved). The server mints one key with the security service's
  `grantAsInternalUser` from the viewer's own credentials: name `app:{appId}@{releaseDigest}`, metadata
  `{app_host, app, release, space}`, expiration 1 h, `refresh=false`, and a role descriptor derived **only** from the
  approved manifest: `read` and `view_index_metadata` on `permissions.indices`, and on `space:default`
  `feature_dashboard_v2.read` with the `kibana.dashboard.read` scope and `feature_indexPatterns.read` with
  the `kibana.dataViews.read` scope; empty `cluster` (so ES refuses ES|QL `ENRICH` and explicit inference commands such as `COMPLETION`/`RERANK`;
  a semantic query on a granted index's `semantic_text` field still runs that field's operator-configured
  inference endpoint, as it does for any reader of the index),
  no `run_as` (`server/ui/app_key.ts`). Elasticsearch caps the key at the viewer's privileges (`limited_by`), so
  every call is enforced natively as **viewer ∩ app**. After the grant returns, the server re-reads the
  state: if the app was disabled or the generation changed meanwhile (a disable, or a disable plus
  re-enable, during the grant), the new key is invalidated by id as the internal user and never issued.
- The response is an opaque **handle** `<releaseDigest>.<generation>.<base64url(iv|tag|ciphertext)>`:
  AES-256-GCM (key = SHA-256 of `xpack.app_host.handleEncryptionKey`) over `{id, apiKey, app, release,
  space, principal, generation, exp}` with AAD `app|release|space|principal|generation`
  (`server/ui/session_handle.ts`). It is
  stateless: nothing is stored and any node with the same key can open it. The raw API key never
  leaves the Kibana server process (not to the page, the bridge Worker, the frame, the port, the
  backend Worker, logs or audit).
- `POST /internal/app_host/ui/execute` `{handle, op, params}` (same route checks, Kibana's default body
  limit). The server opens
  the handle (tampered, another principal or space → `app_denied`; expired → `app_expired`), reads
  enablement, approval and generation (a cached read ≤ 2 s may only accept; refusals use a fresh read;
  disabled → `app_disabled`, release or generation changed → `app_stale`),
  validates the closed operation union, scope, the exact synthetic index and size, the declared
  dashboard id, the data view id syntax and a non-empty ES|QL query **as input validation only**, then
  runs the operation **as the key**:
  - `es.search` via `elasticsearch.client.asScoped({headers: {authorization: 'ApiKey …'}})`;
  - `kibana.dashboard.read` via the local `selfClient` on a fake request carrying the same header
    (`GET /api/dashboards/{id}` version `2023-10-31`): the Dashboard API response unchanged; fails
    closed on redirects (the final URL must equal the fixed path), non-200 and `body.id !== grantedId`
    (S5);
  - `kibana.dataViews.read` the same way: `GET /api/data_views` and `GET
    /api/data_views/data_view/{id}`, the Data Views API responses unchanged (runtime fields and field
    formats included; `server/ui/data_views.ts`; redirects and non-200 fail closed). Data view ids are
    `[A-Za-z0-9_][A-Za-z0-9_.:*-]*`, ≤ 128 characters;
  - `es.esql` via `esql.query` on the key-scoped ES client (`server/ui/esql.ts`): any non-empty query,
    no command allowlist, `maxRetries: 0`, the ES client's own request timeout; the response's `columns` and `values`
    as Elasticsearch sent them. Row limits are Elasticsearch's (the query's `LIMIT` and the cluster's
    ES|QL limits);
  - `app.summary` → backend Worker → `HostEs` callbacks with the same key-scoped client. Before
    **each** callback the host rechecks the session's lifecycle exactly as execute does (enabled,
    approved release, generation; the 2 s cache may accept, refusals use a fresh read). A held
    invocation therefore cannot start new searches after a disable or a generation change, even if
    the key's cleanup in Elasticsearch missed: the callback fails with `app_host:app_disabled` or
    `app_host:app_stale` before any Elasticsearch I/O and is audited (`via: app.summary`, reason
    `disabled` / `stale_generation` / …). A search already admitted runs to completion.

  No result size caps and no host deadline; a request abort aborts the operation. Native refusals map
  to `app_denied`, with the audit reason `native_denied` for a 401/403/404 and `native_rejected` for a
  400: ES|QL reports an index the key may not read exactly like a missing one (`400 Unknown index`), and
  the Data Views API reports an unauthorized saved-object read as `400 Unable to bulk_get
  index-pattern`. Errors are fixed codes only (`app_denied`, `app_unavailable`,
  `app_stale`, `app_disabled`, `app_expired`, `app_cpu_limit`, `bridge_invalid_request`,
  `bridge_protocol_error`).
- **Revocation.** The operator command replaces the generation and persists the state first
  (`ui:operator -- disable|reset`, or a new approval). From then on every earlier handle is refused
  (`app_stale`), also after a re-enable, whether or not the key's invalidation succeeded. It then
  invalidates the app's keys by name as Kibana's internal user (`DELETE /_security/api_key {name:
  "app:alert-digest@*"}` or `@<previous release>`) as cleanup; an HTTP or transport error or
  `error_count > 0` is reported and the command exits non-zero (the state stays as written, and enable
  is not blocked). `kibana_system` can invalidate by name (wildcards included) but cannot list or query
  other users' keys, so query-then-invalidate-by-id is not available to it. Name invalidation can miss a
  key minted less than one `.security` refresh earlier; the generation makes that key's handle useless.
  Restoring the exact approved release while the app stays enabled (no disable, uninstall or new
  approval in between) keeps the generation, so unexpired handles for it work again. Unmount or
  navigation terminates the bridge Worker and with it the handle; no server call.
- There are no rate limits, budgets, deadlines, operation counters or in-flight caps, on the UI or
  the backend path. Abuse
  is handled by audit plus disable; ES-native protections (search timeouts,
  `search.max_buckets`, circuit breakers) cover node safety.
- A closed capability registry (`server/ui/capability_registry.ts`) refuses credential-minting, deferred,
  egress-side-effect and reference-accepting capabilities. The never-delegable list is enforced by *not
  granting* it in the key's role descriptor plus the typed surface. Minting the session key is a
  host-internal broker on consent, never an app capability.
- Bridge methods (in the Worker): exactly `callAppRoute({method:'GET', path:'/summary'})`,
  `search({index, size})`, `getDashboardPreview({id})`, `listDataViews()`, `getDataView({id})`,
  `esql({query})`, `getTheme()`. The Worker checks arity and plain-data arguments (JSON values only:
  functions, stubs, thenables and class instances are refused) and that `callAppRoute` names `GET
  /summary`, then forwards `{op, params}`; the server validates everything else. Results are forwarded
  as the server returned them; the handle travels only in the execute JSON body. No metadata polling:
  the page reads metadata on load and once more after a server rejection that ends the frame
  (`app_disabled`, `app_stale`, `app_expired`, a failed mint), so a different release unmounts the old
  frame before its consent prompt appears (S10). An expired handle is re-minted once per call, only
  inside the Worker started by this page's consent. The frame mounts only after the Worker reports a
  minted session; withdrawing consent (Disable), unmounting or a release change terminates the Worker
  first, so a session still being minted never mounts or binds a frame.
- **K1 fault injection (dev-only).** `xpack.app_host.testOnlySkipInputSchema: true` skips the scope,
  index-literal and dashboard-id input checks so that Elasticsearch and Kibana must deny on their own. The
  setting exists only in dev mode (`--dev`); any value outside dev mode fails config validation. It is
  off by default and set only by `.local/kibana.app_host.k1.yml`.

U3 — adversarial demo and attribution:

- `app_host.bridge` structured records (logger `plugins.appHost.bridge_audit`, JSON appender): handle-derived
  `app.{id,version,release_digest,capability,via}`, `api_key.id` (the session key's id, never the key),
  `user.name`, `kibana.{space_id,correlation_id}`, `event.{action,outcome,reason}`. Worker-path `HostEs`
  reads inside `app.summary` are recorded with the same correlation id (S9). No keys, handles, payloads,
  titles or raw errors; control characters are replaced and fields capped. Prototype attribution, not tamper-proof audit storage.
- A new release needs operator approval and a new viewer click; no Kibana restart or dispatcher redeploy.
- The native `GET /api/apps/{appId}/summary` serves the default space only (404 elsewhere) and writes one
  `app_host.bridge` record per call (`event.provider: native`; app attribution from the approved release,
  none in legacy mode) (F7).

Mini Discover (sample UI, `prototype/ui/src/discover.ts`): plain DOM in the same classic IIFE, no EUI. A
data view picker filled from `listDataViews()` (`data_view[]`); on selection `getDataView({id})` lists
the fields of the returned `data_view` (runtime fields marked) and prefills an editable ES|QL box with `FROM <title> | SORT <timeField> DESC | LIMIT 50`; **Run** renders a
results table and a second query, `FROM <title> | STATS c = COUNT(*) BY b = BUCKET(<timeField>, 1 hour) |
SORT b`, renders a bar chart of DOM elements. Every value is set with `textContent`; errors show their
uniform code. What the app can read is decided natively: index patterns by ES through the key (a data
view on an index outside the grant is listed, because Kibana privileges are per saved-object type, but
any query against its index is refused by ES), data views by Kibana's saved-object authorization for the
key. Note that `feature_dashboard_v2.read` also grants `index-pattern` read, so a release that keeps
`kibana.dashboard.read` but drops `kibana.dataViews.read` is refused data views only by the server's
scope check, not by Kibana.

Backend (Node ↔ dispatcher) capnweb sessions use capnweb's default deserialization limits. Each
side's transport has one bound, the same as the UI Worker's: a receive queue of 8 MiB
(`RECEIVE_QUEUE_BYTES`, 2 bytes per UTF-16 code unit) of frames not yet read by capnweb. Overflow or
a binary frame closes the socket (1009) before capnweb parses anything. Node's built-in WebSocket
cannot cap `maxPayload`, so a frame is buffered before the bound sees it. Errors sent to the
dispatcher are replaced with a stackless `app_host:<code>` error, so no host stack or source path
crosses the wire.

The Cloudflare dispatcher, sample app, fixtures and all demo tooling live in the isolated
[`prototype/`](./prototype/README.md) tool package.

## Configuration

```yaml
xpack.app_host:
  enabled: true
  packagePath: /abs/path/to/package            # operator-controlled directory
  dispatcherUrl: wss://<name>.<subdomain>.workers.dev/rpc   # ws:// only for 127.0.0.1/localhost
  callerToken: <32+ char random secret>         # same value as the dispatcher's KIBANA_CALLER_TOKEN
  consentPath: /abs/path/to/operator/consent.json  # optional; enables the third-party UI cut
  handleEncryptionKey: <32+ char random secret>  # required; AES-256-GCM key material for session handles
  # testOnlySkipInputSchema: true               # K1 fault injection; accepted only in --dev, default false
server.publicBaseUrl: http://localhost:5601     # required for the UI cut (exact CSP sources, Origin check)
csp.frame_ancestors: ["'self'"]                 # trusted chrome cannot be embedded externally
```

`npm run kibana:config` writes all of the above for local development (the handle key is generated once
into `.local/handle_key`, never printed), plus a synthetic CSP report collector (`csp.report_uri`),
Kibana's security audit log, the JSON `app_host.bridge` audit appender and debug appenders for
`http.server.response`, `plugins.appHost`, `plugins.security` and the outgoing `elasticsearch.query`
logger (used to prove neither handle nor key reaches logs). It also writes `.local/kibana.app_host.k1.yml` (the K1 bypass; pass it as a second `-c`).
Logs go to `prototype/.local/logs/`. Elasticsearch must have API keys enabled
(`xpack.security.authc.api_key.enabled`, the default; `node scripts/es snapshot` needs nothing extra).

Installing the plugin needs one Kibana restart. After that, releasing new app code (a new
`<digest>.js` and an atomically replaced `manifest.json`) needs no Kibana restart and no dispatcher
redeploy.

## Local demo (local workerd, not remote acceptance)

All commands run from the worktree root under Node 24.22.1. Secrets go into git-ignored files under
`prototype/.local/`. They are never printed.

```bash
nvm use 24.22.1
node scripts/kbn bootstrap
P=x-pack/platform/plugins/shared/app_host
npm ci --prefix "$P/prototype"
npm --prefix "$P/prototype" run secret:local        # caller secret + cloudflare/.dev.vars
npm --prefix "$P/prototype" run kibana:config       # writes $P/prototype/.local/kibana.app_host.yml (0600)

# terminal 1: dispatcher (local workerd)
(cd "$P/prototype" && npx wrangler dev --config cloudflare/wrangler.jsonc --ip 127.0.0.1 2>&1 | tee .local/logs/wrangler.log)
# terminal 2: Elasticsearch
node scripts/es snapshot
# terminal 3: Kibana
node scripts/kibana --dev --no-base-path -c "$PWD/$P/prototype/.local/kibana.app_host.yml"

# terminal 4
export ES_URL=http://localhost:9200 ES_AUTH=elastic:changeme KB_URL=http://localhost:5601
export APP_PACKAGE_DIR="$PWD/$P/prototype/.local/package"
npm --prefix "$P/prototype" run seed                 # 3 synthetic docs + reader/no-index/no-feature users
npm --prefix "$P/prototype" run release -- --version 1.0.0 --label 'Digest v1' --out "$APP_PACKAGE_DIR"
READER="app_host_reader:$(node -p "require('./$P/prototype/.local/users.json').reader.password")"
curl -s -u "$READER" "$KB_URL/api/apps/alert-digest/summary"
# {"appId":"alert-digest","version":"1.0.0","label":"Digest v1","counts":{"high":2,"low":1}}
curl -s -u "$READER" -H 'x-elastic-internal-origin: kibana' "$KB_URL/internal/app_host/apps"
# {"apps":[{"id":"alert-digest","title":"Alert digest","version":"1.0.0"}]}
npm --prefix "$P/prototype" run release -- --version 1.0.1 --label 'Digest v2' --out "$APP_PACKAGE_DIR"
curl -s -u "$READER" "$KB_URL/api/apps/alert-digest/summary"
# {"appId":"alert-digest","version":"1.0.1","label":"Digest v2","counts":{"high":2,"low":1}}
# --wrangler-log needs an absolute path (npm runs the script in the prototype directory)
npm --prefix "$P/prototype" run acceptance -- --kibana "$KB_URL" --rpc ws://127.0.0.1:8787/rpc \
  --wrangler-log "$PWD/$P/prototype/.local/logs/wrangler.log" --local-workerd
npm --prefix "$P/prototype" run ui-check -- --kibana "$KB_URL"   # page v1 -> v2 via Refresh, screenshots in .local/
npm --prefix "$P/prototype" run benchmark -- --kibana "$KB_URL" --samples 20 \
  --rpc ws://127.0.0.1:8787/rpc --local-workerd

# Third-party UI cut (start Kibana with KBN_HMR=false: dev-mode HMR reloads pages whenever files under
# prototype/.local change, which breaks long browser runs)
npm --prefix "$P/prototype" run ui:seed           # hostile record, dashboards, demo logs + data views, empty space, viewers
npm --prefix "$P/prototype" run release -- --with-ui --version 2.0.0 --approve-local-synthetic  # INSTALLER_AUTH or ES_AUTH
npm --prefix "$P/prototype" run release -- --with-ui --version 2.1.0 --approve-local-synthetic  # next release: viewers consent again
npm --prefix "$P/prototype" run ui:operator -- disable|enable|status|reset   # disable/reset also invalidate keys
npm --prefix "$P/prototype" run ui:security -- --kibana "$KB_URL" --engines chromium,firefox,webkit
npm --prefix "$P/prototype" run ui:security -- --kibana "$KB_URL" --suites discover   # D1–D5 only
# K1 (ES enforces with the input schema bypassed): restart Kibana with a second config, then
#   node scripts/kibana --dev --no-base-path -c .../kibana.app_host.yml -c .../kibana.app_host.k1.yml
npm --prefix "$P/prototype" run ui:security -- --kibana "$KB_URL" --suites k1
```

`acceptance` runs in legacy mode: remove the approval file first (`ui:operator -- reset`); `ui:security`
starts from a reset approval and resets it again at the end.

Open `$KB_URL/app/appHost` as `app_host_reader`, release another label, and press **Refresh**. For the
Mini Discover tile, open `$KB_URL/app/appHost/alert-digest` as `app_host_ui_viewer` (password in
`.local/ui_users.json`), click **Allow this version** and pick *Demo logs*.
`acceptance` and `ui-check` mutate the package directory and restore its original manifest at the end.

`acceptance` and `benchmark` first verify, from the `dispatcher` fingerprint in `x-app-host-timing`,
that Kibana uses the `--rpc` dispatcher, and stop otherwise. Local versus remote is derived from
that evidence. `--local-workerd` is accepted only for a loopback `--rpc` and a verified loopback
dispatcher; it reports the CPU-loop checks as `NOT_ENFORCED_LOCALLY`, because OSS workerd does not
enforce Dynamic Worker `limits.cpuMs`. Remote acceptance must run without that flag, against a
`wss://` dispatcher deployed with explicit approval (see `prototype/README.md`). Without
`--wrangler-log`, the "no dispatcher connection" checks are reported `NOT_VERIFIED` (exit code 3),
never as passing.

## Checks

```bash
node scripts/jest x-pack/platform/plugins/shared/app_host
node scripts/type_check --project x-pack/platform/plugins/shared/app_host/tsconfig.json
node scripts/eslint x-pack/platform/plugins/shared/app_host
npm --prefix x-pack/platform/plugins/shared/app_host/prototype run lint   # Workers tsc + scoped Kibana lint
npm --prefix x-pack/platform/plugins/shared/app_host/prototype run test
```
