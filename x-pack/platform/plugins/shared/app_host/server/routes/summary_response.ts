/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { IKibanaResponse, KibanaResponseFactory } from '@kbn/core/server';
import type { SummaryOutcome, SummaryTimings } from '../app_runner';

export const TIMING_HEADER = 'x-app-host-timing';

const round = (value: number): string => value.toFixed(1);

/** Timing-header entry naming the dispatcher endpoint actually used (scheme, class, fingerprint). */
export const dispatcherEntry = (dispatcher: string): string => `dispatcher;desc="${dispatcher}"`;

/**
 * Host-owned timing header (the timing header syntax; Kibana owns `server-timing` itself): phase
 * durations, logical (JSON) byte counts and the dispatcher endpoint description. Never payloads.
 */
export const appHostTiming = (timings: SummaryTimings, dispatcher: string): string =>
  [
    dispatcherEntry(dispatcher),
    `total;dur=${round(timings.totalMs)}`,
    `package;dur=${round(timings.packageMs)}`,
    `connect;dur=${round(timings.connectMs)}`,
    `auth;dur=${round(timings.authMs)}`,
    `invoke;dur=${round(timings.invokeMs)}`,
    `es;dur=${round(timings.esMs)}`,
    `callbacks;desc="${timings.callbacks}"`,
    `logical_bytes;desc="req=${timings.requestBytes},res=${timings.responseBytes},cb_req=${timings.callbackRequestBytes},cb_res=${timings.callbackResponseBytes}"`,
  ].join(', ');

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * Maps a summary outcome to a host-owned JSON response; app output never sets headers or status.
 * Outcomes that reached the dispatcher carry the dispatcher entry, so tooling can verify the target.
 */
export const toSummaryResponse = (
  response: KibanaResponseFactory,
  outcome: SummaryOutcome,
  dispatcher: string
): IKibanaResponse => {
  const reached = { ...NO_STORE, [TIMING_HEADER]: dispatcherEntry(dispatcher) };
  switch (outcome.status) {
    case 'ok':
      return response.ok({
        body: outcome.body,
        headers: { ...NO_STORE, [TIMING_HEADER]: appHostTiming(outcome.timings, dispatcher) },
      });
    case 'not_found':
      return response.notFound({ body: { message: 'App not found' } });
    case 'busy':
      return response.customError({
        statusCode: 429,
        body: { message: 'Too many concurrent app invocations' },
        headers: { 'retry-after': '1' },
      });
    case 'invalid_package':
      return response.customError({
        statusCode: 500,
        body: { message: 'Installed app package is invalid', attributes: { code: outcome.code } },
      });
    case 'es_forbidden':
      return response.forbidden({
        body: { message: 'Current user is not authorized to read the app data' },
        headers: reached,
      });
    case 'deadline':
      return response.customError({
        statusCode: 504,
        body: { message: 'App invocation exceeded its deadline' },
        headers: reached,
      });
    case 'aborted':
      return response.customError({ statusCode: 499, body: { message: 'Request aborted' } });
    case 'remote_error':
      return response.customError({
        statusCode: 502,
        body: { message: 'App invocation failed', attributes: { code: outcome.code } },
        headers: reached,
      });
    case 'invalid_output':
      return response.customError({
        statusCode: 502,
        body: {
          message: 'App returned invalid output',
          attributes: { code: 'invalid_app_output' },
        },
        headers: reached,
      });
  }
};
