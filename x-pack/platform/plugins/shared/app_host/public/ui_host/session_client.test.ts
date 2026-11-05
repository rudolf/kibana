/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { httpServiceMock } from '@kbn/core/public/mocks';
import type { UiAppMetadata } from '../../common/ui_protocol';
import { createSessionFactory } from './session_client';

const metadata = {
  appId: 'alert-digest',
  releaseDigest: 'a'.repeat(64),
} as UiAppMetadata;
const SUMMARY = { op: 'app.summary' } as const;
const expired = Object.assign(new Error('Forbidden'), {
  body: { message: 'app_expired', attributes: { code: 'app_expired' } },
});

const setup = () => {
  const http = httpServiceMock.createStartContract();
  let minted = 0;
  const executed: Array<Record<string, unknown>> = [];
  const expiredHandles = new Set<string>();
  http.post.mockImplementation((async (path: string, options: { body: string }) => {
    if (path === '/internal/app_host/ui/session') return { handle: `handle-${++minted}` };
    const body = JSON.parse(options.body);
    executed.push(body);
    if (expiredHandles.has(body.handle)) throw expired;
    return { ok: true, result: { total: 0, records: [] } };
  }) as unknown as typeof http.post);
  return { http, executed, expiredHandles, minted: () => minted };
};

describe('createSessionFactory', () => {
  it('mints once and sends {handle, op, params} in the JSON body for every call', async () => {
    const { http, executed, minted } = setup();
    const session = await createSessionFactory(http)(metadata);
    const signal = new AbortController().signal;
    await session?.executor(SUMMARY, signal);
    await session?.executor({ op: 'es.search', params: { index: 'i', size: 1 } }, signal);
    expect(minted()).toBe(1);
    expect(executed).toEqual([
      { handle: 'handle-1', op: 'app.summary' },
      { handle: 'handle-1', op: 'es.search', params: { index: 'i', size: 1 } },
    ]);
    const [[sessionPath, sessionOptions]] = http.post.mock.calls as unknown as Array<
      [string, { body: string }]
    >;
    expect(sessionPath).toBe('/internal/app_host/ui/session');
    expect(JSON.parse(sessionOptions.body)).toEqual({
      appId: 'alert-digest',
      releaseDigest: 'a'.repeat(64),
    });
  });

  it('K3: an expired handle is re-minted once on this consented page, then the call is retried', async () => {
    const { http, executed, expiredHandles, minted } = setup();
    const session = await createSessionFactory(http)(metadata);
    expiredHandles.add('handle-1');
    const outcome = await session?.executor(SUMMARY, new AbortController().signal);
    expect(outcome?.ok).toBe(true);
    expect(minted()).toBe(2);
    expect(executed.map(({ handle }) => handle)).toEqual(['handle-1', 'handle-2']);
  });

  it('never re-mints after the frame was torn down (aborted signal)', async () => {
    const { http, expiredHandles, minted } = setup();
    const session = await createSessionFactory(http)(metadata);
    expiredHandles.add('handle-1');
    const controller = new AbortController();
    controller.abort();
    expect(await session?.executor(SUMMARY, controller.signal)).toEqual({
      ok: false,
      code: 'app_expired',
    });
    expect(minted()).toBe(1);
  });
});
