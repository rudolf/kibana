/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// M1 seam: standalone Node -> capnweb WebSocket -> dispatcher -> fresh Dynamic Worker -> Node callback.
// Prints one machine-readable JSON object and exits non-zero if any required assertion fails.
// Usage: npm run seam -- --url ws://127.0.0.1:8787/rpc [--probe-url ws://127.0.0.1:8788/rpc] [--local-workerd]
//
// Remote mode (no flag) requires a non-loopback wss:// URL. It runs the CPU-loop fixture first as an
// isolated gate and stops if the managed runtime does not report `app_host:app_cpu_limit`.
// --local-workerd is only accepted for a loopback URL: OSS workerd (wrangler dev) does not enforce
// Dynamic Worker `limits.cpuMs` and an infinite loop pins the local runtime, so the loop checks are
// skipped and reported as NOT_ENFORCED_LOCALLY. It must never be used for remote acceptance.

import { randomUUID } from 'node:crypto';
import { parseArgs } from './lib/args';
import { buildFixture, type BuiltPackage } from './lib/build';
import { invokeOnce, openSession, SyntheticHost, type LooseStub } from './lib/client';
import { requestedTarget } from './lib/dispatcher_target';
import { readCallerToken } from './lib/secrets';

const NOT_ENFORCED_LOCALLY = 'NOT_ENFORCED_LOCALLY';
const args = parseArgs(
  process.argv.slice(2),
  ['url', 'probe-url', 'local-workerd'],
  ['local-workerd']
);
const localWorkerd = args['local-workerd'] === 'true';
let url: string;
try {
  ({ url } = requestedTarget(args.url ?? process.env.CF_RPC_URL, localWorkerd));
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: (error as Error).message }, null, 2)}\n`);
  process.exit(2);
}
const token = readCallerToken();
const wrongToken = `${'x'.repeat(40)}`;

const fortyOne = async () => ({ total: 41, records: [] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const request = (pkg: BuiltPackage) => ({
  manifest: pkg.manifest,
  bundle: pkg.bundle,
  invocationId: randomUUID(),
});
const denied = async (fn: () => Promise<unknown>): Promise<string | false> => {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const fixtures = Object.fromEntries(
  await Promise.all(
    ['adder', 'egress', 'loop', 'sentinel', 'echo', 'env_probe'].map(
      async (name) => [name, await buildFixture(name)] as const
    )
  )
) as Record<string, BuiltPackage>;

// One fresh invocation per misuse case, each with its specific expected contract error.
const MISUSE_EXPECTED: Record<string, RegExp> = {
  // Native Workers RPC rejects a method that is not on the HostBridge prototype.
  unknownMethod: /^The RPC receiver does not implement the method "deleteIndex"\.$/,
  wildcard: /^app_host:index_not_granted$/,
  alias: /^app_host:index_not_granted$/,
  arrayIndex: /^app_host:index_not_granted$/,
  extraField: /^app_host:invalid_search$/,
  badSize: /^app_host:invalid_search$/,
};
const misuseFixtures = Object.fromEntries(
  await Promise.all(
    Object.keys(MISUSE_EXPECTED).map(
      async (name) =>
        [name, await buildFixture('misuse', { __MISUSE_CASE__: JSON.stringify(name) })] as const
    )
  )
) as Record<string, BuiltPackage>;

const out: Record<string, unknown> = {
  target: url,
  mode: localWorkerd
    ? 'local workerd (loopback dispatcher), not remote acceptance'
    : 'remote (wss:// dispatcher)',
};
const details: Record<string, unknown> = {};
const report = (failures: string[], extra: Record<string, unknown> = {}) => {
  const notEnforcedLocally = Object.keys(out).filter((key) => out[key] === NOT_ENFORCED_LOCALLY);
  process.stdout.write(
    `${JSON.stringify({ ...out, ...extra, failures, notEnforcedLocally, details }, null, 2)}\n`
  );
};

// CPU gate, first and isolated: the managed runtime must terminate an infinite loop with its CPU
// limit (`app_host:app_cpu_limit`); the harness timeout never satisfies it. On failure the run stops
// before any other invocation.
if (localWorkerd) {
  out.loopCpuLimited = NOT_ENFORCED_LOCALLY;
  out.loopRecovered = NOT_ENFORCED_LOCALLY;
  details.loop =
    'Skipped (loopback dispatcher only): OSS workerd ignores Dynamic Worker limits.cpuMs and a loop ' +
    'pins the local runtime. Remote acceptance must run without --local-workerd.';
} else {
  const start = performance.now();
  const loop = await invokeOnce({ url, token, pkg: fixtures.loop, handler: fortyOne });
  const elapsed = Math.round(performance.now() - start);
  out.loopCpuLimited = !loop.ok && loop.error === 'app_host:app_cpu_limit';
  details.loop = { error: loop.error, elapsedMs: elapsed };
  const recovered = await invokeOnce({ url, token, pkg: fixtures.adder, handler: fortyOne });
  out.loopRecovered = recovered.ok && recovered.value === 42;
  if (!recovered.ok) details.loopRecoveryError = recovered.error;
  const gate = ['loopCpuLimited', 'loopRecovered'].filter((key) => out[key] !== true);
  if (gate.length > 0) {
    report(gate, { stopped: 'CPU gate failed; no further invocations were run' });
    process.exit(1);
  }
}

// 0. Plain HTTP to /rpc without upgrade must be 426.
{
  const httpUrl = url.replace(/^ws/, 'http');
  const response = await fetch(httpUrl);
  out.httpWithoutUpgrade426 = response.status === 426;
}

// 1. Happy path: 41 -> 42 with exactly one callback.
{
  const outcome = await invokeOnce({ url, token, pkg: fixtures.adder, handler: fortyOne });
  out.result = outcome.ok ? outcome.value : `error:${outcome.error}`;
  out.callbackCount = SyntheticHost.calls(outcome.host);
  details.happyPathTiming = outcome.timing;
}

// 2. Unauthenticated invoke: the root has no invoke method and no loader.
{
  const session = openSession(url);
  const root = session.root as unknown as LooseStub;
  const invokeError = await denied(() =>
    root.invoke(request(fixtures.adder), new SyntheticHost(fortyOne))
  );
  out.unauthenticatedInvokeDenied = invokeError !== false;
  details.unauthenticatedInvokeError = invokeError;
  session.close();
}

// 3. Wrong token is denied and the socket is closed; a second attempt is not allowed.
{
  const session = openSession(url);
  const wrong = await denied(() => session.root.authenticate(wrongToken));
  out.wrongTokenDenied = wrong !== false;
  const closed = await Promise.race([session.closed, sleep(3000).then(() => undefined)]);
  out.wrongTokenSocketClosed = closed !== undefined;
  session.close();
}

// 4. Missing token (non-string) is denied.
{
  const session = openSession(url);
  out.missingTokenDenied = (await denied(() => session.root.authenticate(undefined))) !== false;
  session.close();
}

// 5. Unauthenticated idle connection is closed by the dispatcher after ~2s.
{
  const session = openSession(url);
  const closed = await Promise.race([session.closed, sleep(4000).then(() => undefined)]);
  out.idleUnauthClosed = closed !== undefined && closed.afterMs >= 1800 && closed.afterMs < 3500;
  details.idleCloseAfterMs = closed?.afterMs ?? null;
  session.close();
}

// 6. Replay of the same invocation capability fails.
{
  const session = openSession(url);
  const invocation = await session.root.authenticate(token);
  const first = await invocation.invoke(request(fixtures.adder), new SyntheticHost(fortyOne));
  const replay = await denied(() =>
    invocation.invoke(request(fixtures.adder), new SyntheticHost(fortyOne))
  );
  out.replayDenied = first === 42 && replay !== false;
  details.replayError = replay;
  session.close();
}

// 7. Egress: fetch and TCP connect denied by sandbox policy while the granted callback still works.
const EGRESS_POLICY =
  /not permitted to access the internet|not permitted|globalOutbound|disallowed/i;
const NETWORK_FAILURE =
  /ENOTFOUND|getaddrinfo|DNS|ECONNREFUSED|timed? ?out|network connection lost/i;
{
  const outcome = await invokeOnce({ url, token, pkg: fixtures.egress, handler: fortyOne });
  const value = (outcome.value ?? {}) as Record<string, unknown>;
  // The denial must be the sandbox policy (globalOutbound: null), not a DNS/network failure.
  const policyDenial = (reason: unknown) =>
    typeof reason === 'string' && EGRESS_POLICY.test(reason) && !NETWORK_FAILURE.test(reason);
  out.fetchBlocked = policyDenial(value.fetchError);
  out.connectBlocked = policyDenial(value.connectError);
  out.egressCallback = value.callback === 42;
  details.egress = outcome.ok
    ? { fetchError: value.fetchError, connectError: value.connectError }
    : outcome.error;
}

// 8. A digest mismatch is rejected before any code runs.
{
  let called = false;
  const tampered: BuiltPackage = {
    manifest: fixtures.adder.manifest,
    bundle: `${fixtures.adder.bundle}\n// tampered`,
  };
  const mismatch = await invokeOnce({
    url,
    token,
    pkg: tampered,
    handler: async () => {
      called = true;
      return fortyOne();
    },
  });
  out.digestMismatchDenied = mismatch.error === 'app_host:digest_mismatch' && !called;
  details.digestMismatchError = mismatch.error;
}

