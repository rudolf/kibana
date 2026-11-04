/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export type PackageErrorCode =
  | 'package_unavailable'
  | 'manifest_too_large'
  | 'manifest_invalid'
  | 'bundle_unavailable'
  | 'bundle_too_large'
  | 'digest_mismatch'
  | 'ui_invalid'
  | 'release_digest_mismatch'
  | 'scope_map_mismatch'
  | 'ui_bundle_unavailable'
  | 'ui_bundle_too_large'
  | 'ui_digest_mismatch';

/** Raised when the installed package cannot be trusted; the host fails closed before any remote call. */
export class PackageError extends Error {
  readonly code: PackageErrorCode;

  constructor(code: PackageErrorCode) {
    super(`App package rejected: ${code}`);
    this.name = 'PackageError';
    this.code = code;
  }
}
