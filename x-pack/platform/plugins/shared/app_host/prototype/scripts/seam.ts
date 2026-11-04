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
import { invokeOnce, openSession, SyntheticHost, type LooseStub, type Session } from './lib/client';
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
/** Close code if the peer closed the socket within `ms`, otherwise null. */
const closedWithin = async (session: Session, ms: number): Promise<number | null> => {
  const closed = await Promise.race([session.closed, sleep(ms).then(() => undefined)]);
  return closed?.code ?? null;
};
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
    ['adder', 'egress', 'loop', 'sentinel', 'echo', 'budget', 'env_probe'].map(
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
  oversize: /^app_host:invalid_search$/,
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
// limit (`app_host:app_cpu_limit`). The 5 s client deadline is a separate wall-clock assertion and
// never satisfies the CPU gate. On failure the run stops before any other invocation.
if (localWorkerd) {
  out.loopCpuLimited = NOT_ENFORCED_LOCALLY;
  out.loopWallBounded = NOT_ENFORCED_LOCALLY;
  out.loopRecovered = NOT_ENFORCED_LOCALLY;
  details.loop =
    'Skipped (loopback dispatcher only): OSS workerd ignores Dynamic Worker limits.cpuMs and a loop ' +
    'pins the local runtime. Remote acceptance must run without --local-workerd.';
} else {
  const start = performance.now();
  const loop = await invokeOnce({
    url,
    token,
    pkg: fixtures.loop,
    handler: fortyOne,
    deadlineMs: 5000,
  });
  const elapsed = Math.round(performance.now() - start);
  out.loopCpuLimited = !loop.ok && loop.error === 'app_host:app_cpu_limit';
  out.loopWallBounded = !loop.ok && elapsed <= 5500;
  details.loop = { error: loop.error, elapsedMs: elapsed };
  const recovered = await invokeOnce({ url, token, pkg: fixtures.adder, handler: fortyOne });
  out.loopRecovered = recovered.ok && recovered.value === 42;
  if (!recovered.ok) details.loopRecoveryError = recovered.error;
  const gate = ['loopCpuLimited', 'loopWallBounded', 'loopRecovered'].filter(
    (key) => out[key] !== true
  );
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

// 8. Digest mismatch and oversized bundle are rejected before any code runs.
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
  const big = `${fixtures.adder.bundle}\n//${'a'.repeat(70 * 1024)}`;
  const oversized = await invokeOnce({
    url,
    token,
    pkg: { manifest: { ...fixtures.adder.manifest }, bundle: big },
    handler: fortyOne,
  });
  out.oversizedBundleDenied = oversized.error === 'app_host:invalid_bundle';
  details.oversizedBundleError = oversized.error;
}

// 9. Host-contract misuse: each case in a fresh invocation (so the one-call budget never masks a
// validator), with its specific contract error and no Node handler call. Budget is exactly one.
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

  let budgetCalls = 0;
  const budget = await invokeOnce({
    url,
    token,
    pkg: fixtures.budget,
    handler: async () => {
      budgetCalls += 1;
      return fortyOne();
    },
    maxCalls: 10,
  });
  const budgetValue = (budget.value ?? {}) as Record<string, unknown>;
  out.callbackBudgetEnforced =
    budget.ok &&
    budgetValue.first === 41 &&
    budgetValue.secondError === 'app_host:callback_budget' &&
    budgetCalls === 1;
  details.callbackBudget = budget.ok ? budgetValue : budget.error;
}

// 10. Receiver-side transport limits. A frame over 256 KiB (UTF-8 bytes) makes the dispatcher's
// transport close the socket with 1009 before parsing; an over-deep message makes capnweb abort
// the session (`app_host:rpc_limit`, socket closed 1011). Controls show the same channel reports
// the ordinary validator code, and keeps the socket open, when only the payload is invalid.
{
  const frameCase = async (bundle: string) => {
    const session = openSession(url);
    const invocation = await session.root.authenticate(token);
    const error = await denied(() =>
      invocation.invoke({ ...request(fixtures.adder), bundle }, new SyntheticHost(fortyOne))
    );
    const closeCode = await closedWithin(session, 2000);
    session.close();
    return { error, closeCode };
  };
  // 257 KiB of ASCII: over the frame cap.
  const ascii = await frameCase('a'.repeat(257 * 1024));
  out.oversizedMessageRejected =
    ascii.closeCode === 1009 && ascii.error !== 'app_host:invalid_bundle';
  details.oversizedMessage = ascii;
  // 90,000 x U+6F22: 90,000 UTF-16 code units (under capnweb's code-unit limit) but 270,000 UTF-8
  // bytes. Only byte counting rejects it at the frame; code-unit counting would let the validator
  // answer `invalid_bundle` instead.
  const multibyte = await frameCase('\u6f22'.repeat(90_000));
  out.oversizedMultibyteMessageRejected =
    multibyte.closeCode === 1009 && multibyte.error !== 'app_host:invalid_bundle';
  details.oversizedMultibyteMessage = multibyte;
  // Control: a 70 KiB bundle fits the frame; the bundle validator rejects it, socket stays open.
  const control = await frameCase(`${fixtures.adder.bundle}\n//${'a'.repeat(70 * 1024)}`);
  out.frameLimitControl = control.error === 'app_host:invalid_bundle' && control.closeCode === null;
  details.frameLimitControl = control;

  const depthCase = async (extra: unknown) => {
    const session = openSession(url);
    const invocation = await session.root.authenticate(token);
    const error = await denied(() =>
      invocation.invoke({ ...request(fixtures.adder), extra }, new SyntheticHost(fortyOne))
    );
    const closeCode = await closedWithin(session, 2000);
    session.close();
    return { error, closeCode };
  };
  let deep: unknown = 'leaf';
  for (let i = 0; i < 40; i++) deep = [deep];
  const deepResult = await depthCase(deep);
  out.deepMessageRejected =
    deepResult.error === 'app_host:rpc_limit' && deepResult.closeCode === 1011;
  details.deepMessage = deepResult;
  // Control: the same unknown field at depth 2 reaches the request validator; socket stays open.
  const shallow = await depthCase([['leaf']]);
  out.depthLimitControl =
    shallow.error === 'app_host:invalid_request' && shallow.closeCode === null;
  details.depthLimitControl = shallow;

  // Host -> dispatcher direction: the dispatcher's capnweb rejects a deep callback result and
  // aborts the session; the Node handler did run (positive control for the callback path).
  let deepHandlerCalled = false;
  const deepCallback = await invokeOnce({
    url,
    token,
    pkg: fixtures.adder,
    handler: async () => {
      deepHandlerCalled = true;
      return deep as never;
    },
  });
  out.deepCallbackResultRejected =
    deepHandlerCalled && !deepCallback.ok && deepCallback.error === 'app_host:rpc_limit';
  details.deepCallbackResult = { error: deepCallback.error, handlerCalled: deepHandlerCalled };
}

// 11. Fresh Worker per invocation: module/global state never survives.
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

// 12. Two concurrent invocations cannot reach each other's host capability.
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

// 13. Disconnect during a delayed callback revokes the host; a new connection then works.
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
  'loopWallBounded',
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
  'oversizedBundleDenied',
  'misuseDenied',
  'callbackBudgetEnforced',
  'oversizedMessageRejected',
  'oversizedMultibyteMessageRejected',
  'frameLimitControl',
  'deepMessageRejected',
  'depthLimitControl',
  'deepCallbackResultRejected',
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