// 9. Host-contract misuse: each case in a fresh invocation, with its specific contract error and no
// Node handler call.
{
  const cases: Record<string, unknown> = {};
  let allDenied = true;
  for (const [name, expected] of Object.entries(MISUSE_EXPECTED)) {
    let handlerCalled = false;
    const outcome = await invokeOnce({
      url,
      token,
      pkg: misuseFixtures[name],
      handler: async () => {
        handlerCalled = true;
        return fortyOne();
      },
    });
    const value = (outcome.value ?? {}) as Record<string, unknown>;
    const ok =
      outcome.ok &&
      value.case === name &&
      typeof value.error === 'string' &&
      expected.test(value.error) &&
      !handlerCalled &&
      SyntheticHost.calls(outcome.host) === 0;
    allDenied &&= ok;
    cases[name] = {
      ok,
      error: outcome.ok ? value.error : `invocation failed: ${outcome.error}`,
      nodeHandlerCalled: handlerCalled,
    };
  }
  out.misuseDenied =
    allDenied && Object.keys(cases).sort().join() === Object.keys(MISUSE_EXPECTED).sort().join();
  details.misuse = cases;
}

// 10. Fresh Worker per invocation: module/global state never survives.
{
  const results = [];
  for (let i = 0; i < 3; i++) {
    const outcome = await invokeOnce({ url, token, pkg: fixtures.sentinel, handler: fortyOne });
    results.push(outcome.value);
  }
  out.freshModuleState = results.every(
    (value) =>
      (value as Record<string, unknown>)?.moduleCount === 1 &&
      (value as Record<string, unknown>)?.globalSeen === false
  );
}

