/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { httpServerMock } from '@kbn/core/server/mocks';
import type { SummaryOutcome } from '../app_runner';
import { TIMING_HEADER, appHostTiming, toSummaryResponse } from './summary_response';

const timings = {
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
};
const DISPATCHER = 'scheme=ws,class=loopback,fp=731a85aec9305232';
const DISPATCHER_ONLY = `dispatcher;desc="${DISPATCHER}"`;

describe('toSummaryResponse', () => {
  it('returns host-owned JSON with no-store and the timing header', () => {
    const factory = httpServerMock.createResponseFactory();
    const body = {
      appId: 'alert-digest',
      version: '1.0.0',
      label: 'Digest v1',
      counts: { high: 2, low: 1 },
    };
    toSummaryResponse(factory, { status: 'ok', body, timings }, DISPATCHER);
    expect(factory.ok).toHaveBeenCalledWith({
      body,
      headers: { 'cache-control': 'no-store', [TIMING_HEADER]: appHostTiming(timings, DISPATCHER) },
    });
  });

  it.each<[SummaryOutcome, number, boolean]>([
    [{ status: 'invalid_package', code: 'digest_mismatch' }, 500, false],
    [{ status: 'remote_error', code: 'app_cpu_limit' }, 502, true],
    [{ status: 'invalid_output' }, 502, true],
  ])('maps %p to %s (dispatcher entry: %s)', (outcome, statusCode, reached) => {
    const factory = httpServerMock.createResponseFactory();
    toSummaryResponse(factory, outcome, DISPATCHER);
    expect(factory.customError).toHaveBeenCalledWith(expect.objectContaining({ statusCode }));
    const [[{ headers }]] = factory.customError.mock.calls;
    expect((headers as Record<string, string> | undefined)?.[TIMING_HEADER]).toBe(
      reached ? DISPATCHER_ONLY : undefined
    );
  });

  it('maps not found and Elasticsearch denial', () => {
    const factory = httpServerMock.createResponseFactory();
    toSummaryResponse(factory, { status: 'not_found' }, DISPATCHER);
    toSummaryResponse(factory, { status: 'es_forbidden' }, DISPATCHER);
    expect(factory.notFound).toHaveBeenCalled();
    expect(factory.forbidden).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ [TIMING_HEADER]: DISPATCHER_ONLY }),
      })
    );
  });

  it('leads with the dispatcher entry and never includes payloads', () => {
    expect(appHostTiming(timings, DISPATCHER)).toMatch(
      /^dispatcher;desc="scheme=ws,class=loopback,fp=731a85aec9305232", total;dur=10\.0, package;dur=1\.0/
    );
    expect(appHostTiming(timings, DISPATCHER)).toContain(
      'logical_bytes;desc="req=100,res=50,cb_req=10,cb_res=20"'
    );
  });
});
