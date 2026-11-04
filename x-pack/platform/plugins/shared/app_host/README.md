# App Host (prototype)

Prototype plugin that runs one operator-installed backend app bundle in a fresh Cloudflare Dynamic
Worker. It gives the app a request-scoped, read-only Elasticsearch capability for the current user,
and renders the app's result on a static host page. It is **disabled by default**, is not production
code, and does not offer an SDK, install API, saved objects, tasks or app-authored browser code.

## What it does

- `GET /api/apps/{appId}/summary` (public, requires the `read_app_host` API privilege):
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
- `GET /internal/app_host/apps` (same privilege): `{apps: [{id, title, version}]}`.
- `/app/appHost`: a static, host-rendered page with title, version, refresh button and severity
  table. App-provided text is rendered as text.

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
```

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
```

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
