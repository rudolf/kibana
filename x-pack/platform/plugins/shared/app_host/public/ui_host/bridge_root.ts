/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RpcTarget } from 'capnweb';
import type {
  BridgeErrorCode,
  UiDashboardPreview,
  UiOperation,
  UiScope,
  UiSearchResult,
  UiSummaryResult,
  UiTheme,
} from '../../common/ui_protocol';
import {
  UI_LIMITS,
  isBridgeErrorCode,
  parseCallAppRouteArgs,
  parseDashboardArgs,
  parseDashboardPreview,
  parseSearchArgs,
  parseSearchResult,
  parseSummaryResult,
} from '../../common/ui_protocol';
import type { BridgeLifecycle } from './bridge_lifecycle';
import { TokenBucket, utf8Bytes } from './port_transport';

export { BridgeLifecycle } from './bridge_lifecycle';

export type ExecuteOutcome =
  | { readonly ok: true; readonly result: Record<string, unknown> }
  | { readonly ok: false; readonly code: BridgeErrorCode };

/** The fixed, host-owned server request for one operation (lease secret stays in its closure). */
export type BridgeExecutor = (
  operation: UiOperation,
  signal: AbortSignal
) => Promise<ExecuteOutcome>;

export interface BridgeGrant {
  readonly scopes: readonly UiScope[];
  readonly dashboardIds: readonly string[];
}

export interface BridgeHooks {
  /** Called synchronously before each method; false terminates (e.g. too many live stubs). */
  readonly beforeCall: () => boolean;
  /** Terminate the session (repeated invalid calls). */
  readonly terminate: (reason: string) => void;
  /** Local-only rejection telemetry (never a server audit event). */
  readonly onLocalRejection?: (method: string, code: BridgeErrorCode) => void;
}

/** A stackless error carrying only a fixed public code. */
export const bridgeError = (code: BridgeErrorCode): Error => {
  const error = new Error(code);
  delete error.stack;
  return error;
};

/** capnweb `onSendError`: only fixed codes and no stacks ever reach the guest. */
export const sanitizeBridgeError = (error: Error): Error =>
  bridgeError(isBridgeErrorCode(error.message) ? error.message : 'app_unavailable');

export const isValidTheme = (theme: UiTheme): boolean => {
  const { mode, colors } = theme;
  if (mode !== 'light' && mode !== 'dark') return false;
  const values = [colors.background, colors.text, colors.border, colors.primary, colors.danger];
  if (!values.every((v) => typeof v === 'string' && v.length <= UI_LIMITS.themeColorLength)) {
    return false;
  }
  return utf8Bytes(JSON.stringify(theme)) <= UI_LIMITS.themeBytes;
};

/**
 * The only object exposed to the guest: exactly four public methods, all state private, plain-data
 * arguments only (functions, stubs, thenables and extra fields are rejected) and never an awaited
 * guest value. Budgets are checked synchronously before any awaited work. The server repeats every
 * check; this class is not the security boundary for server operations.
 */
export class AppBridge extends RpcTarget {
  readonly #grant: BridgeGrant;
  readonly #theme: () => UiTheme;
  readonly #executor: BridgeExecutor | undefined;
  readonly #hooks: BridgeHooks;
  readonly #lifecycle: BridgeLifecycle;
  readonly #operations = new TokenBucket(UI_LIMITS.operationsPerSecond, UI_LIMITS.operationsBurst);
  #operationCount = 0;
  #inFlight = 0;
  #invalidCalls = 0;

  constructor(
    grant: BridgeGrant,
    theme: () => UiTheme,
    executor: BridgeExecutor | undefined,
    hooks: BridgeHooks,
    lifecycle: BridgeLifecycle
  ) {
    super();
    this.#grant = grant;
    this.#theme = theme;
    this.#executor = executor;
    this.#hooks = hooks;
    this.#lifecycle = lifecycle;
  }

