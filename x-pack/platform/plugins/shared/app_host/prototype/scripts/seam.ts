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
// --local-workerd: OSS workerd (wrangler dev) does not enforce Dynamic Worker `limits.cpuMs`; an
// infinite loop pins the local runtime. With this flag the loop test is skipped and reported as
// NOT_ENFORCED_LOCALLY. It must never be used for remote acceptance.

import { randomUUID } from 'node:crypto';
import { parseArgs } from './lib/args';
import { buildFixture, type BuiltPackage } from './lib/build';
import { invokeOnce, openSession, SyntheticHost, type LooseStub } from './lib/client';
import { readCallerToken } from './lib/secrets';

const args = parseArgs(
  process.argv.slice(2),
  ['url', 'probe-url', 'local-workerd'],
  ['local-workerd']
);
const localWorkerd = args['local-workerd'] === 'true';
const url = args.url ?? process.env.CF_RPC_URL;
if (!url) throw new Error('--url is required (ws://127.0.0.1:8787/rpc or wss://.../rpc)');
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
    ['adder', 'egress', 'loop', 'sentinel', 'echo', 'misuse', 'budget', 'env_probe'].map(
      async (name) => [name, await buildFixture(name)] as const
    )
  )
) as Record<string, BuiltPackage>;

const out: Record<string, unknown> = {
  target: url,
  mode: localWorkerd ? 'local workerd, not remote acceptance' : 'full',
};
const details: Record<string, unknown> = {};

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

// 7. Egress: fetch and TCP connect denied while the granted callback still works.
{
  const outcome = await invokeOnce({ url, token, pkg: fixtures.egress, handler: fortyOne });
  const value = (outcome.value ?? {}) as Record<string, unknown>;
  out.fetchBlocked = value.fetchBlocked === true;
  out.connectBlocked = value.connectBlocked === true;
  out.egressCallback = value.callback === 42;
  if (!outcome.ok) details.egressError = outcome.error;
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
  out.digestMismatchDenied = !mismatch.ok && !called;
  details.digestMismatchError = mismatch.error;
  const big = `${fixtures.adder.bundle}\n//${'a'.repeat(70 * 1024)}`;
  const oversized = await invokeOnce({
    url,
    token,
    pkg: { manifest: { ...fixtures.adder.manifest }, bundle: big },
    handler: fortyOne,
  });
  out.oversizedBundleDenied = !oversized.ok;
  details.oversizedBundleError = oversized.error;
}

// 9. Host-contract misuse is denied by the bridge; callback budget is one.
{
  const misuse = await invokeOnce({ url, token, pkg: fixtures.misuse, handler: fortyOne });
  const value = (misuse.value ?? {}) as Record<string, unknown>;
  out.misuseDenied = misuse.ok && Object.values(value).every((v) => v === true);
  details.misuse = misuse.ok ? value : misuse.error;
  out.misuseHostCalls = SyntheticHost.calls(misuse.host);
  const budget = await invokeOnce({
    url,
    token,
    pkg: fixtures.budget,
    handler: fortyOne,
    maxCalls: 10,
  });
  const budgetValue = (budget.value ?? {}) as Record<string, unknown>;
  out.callbackBudgetEnforced =
    budget.ok &&
    budgetValue.first === 41 &&
    budgetValue.secondDenied === true &&
    SyntheticHost.calls(budget.host) === 1;
}

// 10. Oversized (257 KiB) and deep (depth 40) messages abort the session at the receiver.
{
  const session = openSession(url);
  const invocation = await session.root.authenticate(token);
  const huge = { ...request(fixtures.adder), bundle: 'a'.repeat(257 * 1024) };
  const oversized = await denied(() => invocation.invoke(huge, new SyntheticHost(fortyOne)));
  out.oversizedMessageRejected = oversized !== false;
  details.oversizedMessageError = oversized;
  session.close();

  const deepSession = openSession(url);
  const deepInvocation = await deepSession.root.authenticate(token);
  let deep: unknown = 'leaf';
  for (let i = 0; i < 40; i++) deep = [deep];
  const deepError = await denied(() =>
    deepInvocation.invoke({ ...request(fixtures.adder), extra: deep }, new SyntheticHost(fortyOne))
  );
  out.deepMessageRejected = deepError !== false;
  details.deepMessageError = deepError;
  deepSession.close();

  // Host -> dispatcher direction: a deep callback result is rejected too.
  const deepResult = await invokeOnce({
    url,
    token,
    pkg: fixtures.adder,
    handler: async () => deep as never,
  });
  out.deepCallbackResultRejected = !deepResult.ok;
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

// 14. Infinite loop is bounded (CPU limit or 5s host deadline), then a new call recovers.
// Runs after the optional probe because a local loop pins OSS workerd.
const runLoopTest = async () => {
  if (localWorkerd) {
    out.loopBounded = 'NOT_ENFORCED_LOCALLY';
    out.loopRecovered = 'NOT_ENFORCED_LOCALLY';
    details.loop =
      'Skipped: OSS workerd ignores Dynamic Worker limits.cpuMs; a loop pins the local runtime. ' +
      'Remote acceptance must run without --local-workerd.';
    return;
  }
  const start = performance.now();
  const loop = await invokeOnce({
    url,
    token,
    pkg: fixtures.loop,
    handler: fortyOne,
    deadlineMs: 5000,
  });
  const elapsed = Math.round(performance.now() - start);
  out.loopBounded = !loop.ok && elapsed <= 5500;
  out.loopCpuLimited = loop.error === 'app_host:app_cpu_limit';
  details.loop = { error: loop.error, elapsedMs: elapsed };
  const recovered = await invokeOnce({ url, token, pkg: fixtures.adder, handler: fortyOne });
  out.loopRecovered = recovered.ok && recovered.value === 42;
  if (!recovered.ok) details.loopRecoveryError = recovered.error;
};

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

await runLoopTest();

const required = [
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
  'deepMessageRejected',
  'deepCallbackResultRejected',
  'freshModuleState',
  'concurrentIsolated',
  'disconnectRevoked',
  'reconnectSucceeded',
  'loopBounded',
  'loopRecovered',
];
const notEnforcedLocally = (key: string) => localWorkerd && out[key] === 'NOT_ENFORCED_LOCALLY';
const failures = required.filter((key) => out[key] !== true && !notEnforcedLocally(key));
if (out.result !== 42) failures.unshift('result');
if (out.callbackCount !== 1) failures.unshift('callbackCount');
const report = { ...out, failures, details };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(failures.length === 0 ? 0 : 1);
