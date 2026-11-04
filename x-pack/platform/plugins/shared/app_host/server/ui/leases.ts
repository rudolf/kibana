/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { UI_LIMITS } from '../../common/ui_protocol';
import type { UiScope } from '../../common/ui_protocol';

/** Everything a lease is bound to; compared on every execute. */
export interface LeaseBinding {
  readonly principal: string;
  readonly userName: string;
  readonly spaceId: string;
  readonly appId: string;
  readonly releaseDigest: string;
  readonly version: string;
  readonly scopes: readonly UiScope[];
  readonly indices: readonly string[];
  readonly dashboardIds: readonly string[];
}

export interface Lease {
  readonly id: string;
  readonly binding: LeaseBinding;
  readonly expiresAt: number;
  readonly abort: AbortController;
  operations: number;
  inFlight: number;
}

const hash = (secret: string): Buffer => createHash('sha256').update(secret, 'utf8').digest();

interface StoredLease extends Lease {
  readonly secretHash: Buffer;
}

export type LeaseLookup =
  | { readonly status: 'ok'; readonly lease: Lease }
  | { readonly status: 'unknown' | 'bad_secret' | 'expired' };

/**
 * In-memory, single-node lease store. The random 32-byte secret is returned to the parent once and
 * stored only as a SHA-256 hash (compared in constant time). Caps: 32 active leases globally and 4
 * per principal; 5-minute TTL.
 */
export class LeaseStore {
  readonly #leases = new Map<string, StoredLease>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  public get size(): number {
    this.#purge();
    return this.#leases.size;
  }

  create(
    binding: LeaseBinding
  ): { leaseId: string; secret: string; expiresAt: number } | { error: 'lease_limit' } {
    this.#purge();
    const forPrincipal = [...this.#leases.values()].filter(
      (lease) => lease.binding.principal === binding.principal
    ).length;
    if (
      this.#leases.size >= UI_LIMITS.leasesGlobal ||
      forPrincipal >= UI_LIMITS.leasesPerPrincipal
    ) {
      return { error: 'lease_limit' };
    }
    const leaseId = randomBytes(24).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = this.#now() + UI_LIMITS.leaseTtlMs;
    this.#leases.set(leaseId, {
      id: leaseId,
      binding,
      expiresAt,
      abort: new AbortController(),
      operations: 0,
      inFlight: 0,
      secretHash: hash(secret),
    });
    return { leaseId, secret, expiresAt };
  }

  lookup(leaseId: string, secret: string): LeaseLookup {
    const lease = this.#leases.get(leaseId);
    if (!lease) return { status: 'unknown' };
    if (!timingSafeEqual(hash(secret), lease.secretHash)) return { status: 'bad_secret' };
    if (this.#now() >= lease.expiresAt) {
      this.revoke(leaseId);
      return { status: 'expired' };
    }
    return { status: 'ok', lease };
  }

  /** Aborts in-flight work and forgets the lease. Idempotent. */
  revoke(leaseId: string): void {
    const lease = this.#leases.get(leaseId);
    if (!lease) return;
    lease.abort.abort();
    this.#leases.delete(leaseId);
  }

  #purge(): void {
    const now = this.#now();
    for (const [id, lease] of this.#leases) if (now >= lease.expiresAt) this.revoke(id);
  }
}
