/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import { isRequestAbortedError, isResponseError } from '@kbn/es-errors';
import type { NativeOutcome } from './data_views';

/**
 * Runs an app-authored ES|QL query with the app session key's client. There is no command
 * allowlist: the key's role descriptor (granted index patterns, empty `cluster`) is what
 * Elasticsearch enforces, so `FROM` outside the grant, `ENRICH` and explicit inference commands are refused
 * natively. A `MATCH` on a granted index's `semantic_text` field still triggers that field's configured
 * inference endpoint (ES runs it on an internal origin); that is part of reading the granted index.
 * Row limits and timeouts are Elasticsearch's and the ES client's own; a request abort aborts the
 * query. Returns the response's `columns` and `values` as Elasticsearch
 * sent them.
 */
export const runEsql = async (
  client: ElasticsearchClient,
  query: string,
  signal: AbortSignal
): Promise<NativeOutcome> => {
  let response: { columns?: unknown; values?: unknown };
  try {
    response = (await client.esql.query(
      { query },
      {
        signal,
        maxRetries: 0,
      }
    )) as unknown as { columns?: unknown; values?: unknown };
  } catch (error) {
    if (isRequestAbortedError(error) || signal.aborted) {
      return { ok: false, code: 'app_unavailable', reason: 'aborted' };
    }
    if (isResponseError(error)) {
      if (error.statusCode === 401 || error.statusCode === 403) {
        return { ok: false, code: 'app_denied', reason: 'native_denied' };
      }
      // ES|QL reports an index the key may not read exactly like a missing one (400 "Unknown
      // index"), and rejects invalid queries with 400 too: a native refusal, never Kibana's.
      if (error.statusCode === 400) {
        return { ok: false, code: 'app_denied', reason: 'native_rejected' };
      }
    }
    return { ok: false, code: 'app_unavailable', reason: 'native_failed' };
  }
  const { columns, values } = response;
  if (!Array.isArray(columns) || !Array.isArray(values)) {
    return { ok: false, code: 'app_unavailable', reason: 'invalid_result' };
  }
  return { ok: true, result: { columns, values } };
};
