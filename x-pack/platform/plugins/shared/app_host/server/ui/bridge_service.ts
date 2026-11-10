/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { randomUUID } from 'node:crypto';
import type { ElasticsearchClient, HttpSelfScopedClient } from '@kbn/core/server';
import { INSTALLED_APP_ID } from '../../common';
import { BRIDGE_V1_CAPABILITIES } from '../../common/ui_contract';
import type { BridgeErrorCode, CreateSessionResponse, UiOperation } from '../../common/ui_protocol';
import { UI_LIMITS, isHex64, parseUiOperation } from '../../common/ui_protocol';
import type { AppRunner, SummaryOutcome } from '../app_runner';
import type { UiAppManifest } from '../package/manifest_schema';
import { HostError } from '../remote/host_error';
import { SearchCapability } from '../remote/search_capability';
import { parseSearchInput } from '../search_input';
import { appKeyRequest, type AppKey, type AppKeyRequest } from './app_key';
import type { AuditReason, BridgeAuditEvent, BridgeAuditLogger } from './audit';
import { CapabilityRegistry } from './capability_registry';
import { readUiReleaseState, type UiReleaseState } from './consent';
import { readDashboardPreview } from './dashboard_preview';
import { getDataView, listDataViews } from './data_views';
import { runEsql } from './esql';
import { SessionHandles, type SessionPayload } from './session_handle';

/** Clients that authenticate as one app session key, never as the viewer's own session. */
export interface KeyScopedClients {
  readonly esClient: ElasticsearchClient;
  readonly selfClient: HttpSelfScopedClient;
}

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
  /** Grants a key from the viewer's own credentials; null when API keys are unavailable. */
  readonly grantKey: (request: AppKeyRequest) => Promise<AppKey | null>;
  /** Invalidates one key by id as Kibana's internal user (cleanup of a key that is never issued). */
  readonly invalidateKey: (id: string) => Promise<void>;
  readonly asKey: (key: AppKey) => KeyScopedClients;
  /** Absolute pathname a self call to `path` must hit (server base path, default space). */
  readonly selfPathname: (path: string) => string;
}

export interface ServiceResponse {
  readonly status: number;
  readonly body:
    | CreateSessionResponse
    | { readonly ok: true; readonly result: Record<string, unknown> }
    | { readonly ok: false; readonly code: BridgeErrorCode };
}

