# App Host prototype tooling

Isolated tool package for the App Host prototype: the Cloudflare dispatcher Worker, the sample
`alert-digest` app, adversarial seam fixtures and the `seam`, `seed`, `release`, `acceptance`,
`benchmark` and `test` scripts. It has its own pinned dependencies and lockfile; it is not part of
the Kibana workspace and is not a public SDK.

See `../README.md` for the end-to-end Kibana demo (M2/M3). This file covers the tool package, M1 and
the remote steps.

| Script | Purpose |
|---|---|
| `secret:local` | Generate the 32-byte caller secret (`.local/caller_token`, `cloudflare/.dev.vars`), never printed |
| `dev` / `dev:probe` | `wrangler dev` for the dispatcher (8787) / the diagnostic env probe (8788) |
| `seam` | M1 assertions: Node → dispatcher → fresh Dynamic Worker → Node callback |
| `kibana:config` | Write the git-ignored Kibana config `.local/kibana.app_host.yml` (0600, incl. the generated `.local/handle_key`) and `.local/kibana.app_host.k1.yml` (dev-only K1 input-schema bypass, add as a second `-c`) |
| `seed` | Synthetic index (high/high/low, no aliases) and reader/no-index/no-feature roles and users |
| `release` | Build the sample app; write `<sha256>.js` first, then atomically replace `manifest.json`. `--with-ui` also builds the UI IIFE and the UI envelope; `--approve-local-synthetic` runs the checked superuser approval and writes `.local/operator/consent.json` (0600) |
| `ui:seed` | UI cut seed on top of `seed`: hostile `medium` record, a viewer-only index `kbn-apps-prototype-viewer-only` (K1), granted + ungranted synthetic dashboards, empty space `app-host-empty`, Mini Discover data (`kbn-apps-demo-logs-a`/`-b`: 240 docs each over 24 h with `@timestamp`, `log.level`, `service.name`, `message`, three attacker-style messages; `kbn-apps-other-secret`: 5 docs outside the grant; data views `kbn-apps-demo-logs`, with one runtime field `event.hour` and its field format, and `kbn-apps-other-secret`), viewer matrix (`.local/ui_users.json`, never printed): viewer with demo/secret index read and the data view feature, no-index, no-dashboard, no-data-views, global-only, superuser |
| `ui:operator` | Operator `disable` / `enable` / `status` / `reset` of the approval file (never reachable through the bridge). `disable` replaces the approval generation and `reset` deletes the record, so the next approval writes a new one (old handles are refused for good), then invalidate the app's session keys by name as `kibana_system` (`KIBANA_SYSTEM_AUTH`, local default `kibana_system:changeme`); a failed or partial invalidation is reported and exits 1 |
| `ui:security` | K1–K6 (app session key), D1–D5 (`--suites discover`, Mini Discover; screenshots `.local/discover-<engine>.png`), W1/W2 (`--suites w`, the bridge Worker: main-thread responsiveness under a bridge flood, queue overflow, the Worker's CSP, handle confinement incl. a Chromium heap snapshot, and the frame-CPU diagnostic) and the T-suites, Playwright/API harness in Chromium/Firefox/WebKit; JSON report in `.local/ui_security-*.json`. `--suites t4tls --tls DIR` runs the SameSite=None HTTPS cookie fixture against Kibana started with `kibana:config -- --tls DIR` (see below) |
| `acceptance` | Kibana-level M2/M3 assertions (authz, ES denial, package failures, host contract, abort, ...) |
| `ui-check` | Page check of `/app/appHost` v1 → v2 via Refresh (uses the Kibana workspace's Playwright) |
| `benchmark` | Fresh-invocation latency sample through Kibana (and optionally the raw seam) |
| `test` | `tsc` for Node and Workers code, then `node:test` unit tests |
| `lint` | Workers-aware check: both `tsc` projects, then Kibana's `node scripts/eslint` (oxlint + ESLint) on this directory |

## M1: transport and isolation seam (local workerd)

```bash
nvm use 24.22.1
P=x-pack/platform/plugins/shared/app_host
npm ci --prefix "$P/prototype"
npm --prefix "$P/prototype" run secret:local   # 32-byte caller secret in .local/ and cloudflare/.dev.vars; never printed
(cd "$P/prototype" && npx wrangler dev --config cloudflare/wrangler.jsonc --ip 127.0.0.1)
# optional diagnostic probe Worker (raw capnweb stub in Loader env), separate terminal:
npm --prefix "$P/prototype" run dev:probe
# another terminal:
npm --prefix "$P/prototype" run seam -- --url ws://127.0.0.1:8787/rpc --probe-url ws://127.0.0.1:8788/rpc --local-workerd
```

`seam` prints one JSON object and exits 0 only when every required assertion holds. Remote mode
(no flag) needs a non-loopback `wss://` URL and runs the CPU gate **first, isolated**: the loop
fixture must fail with `app_host:app_cpu_limit` (`loopCpuLimited`); the harness timeout or a generic
error is a failure, and the run stops before any other invocation. Then: `result:42`,
`callbackCount:1`, `unauthenticatedInvokeDenied`, `wrongTokenDenied`, `idleUnauthClosed`,
`fetchBlocked`/`connectBlocked` (workerd's `globalOutbound: null` policy message, not a DNS or
network failure), replay and digest checks, six misuse cases **each in a fresh invocation** with
its specific contract error and no Node handler call, fresh module state, concurrency, disconnect
and reconnect.

`--local-workerd` is accepted only for a loopback URL. OSS workerd (used by `wrangler dev`) does not
enforce Dynamic Worker `limits.cpuMs`: an infinite loop pins the local runtime until it is restarted.
With the flag, the three loop checks are reported as `NOT_ENFORCED_LOCALLY` and the loop fixture is
not run. **Remote acceptance must not use it.**

## Remote acceptance (requires explicit user approval first)

Do not run these without explicit approval for the named dispatcher `kbn-app-host-proto-dispatcher`,
its secret, and at most 200 synthetic invocations. Credentials alone are not approval.
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit, Account Settings: Read,
Workers Tail: Read) come from a private environment.

```bash
cd "$P/prototype"
npx wrangler secret put KIBANA_CALLER_TOKEN --config cloudflare/wrangler.jsonc < .local/caller_token
npx wrangler deploy --config cloudflare/wrangler.jsonc
export CF_RPC_URL="wss://kbn-app-host-proto-dispatcher.<subdomain>.workers.dev/rpc"
curl -s -o /dev/null -w '%{http_code}\n' "${CF_RPC_URL/wss:/https:}"   # 426, not an upload endpoint
npm run seam -- --url "$CF_RPC_URL"                                # CPU gate first; ~21 fresh Workers
npm run kibana:config -- --dispatcher "$CF_RPC_URL"                # then restart local Kibana once
npm run acceptance -- --kibana "$KB_URL" --rpc "$CF_RPC_URL"       # verify target, CPU gate, ~26 Workers
npm run benchmark -- --kibana "$KB_URL" --samples 20 --rpc "$CF_RPC_URL" --note 'remote workers.dev'  # 40
```

Each command refuses a non-`wss://` or loopback URL in remote mode. `acceptance` and `benchmark`
first check that Kibana reports the same dispatcher fingerprint as `--rpc` (host-owned
`x-app-host-timing` evidence, so a stale config without a restart is caught) and stop after one
invocation otherwise; `remote`/`local` in their output is derived from that evidence, and `--note`
never affects it. A latency GO needs a verified remote dispatcher and every requested Kibana and seam
sample to succeed with valid evidence. There is no remote dispatcher connection observer, so the
acceptance "no invocation" checks are `NOT_VERIFIED` remotely (verdict `PASS_WITH_NOT_VERIFIED`,
exit 3); their HTTP-denial halves are still asserted, and the local run keeps the observer with a
positive control.

The total stays under 200 fresh invocations (~87). Cleanup (also needs approval):
`npx wrangler delete --config cloudflare/wrangler.jsonc`.

## Known prototype limitations

- **An authenticated dispatcher socket has no idle or operation timeout.** Unauthenticated sockets
  are closed after 2 s, but once `authenticate` succeeds the dispatcher keeps the socket open until
  the client closes it. Kibana's caller closes its single-use socket in `finally` (and on request
  abort), and no capability or fresh Worker exists until `invoke`, but any client holding the
  caller token could keep an unused (or used) authenticated socket open. A dispatcher-side
  post-auth/operation timeout is later hardening, not production-ready behaviour.
