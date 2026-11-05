/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Local superuser-operated approval tool. Before writing consent.json it verifies, with the same
// authenticated installer principal in ES and Kibana: the reserved `superuser` role, ES
// `_has_privileges` read and view_index_metadata on every granted index and pattern, and a successful native GET of the exact dashboard.
// Every negative or unavailable check fails closed without writing. No credentials are persisted.
// Replacing an approval flips the state first, then invalidates the previous release's app keys.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../../../common/ui_contract';
import { invalidateAppKeys, type InvalidationResult } from './app_keys';
import { http as defaultHttp, type HttpResult } from './http';
import { LOCAL_DIR } from './secrets';
import { sha256, type UiManifest } from './ui_release';

export const CONSENT_FILE = join(LOCAL_DIR, 'operator', 'consent.json');

export interface ConsentRecord {
  readonly appId: string;
  readonly enabled: boolean;
  readonly approvedReleaseDigest: string;
  readonly approvedVersion: string;
  readonly approvedBy: string;
  readonly installerGrantDigest: string;
  /** Replaced on every approval and disable; app session handles must carry exactly this token. */
  readonly generation: string;
}

/**
 * A fresh approval generation: 16 random bytes, base64url. Execute only compares for equality, so
 * no ordering, clock or remembered high-water mark is needed, also across `reset`.
 */
export const newGeneration = (): string => randomBytes(16).toString('base64url');

export const installerGrantDigest = (manifest: UiManifest, approvedBy: string): string =>
  sha256(
    canonicalJson({
      appId: manifest.id,
      releaseDigest: manifest.releaseDigest,
      indices: manifest.permissions.indices,
      dashboardIds: manifest.permissions.dashboardIds,
      scopes: manifest.ui.scopes,
      approvedBy,
    })
  );

const VERSION = /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/;
export const parseVersion = (value: string): [number, number, number] => {
  const match = VERSION.exec(value);
  const parts = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [];
  if (parts.length !== 3 || parts.some((part) => part > 65535)) {
    throw new Error(`Invalid UI release version ${value}`);
  }
  return [parts[0], parts[1], parts[2]];
};
export const compareVersions = (a: string, b: string): number => {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

export const readConsent = (path = CONSENT_FILE): ConsentRecord | undefined =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ConsentRecord) : undefined;

export const writeConsent = (record: ConsentRecord, path = CONSENT_FILE): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
};

/**
 * Operator enable/disable. Disable replaces the generation and persists it first, which already makes
 * every earlier handle unusable forever; it then invalidates the app's keys in Elasticsearch as
 * cleanup and rejects (`AppKeyInvalidationError`) if that cleanup failed. Enable keeps the
 * generation, so handles from before the disable stay dead.
 */
export const setAppEnabled = async (
  enabled: boolean,
  {
    consentPath = CONSENT_FILE,
    esUrl,
    http,
  }: { consentPath?: string; esUrl?: string; http?: typeof defaultHttp } = {}
): Promise<InvalidationResult | undefined> => {
  const consent = readConsent(consentPath);
  if (!consent) throw new Error('No approval to change');
  if (enabled) {
    writeConsent({ ...consent, enabled }, consentPath);
    return undefined;
  }
  writeConsent({ ...consent, enabled, generation: newGeneration() }, consentPath);
  return invalidateAppKeys({ esUrl, appId: consent.appId, http });
};

export type ApprovalFailure =
  | 'es_unavailable'
  | 'kibana_unavailable'
  | 'not_superuser'
  | 'mixed_identities'
  | 'index_privilege_missing'
  | 'dashboard_unreadable'
  | 'downgrade_rejected';

export class ApprovalError extends Error {
  readonly code: ApprovalFailure;
  constructor(code: ApprovalFailure) {
    super(`approval refused: ${code}`);
    this.code = code;
  }
}

export interface ApprovalOptions {
  readonly manifest: UiManifest;
  readonly esUrl: string;
  readonly kbUrl: string;
  /** Installer credentials for ES and Kibana; normally the same `user:pass`. */
  readonly esAuth: string;
  readonly kbAuth: string;
  readonly consentPath?: string;
  readonly http?: typeof defaultHttp;
}

export interface ApprovalResult {
  readonly written: boolean;
  readonly idempotent: boolean;
  readonly approvedBy: string;
  readonly installerGrantDigest: string;
  /** Keys of the superseded release, invalidated after the new approval was written. */
  readonly revoked?: InvalidationResult;
}

