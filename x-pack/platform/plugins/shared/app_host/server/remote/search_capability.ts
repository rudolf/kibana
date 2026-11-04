/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import { isRequestAbortedError, isResponseError } from '@kbn/es-errors';
import { LIMITS, SYNTHETIC_INDEX } from '../../common';
import { HostError } from './host_error';

export interface HostEsRecord {
  readonly severity: string;
  readonly rule: string;
}

export interface HostEsSearchResult {
  readonly total: number;
  readonly records: readonly HostEsRecord[];
}

export interface SearchCapabilityStats {
  readonly calls: number;
  readonly esDenied: boolean;
  readonly esMs: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
}

interface AlertSource {
  severity?: unknown;
  rule?: unknown;
}

const SEVERITY_PATTERN = /^[a-z]{1,16}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const parseParams = (params: unknown): { size: number } => {
  if (!isPlainObject(params)) throw new HostError('invalid_search');
  const keys = Object.keys(params);
  if (keys.length !== 2 || !keys.includes('index') || !keys.includes('size')) {
    throw new HostError('invalid_search');
  }
  const { index, size } = params;
  // Exact match only: no wildcards, comma lists, arrays, cross-cluster names or other indices.
  if (index !== SYNTHETIC_INDEX) throw new HostError('index_not_granted');
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
    throw new HostError('invalid_search');
  }
  if (size > LIMITS.callbackRecords) throw new HostError('invalid_search');
  return { size };
};

/**
 * Request-scoped Elasticsearch capability behind the exposed `HostEs` facade.
 * Holds the route's `asCurrentUser` client, a one-call budget and an abort signal; never exposed.
 */
export class SearchCapability {
  readonly #client: ElasticsearchClient;
  readonly #abort = new AbortController();
  #active = true;
  #calls = 0;
  #esDenied = false;
  #esMs = 0;
  #requestBytes = 0;
  #responseBytes = 0;

  constructor(client: ElasticsearchClient) {
    this.#client = client;
  }

  public get active(): boolean {
    return this.#active;
  }

  public get stats(): SearchCapabilityStats {
    return {
      calls: this.#calls,
      esDenied: this.#esDenied,
      esMs: this.#esMs,
      requestBytes: this.#requestBytes,
      responseBytes: this.#responseBytes,
    };
  }

  /** Idempotent. Rejects later calls and aborts an in-flight Elasticsearch request. */
  revoke(): void {
    this.#active = false;
    this.#abort.abort();
  }

  async search(params: unknown): Promise<HostEsSearchResult> {
    if (!this.#active) throw new HostError('host_revoked');
    this.#calls += 1;
    if (this.#calls > LIMITS.callbacksPerInvocation) throw new HostError('callback_budget');
    this.#requestBytes += Buffer.byteLength(JSON.stringify(params) ?? '');
    const { size } = parseParams(params);
    const started = performance.now();
    try {
      const response = await this.#client.search<AlertSource>(
        {
          index: SYNTHETIC_INDEX,
          size,
          expand_wildcards: 'none',
          allow_no_indices: false,
          ignore_unavailable: false,
          track_total_hits: true,
          query: { match_all: {} },
          _source: ['severity', 'rule'],
        },
        { signal: this.#abort.signal, maxRetries: 0 }
      );
      if (!this.#active) throw new HostError('host_revoked');
      const result = this.#toResult(response.hits);
      this.#responseBytes += Buffer.byteLength(JSON.stringify(result));
      return result;
    } catch (error) {
      throw this.#normalize(error);
    } finally {
      this.#esMs += performance.now() - started;
    }
  }

  #toResult(hits: {
    total?: number | { value: number };
    hits: Array<{ _index: string; _source?: AlertSource }>;
  }): HostEsSearchResult {
    const records: HostEsRecord[] = [];
    let bytes = 0;
    for (const hit of hits.hits.slice(0, LIMITS.callbackRecords)) {
      // An alias with the granted name could resolve elsewhere; refuse rather than leak.
      if (hit._index !== SYNTHETIC_INDEX) throw new HostError('index_not_granted');
      const { severity, rule } = hit._source ?? {};
      if (typeof severity !== 'string' || !SEVERITY_PATTERN.test(severity)) continue;
      if (typeof rule !== 'string' || rule.length === 0 || rule.length > LIMITS.ruleLength) {
        continue;
      }
      const record = { severity, rule };
      bytes += Buffer.byteLength(JSON.stringify(record)) + 1;
      if (bytes > LIMITS.callbackResultBytes - 64) break;
      records.push(record);
    }
    const total = typeof hits.total === 'number' ? hits.total : hits.total?.value ?? records.length;
    return { total, records };
  }

  #normalize(error: unknown): HostError {
    if (error instanceof HostError) return error;
    if (isRequestAbortedError(error) || !this.#active) return new HostError('host_revoked');
    if (isResponseError(error) && (error.statusCode === 401 || error.statusCode === 403)) {
      this.#esDenied = true;
      return new HostError('es_forbidden');
    }
    return new HostError('es_failed');
  }
}
