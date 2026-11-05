/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loggingSystemMock } from '@kbn/core/server/mocks';
import { AppRunner } from './app_runner';
import { createFakeDispatcher, type InvokeBehaviour } from './mocks/fake_dispatcher';
import { createScopedClient, responseError, searchResponse } from './mocks/es';

const TOKEN = 't'.repeat(43);
const SEARCH = { index: 'kbn-apps-prototype-alerts', size: 100 };
const bundle = 'export class App {}\n';
const digest = createHash('sha256').update(bundle).digest('hex');

const summarise: InvokeBehaviour = async (_req, host) => {
  const { records } = (await host.search(SEARCH)) as { records: Array<{ severity: string }> };
  const high = records.filter((r) => r.severity === 'high').length;
  return { label: 'Digest v1', counts: { high, low: records.length - high } };
};

describe('AppRunner', () => {
  let dir: string;

  const writePackage = async (manifestOverrides: Record<string, unknown> = {}) => {
    await writeFile(join(dir, `${digest}.js`), bundle);
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'alert-digest',
        title: 'Alert digest',
        version: '1.0.0',
        hostApi: 1,
        digest,
        permissions: { indices: ['kbn-apps-prototype-alerts'] },
        routes: [{ method: 'GET', path: '/summary', handler: 'summary' }],
        ...manifestOverrides,
      })
    );
  };

  const setup = (behaviour: InvokeBehaviour) => {
    const dispatcher = createFakeDispatcher({ token: TOKEN, behaviour });
    const createSocket = jest.fn(dispatcher.createSocket);
    const runner = new AppRunner(
      {
        packagePath: dir,
        dispatcherUrl: 'ws://127.0.0.1:8787/rpc',
        callerToken: TOKEN,
        createSocket,
      },
      loggingSystemMock.createLogger()
    );
    const client = createScopedClient();
    client.search.mockResponse(searchResponse());
    const run = (appId = 'alert-digest') =>
      runner.runSummary(appId, client, new AbortController().signal);
    return { dispatcher, createSocket, client, run };
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'app-host-runner-'));
    await writePackage();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns host-owned output computed by the remote app', async () => {
    const { run } = setup(summarise);
    const outcome = await run();
    expect(outcome).toEqual({
      status: 'ok',
      body: {
        appId: 'alert-digest',
        version: '1.0.0',
        label: 'Digest v1',
        counts: { high: 2, low: 1 },
      },
      timings: expect.objectContaining({ callbacks: 1 }),
    });
  });

  it('picks up a replaced package without restarting', async () => {
    const { run } = setup(summarise);
    await run();
    await writePackage({ version: '1.0.1' });
    const outcome = await run();
    expect(outcome.status === 'ok' && outcome.body.version).toBe('1.0.1');
  });

  it('returns 404 for unknown apps without connecting', async () => {
    const { run, createSocket } = setup(summarise);
    expect(await run('other-app')).toEqual({ status: 'not_found' });
    expect(createSocket).not.toHaveBeenCalled();
  });

  it.each([
    ['digest mismatch', async () => writeFile(join(dir, `${digest}.js`), `${bundle}//x`)],
    ['unsupported host API', async () => writePackage({ hostApi: 2 })],
  ])('fails closed before remote execution on %s', async (_name, mutate) => {
    await mutate();
    const { run, createSocket } = setup(summarise);
    const outcome = await run();
    expect(outcome.status).toBe('invalid_package');
    expect(createSocket).not.toHaveBeenCalled();
  });

  it('normalizes a current-user Elasticsearch denial to es_forbidden even if the app hides it', async () => {
    const { run, client } = setup(async (_req, host) => {
      await host.search(SEARCH).catch(() => undefined);
      return { label: 'looks fine', counts: { high: 0, low: 0 } };
    });
    client.search.mockRejectedValue(responseError(403));
    expect(await run()).toEqual({ status: 'es_forbidden' });
  });

  it('rejects invalid app output', async () => {
    const { run } = setup(async () => ({
      label: '<b>x</b>',
      counts: { high: 1, low: 1 },
      html: 1,
    }));
    expect(await run()).toEqual({ status: 'invalid_output' });
  });

  it('maps remote failures to sanitized codes', async () => {
    const { run } = setup(async () => {
      throw new Error('app_host:app_cpu_limit');
    });
    expect(await run()).toEqual({ status: 'remote_error', code: 'app_cpu_limit' });
  });
});
