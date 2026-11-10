/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  createFakeDispatcher,
  type FakeSocket,
  type HostStub,
  type InvokeBehaviour,
} from '../mocks/fake_dispatcher';
import { createScopedClient, responseError, searchResponse } from '../mocks/es';
import type { AppPackage } from '../package/read_package';
import { HostError, sanitizeOutboundError } from './host_error';
import { InvokeError, invokeApp } from './invoke_app';
import { SearchCapability } from './search_capability';

const TOKEN = 't'.repeat(43);
const SEARCH = { index: 'kbn-apps-prototype-alerts', size: 100 };

const pkg = (id = 'alert-digest'): AppPackage => ({
  manifest: {
    id: id as 'alert-digest',
    title: 'Alert digest',
    version: '1.0.0',
    hostApi: 1,
    digest: 'a'.repeat(64),
    permissions: { indices: ['kbn-apps-prototype-alerts'] },
    routes: [{ method: 'GET', path: '/summary', handler: 'summary' }],
  },
  bundle: 'export class App {}',
});

const summarise = async (host: HostStub) => {
  const result = (await host.search(SEARCH)) as { records: Array<{ severity: string }> };
  const high = result.records.filter((r) => r.severity === 'high').length;
  return { label: 'Digest v1', counts: { high, low: result.records.length - high } };
};

const setup = (behaviour: InvokeBehaviour, token = TOKEN) => {
  const dispatcher = createFakeDispatcher({ token: TOKEN, behaviour });
  const client = createScopedClient();
  client.search.mockResponse(searchResponse());
  const capability = new SearchCapability(client);
  const run = (signal: AbortSignal = new AbortController().signal) =>
    invokeApp({
      dispatcherUrl: 'ws://127.0.0.1:8787/rpc',
      callerToken: token,
      pkg: pkg(),
      capability,
      signal,
      createSocket: dispatcher.createSocket,
    });
  return { dispatcher, client, capability, run };
};

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e) => e
  );
  expect(error).toBeInstanceOf(InvokeError);
  return error as InvokeError;
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Finds every capnweb `["error", name, message, stack?, props?]` tuple in a decoded frame. */
const errorTuples = (node: unknown): unknown[][] => {
  if (!Array.isArray(node)) return [];
  if (node[0] === 'error' && typeof node[1] === 'string') return [node];
  return node.flatMap(errorTuples);
};

