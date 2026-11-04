/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { parseAppOutput } from './app_output';

describe('parseAppOutput', () => {
  it('accepts the exact output shape', () => {
    expect(parseAppOutput({ label: 'Digest v1', counts: { high: 2, low: 1 } })).toEqual({
      label: 'Digest v1',
      counts: { high: 2, low: 1 },
    });
  });

  it.each([
    ['extra field', { label: 'x', counts: { high: 0, low: 0 }, html: '<b>' }],
    ['extra count', { label: 'x', counts: { high: 0, low: 0, medium: 1 } }],
    ['long label', { label: 'x'.repeat(81), counts: { high: 0, low: 0 } }],
    ['empty label', { label: '', counts: { high: 0, low: 0 } }],
    ['negative count', { label: 'x', counts: { high: -1, low: 0 } }],
    ['too large count', { label: 'x', counts: { high: 101, low: 0 } }],
    ['fractional count', { label: 'x', counts: { high: 1.5, low: 0 } }],
    ['string count', { label: 'x', counts: { high: '1', low: 0 } }],
    ['number', 42],
    ['null', null],
  ])('rejects %s', (_name, value) => {
    expect(parseAppOutput(value)).toBeUndefined();
  });
});