// 11. Two concurrent invocations cannot reach each other's host capability.
{
  const hostFor = (marker: number, rule: string) => async () => {
    await sleep(300);
    return { total: marker, records: [{ severity: 'high', rule }] };
  };
  const [a, b] = await Promise.all([
    invokeOnce({ url, token, pkg: fixtures.echo, handler: hostFor(7, 'rule-a') }),
    invokeOnce({ url, token, pkg: fixtures.echo, handler: hostFor(9, 'rule-b') }),
  ]);
  const va = a.value as Record<string, unknown> | undefined;
  const vb = b.value as Record<string, unknown> | undefined;
  out.concurrentIsolated =
    va?.total === 7 &&
    va?.rule === 'rule-a' &&
    vb?.total === 9 &&
    vb?.rule === 'rule-b' &&
    SyntheticHost.calls(a.host) === 1 &&
    SyntheticHost.calls(b.host) === 1;
}

// 12. Disconnect during a delayed callback revokes the host; a new connection then works.
{
  let session: ReturnType<typeof openSession> | undefined;
  let callbackStarted = false;
  const outcome = await invokeOnce({
    url,
    token,
    pkg: fixtures.adder,
    handler: async () => {
      callbackStarted = true;
      session?.close();
      await sleep(500);
      return { total: 41, records: [] };
    },
    onSession: (s) => {
      session = s;
    },
  });
  // After the socket closes, capnweb aborts the session: every stub on it is broken.
  const closedSession = session;
  const brokenAfterClose =
    closedSession !== undefined &&
    (await denied(() => closedSession.root.authenticate(token))) !== false;
  out.disconnectRevoked =
    callbackStarted && !outcome.ok && SyntheticHost.isRevoked(outcome.host) && brokenAfterClose;
  details.disconnectError = outcome.error;
  const reconnect = await invokeOnce({ url, token, pkg: fixtures.adder, handler: fortyOne });
  out.reconnectSucceeded = reconnect.ok && reconnect.value === 42;
  if (!reconnect.ok) details.reconnectError = reconnect.error;
}

// Optional diagnostic: raw capnweb stub in Loader env (separate probe Worker; not a gate).
if (args['probe-url']) {
  const probeUrl = args['probe-url'];
  const session = openSession(probeUrl);
  try {
    const probe = (await session.root.authenticate(token)) as unknown as LooseStub;
    const host = new SyntheticHost(fortyOne);
    details.rawStubEnvProbe = await probe.rawStubInEnv(request(fixtures.env_probe), host);
    details.ctxExportsEnvProbe = await probe.ctxExportsInEnv(request(fixtures.env_probe));
  } catch (error) {
    details.rawStubEnvProbe = { ok: false, error: String(error) };
  } finally {
    session.close();
  }
}

const required = [
  'loopCpuLimited',
  'loopRecovered',
  'httpWithoutUpgrade426',
  'unauthenticatedInvokeDenied',
  'wrongTokenDenied',
  'wrongTokenSocketClosed',
  'missingTokenDenied',
  'idleUnauthClosed',
  'replayDenied',
  'fetchBlocked',
  'connectBlocked',
  'egressCallback',
  'digestMismatchDenied',
  'misuseDenied',
  'freshModuleState',
  'concurrentIsolated',
  'disconnectRevoked',
  'reconnectSucceeded',
];
const skippedLocally = (key: string) => localWorkerd && out[key] === NOT_ENFORCED_LOCALLY;
const failures = required.filter((key) => out[key] !== true && !skippedLocally(key));
if (out.result !== 42) failures.unshift('result');
if (out.callbackCount !== 1) failures.unshift('callbackCount');
report(failures);
process.exit(failures.length === 0 ? 0 : 1);
