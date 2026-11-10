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
  | 'session_created'
  | 'mint_failed'
  | 'revoked_during_mint'
  | 'stale_generation'
  | 'bad_handle'
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
  | 'aborted'
  | 'native_denied'
  | 'native_rejected'
  | 'native_failed'
  | 'invalid_result'
  | 'cpu_limit';

export interface BridgeAuditEvent {
  /**
   * From the verified handle/registry only; omitted when no valid app context exists. `apiKeyId`
   * is the app session key's id (never the key itself).
   */
  readonly app?: {
    readonly id: string;
    readonly version: string;
    readonly releaseDigest: string;
    readonly apiKeyId?: string;
  };
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
  readonly via: 'bridge' | 'app.summary' | 'session' | 'native';
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
  api_key?: { id: string };
}

/** Strips control characters (CRLF, ANSI escapes) and caps length; values are JSON-escaped later. */
export const boundedField = (value: string, max = 256): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, max);

/**
 * Structured `app_host.bridge` records with a fixed message. No API keys, handles, tokens, query
 * bodies, payloads, titles or raw errors are ever included; only the key id (`api_key.id`). Prototype attribution only, not
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
      ...(event.app?.apiKeyId ? { api_key: { id: boundedField(event.app.apiKeyId, 64) } } : {}),
    };
    this.#logger.info<BridgeAuditMeta>('app_host.bridge', meta);
  }
}
