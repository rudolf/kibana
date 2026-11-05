/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import { isRequestAbortedError, isResponseError } from '@kbn/es-errors';
import type { UiEsqlResult, UiEsqlValue } from '../../common/ui_protocol';
import { UI_LIMITS } from '../../common/ui_protocol';
import type { NativeFailure } from './data_views';

export type EsqlOutcome = { readonly ok: true; readonly result: UiEsqlResult } | NativeFailure;

const isScalar = (value: unknown): value is string | number | boolean | null =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

const toCell = (value: unknown): UiEsqlValue | undefined => {
  if (isScalar(value)) return value;
  if (Array.isArray(value) && value.every(isScalar)) return value;
  return undefined;
};

/**
 * Runs an app-authored ES|QL query with the app session key's client. There is no command
 * allowlist: the key's role descriptor (granted index patterns, empty `cluster`) is what
 * Elasticsearch enforces, so `FROM` outside the grant, `ENRICH` and inference are refused natively.
 * Bounds are structural only: the query size (parsed earlier), the operation deadline, the response
 * size read from Elasticsearch, and the projected result (≤ 500 rows; bytes are checked by the caller).
 */
export const runEsql = async (
  client: ElasticsearchClient,
  query: string,
  signal: AbortSignal
): Promise<EsqlOutcome> => {
  let response: { columns?: unknown; values?: unknown };
  try {
    response = (await client.esql.query(
      { query },
      {
        signal,
        maxRetries: 0,
        requestTimeout: UI_LIMITS.operationDeadlineMs,
        maxResponseSize: UI_LIMITS.dataViewBodyBytes,
      }
    )) as unknown as { columns?: unknown; values?: unknown };
  } catch (error) {
    if (isRequestAbortedError(error) || signal.aborted) {
      return { ok: false, code: 'app_timeout', reason: 'deadline' };
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
  if (values.length > UI_LIMITS.esqlRows || columns.length > UI_LIMITS.esqlColumns) {
    return { ok: false, code: 'app_unavailable', reason: 'invalid_result' };
  }
  const projectedColumns: Array<{ name: string; type: string }> = [];
  for (const column of columns as Array<{ name?: unknown; type?: unknown }>) {
    if (typeof column?.name !== 'string' || typeof column.type !== 'string') {
      return { ok: false, code: 'app_unavailable', reason: 'invalid_result' };
    }
    projectedColumns.push({ name: column.name, type: column.type });
  }
  const rows: UiEsqlValue[][] = [];
  for (const row of values as unknown[]) {
    if (!Array.isArray(row) || row.length !== projectedColumns.length) {
      return { ok: false, code: 'app_unavailable', reason: 'invalid_result' };
    }
    const cells: UiEsqlValue[] = [];
    for (const value of row) {
      const cell = toCell(value);
      if (cell === undefined)
        return { ok: false, code: 'app_unavailable', reason: 'invalid_result' };
      cells.push(cell);
    }
    rows.push(cells);
  }
  return { ok: true, result: { columns: projectedColumns, values: rows } };
};
