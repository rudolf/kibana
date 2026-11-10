/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Binds a tool run to the dispatcher Kibana actually uses. Kibana reports a host-owned
// `dispatcher;desc="scheme=..,class=..,fp=.."` entry in `x-app-host-timing`
// (server/remote/dispatcher_endpoint.ts); this recomputes the same description from `--rpc`.
// Local versus remote is derived from that evidence, never from a label.

import { createHash } from 'node:crypto';

export const TIMING_HEADER = 'x-app-host-timing';
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type TargetMode = 'local' | 'remote';
export type HostClass = 'loopback' | 'remote';

export interface DispatcherDescription {
  readonly scheme: 'ws' | 'wss';
  readonly hostClass: HostClass;
  readonly fingerprint: string;
}

/** Normalized `scheme://host[:port]/path`; must stay identical to Kibana's implementation. */
export const normalizeDispatcherUrl = (value: string): string => {
  const { protocol, hostname, port, pathname } = new URL(value);
  return `${protocol}//${hostname}${port ? `:${port}` : ''}${pathname || '/'}`;
};

export const describeDispatcher = (value: string): string => {
  const normalized = normalizeDispatcherUrl(value);
  const { protocol, hostname } = new URL(normalized);
  const scheme = protocol.replace(/:$/, '');
  const hostClass = LOOPBACK_HOSTS.has(hostname) ? 'loopback' : 'remote';
  const fingerprint = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `scheme=${scheme},class=${hostClass},fp=${fingerprint}`;
};

export const parseDescription = (value: string | undefined): DispatcherDescription | undefined => {
  const match = /^scheme=(wss?),class=(loopback|remote),fp=([0-9a-f]{16})$/.exec(value ?? '');
  if (!match) return undefined;
  return {
    scheme: match[1] as 'ws' | 'wss',
    hostClass: match[2] as HostClass,
    fingerprint: match[3],
  };
};

/** Parses `name;dur=1.0` and `name;desc="a=1,b=2"` entries of the host-owned timing header. */
export const parseTimingHeader = (header: string | null | undefined) => {
  const durations: Record<string, number> = {};
  const descriptions: Record<string, string> = {};
  for (const entry of (header ?? '').split(/,\s*(?=[a-z_]+;)/)) {
    const [name, ...params] = entry.split(';');
    for (const param of params) {
      const separator = param.indexOf('=');
      const key = param.slice(0, separator);
      const raw = param.slice(separator + 1);
      if (key === 'dur') durations[name] = Number(raw);
      if (key === 'desc') descriptions[name] = raw.replace(/^"|"$/g, '');
    }
  }
  return { durations, descriptions };
};

export interface RequestedTarget {
  readonly url: string;
  readonly mode: TargetMode;
  readonly expected: string;
}

/**
 * Validates `--rpc` against the requested mode before anything runs: `--local-workerd` only for a
 * loopback endpoint; remote mode only for a non-loopback `wss://` endpoint.
 */
export const requestedTarget = (
  url: string | undefined,
  localWorkerd: boolean
): RequestedTarget => {
  if (!url) throw new Error('--rpc is required: the dispatcher URL Kibana is expected to use');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('--rpc must be a valid ws:// or wss:// URL');
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (!['ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error('--rpc must be a ws:// or wss:// URL');
  }
  if (localWorkerd && !loopback) {
    throw new Error('--local-workerd is only allowed for a loopback dispatcher URL');
  }
  if (!localWorkerd && parsed.protocol !== 'wss:') {
    throw new Error('remote mode requires a wss:// dispatcher URL (ws:// is local only)');
  }
  if (!localWorkerd && loopback) {
    throw new Error('remote mode requires a non-loopback dispatcher; use --local-workerd locally');
  }
  return { url, mode: localWorkerd ? 'local' : 'remote', expected: describeDispatcher(url) };
};

export interface DispatcherVerification {
  readonly verified: boolean;
  readonly expected: string;
  readonly observed: string | null;
  /** Derived from the observed, host-owned description; null when there is no evidence. */
  readonly observedMode: TargetMode | null;
  readonly reason?: string;
}

/** Checks the dispatcher Kibana reported in `x-app-host-timing` against the requested target. */
export const verifyDispatcher = (
  target: RequestedTarget,
  header: string | null | undefined
): DispatcherVerification => {
  const observed = parseTimingHeader(header).descriptions.dispatcher ?? null;
  const description = parseDescription(observed ?? undefined);
  const base = { expected: target.expected, observed };
  if (!description) {
    return {
      ...base,
      verified: false,
      observedMode: null,
      reason: 'no dispatcher evidence in x-app-host-timing',
    };
  }
  const observedMode: TargetMode = description.hostClass === 'loopback' ? 'local' : 'remote';
  if (observedMode !== target.mode) {
    return {
      ...base,
      verified: false,
      observedMode,
      reason: `Kibana uses a ${observedMode} dispatcher, ${target.mode} was requested`,
    };
  }
  if (observedMode === 'remote' && description.scheme !== 'wss') {
    return { ...base, verified: false, observedMode, reason: 'remote dispatcher is not wss://' };
  }
  if (observed !== target.expected) {
    return {
      ...base,
      verified: false,
      observedMode,
      reason: 'Kibana uses a different dispatcher endpoint than --rpc (fingerprint mismatch)',
    };
  }
  return { ...base, verified: true, observedMode };
};
