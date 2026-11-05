/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Everything the sealed handle carries. `apiKey` is the raw key secret: server memory only. */
export interface SessionPayload {
  readonly id: string;
  readonly apiKey: string;
  readonly app: string;
  readonly release: string;
  readonly space: string;
  readonly principal: string;
  /** Approval generation at mint time (see `consentSchema.generation`). */
  readonly generation: string;
  readonly exp: number;
}

/** The binding the server derives from the current request (never from the handle). */
export interface SessionBinding {
  readonly app: string;
  readonly space: string;
  readonly principal: string;
}

export type OpenedHandle =
  | { readonly status: 'ok'; readonly payload: SessionPayload }
  | { readonly status: 'invalid' | 'expired' };

const IV_BYTES = 12;
const TAG_BYTES = 16;
// `<release digest>.<generation>.<base64url(iv | tag | ciphertext)>`. Digest and generation are
// public and authenticated through the AAD; they are in clear so that a release or generation change
// is reported as stale, not tampered.
const HANDLE = /^([0-9a-f]{64})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{40,1024})$/;

const aad = (
  { app, space, principal }: SessionBinding,
  release: string,
  generation: string
): Buffer => Buffer.from(`${app}|${release}|${space}|${principal}|${generation}`, 'utf8');

const isPayload = (value: unknown): value is SessionPayload => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    ['id', 'apiKey', 'app', 'release', 'space', 'principal'].every(
      (key) => typeof record[key] === 'string'
    ) &&
    typeof record.exp === 'number' &&
    typeof record.generation === 'string'
  );
};

/**
 * Stateless app session handle: AES-256-GCM over the payload with AAD
 * `app|release|space|principal|generation`.
 * Any node with the same `xpack.app_host.handleEncryptionKey` can open it; nothing is stored. A
 * tampered handle or one presented by another principal or in another space fails authentication.
 */
export class SessionHandles {
  readonly #key: Buffer;
  readonly #now: () => number;

  constructor(secret: string, now: () => number = Date.now) {
    this.#key = createHash('sha256').update(secret, 'utf8').digest();
    this.#now = now;
  }

  seal(payload: SessionPayload): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(payload, payload.release, payload.generation));
    const sealed = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const encoded = Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
    return `${payload.release}.${payload.generation}.${encoded}`;
  }

  open(handle: string, binding: SessionBinding): OpenedHandle {
    const match = HANDLE.exec(handle);
    if (!match) return { status: 'invalid' };
    const [, release, generation, encoded] = match;
    const bytes = Buffer.from(encoded, 'base64url');
    // Canonical encoding only: trailing junk that base64 decoding would silently drop is refused.
    if (bytes.length <= IV_BYTES + TAG_BYTES || bytes.toString('base64url') !== encoded) {
      return { status: 'invalid' };
    }
    let payload: unknown;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(0, IV_BYTES), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad(binding, release, generation));
      decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const plain = Buffer.concat([
        decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
      payload = JSON.parse(plain.toString('utf8'));
    } catch {
      return { status: 'invalid' };
    }
    if (
      !isPayload(payload) ||
      payload.app !== binding.app ||
      payload.release !== release ||
      payload.generation !== generation ||
      payload.space !== binding.space ||
      payload.principal !== binding.principal
    ) {
      return { status: 'invalid' };
    }
    if (this.#now() >= payload.exp) return { status: 'expired' };
    return { status: 'ok', payload };
  }
}