  callAppRoute(...args: unknown[]): Promise<UiSummaryResult> {
    const input = args.length === 1 ? parseCallAppRouteArgs(args[0]) : undefined;
    if (!input) return this.#invalid('callAppRoute');
    return this.#run('callAppRoute', 'app.summary', { op: 'app.summary' }, parseSummaryResult);
  }

  search(...args: unknown[]): Promise<UiSearchResult> {
    const input = args.length === 1 ? parseSearchArgs(args[0]) : undefined;
    if (!input) return this.#invalid('search');
    return this.#run(
      'search',
      'es.search',
      { op: 'es.search', params: { index: input.index, size: input.size } },
      parseSearchResult
    );
  }

  getDashboardPreview(...args: unknown[]): Promise<UiDashboardPreview> {
    const input = args.length === 1 ? parseDashboardArgs(args[0]) : undefined;
    if (!input) return this.#invalid('getDashboardPreview');
    // Deny ungranted selectors before any lookup, identically whether or not they exist.
    if (!this.#grant.dashboardIds.includes(input.id)) {
      return this.#reject('getDashboardPreview', 'app_denied');
    }
    return this.#run(
      'getDashboardPreview',
      'kibana.dashboard.read',
      { op: 'kibana.dashboard.read', params: { id: input.id } },
      parseDashboardPreview
    );
  }

  getTheme(...args: unknown[]): Promise<UiTheme> {
    if (args.length !== 0) return this.#invalid('getTheme');
    const { revoked } = this.#lifecycle;
    if (revoked) return this.#reject('getTheme', revoked);
    if (!this.#hooks.beforeCall()) return this.#reject('getTheme', 'bridge_protocol_error');
    const theme = this.#theme();
    if (!isValidTheme(theme)) return this.#reject('getTheme', 'app_unavailable');
    const { mode, colors } = theme;
    return Promise.resolve({
      mode,
      colors: {
        background: colors.background,
        text: colors.text,
        border: colors.border,
        primary: colors.primary,
        danger: colors.danger,
      },
    });
  }

  #invalid<T>(method: string): Promise<T> {
    this.#invalidCalls += 1;
    if (this.#invalidCalls >= UI_LIMITS.invalidCallsBeforeTermination) {
      this.#hooks.terminate('repeated_invalid_calls');
    }
    return this.#reject(method, 'bridge_invalid_request');
  }

  #reject<T>(method: string, code: BridgeErrorCode): Promise<T> {
    this.#hooks.onLocalRejection?.(method, code);
    return Promise.reject(bridgeError(code));
  }

  async #run<T>(
    method: string,
    scope: UiScope,
    operation: UiOperation,
    parse: (result: Record<string, unknown>) => T | undefined
  ): Promise<T> {
    // All checks below are synchronous and happen before anything is awaited.
    const { revoked } = this.#lifecycle;
    if (revoked) return this.#reject(method, revoked);
    if (!this.#hooks.beforeCall()) return this.#reject(method, 'bridge_protocol_error');
    if (!this.#grant.scopes.includes(scope) || !this.#executor) {
      return this.#reject(method, 'app_denied');
    }
    if (this.#operationCount >= UI_LIMITS.operationsPerLease) {
      return this.#reject(method, 'app_rate_limited');
    }
    if (this.#inFlight >= UI_LIMITS.inFlightPerLease || !this.#operations.tryTake()) {
      return this.#reject(method, 'app_rate_limited');
    }
    this.#operationCount += 1;
    this.#inFlight += 1;
    try {
      const outcome = await this.#executor(operation, this.#lifecycle.signal);
      // Suppress results that arrive after revocation; delivered data cannot be recalled.
      const revokedNow = this.#lifecycle.revoked;
      if (revokedNow) throw bridgeError(revokedNow);
      if (!outcome.ok) throw bridgeError(outcome.code);
      const parsed = parse(outcome.result);
      if (parsed === undefined) throw bridgeError('app_unavailable');
      return parsed;
    } finally {
      this.#inFlight -= 1;
    }
  }
}
