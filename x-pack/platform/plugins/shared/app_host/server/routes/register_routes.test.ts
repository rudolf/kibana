/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestHandler } from '@kbn/core/server';
import { coreMock, httpServerMock, httpServiceMock } from '@kbn/core/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import { SUMMARY_PATH } from '../../common';
import type { AppRunner } from '../app_runner';
import { BridgeAuditLogger } from '../ui/audit';
import { registerRoutes } from './register_routes';

describe('native summary route (F7)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'app-host-routes-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const setup = (requestBasePath: string) => {
    const router = httpServiceMock.createRouter();
    const auditLogger = loggerMock.create();
    const runner = {
      dispatcher: 'scheme=ws,class=loopback,fp=731a85aec9305232',
      runSummary: jest.fn(async () => ({
        status: 'ok',
        body: { appId: 'alert-digest', version: '1.0.0', label: 'L', counts: { high: 1, low: 0 } },
        timings: {
          totalMs: 10,
          packageMs: 1,
          connectMs: 2,
          authMs: 1,
          invokeMs: 5,
          esMs: 3,
          callbacks: 1,
          requestBytes: 100,
          responseBytes: 50,
          callbackRequestBytes: 10,
          callbackResponseBytes: 20,
        },
      })),
    } as unknown as AppRunner;
    registerRoutes({
      router,
      runner,
      packagePath: dir,
      // No approval file: legacy backend-only mode.
      consentPath: join(dir, 'consent.json'),
      logger: loggerMock.create(),
      basePath: { get: () => requestBasePath, serverBasePath: '' } as never,
      audit: new BridgeAuditLogger(auditLogger),
      userNameOf: async () => 'viewer',
    });
    const [, handler] = router.get.mock.calls.find(([config]) => config.path === SUMMARY_PATH) as [
      unknown,
      RequestHandler
    ];
    const call = async () => {
      const response = httpServerMock.createResponseFactory();
      await handler(
        coreMock.createCustomRequestHandlerContext({
          core: coreMock.createRequestHandlerContext(),
        }) as never,
        httpServerMock.createKibanaRequest({ params: { appId: 'alert-digest' } }),
        response
      );
      return response;
    };
    const records = () =>
      auditLogger.info.mock.calls.map(([, meta]) => meta as Record<string, any>);
    return { call, runner, records };
  };

  it('refuses a non-default space with 404 before any app invocation or record', async () => {
    const { call, runner, records } = setup('/s/app-host-empty');
    const response = await call();
    expect(response.notFound).toHaveBeenCalledTimes(1);
    expect(runner.runSummary).not.toHaveBeenCalled();
    expect(records()).toEqual([]);
  });

  it('writes exactly one app_host.bridge record (via native) per default-space call', async () => {
    const { call, runner, records } = setup('');
    await call();
    expect(runner.runSummary).toHaveBeenCalledTimes(1);
    const [record, ...rest] = records();
    expect(rest).toEqual([]);
    expect(record.event).toEqual(
      expect.objectContaining({
        action: 'app_host.bridge',
        outcome: 'success',
        reason: 'ok',
        provider: 'native',
      })
    );
    expect(record.user).toEqual({ name: 'viewer' });
    expect(record.kibana).toEqual(
      expect.objectContaining({ space_id: 'default', correlation_id: expect.any(String) })
    );
  });
});