interface Realm {
  readonly type?: string;
  readonly name?: string;
}

/** Both realms present, with non-empty and equal type and name. */
const sameRealm = (a: Realm | undefined, b: Realm | undefined): boolean =>
  Boolean(a?.type && a.name && b?.type && b.name) && a?.type === b?.type && a?.name === b?.name;

const safe = async (call: () => Promise<HttpResult>, failure: ApprovalFailure) => {
  try {
    return await call();
  } catch {
    throw new ApprovalError(failure);
  }
};

export const approveRelease = async ({
  manifest,
  esUrl,
  kbUrl,
  esAuth,
  kbAuth,
  consentPath = CONSENT_FILE,
  http = defaultHttp,
}: ApprovalOptions): Promise<ApprovalResult> => {
  parseVersion(manifest.version);
  const authenticate = await safe(
    () => http(`${esUrl}/_security/_authenticate`, { auth: esAuth }),
    'es_unavailable'
  );
  if (authenticate.status !== 200) throw new ApprovalError('es_unavailable');
  const esUser = authenticate.body as {
    username?: string;
    roles?: string[];
    authentication_realm?: Realm;
  };
  if (!esUser.username || !(esUser.roles ?? []).includes('superuser')) {
    throw new ApprovalError('not_superuser');
  }
  const me = await safe(
    () =>
      http(`${kbUrl}/internal/security/me`, {
        auth: kbAuth,
        headers: { 'x-elastic-internal-origin': 'app-host-approval' },
      }),
    'kibana_unavailable'
  );
  if (me.status !== 200) throw new ApprovalError('kibana_unavailable');
  const kbUser = me.body as { username?: string; authentication_realm?: Realm };
  // The same authenticated principal must pass both checks; never combine two people's privileges.
  // A principal is username + authentication realm (type and name): the same username in two realms
  // is two principals.
  if (
    kbUser.username !== esUser.username ||
    !sameRealm(kbUser.authentication_realm, esUser.authentication_realm)
  ) {
    throw new ApprovalError('mixed_identities');
  }
  const privileges = await safe(
    () =>
      http(`${esUrl}/_security/user/_has_privileges`, {
        method: 'POST',
        auth: esAuth,
        body: {
          index: [
            {
              names: [...manifest.permissions.indices],
              privileges: ['read', 'view_index_metadata'],
            },
          ],
        },
      }),
    'es_unavailable'
  );
  const has = privileges.body as { has_all_requested?: boolean; username?: string };
  if (privileges.status !== 200 || has.username !== esUser.username || !has.has_all_requested) {
    throw new ApprovalError('index_privilege_missing');
  }
  const [dashboardId] = manifest.permissions.dashboardIds;
  const dashboard = await safe(
    () =>
      http(`${kbUrl}/api/dashboards/${encodeURIComponent(dashboardId)}`, {
        auth: kbAuth,
        headers: { 'elastic-api-version': '2023-10-31' },
      }),
    'kibana_unavailable'
  );
  if (dashboard.status !== 200 || (dashboard.body as { id?: string }).id !== dashboardId) {
    throw new ApprovalError('dashboard_unreadable');
  }
  const approvedBy = esUser.username;
  const grant = installerGrantDigest(manifest, approvedBy);
  const existing = readConsent(consentPath);
  if (existing) {
    if (
      existing.approvedReleaseDigest === manifest.releaseDigest &&
      existing.approvedVersion === manifest.version
    ) {
      return { written: false, idempotent: true, approvedBy, installerGrantDigest: grant };
    }
    if (compareVersions(manifest.version, existing.approvedVersion) <= 0) {
      throw new ApprovalError('downgrade_rejected');
    }
  }
  writeConsent(
    {
      appId: manifest.id,
      enabled: true,
      approvedReleaseDigest: manifest.releaseDigest,
      approvedVersion: manifest.version,
      approvedBy,
      installerGrantDigest: grant,
      generation: newGeneration(),
    },
    consentPath
  );
  const revoked = existing
    ? await invalidateAppKeys({
        esUrl,
        appId: existing.appId,
        releaseDigest: existing.approvedReleaseDigest,
        http,
      })
    : undefined;
  return { written: true, idempotent: false, approvedBy, installerGrantDigest: grant, revoked };
};
