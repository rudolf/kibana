# App Host prototype tooling

Isolated tool package for the App Host prototype: the Cloudflare dispatcher Worker, the sample
`alert-digest` app, adversarial seam fixtures and the `seam`, `seed`, `release`, `acceptance`,
`benchmark` and `test` scripts. It has its own pinned dependencies and lockfile; it is not part of
the Kibana workspace and is not a public SDK.

See `../README.md` for the end-to-end demo. This file covers M1 only.

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

## Remote M1 (requires explicit user approval first)

Do not run these without approval for the named dispatcher `kbn-app-host-proto-dispatcher`, its
secret, and at most 200 synthetic invocations.

```bash
(cd "$P/prototype" && npx wrangler secret put KIBANA_CALLER_TOKEN --config cloudflare/wrangler.jsonc < .local/caller_token)
(cd "$P/prototype" && npx wrangler deploy --config cloudflare/wrangler.jsonc)
npm --prefix "$P/prototype" run seam -- --url "wss://kbn-app-host-proto-dispatcher.<subdomain>.workers.dev/rpc"
```

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