describe('invokeApp', () => {
  it('authenticates, invokes once with a fresh host and closes everything', async () => {
    let request: unknown;
    const { dispatcher, client, capability, run } = setup(async (req, host) => {
      request = req;
      return summarise(host);
    });
    const { value, timings } = await run();
    expect(value).toEqual({ label: 'Digest v1', counts: { high: 2, low: 1 } });
    expect(request).toEqual({
      manifest: pkg().manifest,
      bundle: 'export class App {}',
      invocationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(client.search).toHaveBeenCalledTimes(1);
    expect(capability.active).toBe(false);
    const [connection] = dispatcher.connections;
    expect(connection.authenticated).toBe(true);
    expect(connection.invocations).toBe(1);
    expect(connection.client.closeCode).toBe(1000);
    expect(timings.requestBytes).toBeGreaterThan(0);
  });

  it('does not send the token, request or credentials anywhere but authenticate', async () => {
    let request: unknown;
    const { run } = setup(async (req, host) => {
      request = req;
      return summarise(host);
    });
    await run();
    expect(JSON.stringify(request)).not.toContain(TOKEN);
    expect(Object.keys(request as object).sort()).toEqual(['bundle', 'invocationId', 'manifest']);
  });

  it('projects a UI release manifest onto the unchanged Worker wire schema', async () => {
    let request: { manifest?: Record<string, unknown> } | undefined;
    const dispatcher = createFakeDispatcher({
      token: TOKEN,
      behaviour: async (req, host) => {
        request = req as typeof request;
        return summarise(host);
      },
    });
    const client = createScopedClient();
    client.search.mockResponse(searchResponse());
    const base = pkg();
    await invokeApp({
      dispatcherUrl: 'ws://127.0.0.1:8787/rpc',
      callerToken: TOKEN,
      pkg: {
        ...base,
        manifest: {
          ...base.manifest,
          version: '2.0.0',
          permissions: {
            indices: ['kbn-apps-prototype-alerts'],
            dashboardIds: ['78a07dab-f7e4-4bdf-b155-da929711312c'],
          },
          ui: {
            entry: `${'b'.repeat(64)}.js`,
            digest: 'b'.repeat(64),
            bridgeApi: 1,
            scopeMapDigest: 'c'.repeat(64),
            scopes: ['app.summary'],
            egress: { client: [], server: [] },
          },
          releaseDigest: 'd'.repeat(64),
        },
      },
      capability: new SearchCapability(client),
      signal: new AbortController().signal,
      createSocket: dispatcher.createSocket,
    });
    expect(Object.keys(request?.manifest ?? {}).sort()).toEqual(
      ['digest', 'hostApi', 'id', 'permissions', 'routes', 'title', 'version'].sort()
    );
    expect(request?.manifest?.permissions).toEqual({ indices: ['kbn-apps-prototype-alerts'] });
  });

  it('exposes nothing on the Node side before authentication', async () => {
    const { dispatcher, run } = setup((_req, host) => summarise(host), 'w'.repeat(43));
    const pending = run();
    await tick();
    const [connection] = dispatcher.connections;
    const nodeMain = connection.session.getRemoteMain() as unknown as HostStub;
    await expect(nodeMain.search(SEARCH)).rejects.toThrow();
    const error = await failure(pending);
    expect(error.code).toBe('dispatcher_unauthorized');
    expect(connection.invocations).toBe(0);
  });

  it('rejects methods that are not on the facade', async () => {
    let denied = false;
    const { client, run } = setup(async (_req, host) => {
      denied = await host.deleteIndex(SEARCH).then(
        () => false,
        () => true
      );
      return summarise(host);
    });
    await run();
    expect(denied).toBe(true);
    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it('revokes the host after completion even if the app kept a reference', async () => {
    let kept: HostStub | undefined;
    const { client, run } = setup(async (_req, host) => {
      kept = (host as unknown as { dup(): HostStub }).dup();
      return summarise(host);
    });
    await run();
    await expect(kept?.search(SEARCH)).rejects.toThrow();
    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it('revokes immediately when the HTTP request is aborted mid-callback', async () => {
    const controller = new AbortController();
    const { client, capability, run } = setup(async (_req, host) => host.search(SEARCH));
    let esSignal: AbortSignal | undefined;
    client.search.mockImplementation((_r, opts) => {
      esSignal = opts?.signal;
      controller.abort();
      return new Promise((_, reject) =>
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      );
    });
    const error = await failure(run(controller.signal));
    expect(error.code).toBe('aborted');
    expect(capability.active).toBe(false);
    expect(esSignal?.aborted).toBe(true);
  });

  it('fails and revokes when the dispatcher disconnects during a callback', async () => {
    const { dispatcher, capability, run } = setup(async (_req, host) => {
      dispatcher.connections[0].server.close(1011);
      return host.search(SEARCH);
    });
    const error = await failure(run());
    expect(['disconnected', 'remote_error']).toContain(error.code);
    expect(capability.active).toBe(false);
  });

  it('encodes host errors on the wire as a sanitized code with no stack or host path', async () => {
    let seen: unknown;
    const dispatcher = createFakeDispatcher({
      token: TOKEN,
      behaviour: async (_req, host) => {
        seen = await host.search(SEARCH).catch((e) => e);
        return { label: 'x', counts: { high: 0, low: 0 } };
      },
    });
    const frames: string[] = [];
    const createSocket = () => {
      const socket = dispatcher.createSocket() as FakeSocket;
      const send = socket.send.bind(socket);
      socket.send = (data: string) => {
        frames.push(data);
        send(data);
      };
      return socket;
    };
    const client = createScopedClient();
    client.search.mockRejectedValue(responseError(500));
    await invokeApp({
      dispatcherUrl: 'ws://127.0.0.1:8787/rpc',
      callerToken: TOKEN,
      pkg: pkg(),
      capability: new SearchCapability(client),
      signal: new AbortController().signal,
      createSocket,
    });
    expect((seen as Error).message).toBe('app_host:es_failed');
    const encoded = frames.filter((frame) => frame.includes('"error"'));
    expect(encoded).toHaveLength(1);
    // Exactly ["error", name, message]: no stack element, no extra properties.
    expect(errorTuples(JSON.parse(encoded[0]))).toEqual([['error', 'Error', 'app_host:es_failed']]);
    for (const frame of frames) {
      expect(frame).not.toMatch(/\.ts\b|\.js\b|node_modules|\bat \S+ \(|\\n\s*at /);
      expect(frame).not.toContain(__dirname);
    }
  });

  it('replaces every outbound error with a stackless code', () => {
    const generic = sanitizeOutboundError(new TypeError(`boom at ${__filename}`));
    expect(generic.message).toBe('app_host:host_error');
    expect(generic.stack).toBeUndefined();
    const host = sanitizeOutboundError(new HostError('index_not_granted'));
    expect(host.message).toBe('app_host:index_not_granted');
    expect(host.stack).toBeUndefined();
  });

  it('keeps two concurrent invocations (different app identities) apart', async () => {
    const dispatcher = createFakeDispatcher({
      token: TOKEN,
      behaviour: async (_req, host) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return host.search(SEARCH);
      },
    });
    const make = (rule: string) => {
      const client = createScopedClient();
      client.search.mockResponse(searchResponse([{ severity: 'high', rule }]));
      return { client, capability: new SearchCapability(client) };
    };
    const a = make('rule-a');
    const b = make('rule-b');
    const run = (appId: string, capability: SearchCapability) =>
      invokeApp({
        dispatcherUrl: 'ws://127.0.0.1:8787/rpc',
        callerToken: TOKEN,
        pkg: pkg(appId),
        capability,
        signal: new AbortController().signal,
        createSocket: dispatcher.createSocket,
      });
    const [resultA, resultB] = await Promise.all([
      run('alert-digest', a.capability),
      run('second-app', b.capability),
    ]);
    expect(resultA.value).toEqual({ total: 1, records: [{ severity: 'high', rule: 'rule-a' }] });
    expect(resultB.value).toEqual({ total: 1, records: [{ severity: 'high', rule: 'rule-b' }] });
    expect(a.client.search).toHaveBeenCalledTimes(1);
    expect(b.client.search).toHaveBeenCalledTimes(1);
    expect(dispatcher.connections).toHaveLength(2);
  });
});
