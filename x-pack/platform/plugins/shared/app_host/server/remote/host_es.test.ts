/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { expose } from '@kbn/core-remote-common';
import { createScopedClient, searchResponse } from '../mocks/es';
import { HostEs } from './host_es';
import { SearchCapability } from './search_capability';

describe('HostEs facade', () => {
  it('has exactly one public method on its prototype', () => {
    expect(Object.getOwnPropertyNames(HostEs.prototype).sort()).toEqual(['constructor', 'search']);
  });

  it('exposes only search through the remotable adapter', () => {
    const adapter = expose(new HostEs(new SearchCapability(createScopedClient())));
    const proto = Object.getPrototypeOf(adapter);
    expect(Object.getOwnPropertyNames(proto).sort()).toEqual(['constructor', 'search']);
    expect(Object.keys(adapter)).toEqual([]);
  });

  it('keeps the capability out of reach', () => {
    const facade = new HostEs(new SearchCapability(createScopedClient()));
    expect(Object.keys(facade)).toEqual([]);
    expect(Object.getOwnPropertySymbols(facade)).toEqual([]);
  });

  it('delegates search to its own capability only', async () => {
    const clientA = createScopedClient();
    const clientB = createScopedClient();
    clientA.search.mockResponse(searchResponse([{ severity: 'high', rule: 'a' }]));
    clientB.search.mockResponse(searchResponse([{ severity: 'low', rule: 'b' }]));
    const a = expose(new HostEs(new SearchCapability(clientA))) as unknown as HostEs;
    const b = expose(new HostEs(new SearchCapability(clientB))) as unknown as HostEs;
    const [resultA, resultB] = await Promise.all([
      a.search({ index: 'kbn-apps-prototype-alerts', size: 1 }),
      b.search({ index: 'kbn-apps-prototype-alerts', size: 1 }),
    ]);
    expect(resultA.records).toEqual([{ severity: 'high', rule: 'a' }]);
    expect(resultB.records).toEqual([{ severity: 'low', rule: 'b' }]);
    expect(clientA.search).toHaveBeenCalledTimes(1);
    expect(clientB.search).toHaveBeenCalledTimes(1);
  });
});
