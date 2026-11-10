/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import { isRequestAbortedError, isResponseError } from '@kbn/es-errors';
import { LIMITS } from '../../common';
import { parseSearchInput } from '../search_input';
import { HostError } from './host_error';

/** Observes every search attempt (audit attribution); never receives payloads. */
export type SearchObserver = (outcome: 'success' | 'failure', reason: string) => void;

/**
 * Authorizes one callback before any Elasticsearch I/O. Resolves to undefined to allow, or to the
 * refusal's public code and audit reason.
 */
export type CallbackAuthorizer = () => Promise<
  { readonly code: 'app_disabled' | 'app_stale'; readonly reason: string } | undefined
>;

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

export interface SearchCapabilityOptions {
  readonly observer?: SearchObserver;
  readonly authorize?: CallbackAuthorizer;
  /** K1 fault injection only (dev-only config): skip the index literal of the input schema. */
  readonly anyIndex?: boolean;
}

/**
 * Request-scoped Elasticsearch capability behind the exposed `HostEs` facade. Holds a scoped
 * client (the app session key on the bridge path, `asCurrentUser` on the native route), an abort
 * signal and, on the bridge path, a lifecycle authorizer run before every search; never exposed.
 * Elasticsearch decides what the client may read.
 */
export class SearchCapability {
  readonly #client: ElasticsearchClient;
  readonly #observer: SearchObserver | undefined;
  readonly #authorize: CallbackAuthorizer | undefined;
  readonly #anyIndex: boolean;
  readonly #abort = new AbortController();
  #active = true;
  #calls = 0;
  #esDenied = false;
  #esMs = 0;
  #requestBytes = 0;
  #responseBytes = 0;

  constructor(
    client: ElasticsearchClient,
    { observer, authorize, anyIndex = false }: SearchCapabilityOptions = {}
  ) {
    this.#client = client;
    this.#observer = observer;
    this.#authorize = authorize;
    this.#anyIndex = anyIndex;
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
    try {
      const result = await this.#search(params);
      this.#observer?.('success', 'ok');
      return result;
    } catch (error) {
      this.#observer?.('failure', error instanceof HostError ? error.reason : 'host_error');
      throw error;
    }
  }

  async #search(params: unknown): Promise<HostEsSearchResult> {
    if (!this.#active) throw new HostError('host_revoked');
    this.#calls += 1;
    this.#requestBytes += Buffer.byteLength(JSON.stringify(params) ?? '');
    const input = parseSearchInput(params, { anyIndex: this.#anyIndex });
    if (!input.ok) throw new HostError(input.reason);
    const { index, size } = input;
    if (this.#authorize) {
      const refusal = await this.#authorize();
      if (refusal) throw new HostError(refusal.code, refusal.reason);
      if (!this.#active) throw new HostError('host_revoked');
    }
    const started = performance.now();
    try {
      const response = await this.#client.search<AlertSource>(
        {
          index,
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
    hits: Array<{ _source?: AlertSource }>;
  }): HostEsSearchResult {
    const records: HostEsRecord[] = [];
    for (const hit of hits.hits) {
      const { severity, rule } = hit._source ?? {};
      if (typeof severity !== 'string' || !SEVERITY_PATTERN.test(severity)) continue;
      if (typeof rule !== 'string' || rule.length === 0 || rule.length > LIMITS.ruleLength) {
        continue;
      }
      records.push({ severity, rule });
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
