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
  handleEncryptionKey: 'k'.repeat(32),
};
const PROD = { dev: false };
const DEV = { dev: true };

describe('xpack.app_host config', () => {
  it('is disabled by default and needs nothing else', () => {
    expect(schema.validate({}, PROD)).toEqual({ enabled: false, testOnlySkipInputSchema: false });
  });

  it('requires package path, dispatcher URL, caller token and handle key when enabled', () => {
    expect(() => schema.validate({ enabled: true }, PROD)).toThrow();
    const { handleEncryptionKey: _omitted, ...withoutKey } = valid;
    expect(() => schema.validate(withoutKey, PROD)).toThrow(/handleEncryptionKey/);
    expect(() =>
      schema.validate({ ...valid, handleEncryptionKey: 'k'.repeat(31) }, PROD)
    ).toThrow();
    expect(schema.validate(valid, PROD)).toEqual({ ...valid, testOnlySkipInputSchema: false });
  });

  it('allows the K1 input-schema bypass only in dev mode, off by default', () => {
    expect(schema.validate(valid, DEV).testOnlySkipInputSchema).toBe(false);
    expect(
      schema.validate({ ...valid, testOnlySkipInputSchema: true }, DEV).testOnlySkipInputSchema
    ).toBe(true);
    expect(() => schema.validate({ ...valid, testOnlySkipInputSchema: true }, PROD)).toThrow();
  });

  it('requires wss:// except for a loopback dispatcher', () => {
    expect(() =>
      schema.validate({ ...valid, dispatcherUrl: 'ws://example.com/rpc' }, PROD)
    ).toThrow(/wss/);
    expect(() =>
      schema.validate({ ...valid, dispatcherUrl: 'https://example.com/rpc' }, PROD)
    ).toThrow();
    expect(
      schema.validate({ ...valid, dispatcherUrl: 'ws://127.0.0.1:8787/rpc' }, PROD).dispatcherUrl
    ).toBe('ws://127.0.0.1:8787/rpc');
  });

  it('bounds the caller token', () => {
    expect(() => schema.validate({ ...valid, callerToken: 'short' }, PROD)).toThrow();
    expect(() => schema.validate({ ...valid, callerToken: 'x'.repeat(257) }, PROD)).toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() => schema.validate({ ...valid, backend: 'sandbox' }, PROD)).toThrow();
  });
});