- Closing a socket does not prove an isolate was terminated; only the managed runtime's CPU-limit
  error (`app_host:app_cpu_limit`) is accepted as CPU-enforcement evidence. The dispatcher maps the
  runtime's CPU-limit message by pattern (`errors.ts`); that mapping is unverified until the remote run.
- Node's built-in WebSocket buffers one complete frame before the transport's queue bound sees it.
- A remote app that never returns holds its invocation until the client aborts the request; there is
  no host deadline (Cloudflare's CPU limit bounds CPU, not waiting).

## Layout

- `cloudflare/src/` dispatcher (`dispatcher.ts`, `public_root.ts`, `invocation.ts`, `host_bridge.ts`) and the
  separate diagnostic probe (`probe*.ts`).
- `shared/` wire protocol validation and the bounded WebSocket transport, used by the dispatcher and Node tools.
- `app/src/` sample app: plain `Summary` class plus a native `WorkerEntrypoint` adapter (`App`).
- `ui/src/` sample app UI (one classic IIFE: `main.ts`, the Mini Discover tile `discover.ts` and the small
  guest SDK `sdk.ts`); `ui/fixtures/hostile.ts`
  is the deliberately hostile UI used by T1/T3–T6.
- `scripts/lib/ui_suites/` the `ui:security` suites (`k_session.ts`: K1–K6; `d_discover.ts`: D1–D5;
  `w_worker.ts`: W1/W2); `scripts/lib/approval.ts` the
  local approval tool; `scripts/lib/app_keys.ts` operator-side key invalidation by name.
  `ui/fixtures/channels.ts` holds the T4 channel probes, shared by the hostile frame and by an ordinary
  control page (`ui/fixtures/channel_control.ts`) so that every claimed block has a working control.

### SameSite=None HTTPS fixture (T4-TLS)

```bash
cd "$P/prototype"
mkdir -p .local/tls && openssl req -x509 -newkey rsa:2048 -nodes -days 3 -subj /CN=localhost \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -keyout .local/tls/key.pem -out .local/tls/cert.pem
npm run kibana:config -- --tls "$PWD/.local/tls"     # writes .local/kibana.app_host.tls.yml
# restart Kibana with -c .local/kibana.app_host.tls.yml (KBN_HMR=false), then:
NODE_EXTRA_CA_CERTS="$PWD/.local/tls/cert.pem" npm run ui:security -- --kibana https://localhost:5601 \
  --suites t4tls --tls "$PWD/.local/tls" --engines chromium,firefox,webkit
```

The certificate and key are local, self-signed and git-ignored; browsers trust them per context only.
- `fixtures/` adversarial seam apps (egress, loop, misuse, sentinel, echo, env probe).
- `scripts/` Node tools run with the pinned `tsx`; `test/` node:test unit tests.

## Lint and type check

`npm run lint` is the Workers-aware check for this directory. It runs the three `tsc` projects (Node
tools; `cloudflare/tsconfig.json` against `@cloudflare/workers-types`, covering `cloudflare/`, `app/`,
`fixtures/` and `shared/`; `ui/tsconfig.json` for the browser UI), then Kibana's own `node scripts/eslint`
on the prototype directory. The release tool imports the plugin's own `common/ui_contract.ts`, so the
scope-map digest it writes is the one Kibana pins. Two
narrowly scoped overrides in the repository lint config make the Kibana lint accept constructs the
Workers runtime requires, without inline `eslint-disable` comments:

- `.oxlint/imports.mts`: `@kbn/imports/no_unresolvable_imports` is off for
  `prototype/{cloudflare,app,fixtures}/**/*.ts`, which import the runtime's built-in
  `cloudflare:workers` / `cloudflare:sockets`. Kibana's Node import resolver cannot resolve those;
  the Workers `tsc` resolves them and fails on any other unresolvable import (TS2307).
- `.oxlint/import_plugin.mts`: `import/no-default-export` is off for exactly
  `cloudflare/src/dispatcher.ts` and `cloudflare/src/probe.ts`, the Worker main modules whose
  default export is the runtime's fetch handler.

The isolated `package-lock.json` is kept by the `!package-lock.json` entry in `.gitignore`; no lint
or pre-commit check rejects it.
