/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createScopedClient, responseError, searchResponse } from '../mocks/es';
import { HostError } from './host_error';
import { SearchCapability } from './search_capability';

const params = { index: 'kbn-apps-prototype-alerts', size: 100 };

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HostError) return error.code;
    throw error;
  }
  return 'ok';
};

describe('SearchCapability', () => {
  it('builds the search itself with the scoped client and returns bounded records', async () => {
    const client = createScopedClient();
    client.search.mockResponse(searchResponse());
    const capability = new SearchCapability(client);
    const result = await capability.search(params);
    expect(result).toEqual({
      total: 3,
      records: [
        { severity: 'high', rule: 'synthetic-rule-a' },
        { severity: 'high', rule: 'synthetic-rule-b' },
        { severity: 'low', rule: 'synthetic-rule-c' },
      ],
    });
    expect(client.search).toHaveBeenCalledTimes(1);
    const [request, options] = client.search.mock.calls[0];
    expect(request).toEqual({
      index: 'kbn-apps-prototype-alerts',
      size: 100,
      expand_wildcards: 'none',
      allow_no_indices: false,
      ignore_unavailable: false,
      track_total_hits: true,
      query: { match_all: {} },
      _source: ['severity', 'rule'],
    });
    expect(options).toEqual(expect.objectContaining({ maxRetries: 0, signal: expect.anything() }));
  });

  it.each([
    ['wildcard', { index: 'kbn-apps-*', size: 1 }, 'index_not_granted'],
    ['comma list', { index: 'kbn-apps-prototype-alerts,.kibana', size: 1 }, 'index_not_granted'],
    ['cross-cluster', { index: 'remote:kbn-apps-prototype-alerts', size: 1 }, 'index_not_granted'],
    ['array', { index: ['kbn-apps-prototype-alerts'], size: 1 }, 'index_not_granted'],
    ['other index', { index: '.alerts-security.alerts-default', size: 1 }, 'index_not_granted'],
    ['size 0', { index: 'kbn-apps-prototype-alerts', size: 0 }, 'invalid_search'],
    ['size 101', { index: 'kbn-apps-prototype-alerts', size: 101 }, 'invalid_search'],
    ['fractional size', { index: 'kbn-apps-prototype-alerts', size: 1.5 }, 'invalid_search'],
    ['string size', { index: 'kbn-apps-prototype-alerts', size: '1' }, 'invalid_search'],
    ['query DSL', { ...params, query: { match_all: {} } }, 'invalid_search'],
    ['not an object', 'kbn-apps-prototype-alerts', 'invalid_search'],
  ])('rejects %s without calling Elasticsearch', async (_name, input, code) => {
    const client = createScopedClient();
    expect(await codeOf(new SearchCapability(client).search(input))).toBe(code);
    expect(client.search).not.toHaveBeenCalled();
  });

  it('allows one callback per invocation', async () => {
    const client = createScopedClient();
    client.search.mockResponse(searchResponse());
    const capability = new SearchCapability(client);
    await capability.search(params);
    expect(await codeOf(capability.search(params))).toBe('callback_budget');
    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it('rejects calls after revocation and aborts in-flight requests', async () => {
    const client = createScopedClient();
    let signal: AbortSignal | undefined;
    client.search.mockImplementation((_req, opts) => {
      signal = opts?.signal;
      return new Promise((_, reject) =>
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
      );
    });
    const capability = new SearchCapability(client);
    const pending = capability.search(params);
    capability.revoke();
    expect(await codeOf(pending)).toBe('host_revoked');
    expect(signal?.aborted).toBe(true);
    expect(await codeOf(capability.search(params))).toBe('host_revoked');
  });

  it.each([401, 403])(
    'normalizes Elasticsearch %s to es_forbidden and records it',
    async (status) => {
      const client = createScopedClient();
      client.search.mockRejectedValue(responseError(status));
      const capability = new SearchCapability(client);
      expect(await codeOf(capability.search(params))).toBe('es_forbidden');
      expect(capability.stats.esDenied).toBe(true);
    }
  );

  it('sanitizes other Elasticsearch failures', async () => {
    const client = createScopedClient();
    client.search.mockRejectedValue(responseError(500));
    const capability = new SearchCapability(client);
    const error = await capability.search(params).catch((e) => e);
    expect(error).toBeInstanceOf(HostError);
    expect(error.message).toBe('app_host:es_failed');
    expect(capability.stats.esDenied).toBe(false);
  });

  it('K1 fault injection: anyIndex skips only the index literal; Elasticsearch decides', async () => {
    const client = createScopedClient();
    client.search.mockRejectedValue(responseError(403));
    const capability = new SearchCapability(client, { anyIndex: true });
    expect(await codeOf(capability.search({ index: '.security', size: 1 }))).toBe('es_forbidden');
    expect(client.search.mock.calls[0][0]).toEqual(expect.objectContaining({ index: '.security' }));
    expect(
      await codeOf(new SearchCapability(client, { anyIndex: true }).search({ index: 'x', size: 0 }))
    ).toBe('invalid_search');
  });

  it('drops malformed records and bounds the result size', async () => {
    const client = createScopedClient();
    const docs = [
      { severity: 'HIGH', rule: 'a' },
      { severity: 'high', rule: 'x'.repeat(129) },
      { severity: 'high' },
      ...Array.from({ length: 100 }, () => ({ severity: 'low', rule: 'r'.repeat(128) })),
    ];
    client.search.mockResponse(searchResponse(docs));
    const result = await new SearchCapability(client).search(params);
    expect(result.records.every(({ severity }) => severity === 'low')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
    expect(result.records.length).toBeLessThan(100);
  });
});
