# App Host (prototype)

Prototype plugin that runs one operator-installed backend app bundle in a fresh Cloudflare Dynamic
Worker. It gives the app a request-scoped, read-only Elasticsearch capability for the current user,
and renders the app's result on a static host page. With an operator approval file it also hosts the
app's own UI in a guardian-wrapped, opaque-origin iframe with a typed bridge whose calls run as a
restricted, short-lived Elasticsearch API key (the synthetic, local-only UI cut below). It is **disabled by default**, is not production code, and does not offer an SDK,
install API, saved objects or tasks. App-authored browser code never runs in Kibana's origin.

## What it does

- `GET /api/apps/{appId}/summary` (public, requires `read_app_host` **and** `read_app_alert_digest`):
  1. limits in-flight invocations to four per Kibana process (excess → `429`);
  2. reads `manifest.json` from `xpack.app_host.packagePath` **on every request**, then
     `<digest>.js`, and verifies the SHA-256 digest (bounded: manifest 16 KiB, bundle 64 KiB).
     An invalid package fails closed with `500` before any remote call;
  3. opens a **fresh** WebSocket to the dispatcher, sends the caller token to `authenticate`, and
     only then calls `invoke({manifest, bundle, invocationId}, host)`. Nothing on the Node side is
     reachable before authentication;
  4. `host` is a fresh `@remotable` `HostEs` facade exposed with `@kbn/core-remote-common`'s
     `expose`. Its only method is `search({index, size})`: exact index `kbn-apps-prototype-alerts`,
     integer size 1–100, one call per invocation, run with the route's `asCurrentUser` client.
     Results are `{total, records: [{severity, rule}]}`, at most 100 records and 16 KiB;
  5. enforces a 5 s deadline (`504`). In `finally`, it revokes the capability, aborts in-flight
     Elasticsearch work, closes the socket and disposes stubs. Request abort revokes immediately.
     Nothing is replayed;
  6. validates the app output as exactly `{label, counts: {high, low}}`, and returns host-owned JSON
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
- Assets `GET /api/app_host/ui_assets/{file}`: the two fixed host scripts (`host-guardian.js`,
  `host-child.js`) and the approved UI bundle `<uiDigest>.js` (≤512 KiB; its verified bytes are cached by
  digest and re-hashed only when the approved digest or the file's inode/size/mtime changes, F3). Public, `application/javascript`, `Content-Disposition: attachment`, `nosniff`, response
  sandbox. Anything else (unknown, unapproved, disabled, tampered) is **404**, never 401/403 (S6).
- A post-Core `onPreResponse` hook composes the final-wire headers on every App Host path (`/api/app_host/`,
  `/internal/app_host/`, `/api/apps/`), including 4xx/5xx: Core's enforcing policy rebuilt from
  `http.csp.header` minus `report-uri`/`report-to`/`'report-sample'` (S1), then the strict surface policy
  (guardian, child, asset or JSON), an empty `Content-Security-Policy-Report-Only`, and post-Core
  `Referrer-Policy: no-referrer`, a deny-all `Permissions-Policy`, `X-DNS-Prefetch-Control: off`,
  `Cache-Control: no-store` and `nosniff` (S2). Other Kibana routes are untouched.
- Handshake: the parent creates one RPC `MessageChannel` and one control channel, posts them to the
  guardian (exact Kibana origin). The guardian accepts exactly two handshake messages, checking
  `event.source`/origin before reading data (S4): the parent's init and the child's echo of a one-time
  challenge it sends on the child's first load. It then transfers the RPC port once and removes its
  listeners. Any later child or guardian load revokes; nothing is rebound. The host child bootstrap
  clears `window.name`, answers the challenge, then loads only the verified UI bundle. Lifecycle notices
  use the control port; the parent has no window `message` listener.
- Parent RPC: capnweb `RpcSession` over a bounded string-only port transport (32 KiB UTF-8 per frame,
  256 KiB / 1,024-frame queue, `messageerror` terminates; depth 12, BigInt 64, 8 invalid calls
  terminate). These are structural memory bounds, not usage quotas; there are no rate limits. The cap of 128 live capnweb imports + exports is checked by the
  transport each time capnweb asks for the next frame and after every send, so protocol-only growth
  (retained pushes, guest-exported stubs, unknown-method pipelines) terminates the session too
  (`live_stubs`), not only bridge-method entry. Depth and BigInt breaches terminate with
  `depth_exceeded` / `bigint_too_large`. Errors sent to the guest carry no stack in any engine (an own
  empty `stack` shadows Firefox's inherited accessor). No global message dispatcher.

U2 — delegation and consent:

- Manifest UI envelope `{entry, digest, bridgeApi: 1, scopeMapDigest, scopes, egress: {client: [],
  server: []}}`, `permissions.dashboardIds` (one UUID) and `releaseDigest` (canonical SHA-256 of every
  other manifest field). Non-empty egress, unknown/duplicate scopes, any index but the synthetic literal
  (S8), a scope-map digest other than the host's pinned bridgeApi 1 contract (capabilities + UI security
  profile, `common/ui_contract.ts`), non-numeric versions and digest mismatches are rejected at parse.
  Legacy backend-only manifests stay valid and carry none of these fields.
- Operator approval `consent.json` (`xpack.app_host.consentPath`, mode 0600, exact keys `appId, enabled,
  approvedReleaseDigest, approvedVersion, approvedBy, installerGrantDigest`), re-read on every request.
  Written only by the local approval tool (`release --with-ui --approve-local-synthetic`), which checks the
  installer is a `superuser` in ES, the same principal in Kibana, has ES `_has_privileges` read on the exact
  index and can natively GET the exact dashboard; it refuses downgrades and is idempotent for the same
  digest. Once an approval file exists, the native `/api/apps/{appId}/summary` also runs only the enabled,
  approved release; without one, only legacy manifests run. The approval tool's same-principal check
  compares username **and** authentication realm (type and name) in ES and Kibana (F5).
- Fixed per-app privilege `read_app_alert_digest` (feature `appHostAlertDigest`), required **with**
  `read_app_host` for metadata, documents, sessions, execution and the native summary.
- **App session = restricted API key** (spec `kibana-apps-key-session-spec.md`). When the viewer clicks
  **Allow this version**, the parent calls `POST /internal/app_host/ui/session` `{appId, releaseDigest}`
  (authenticated, both privileges, Kibana XSRF, exact configured `Origin`, default space, no run_as; the
  release must be enabled and approved). The server mints one key with the security service's
  `grantAsInternalUser` from the viewer's own credentials: name `app:{appId}@{releaseDigest}`, metadata
  `{app_host, app, release, space}`, expiration 1 h, and a role descriptor derived **only** from the
  approved manifest: `read` on `permissions.indices`, `feature_dashboard_v2.read` on `space:default` only
  with the `kibana.dashboard.read` scope, no cluster privileges, no `run_as`
  (`server/ui/app_key.ts`). Elasticsearch caps the key at the viewer's privileges (`limited_by`), so
  every call is enforced natively as **viewer ∩ app**.
- The response is an opaque **handle** `<releaseDigest>.<base64url(iv|tag|ciphertext)>`: AES-256-GCM
  (key = SHA-256 of `xpack.app_host.handleEncryptionKey`) over `{id, apiKey, app, release, space,
  principal, exp}` with AAD `app|release|space|principal` (`server/ui/session_handle.ts`). It is
  stateless: nothing is stored and any node with the same key can open it. The raw API key never
  leaves the Kibana server process (not to parent JS, the frame, the port, the Worker, logs or audit).
- `POST /internal/app_host/ui/execute` `{handle, op, params}` (same route checks). The server opens
  the handle (tampered, another principal or space → `app_denied`; expired → `app_expired`), reads
  enablement and approval (cached ≤ 2 s; disabled → `app_disabled`, release changed → `app_stale`),
  validates the closed operation union, scope, the exact synthetic index and size, and the declared
  dashboard id **as input validation only**, then runs the operation **as the key**: `es.search` via
  `elasticsearch.client.asScoped({headers: {authorization: 'ApiKey …'}})`, `kibana.dashboard.read`
  via the local `selfClient` on a fake request carrying the same header (`GET /api/dashboards/{id}`
  version `2023-10-31`; fails closed on redirects, non-200, bodies over 256 KiB and
  `body.id !== grantedId`, S5), and `app.summary` → Worker → `HostEs` callbacks with the same
  key-scoped client. 5 s deadline. Errors are fixed codes only (`app_denied`, `app_unavailable`,
  `app_stale`, `app_disabled`, `app_expired`, `app_rate_limited` (backend invocation limiter only),
  `app_timeout`, `app_cpu_limit`, `bridge_invalid_request`, `bridge_protocol_error`).
- **Revocation.** The operator command flips the persisted state first (`ui:operator -- disable|reset`,
  or a new approval), then invalidates the app's keys by name as Kibana's internal user
  (`DELETE /_security/api_key {name: "app:alert-digest@*"}` or `@<previous release>`). `kibana_system`
  can invalidate by name (wildcards included) but cannot list or query other users' keys, so
  query-then-invalidate-by-id is not available to it. The per-call state check covers the window
  before invalidation lands. Unmount or navigation just drops the handle in the parent; no server call.
- No leases, lease secrets, lease caps, token buckets, operation counters, in-flight caps or UI process
  cap remain. Abuse is handled by audit plus disable; ES-native protections (search timeouts,
  `search.max_buckets`, circuit breakers) cover node safety.
- A closed capability registry (`server/ui/capability_registry.ts`) refuses credential-minting, deferred,
  egress-side-effect and reference-accepting capabilities. The never-delegable list is enforced by *not
  granting* it in the key's role descriptor plus the typed surface. Minting the session key is a
  host-internal broker on consent, never an app capability.
- Parent bridge: exactly `callAppRoute({method:'GET', path:'/summary'})`, `search({index, size})`,
  `getDashboardPreview({id})`, `getTheme()`; plain-data arguments only; the handle stays in the parent's
  closure and travels only in the execute JSON body. No metadata polling: the page reads metadata on
  load and once more after a server rejection that ends the frame (`app_disabled`, `app_stale`,
  `app_expired`), so a different release unmounts the old frame before its consent prompt appears (S10).
  An expired handle is re-minted once per call, only inside the session created by this page's consent.
  A session that is still being minted when consent is withdrawn (Disable), the page unmounts or the
  release changes never mounts or binds a frame (generation check).
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
- Release v2 needs operator approval and a new viewer click; no Kibana restart or dispatcher redeploy.
- The native `GET /api/apps/{appId}/summary` serves the default space only (404 elsewhere) and writes one
  `app_host.bridge` record per call (`event.provider: native`; app attribution from the approved release,
  none in legacy mode) (F7).

capnweb sessions use `maxMessageSize: 256 KiB`, `maxDepth: 32` and `maxBigIntDigits: 64`, plus a
transport that rejects binary frames, frames over 256 KiB and a receive queue over 1 MiB before
parsing. Both caps count **UTF-8 bytes** (capnweb's own `maxMessageSize` counts UTF-16 code units).
Node's built-in WebSocket cannot cap `maxPayload`, so one oversized frame is still buffered before it
is rejected. Errors sent to the dispatcher are replaced with a stackless `app_host:<code>` error, so
no host stack or source path crosses the wire.

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
`http.server.response`, `plugins.appHost` and `plugins.security` (used to prove neither handle nor key
reaches logs). It also writes `.local/kibana.app_host.k1.yml` (the K1 bypass; pass it as a second `-c`).
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
npm --prefix "$P/prototype" run ui:seed           # hostile record, synthetic dashboards, empty space, viewers
npm --prefix "$P/prototype" run release -- --with-ui --version 2.0.0 --approve-local-synthetic  # INSTALLER_AUTH or ES_AUTH
npm --prefix "$P/prototype" run ui:operator -- disable|enable|status|reset   # disable/reset also invalidate keys
npm --prefix "$P/prototype" run ui:security -- --kibana "$KB_URL" --engines chromium,firefox,webkit
# K1 (ES enforces with the input schema bypassed): restart Kibana with a second config, then
#   node scripts/kibana --dev --no-base-path -c .../kibana.app_host.yml -c .../kibana.app_host.k1.yml
npm --prefix "$P/prototype" run ui:security -- --kibana "$KB_URL" --suites k1
```

`acceptance` runs in legacy mode: remove the approval file first (`ui:operator -- reset`); `ui:security`
starts from a reset approval and resets it again at the end.

Open `$KB_URL/app/appHost` as `app_host_reader`, release another label, and press **Refresh**.
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
