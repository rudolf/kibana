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
  expiryTimer?: ReturnType<typeof setTimeout>;
}

export type LeaseLookup =
  | { readonly status: 'ok'; readonly lease: Lease }
  | { readonly status: 'unknown' | 'bad_secret' | 'expired' };

/**
 * In-memory, single-node lease store. The random 32-byte secret is returned to the parent once and
 * stored only as a SHA-256 hash (compared in constant time). Caps: 32 active leases globally and 4
 * per principal; 5-minute TTL. Expiry is enforced by a timer as well as on lookup, so a lease
 * that expires while a read is pending aborts that read without waiting for another request.
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
  ):
    | { leaseId: string; secret: string; expiresAt: number; ttlMs: number }
    | { error: 'lease_limit' } {
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
    const lease: StoredLease = {
      id: leaseId,
      binding,
      expiresAt,
      abort: new AbortController(),
      operations: 0,
      inFlight: 0,
      secretHash: hash(secret),
    };
    this.#leases.set(leaseId, lease);
    this.#scheduleExpiry(lease);
    return { leaseId, secret, expiresAt, ttlMs: UI_LIMITS.leaseTtlMs };
  }

  /** True while the lease is stored and unexpired (checked again before returning data). */
  isLive(lease: Lease): boolean {
    return this.#leases.get(lease.id) === lease && this.#now() < lease.expiresAt;
  }

  /** True once the lease's TTL has passed, whether or not it was already revoked. */
  isExpired(lease: Lease): boolean {
    return this.#now() >= lease.expiresAt;
  }

  #scheduleExpiry(lease: StoredLease): void {
    const delay = Math.max(0, lease.expiresAt - this.#now());
    const timer = setTimeout(() => {
      if (this.#leases.get(lease.id) !== lease) return;
      if (this.#now() >= lease.expiresAt) this.revoke(lease.id);
      else this.#scheduleExpiry(lease);
    }, delay);
    // Never keep the Kibana process alive for a lease timer.
    (timer as { unref?: () => void }).unref?.();
    lease.expiryTimer = timer;
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
    if (lease.expiryTimer) clearTimeout(lease.expiryTimer);
    lease.abort.abort();
    this.#leases.delete(leaseId);
  }

  #purge(): void {
    const now = this.#now();
    for (const [id, lease] of this.#leases) if (now >= lease.expiresAt) this.revoke(id);
  }
}
