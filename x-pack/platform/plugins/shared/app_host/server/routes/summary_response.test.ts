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

describe('toSummaryResponse', () => {
  it('returns host-owned JSON with no-store and the timing header', () => {
    const factory = httpServerMock.createResponseFactory();
    const body = {
      appId: 'alert-digest',
      version: '1.0.0',
      label: 'Digest v1',
      counts: { high: 2, low: 1 },
    };
    toSummaryResponse(factory, { status: 'ok', body, timings });
    expect(factory.ok).toHaveBeenCalledWith({
      body,
      headers: { 'cache-control': 'no-store', [TIMING_HEADER]: appHostTiming(timings) },
    });
  });

  it.each<[SummaryOutcome, number]>([
    [{ status: 'busy' }, 429],
    [{ status: 'invalid_package', code: 'digest_mismatch' }, 500],
    [{ status: 'deadline' }, 504],
    [{ status: 'remote_error', code: 'app_failed' }, 502],
    [{ status: 'invalid_output' }, 502],
  ])('maps %p to %s', (outcome, statusCode) => {
    const factory = httpServerMock.createResponseFactory();
    toSummaryResponse(factory, outcome);
    expect(factory.customError).toHaveBeenCalledWith(expect.objectContaining({ statusCode }));
  });

  it('maps not found and Elasticsearch denial', () => {
    const factory = httpServerMock.createResponseFactory();
    toSummaryResponse(factory, { status: 'not_found' });
    toSummaryResponse(factory, { status: 'es_forbidden' });
    expect(factory.notFound).toHaveBeenCalled();
    expect(factory.forbidden).toHaveBeenCalled();
  });

  it('never includes payloads in the timing header', () => {
    expect(appHostTiming(timings)).toMatch(/^total;dur=10\.0, package;dur=1\.0/);
    expect(appHostTiming(timings)).toContain(
      'logical_bytes;desc="req=100,res=50,cb_req=10,cb_res=20"'
    );
  });
});
