/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { config } from './config';

const { schema } = config;
const valid = {
  enabled: true,
  packagePath: '/tmp/app',
  dispatcherUrl: 'wss://dispatcher.example.workers.dev/rpc',
  callerToken: 'x'.repeat(43),
};

describe('xpack.app_host config', () => {
  it('is disabled by default and needs nothing else', () => {
    expect(schema.validate({})).toEqual({ enabled: false });
  });

  it('requires package path, dispatcher URL and caller token when enabled', () => {
    expect(() => schema.validate({ enabled: true })).toThrow();
    expect(schema.validate(valid)).toEqual(valid);
  });

  it('requires wss:// except for a loopback dispatcher', () => {
    expect(() => schema.validate({ ...valid, dispatcherUrl: 'ws://example.com/rpc' })).toThrow(
      /wss/
    );
    expect(() => schema.validate({ ...valid, dispatcherUrl: 'https://example.com/rpc' })).toThrow();
    expect(
      schema.validate({ ...valid, dispatcherUrl: 'ws://127.0.0.1:8787/rpc' }).dispatcherUrl
    ).toBe('ws://127.0.0.1:8787/rpc');
  });

  it('bounds the caller token', () => {
    expect(() => schema.validate({ ...valid, callerToken: 'short' })).toThrow();
    expect(() => schema.validate({ ...valid, callerToken: 'x'.repeat(257) })).toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() => schema.validate({ ...valid, backend: 'sandbox' })).toThrow();
  });
});
