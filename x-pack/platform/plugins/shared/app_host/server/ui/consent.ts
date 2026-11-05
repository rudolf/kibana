/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { constants, promises as fs } from 'node:fs';
import type { TypeOf } from '@kbn/config-schema';
import { schema } from '@kbn/config-schema';
import { INSTALLED_APP_ID } from '../../common';
import { canonicalJson } from '../../common/ui_contract';
import { PackageError } from '../package/package_error';
import { readManifest, isUiManifest } from '../package/read_package';
import { UI_VERSION_PATTERN, type UiAppManifest } from '../package/manifest_schema';
import { sha256Hex } from './contract';

const MAX_CONSENT_BYTES = 4 * 1024;

const hex64 = () =>
  schema.string({
    minLength: 64,
    maxLength: 64,
    validate: (value) => (/^[0-9a-f]{64}$/.test(value) ? undefined : 'must be sha256 hex'),
  });

/** Operator-controlled approval record. Exact keys; no credentials are ever stored. */
export const consentSchema = schema.object({
  appId: schema.literal(INSTALLED_APP_ID),
  enabled: schema.boolean(),
  approvedReleaseDigest: hex64(),
  approvedVersion: schema.string({
    maxLength: 17,
    validate: (value) => (UI_VERSION_PATTERN.test(value) ? undefined : 'invalid version'),
  }),
  approvedBy: schema.string({ minLength: 1, maxLength: 256 }),
  installerGrantDigest: hex64(),
  // Monotonic approval generation: raised on every disable, uninstall and new approval. App session
  // handles carry it, so a handle from before any of these is refused forever, even after re-enable.
  generation: schema.number({
    min: 1,
    validate: (value) => (Number.isSafeInteger(value) ? undefined : 'must be an integer'),
  }),
});

export type ConsentRecord = TypeOf<typeof consentSchema>;

/**
 * Fingerprint of the exact grant the installer's privileges were checked against. The approval
 * tool computes the same value; the server recomputes it from the manifest on every read.
 */
export const installerGrantDigest = (manifest: UiAppManifest, approvedBy: string): string =>
  sha256Hex(
    canonicalJson({
      appId: manifest.id,
      releaseDigest: manifest.releaseDigest,
      indices: manifest.permissions.indices,
      dashboardIds: manifest.permissions.dashboardIds,
      scopes: manifest.ui.scopes,
      approvedBy,
    })
  );

/** Group-write (0o020) or other-write (0o002) permission bit set. */
const isGroupOrOtherWritable = (mode: number): boolean =>
  Math.floor(mode / 0o20) % 2 === 1 || Math.floor(mode / 0o2) % 2 === 1;

export type ConsentReadResult =
  | { readonly status: 'missing' }
  | { readonly status: 'invalid' }
  | { readonly status: 'ok'; readonly consent: ConsentRecord };

/** Bounded, non-symlink, not group/other-writable read of consent.json. */
export const readConsent = async (path: string): Promise<ConsentReadResult> => {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path, constants.O_NOFOLLOW);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'invalid' };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONSENT_BYTES || isGroupOrOtherWritable(stat.mode)) {
      return { status: 'invalid' };
    }
    const buffer = Buffer.alloc(MAX_CONSENT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, MAX_CONSENT_BYTES + 1, 0);
    if (bytesRead > MAX_CONSENT_BYTES) return { status: 'invalid' };
    return {
      status: 'ok',
      consent: consentSchema.validate(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))),
    };
  } catch {
    return { status: 'invalid' };
  } finally {
    await handle.close();
  }
};

export type UiReleaseState =
  | { readonly status: 'not_installed' }
  | { readonly status: 'invalid' }
  | { readonly status: 'not_approved'; readonly manifest?: UiAppManifest }
  | {
      readonly status: 'disabled';
      readonly manifest: UiAppManifest;
      readonly consent: ConsentRecord;
    }
  | {
      readonly status: 'approved';
      readonly manifest: UiAppManifest;
      readonly consent: ConsentRecord;
    };

/**
 * Reads the installed manifest and the operator approval afresh. Only an enabled consent that
 * approves this exact full release digest, version and checked grant yields `approved`.
 */
export const readUiReleaseState = async (
  packagePath: string,
  consentPath: string | undefined
): Promise<UiReleaseState> => {
  if (!consentPath) return { status: 'not_installed' };
  const consentResult = await readConsent(consentPath);
  if (consentResult.status === 'missing') return { status: 'not_installed' };
  if (consentResult.status === 'invalid') return { status: 'invalid' };
  const { consent } = consentResult;
  let manifest;
  try {
    manifest = await readManifest(packagePath);
  } catch (error) {
    if (error instanceof PackageError) return { status: 'invalid' };
    throw error;
  }
  if (!isUiManifest(manifest)) return { status: 'not_approved' };
  if (
    consent.approvedReleaseDigest !== manifest.releaseDigest ||
    consent.approvedVersion !== manifest.version ||
    consent.installerGrantDigest !== installerGrantDigest(manifest, consent.approvedBy)
  ) {
    return { status: 'not_approved', manifest };
  }
  if (!consent.enabled) return { status: 'disabled', manifest, consent };
  return { status: 'approved', manifest, consent };
};
