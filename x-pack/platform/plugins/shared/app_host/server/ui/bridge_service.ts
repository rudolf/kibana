/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { randomUUID } from 'node:crypto';
import type { ElasticsearchClient, HttpSelfScopedClient } from '@kbn/core/server';
import { BRIDGE_V1_CAPABILITIES } from '../../common/ui_contract';
import type {
  BridgeErrorCode,
  CreateLeaseResponse,
  UiOperation,
  UiScope,
} from '../../common/ui_protocol';
import { UI_LIMITS, isHex64, parseUiOperation } from '../../common/ui_protocol';
import type { AppRunner, SummaryOutcome } from '../app_runner';
import { evaluateSearch } from '../grant_evaluator';
import { HostError } from '../remote/host_error';
import { SearchCapability } from '../remote/search_capability';
import type { AuditReason, BridgeAuditLogger } from './audit';
import { OperationBuckets, Semaphore } from './budgets';
import { CapabilityRegistry } from './capability_registry';
import { readUiReleaseState, type UiReleaseState } from './consent';
import { readDashboardPreview } from './dashboard_preview';
import { LeaseStore, type Lease, type LeaseBinding } from './leases';

/** Per-request facts derived by the route from the authenticated scoped request. */
export interface CallerContext {
  /** Stable principal key (realm + username); undefined when unauthenticated. */
  readonly principal: string | undefined;
  readonly userName: string | undefined;
  readonly spaceId: string;
  readonly isDefaultSpace: boolean;
  /** Exact same-origin `Origin` header matched the configured Kibana origin. */
  readonly originOk: boolean;
  /** An `es-security-runas-user` header or run_as parameter was present. */
  readonly runAs: boolean;
  readonly requestAborted: AbortSignal;
  readonly esClient: () => ElasticsearchClient;
  readonly selfClient: () => HttpSelfScopedClient;
  /** Absolute pathname the dashboard self call must hit (server base path, default space). */
  readonly dashboardPathname: (id: string) => string;
}

export interface ServiceResponse {
  readonly status: number;
  readonly body:
    | CreateLeaseResponse
    | { readonly ok: true; readonly result: Record<string, unknown> }
    | { readonly ok: false; readonly code: BridgeErrorCode }
    | { readonly revoked: true };
}

const STATUS: Record<BridgeErrorCode, number> = {
  app_denied: 403,
  app_unavailable: 502,
  app_stale: 409,
  app_disabled: 403,
  // Never 401: Kibana's browser client treats 401 as an expired *Kibana* session.
  app_expired: 403,
  app_rate_limited: 429,
  app_timeout: 504,
  app_cpu_limit: 502,
  bridge_invalid_request: 400,
  bridge_protocol_error: 400,
};

const failure = (code: BridgeErrorCode): ServiceResponse => ({
  status: STATUS[code],
  body: { ok: false, code },
});

type OperationOutcome =
  | { readonly ok: true; readonly result: Record<string, unknown> }
  | { readonly ok: false; readonly code: BridgeErrorCode; readonly reason: AuditReason };

interface OperationInput {
  readonly operation: UiOperation;
  readonly lease: Lease;
  readonly caller: CallerContext;
  readonly signal: AbortSignal;
  readonly correlationId: string;
}

type OperationHandler = (input: OperationInput) => Promise<OperationOutcome>;

const descriptor = (id: string) => {
  const found = BRIDGE_V1_CAPABILITIES.find((capability) => capability.id === id);
  if (!found) throw new Error(`Unknown capability ${id}`);
  return found;
};

const summaryOutcome = (outcome: SummaryOutcome): OperationOutcome => {
  switch (outcome.status) {
    case 'ok':
      return { ok: true, result: { ...outcome.body } };
    case 'es_forbidden':
      return { ok: false, code: 'app_denied', reason: 'native_denied' };
    case 'deadline':
    case 'aborted':
      return { ok: false, code: 'app_timeout', reason: 'deadline' };
    case 'busy':
      return { ok: false, code: 'app_rate_limited', reason: 'process_limit' };
    case 'release_mismatch':
      return { ok: false, code: 'app_stale', reason: 'stale_release' };
    case 'remote_error':
      return outcome.code === 'app_cpu_limit'
        ? { ok: false, code: 'app_cpu_limit', reason: 'cpu_limit' }
        : { ok: false, code: 'app_unavailable', reason: 'native_failed' };
    default:
      return { ok: false, code: 'app_unavailable', reason: 'native_failed' };
  }
};

