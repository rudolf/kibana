/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { errors, type DiagnosticResult, type TransportResult } from '@elastic/elasticsearch';
import { elasticsearchServiceMock } from '@kbn/core/server/mocks';

export const SYNTHETIC_DOCS = [
  { severity: 'high', rule: 'synthetic-rule-a' },
  { severity: 'high', rule: 'synthetic-rule-b' },
  { severity: 'low', rule: 'synthetic-rule-c' },
];

export const searchResponse = (
  docs: ReadonlyArray<Record<string, unknown>> = SYNTHETIC_DOCS,
  index = 'kbn-apps-prototype-alerts'
) => ({
  took: 1,
  timed_out: false,
  _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
  hits: {
    total: { value: docs.length, relation: 'eq' as const },
    max_score: 1,
    hits: docs.map((doc, i) => ({ _index: index, _id: String(i), _score: 1, _source: doc })),
  },
});

export const responseError = (statusCode: number) =>
  new errors.ResponseError({
    body: { error: { type: 'security_exception' } },
    statusCode,
    headers: {},
    warnings: [],
    meta: {} as DiagnosticResult['meta'],
  } as TransportResult);

export const createScopedClient = () => elasticsearchServiceMock.createElasticsearchClient();
