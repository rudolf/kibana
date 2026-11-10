/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'node:crypto';

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Normalized `scheme://host[:port]/path`: lowercase host, default port omitted, no query/hash/userinfo. */
export const normalizeDispatcherUrl = (value: string): string => {
  const { protocol, hostname, port, pathname } = new URL(value);
  return `${protocol}//${hostname}${port ? `:${port}` : ''}${pathname || '/'}`;
};

/**
 * Host-owned, non-secret description of the dispatcher this Kibana process actually uses:
 * scheme, loopback/remote class and a 16-hex-digit SHA-256 fingerprint of the normalized URL.
 * The prototype tooling recomputes it from `--rpc` to verify the live target.
 */
export const describeDispatcher = (value: string): string => {
  const normalized = normalizeDispatcherUrl(value);
  const { protocol, hostname } = new URL(normalized);
  const scheme = protocol.replace(/:$/, '');
  const hostClass = LOOPBACK_HOSTS.has(hostname) ? 'loopback' : 'remote';
  const fingerprint = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `scheme=${scheme},class=${hostClass},fp=${fingerprint}`;
};
