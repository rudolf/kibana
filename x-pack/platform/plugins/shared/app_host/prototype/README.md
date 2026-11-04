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
| `kibana:config` | Write the git-ignored Kibana config `.local/kibana.app_host.yml` (0600) |
| `seed` | Synthetic index (high/high/low, no aliases) and reader/no-index/no-feature roles and users |
| `release` | Build the sample app; write `<sha256>.js` first, then atomically replace `manifest.json` |
| `acceptance` | Kibana-level M2/M3 assertions (authz, ES denial, package failures, limits, deadline, ...) |
| `ui-check` | Page check of `/app/appHost` v1 → v2 via Refresh (uses the Kibana workspace's Playwright) |
| `benchmark` | Fresh-invocation latency sample through Kibana (and optionally the raw seam) |
| `test` | `tsc` for Node and Workers code, then `node:test` unit tests |

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

`seam` prints one JSON object and exits 0 only when every required assertion holds:
`result:42`, `callbackCount:1`, `unauthenticatedInvokeDenied`, `wrongTokenDenied`,
`idleUnauthClosed`, `fetchBlocked`, `connectBlocked`, `loopBounded`, `reconnectSucceeded`, plus
replay, digest, size/depth, misuse, budget, fresh-module, concurrency and disconnect checks.

`--local-workerd` exists because OSS workerd (used by `wrangler dev`) does not enforce Dynamic
Worker `limits.cpuMs`: an infinite loop pins the local runtime until it is restarted. With the
flag, the loop test is reported as `NOT_ENFORCED_LOCALLY`. **Remote acceptance must not use it.**

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
npm run seam -- --url "$CF_RPC_URL"                                # ~25 invocations, no --local-workerd
npm run kibana:config -- --dispatcher "$CF_RPC_URL"                # then restart local Kibana once
npm run acceptance -- --kibana "$KB_URL" --rpc "$CF_RPC_URL"       # ~30 invocations, includes CPU loop
npm run benchmark -- --kibana "$KB_URL" --samples 20 --rpc "$CF_RPC_URL" --label 'remote workers.dev'  # 40
```

The total stays under 200 fresh invocations. Cleanup (also needs approval):
`npx wrangler delete --config cloudflare/wrangler.jsonc`.

## Layout

- `cloudflare/src/` dispatcher (`dispatcher.ts`, `public_root.ts`, `invocation.ts`, `host_bridge.ts`) and the
  separate diagnostic probe (`probe*.ts`).
- `shared/` wire protocol validation and the bounded WebSocket transport, used by the dispatcher and Node tools.
- `app/src/` sample app: plain `Summary` class plus a native `WorkerEntrypoint` adapter (`App`).
- `fixtures/` adversarial seam apps (egress, loop, misuse, budget, sentinel, echo, env probe).
- `scripts/` Node tools run with the pinned `tsx`; `test/` node:test unit tests.

Kibana's ESLint reports `@kbn/imports/no_unresolvable_imports` for `cloudflare:*` imports and
`import/no-default-export` for the two Worker main modules. Both are required by the Workers runtime;
this package is type-checked with its own `tsc` against `@cloudflare/workers-types`.
