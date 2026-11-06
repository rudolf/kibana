/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpSelfScopedClient } from '@kbn/core/server';
import { loggerMock } from '@kbn/logging-mocks';
import { loggingSystemMock } from '@kbn/core/server/mocks';
import { AppRunner } from '../app_runner';
import { createFakeDispatcher, type HostStub } from '../mocks/fake_dispatcher';
import { createScopedClient, searchResponse } from '../mocks/es';
import { uiManifest, writeConsentFile, writeUiPackage } from '../test/ui_fixtures';
import type { AppKey } from './app_key';
import { BridgeAuditLogger } from './audit';
import { BridgeService, type CallerContext } from './bridge_service';
import { readUiReleaseState } from './consent';

const TOKEN = 't'.repeat(43);
const SEARCH = { index: 'kbn-apps-prototype-alerts', size: 10 };
const G1 = 'GenerationToken0000001';
const G2 = 'GenerationToken0000002';

/** A gate the test opens to let the held invocation make its next callback. */
const gate = () => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

const errorOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'allowed';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const until = async (condition: () => boolean) => {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
};

/**
 * Real BridgeService, AppRunner and SearchCapability over a held fake dispatcher invocation. The
 * app session key stays valid in Elasticsearch throughout (key cleanup "missed"), so only the
 * host's own lifecycle check can stop the later callbacks.
 */
describe('held backend invocation across a disable and a generation change (review P2)', () => {
  let dir: string;
  let consentPath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'app-host-held-'));
    consentPath = join(dir, 'consent.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses every HostEs callback after the session is revoked, before any Elasticsearch I/O', async () => {
    const manifest = uiManifest();
    await writeUiPackage(dir, manifest);
    await writeConsentFile(consentPath, manifest, { generation: G1 });

    const second = gate();
    const third = gate();
    const callbacks: string[] = [];
    const dispatcher = createFakeDispatcher({
      token: TOKEN,
      behaviour: async (_request, host: HostStub) => {
        callbacks.push(await errorOf(() => host.search(SEARCH)));
        await second.opened;
        callbacks.push(await errorOf(() => host.search(SEARCH)));
        await third.opened;
        callbacks.push(await errorOf(() => host.search(SEARCH)));
        return { label: 'held', counts: { high: 0, low: 0 } };
      },
    });
    const runner = new AppRunner(
      {
        packagePath: dir,
        dispatcherUrl: 'ws://127.0.0.1:8787/rpc',
        callerToken: TOKEN,
        createSocket: dispatcher.createSocket,
      },
      loggingSystemMock.createLogger()
    );
    let now = 1_000_000;
    const logger = loggerMock.create();
    const service = new BridgeService({
      packagePath: dir,
      consentPath,
      runner,
      audit: new BridgeAuditLogger(logger),
      handleEncryptionKey: 'h'.repeat(32),
      now: () => now,
      readState: () => readUiReleaseState(dir, consentPath),
    });
    // The key's client never refuses: Elasticsearch-side invalidation is assumed to have missed.
    const esClient = createScopedClient();
    esClient.search.mockResponse(searchResponse());
    let minted = 0;
    const caller = (): CallerContext => ({
      principal: '["native","native","viewer"]',
      userName: 'viewer',
      spaceId: 'default',
      isDefaultSpace: true,
      originOk: true,
      runAs: false,
      requestAborted: new AbortController().signal,
      grantKey: async () => ({ id: `key-${++minted}`, apiKey: 'still-valid-secret' }),
      invalidateKey: async () => undefined,
      asKey: (_key: AppKey) => ({ esClient, selfClient: {} as HttpSelfScopedClient }),
      selfPathname: (path) => path,
    });
    const mint = async () =>
      (
        (await service.createSession(caller(), 'alert-digest', manifest.releaseDigest as string))
          .body as { handle: string }
      ).handle;
    const auditReasons = () =>
      logger.info.mock.calls
        .map(([, meta]) => meta as Record<string, any>)
        .filter((record) => record.app?.via === 'app.summary')
        .map((record) => record.event?.reason);

    // 1. A consented invocation makes one allowed search, then stays open.
    const held = await mint();
    const pending = service.execute(caller(), held, { op: 'app.summary' });
    await until(() => callbacks.length === 1);
    expect(callbacks).toEqual(['allowed']);
    expect(esClient.search).toHaveBeenCalledTimes(1);

    // 2. Operator disable (new generation); key cleanup missed. Past the state-cache window, the
    //    held invocation's next callback is refused before Elasticsearch I/O.
    await writeConsentFile(consentPath, manifest, { enabled: false, generation: G2 });
    now += 2_001;
    second.open();
    await until(() => callbacks.length === 2);
    expect(callbacks[1]).toBe('app_host:app_disabled');
    expect(esClient.search).toHaveBeenCalledTimes(1);
    expect((await service.execute(caller(), held, { op: 'app.summary' })).body).toEqual({
      ok: false,
      code: 'app_disabled',
    });

    // 3. Re-enable with the replacement generation: the old invocation still cannot search.
    await writeConsentFile(consentPath, manifest, { enabled: true, generation: G2 });
    now += 2_001;
    third.open();
    await until(() => callbacks.length === 3);
    expect(callbacks[2]).toBe('app_host:app_stale');
    expect(esClient.search).toHaveBeenCalledTimes(1);
    expect((await pending).status).toBe(200);
    expect(auditReasons()).toEqual(['ok', 'disabled', 'stale_generation']);

    // 4. Control: a newly consented session's invocation can search.
    const fresh = await mint();
    expect((await service.execute(caller(), fresh, { op: 'app.summary' })).status).toBe(200);
    expect(callbacks.slice(3)).toEqual(['allowed', 'allowed', 'allowed']);
    expect(esClient.search).toHaveBeenCalledTimes(4);
  });
});