const STATUS: Record<BridgeErrorCode, number> = {
  app_denied: 403,
  app_unavailable: 502,
  app_stale: 409,
  app_disabled: 403,
  // Never 401: Kibana's browser client treats 401 as an expired *Kibana* session.
  app_expired: 403,
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
  readonly session: SessionPayload;
  readonly app: BridgeAuditEvent['app'];
  readonly clients: KeyScopedClients;
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
    case 'aborted':
      return { ok: false, code: 'app_unavailable', reason: 'aborted' };
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

/** A session's lifecycle refusal: the public code and its audit reason. */
interface LifecycleRefusal {
  readonly code: 'app_disabled' | 'app_stale';
  readonly reason: AuditReason;
}

/**
 * Lifecycle authorization of a session against one state read: enabled, the approved release it
 * was minted for, and the approval generation it carries. Undefined when the session is current.
 */
const lifecycleRefusal = (
  state: UiReleaseState,
  session: SessionPayload
): LifecycleRefusal | undefined => {
  if (state.status === 'disabled') return { code: 'app_disabled', reason: 'disabled' };
  if (state.status !== 'approved') return { code: 'app_stale', reason: 'not_approved' };
  const { manifest, consent } = state;
  if (manifest.releaseDigest !== session.release || manifest.id !== session.app) {
    return { code: 'app_stale', reason: 'stale_release' };
  }
  // Disabled, uninstalled or re-approved since mint: refused forever, whether or not the key's
  // invalidation in Elasticsearch succeeded (that is cleanup).
  if (consent.generation !== session.generation) {
    return { code: 'app_stale', reason: 'stale_generation' };
  }
  return undefined;
};

/** Audit reason of one backend HostEs callback, from the capability's outcome reason. */
const callbackAuditReason = (reason: string): AuditReason => {
  if (reason === 'ok') return 'ok';
  if (reason === 'es_forbidden' || reason === 'index_not_granted') return 'native_denied';
  const lifecycle: readonly string[] = [
    'disabled',
    'not_approved',
    'stale_release',
    'stale_generation',
  ];
  return lifecycle.includes(reason) ? (reason as AuditReason) : 'native_failed';
};

/** Reuses one state read for at most `maxAgeMs`; a failed read is never cached. */
const cachedState = (
  read: () => Promise<UiReleaseState>,
  maxAgeMs: number,
  now: () => number
): (() => Promise<UiReleaseState>) => {
  let readAt = -Infinity;
  let value: Promise<UiReleaseState> | undefined;
  return () => {
    if (!value || now() - readAt >= maxAgeMs) {
      readAt = now();
      const pending = read();
      value = pending;
      pending.catch(() => {
        if (value === pending) value = undefined;
      });
    }
    return value;
  };
};

const appOf = (manifest: UiAppManifest, apiKeyId?: string): BridgeAuditEvent['app'] => ({
  id: manifest.id,
  version: manifest.version,
  releaseDigest: manifest.releaseDigest,
  apiKeyId,
});

/**
 * Server half of the bridge. The app session is a restricted API key minted on consent from the
 * viewer's credentials and the approved manifest's role descriptor; the browser only ever holds an
 * encrypted handle to it. Every operation runs as that key, so Elasticsearch and Kibana's native
 * authorization enforce viewer ∩ app. The checks here are input validation and lifecycle only.
 */
export class BridgeService {
  readonly #audit: BridgeAuditLogger;
  readonly #handles: SessionHandles;
  readonly #registry: CapabilityRegistry<OperationHandler>;
  readonly #readState: () => Promise<UiReleaseState>;
  readonly #cachedState: () => Promise<UiReleaseState>;
  readonly #now: () => number;
  readonly #skipInputSchema: boolean;

  constructor({
    packagePath,
    consentPath,
    runner,
    audit,
    handleEncryptionKey,
    skipInputSchema = false,
    now = Date.now,
    readState,
  }: {
    readonly packagePath: string;
    readonly consentPath: string | undefined;
    readonly runner: Pick<AppRunner, 'runSummary'>;
    readonly audit: BridgeAuditLogger;
    readonly handleEncryptionKey: string;
    /** K1 fault injection (dev-only config): skip scope, index and dashboard-id input checks. */
    readonly skipInputSchema?: boolean;
    readonly now?: () => number;
    readonly readState?: () => Promise<UiReleaseState>;
  }) {
    this.#audit = audit;
    this.#now = now;
    this.#skipInputSchema = skipInputSchema;
    this.#handles = new SessionHandles(handleEncryptionKey, now);
    this.#readState = readState ?? (() => readUiReleaseState(packagePath, consentPath));
    this.#cachedState = cachedState(this.#readState, UI_LIMITS.stateCacheMs, now);
    this.#registry = new CapabilityRegistry<OperationHandler>();
    this.#registry.register(
      descriptor('app.summary'),
      async ({ session, app, clients, caller, signal, correlationId }) =>
        summaryOutcome(
          await runner.runSummary(session.app, clients.esClient, signal, {
            expectedReleaseDigest: session.release,
            // Each HostEs callback rechecks the session's lifecycle, as execute does: an invocation
            // held open across a disable or a generation change cannot start new searches.
            authorizeCallback: async () => (await this.#lifecycle(session)).refusal,
            // S9: Worker-path HostEs reads inside app.summary are attributed with this correlation id.
            searchObserver: (outcome, reason) =>
              this.#record(
                app,
                caller,
                'es.search',
                outcome,
                callbackAuditReason(reason),
                correlationId,
                'app.summary'
              ),
          })
        )
    );
    this.#registry.register(descriptor('es.search'), async ({ operation, clients, signal }) => {
      if (operation.op !== 'es.search') {
        return { ok: false, code: 'app_denied', reason: 'invalid_operation' };
      }
      const capability = new SearchCapability(clients.esClient, {
        anyIndex: this.#skipInputSchema,
      });
      const onAbort = () => capability.revoke();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await capability.search({ ...operation.params });
        return { ok: true, result: { total: result.total, records: [...result.records] } };
      } catch (error) {
        if (error instanceof HostError) {
          if (error.code === 'es_forbidden') {
            return { ok: false, code: 'app_denied', reason: 'native_denied' };
          }
          if (error.code === 'index_not_granted' || error.code === 'invalid_search') {
            return { ok: false, code: 'app_denied', reason: 'resource_not_granted' };
          }
          if (error.code === 'host_revoked') {
            return { ok: false, code: 'app_unavailable', reason: 'aborted' };
          }
        }
        return { ok: false, code: 'app_unavailable', reason: 'native_failed' };
      } finally {
        signal.removeEventListener('abort', onAbort);
        capability.revoke();
      }
    });
    this.#registry.register(
      descriptor('kibana.dashboard.read'),
      async ({ operation, clients, caller, signal }) => {
        if (operation.op !== 'kibana.dashboard.read') {
          return { ok: false, code: 'app_denied', reason: 'invalid_operation' };
        }
        const { id } = operation.params;
        const outcome = await readDashboardPreview(
          clients.selfClient,
          id,
          caller.selfPathname(`/api/dashboards/${encodeURIComponent(id)}`),
          signal
        );
        return outcome.ok ? { ok: true, result: { ...outcome.result } } : outcome;
      }
    );
    this.#registry.register(
      descriptor('kibana.dataViews.read'),
      async ({ operation, clients, caller, signal }) => {
        if (operation.op !== 'kibana.dataViews.read') {
          return { ok: false, code: 'app_denied', reason: 'invalid_operation' };
        }
        const { id } = operation.params;
        const outcome =
          id === undefined
            ? await listDataViews(clients.selfClient, caller.selfPathname, signal)
            : await getDataView(clients.selfClient, id, caller.selfPathname, signal);
        return outcome.ok ? { ok: true, result: { ...outcome.result } } : outcome;
      }
    );
    this.#registry.register(descriptor('es.esql'), async ({ operation, clients, signal }) => {
      if (operation.op !== 'es.esql') {
        return { ok: false, code: 'app_denied', reason: 'invalid_operation' };
      }
      const outcome = await runEsql(clients.esClient, operation.params.query, signal);
      return outcome.ok ? { ok: true, result: { ...outcome.result } } : outcome;
    });
    this.#registry.freeze();
  }

  /** Capability ids served by the execute route (closed set). */
  capabilities(): string[] {
    return this.#registry.ids();
  }

  #record(
    app: BridgeAuditEvent['app'],
    caller: CallerContext,
    capability: string,
    outcome: 'success' | 'failure',
    reason: AuditReason,
    correlationId: string,
    via: BridgeAuditEvent['via'] = 'bridge'
  ): void {
    this.#audit.log({
      app,
      userName: caller.userName,
      spaceId: caller.spaceId,
      capability,
      outcome,
      reason,
      correlationId,
      via,
    });
  }

  /**
   * The session's current lifecycle state. A cached read (≤ 2 s) may only accept; any refusal is
   * decided on a fresh read, so a handle minted right after a state change is not refused as stale.
   */
  async #lifecycle(
    session: SessionPayload
  ): Promise<{ state: UiReleaseState; refusal: LifecycleRefusal | undefined }> {
    const cached = await this.#cachedState();
    if (!lifecycleRefusal(cached, session)) return { state: cached, refusal: undefined };
    const state = await this.#readState();
    return { state, refusal: lifecycleRefusal(state, session) };
  }

  /** Common pre-checks for session creation and execution; fail closed before any I/O. */
  #precheck(caller: CallerContext): { code: BridgeErrorCode; reason: AuditReason } | undefined {
    if (!caller.principal) return { code: 'app_denied', reason: 'principal_mismatch' };
    if (!caller.originOk) return { code: 'app_denied', reason: 'origin_mismatch' };
    if (caller.runAs) return { code: 'app_denied', reason: 'run_as_refused' };
    if (!caller.isDefaultSpace) return { code: 'app_denied', reason: 'non_default_space' };
    return undefined;
  }

  /** Mints one restricted API key for (viewer, space, approved release) and seals its handle. */
  async createSession(
    caller: CallerContext,
    appId: string,
    releaseDigest: string
  ): Promise<ServiceResponse> {
    const correlationId = randomUUID();
    const deny = (
      code: BridgeErrorCode,
      reason: AuditReason,
      app?: BridgeAuditEvent['app']
    ): ServiceResponse => {
      this.#record(app, caller, 'session.create', 'failure', reason, correlationId, 'session');
      return failure(code);
    };
    const pre = this.#precheck(caller);
    if (pre) return deny(pre.code, pre.reason);
    const state = await this.#readState();
    if (state.status === 'disabled') return deny('app_disabled', 'disabled');
    if (state.status !== 'approved') return deny('app_denied', 'not_approved');
    const { manifest } = state;
    if (appId !== manifest.id || !isHex64(releaseDigest)) return deny('app_denied', 'app_mismatch');
    if (releaseDigest !== manifest.releaseDigest) return deny('app_stale', 'stale_release');
    let key: AppKey | null;
    try {
      key = await caller.grantKey(appKeyRequest(manifest, caller.spaceId));
    } catch {
      key = null;
    }
    if (!key) return deny('app_unavailable', 'mint_failed', appOf(manifest));
    // A disable, uninstall or new approval (and a re-enable after it) may have completed while the
    // grant was in flight, and its name-based invalidation can miss this key. Re-read the state: a
    // key minted across a generation change is invalidated and never issued.
    const after = await this.#readState();
    if (
      after.status !== 'approved' ||
      after.manifest.releaseDigest !== manifest.releaseDigest ||
      after.consent.generation !== state.consent.generation
    ) {
      await caller.invalidateKey(key.id).catch(() => undefined);
      return deny(
        after.status === 'disabled' ? 'app_disabled' : 'app_stale',
        'revoked_during_mint',
        appOf(manifest, key.id)
      );
    }
    const handle = this.#handles.seal({
      id: key.id,
      apiKey: key.apiKey,
      app: manifest.id,
      release: manifest.releaseDigest,
      space: caller.spaceId,
      principal: caller.principal as string,
      generation: state.consent.generation,
      // The key's own expiration starts when Elasticsearch creates it, after this instant.
      exp: this.#now() + UI_LIMITS.sessionTtlMs,
    });
    this.#record(
      appOf(manifest, key.id),
      caller,
      'session.create',
      'success',
      'session_created',
      correlationId,
      'session'
    );
    return { status: 200, body: { handle } };
  }

  async execute(
    caller: CallerContext,
    handle: string,
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
    // 1. Handle integrity, principal/space binding and expiry.
    const opened = this.#handles.open(handle, {
      app: INSTALLED_APP_ID,
      space: caller.spaceId,
      principal: caller.principal as string,
    });
    if (opened.status !== 'ok') {
      // No valid app context: recorded without an app actor.
      const expired = opened.status === 'expired';
      this.#record(
        undefined,
        caller,
        capabilityName,
        'failure',
        expired ? 'expired' : 'bad_handle',
        correlationId
      );
      return failure(expired ? 'app_expired' : 'app_denied');
    }
    const { payload: session } = opened;
    // 2. Enablement, approval and generation (cache may accept; refusals use a fresh read).
    const { state, refusal } = await this.#lifecycle(session);
    const sessionApp: BridgeAuditEvent['app'] =
      state.status === 'approved' || state.status === 'disabled'
        ? appOf(state.manifest, session.id)
        : undefined;
    const deny = (code: BridgeErrorCode, reason: AuditReason): ServiceResponse => {
      this.#record(sessionApp, caller, capabilityName, 'failure', reason, correlationId);
      return failure(code);
    };
    if (refusal) return deny(refusal.code, refusal.reason);
    if (state.status !== 'approved') return deny('app_stale', 'not_approved');
    const { manifest } = state;
    // 3. Input schema only (closed union, scope, exact index and dashboard id; data view id syntax,
    // non-empty ES|QL query). Not authorization: the key's role descriptor and the
    // viewer's own privileges are enforced natively.
    const operation = parseUiOperation(rawOperation);
    if (!operation) return deny('bridge_invalid_request', 'invalid_operation');
    if (!this.#skipInputSchema) {
      if (!(manifest.ui.scopes as readonly string[]).includes(operation.op)) {
        return deny('app_denied', 'scope_not_granted');
      }
      if (operation.op === 'es.search' && !parseSearchInput(operation.params).ok) {
        return deny('app_denied', 'resource_not_granted');
      }
      if (
        operation.op === 'kibana.dashboard.read' &&
        !manifest.permissions.dashboardIds.includes(operation.params.id)
      ) {
        return deny('app_denied', 'resource_not_granted');
      }
    }
    const handler = this.#registry.get(operation.op);
    if (!handler) return deny('bridge_invalid_request', 'invalid_operation');
    // 4. Run as the key; a request abort (client gone) aborts the operation.
    const outcome = await handler({
      operation,
      session,
      app: sessionApp,
      clients: caller.asKey({ id: session.id, apiKey: session.apiKey }),
      caller,
      signal: caller.requestAborted,
      correlationId,
    }).catch(
      (): OperationOutcome => ({ ok: false, code: 'app_unavailable', reason: 'native_failed' })
    );
    if (!outcome.ok) return deny(outcome.code, outcome.reason);
    this.#record(sessionApp, caller, operation.op, 'success', 'ok', correlationId);
    return { status: 200, body: { ok: true, result: outcome.result } };
  }
}
