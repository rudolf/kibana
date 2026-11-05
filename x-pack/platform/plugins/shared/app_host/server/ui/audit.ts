/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger, LogMeta } from '@kbn/core/server';

/** Fixed reason codes; logs may be more specific than the public error, never raw text. */
export type AuditReason =
  | 'ok'
  | 'lease_created'
  | 'lease_revoked'
  | 'lease_limit'
  | 'unknown_lease'
  | 'bad_secret'
  | 'expired'
  | 'principal_mismatch'
  | 'non_default_space'
  | 'origin_mismatch'
  | 'run_as_refused'
  | 'app_mismatch'
  | 'not_approved'
  | 'disabled'
  | 'stale_release'
  | 'invalid_operation'
  | 'scope_not_granted'
  | 'resource_not_granted'
  | 'rate_limited'
  | 'lease_budget'
  | 'in_flight_limit'
  | 'process_limit'
  | 'deadline'
  | 'native_denied'
  | 'native_failed'
  | 'invalid_result'
  | 'revoked_during_call'
  | 'cpu_limit';

export interface BridgeAuditEvent {
  /** From the verified lease/registry only; omitted when no valid app context exists. */
  readonly app?: { readonly id: string; readonly version: string; readonly releaseDigest: string };
  readonly userName?: string;
  readonly spaceId: string;
  readonly capability: string;
  readonly outcome: 'success' | 'failure';
  readonly reason: AuditReason;
  readonly correlationId: string;
  /**
   * `bridge` for UI calls; `app.summary` for Worker-path HostEs callbacks inside one; `native` for
   * the native summary route (F7).
   */
  readonly via: 'bridge' | 'app.summary' | 'lease' | 'native';
}

interface BridgeAuditMeta extends LogMeta {
  app?: {
    id: string;
    version: string;
    release_digest: string;
    capability: string;
    via: string;
  };
  kibana: { space_id: string; correlation_id: string };
}

/** Strips control characters (CRLF, ANSI escapes) and caps length; values are JSON-escaped later. */
export const boundedField = (value: string, max = 256): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, max);

/**
 * Structured `app_host.bridge` records with a fixed message. No secrets, lease ids, tokens, query
 * bodies, payloads, titles or raw errors are ever included. Prototype attribution only, not
 * tamper-proof compliance storage.
 */
export class BridgeAuditLogger {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  log(event: BridgeAuditEvent): void {
    const meta: BridgeAuditMeta = {
      event: {
        action: 'app_host.bridge',
        outcome: event.outcome,
        reason: event.reason,
        category: ['web'],
        // Also present without an app actor (e.g. native summary in legacy mode).
        provider: event.via,
      },
      kibana: {
        space_id: boundedField(event.spaceId, 64),
        correlation_id: boundedField(event.correlationId, 64),
      },
      ...(event.userName ? { user: { name: boundedField(event.userName) } } : {}),
      ...(event.app
        ? {
            app: {
              id: boundedField(event.app.id, 64),
              version: boundedField(event.app.version, 32),
              release_digest: boundedField(event.app.releaseDigest, 64),
              capability: boundedField(event.capability, 64),
              via: event.via,
            },
          }
        : {}),
    };
    this.#logger.info<BridgeAuditMeta>('app_host.bridge', meta);
  }
}