/**
 * Server half of the bridge: lease creation and the fixed execute union. Every check is repeated
 * here regardless of what the parent checked; the parent is not a security boundary. App identity
 * comes from the lease and the installed registry only (an `x-kbn-app-id` header is ignored).
 */
export class BridgeService {
  readonly #audit: BridgeAuditLogger;
  readonly #leases: LeaseStore;
  readonly #buckets: OperationBuckets;
  readonly #semaphore: Semaphore;
  readonly #registry: CapabilityRegistry<OperationHandler>;
  readonly #readState: () => Promise<UiReleaseState>;

  constructor({
    packagePath,
    consentPath,
    runner,
    audit,
    now = Date.now,
    readState,
  }: {
    readonly packagePath: string;
    readonly consentPath: string | undefined;
    readonly runner: Pick<AppRunner, 'runSummary'>;
    readonly audit: BridgeAuditLogger;
    readonly now?: () => number;
    readonly readState?: () => Promise<UiReleaseState>;
  }) {
    this.#audit = audit;
    this.#leases = new LeaseStore(now);
    this.#buckets = new OperationBuckets(now);
    this.#semaphore = new Semaphore(UI_LIMITS.uiServerOperationsPerProcess);
    this.#readState = readState ?? (() => readUiReleaseState(packagePath, consentPath));
    this.#registry = new CapabilityRegistry<OperationHandler>();
    this.#registry.register(
      descriptor('app.summary'),
      async ({ lease, caller, signal, correlationId }) =>
        summaryOutcome(
          await runner.runSummary(lease.binding.appId, caller.esClient(), signal, {
            expectedReleaseDigest: lease.binding.releaseDigest,
            // S9: Worker-path HostEs reads inside app.summary are attributed with this correlation id.
            searchObserver: (outcome, reason) =>
              this.#record(
                lease.binding,
                caller,
                'es.search',
                outcome,
                reason === 'ok'
                  ? 'ok'
                  : reason === 'es_forbidden' || reason === 'index_not_granted'
                  ? 'native_denied'
                  : 'native_failed',
                correlationId,
                'app.summary'
              ),
          })
        )
    );
    this.#registry.register(
      descriptor('es.search'),
      async ({ operation, lease, caller, signal }) => {
        if (operation.op !== 'es.search')
          return { ok: false, code: 'app_denied', reason: 'invalid_operation' };
        const capability = new SearchCapability(caller.esClient(), {
          appId: lease.binding.appId,
          indices: lease.binding.indices,
        });
        const onAbort = () => capability.revoke();
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          const result = await capability.search({ ...operation.params });
          return { ok: true, result: { total: result.total, records: [...result.records] } };
        } catch (error) {
          if (error instanceof HostError) {
            if (error.code === 'es_forbidden' || error.code === 'index_not_granted') {
              return { ok: false, code: 'app_denied', reason: 'native_denied' };
            }
            if (error.code === 'host_revoked')
              return { ok: false, code: 'app_timeout', reason: 'deadline' };
          }
          return { ok: false, code: 'app_unavailable', reason: 'native_failed' };
        } finally {
          signal.removeEventListener('abort', onAbort);
          capability.revoke();
        }
      }
    );
    this.#registry.register(
      descriptor('kibana.dashboard.read'),
      async ({ operation, caller, signal }) => {
        if (operation.op !== 'kibana.dashboard.read') {
          return { ok: false, code: 'app_denied', reason: 'invalid_operation' };
        }
        const { id } = operation.params;
        const outcome = await readDashboardPreview(
          caller.selfClient(),
          id,
          caller.dashboardPathname(id),
          signal
        );
        return outcome.ok ? { ok: true, result: { ...outcome.result } } : outcome;
      }
    );
    this.#registry.freeze();
  }

  /** Capability ids served by the execute route (closed set). */
  capabilities(): string[] {
    return this.#registry.ids();
  }

  public get activeLeases(): number {
    return this.#leases.size;
  }

  #record(
    binding: LeaseBinding | undefined,
    caller: CallerContext,
    capability: string,
    outcome: 'success' | 'failure',
    reason: AuditReason,
    correlationId: string,
    via: 'bridge' | 'app.summary' | 'lease' = 'bridge'
  ): void {
    this.#audit.log({
      app: binding
        ? { id: binding.appId, version: binding.version, releaseDigest: binding.releaseDigest }
        : undefined,
      userName: caller.userName,
      spaceId: caller.spaceId,
      capability,
      outcome,
      reason,
      correlationId,
      via,
    });
  }

  /** Common pre-checks for lease creation and execution; fail closed before any service I/O. */
  #precheck(caller: CallerContext): { code: BridgeErrorCode; reason: AuditReason } | undefined {
    if (!caller.principal) return { code: 'app_denied', reason: 'principal_mismatch' };
    if (!caller.originOk) return { code: 'app_denied', reason: 'origin_mismatch' };
    if (caller.runAs) return { code: 'app_denied', reason: 'run_as_refused' };
    if (!caller.isDefaultSpace) return { code: 'app_denied', reason: 'non_default_space' };
    return undefined;
  }

  async createLease(
    caller: CallerContext,
    appId: string,
    releaseDigest: string
  ): Promise<ServiceResponse> {
    const correlationId = randomUUID();
    const pre = this.#precheck(caller);
    if (pre) {
      this.#record(
        undefined,
        caller,
        'lease.create',
        'failure',
        pre.reason,
        correlationId,
        'lease'
      );
      return failure(pre.code);
    }
    const state = await this.#readState();
    if (state.status !== 'approved') {
      this.#record(
        undefined,
        caller,
        'lease.create',
        'failure',
        state.status === 'disabled' ? 'disabled' : 'not_approved',
        correlationId,
        'lease'
      );
      return failure(state.status === 'disabled' ? 'app_disabled' : 'app_denied');
    }
    const { manifest } = state;
    if (
      appId !== manifest.id ||
      !isHex64(releaseDigest) ||
      releaseDigest !== manifest.releaseDigest
    ) {
      this.#record(
        undefined,
        caller,
        'lease.create',
        'failure',
        'app_mismatch',
        correlationId,
        'lease'
      );
      return failure(releaseDigest === manifest.releaseDigest ? 'app_denied' : 'app_stale');
    }
    const binding: LeaseBinding = {
      principal: caller.principal as string,
      userName: caller.userName ?? '',
      spaceId: caller.spaceId,
      appId: manifest.id,
      releaseDigest: manifest.releaseDigest,
      version: manifest.version,
      scopes: manifest.ui.scopes as UiScope[],
      indices: [...manifest.permissions.indices],
      dashboardIds: [...manifest.permissions.dashboardIds],
    };
    const created = this.#leases.create(binding);
    if ('error' in created) {
      this.#record(
        binding,
        caller,
        'lease.create',
        'failure',
        'lease_limit',
        correlationId,
        'lease'
      );
      return failure('app_rate_limited');
    }
    this.#record(
      binding,
      caller,
      'lease.create',
      'success',
      'lease_created',
      correlationId,
      'lease'
    );
    return { status: 200, body: created };
  }

  revokeLease(caller: CallerContext, leaseId: string, secret: string): ServiceResponse {
    const lookup = this.#leases.lookup(leaseId, secret);
    if (lookup.status === 'ok' && lookup.lease.binding.principal === caller.principal) {
      this.#leases.revoke(leaseId);
      this.#record(
        lookup.lease.binding,
        caller,
        'lease.revoke',
        'success',
        'lease_revoked',
        randomUUID(),
        'lease'
      );
    }
    // Uniform response: no oracle for lease existence.
    return { status: 200, body: { revoked: true } };
  }

  async execute(
    caller: CallerContext,
    leaseId: string,
    secret: string,
    rawOperation: unknown
  ): Promise<ServiceResponse> {
    const correlationId = randomUUID();
    const capabilityName =
      typeof rawOperation === 'object' && rawOperation !== null && 'op' in rawOperation
        ? String((rawOperation as { op: unknown }).op).slice(0, 64)
        : 'unknown';
    const pre = this.#precheck(caller);
    if (pre) {
      this.#record(undefined, caller, capabilityName, 'failure', pre.reason, correlationId);
      return failure(pre.code);
    }
    const lookup = this.#leases.lookup(leaseId, secret);
    if (lookup.status !== 'ok') {
      // No valid app context: recorded as an authentication/protocol failure without an app actor.
      this.#record(
        undefined,
        caller,
        capabilityName,
        'failure',
        lookup.status === 'expired'
          ? 'expired'
          : lookup.status === 'bad_secret'
          ? 'bad_secret'
          : 'unknown_lease',
        correlationId
      );
      return failure(lookup.status === 'expired' ? 'app_expired' : 'app_denied');
    }
    const { lease } = lookup;
    const { binding } = lease;
    const deny = (code: BridgeErrorCode, reason: AuditReason, revoke = false): ServiceResponse => {
      if (revoke) this.#leases.revoke(lease.id);
      this.#record(binding, caller, capabilityName, 'failure', reason, correlationId);
      return failure(code);
    };
    if (binding.principal !== caller.principal || binding.spaceId !== caller.spaceId) {
      return deny('app_denied', 'principal_mismatch');
    }
    const state = await this.#readState();
    const releaseCheck = this.#checkRelease(state, binding);
    if (releaseCheck) return deny(releaseCheck.code, releaseCheck.reason, true);
    const operation = parseUiOperation(rawOperation);
    if (!operation) return deny('bridge_invalid_request', 'invalid_operation');
    if (!binding.scopes.includes(operation.op)) return deny('app_denied', 'scope_not_granted');
    // Resource selectors are checked against the lease grant before any lookup or I/O.
    if (operation.op === 'es.search') {
      const decision = evaluateSearch(
        { appId: binding.appId, indices: binding.indices },
        operation.params
      );
      if (!decision.allowed) return deny('app_denied', 'resource_not_granted');
    }
    if (
      operation.op === 'kibana.dashboard.read' &&
      !binding.dashboardIds.includes(operation.params.id)
    ) {
      return deny('app_denied', 'resource_not_granted');
    }
    // Budgets: checked synchronously before awaiting any work.
    if (lease.operations >= UI_LIMITS.operationsPerLease)
      return deny('app_rate_limited', 'lease_budget');
    if (lease.inFlight >= UI_LIMITS.inFlightPerLease)
      return deny('app_rate_limited', 'in_flight_limit');
    if (!this.#buckets.tryTake(binding.appId, binding.principal, binding.spaceId)) {
      return deny('app_rate_limited', 'rate_limited');
    }
    const releaseSlot = this.#semaphore.tryAcquire();
    if (!releaseSlot) return deny('app_rate_limited', 'process_limit');
    const handler = this.#registry.get(operation.op);
    if (!handler) {
      releaseSlot();
      return deny('bridge_invalid_request', 'invalid_operation');
    }
    lease.operations += 1;
    lease.inFlight += 1;
    // One signal for the operation: lease revocation, request abort or the 5 s deadline.
    const controller = new AbortController();
    const abort = () => controller.abort();
    lease.abort.signal.addEventListener('abort', abort, { once: true });
    caller.requestAborted.addEventListener('abort', abort, { once: true });
    if (lease.abort.signal.aborted || caller.requestAborted.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<OperationOutcome>((resolve) => {
        timer = setTimeout(() => {
          abort();
          resolve({ ok: false, code: 'app_timeout', reason: 'deadline' });
        }, UI_LIMITS.operationDeadlineMs);
      });
      const outcome = await Promise.race([
        handler({ operation, lease, caller, signal: controller.signal, correlationId }).catch(
          (): OperationOutcome => ({ ok: false, code: 'app_unavailable', reason: 'native_failed' })
        ),
        timedOut,
      ]);
      // Recheck enablement and release before returning data; revocation suppresses results.
      const after = this.#checkRelease(await this.#readState(), binding);
      if (after) return deny(after.code, after.reason, true);
      if (lease.abort.signal.aborted) return deny('app_disabled', 'revoked_during_call');
      if (!outcome.ok) return deny(outcome.code, outcome.reason);
      if (Buffer.byteLength(JSON.stringify(outcome.result)) > UI_LIMITS.resultBytes) {
        return deny('app_unavailable', 'invalid_result');
      }
      this.#record(binding, caller, operation.op, 'success', 'ok', correlationId);
      return { status: 200, body: { ok: true, result: outcome.result } };
    } finally {
      if (timer) clearTimeout(timer);
      lease.abort.signal.removeEventListener('abort', abort);
      caller.requestAborted.removeEventListener('abort', abort);
      lease.inFlight -= 1;
      releaseSlot();
    }
  }

  #checkRelease(
    state: UiReleaseState,
    binding: LeaseBinding
  ): { code: BridgeErrorCode; reason: AuditReason } | undefined {
    if (state.status === 'disabled') return { code: 'app_disabled', reason: 'disabled' };
    if (state.status !== 'approved') return { code: 'app_stale', reason: 'not_approved' };
    if (
      state.manifest.releaseDigest !== binding.releaseDigest ||
      state.manifest.id !== binding.appId
    ) {
      return { code: 'app_stale', reason: 'stale_release' };
    }
    return undefined;
  }
}
