/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import type { AppSummaryResponse } from '../common';
import { INSTALLED_APP_ID, LIMITS } from '../common';
import { parseAppOutput } from './app_output';
import { InvocationLimiter } from './invocation_limiter';
import { PackageError, type PackageErrorCode } from './package/package_error';
import { readPackage } from './package/read_package';
import type { MinimalWebSocket } from './remote/bounded_transport';
import { createDeadline } from './remote/deadline';
import { InvokeError, invokeApp, type InvokeErrorCode } from './remote/invoke_app';
import { SearchCapability } from './remote/search_capability';

export interface AppRunnerConfig {
  readonly packagePath: string;
  readonly dispatcherUrl: string;
  readonly callerToken: string;
  readonly deadlineMs?: number;
  readonly maxConcurrent?: number;
  readonly createSocket?: (url: string) => MinimalWebSocket;
}

export interface SummaryTimings {
  readonly totalMs: number;
  readonly packageMs: number;
  readonly connectMs: number;
  readonly authMs: number;
  readonly invokeMs: number;
  readonly esMs: number;
  readonly callbacks: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly callbackRequestBytes: number;
  readonly callbackResponseBytes: number;
}

export type SummaryOutcome =
  | { readonly status: 'ok'; readonly body: AppSummaryResponse; readonly timings: SummaryTimings }
  | { readonly status: 'not_found' }
  | { readonly status: 'busy' }
  | { readonly status: 'invalid_package'; readonly code: PackageErrorCode }
  | { readonly status: 'es_forbidden' }
  | { readonly status: 'deadline' }
  | { readonly status: 'aborted' }
  | { readonly status: 'remote_error'; readonly code: string }
  | { readonly status: 'invalid_output' };

/** Orchestrates one summary invocation: limit, verify package, invoke remotely, validate output. */
export class AppRunner {
  readonly #config: AppRunnerConfig;
  readonly #logger: Logger;
  readonly #limiter: InvocationLimiter;

  constructor(config: AppRunnerConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger;
    this.#limiter = new InvocationLimiter(config.maxConcurrent ?? LIMITS.concurrentInvocations);
  }

  async runSummary(
    appId: string,
    esClient: ElasticsearchClient,
    requestAborted: AbortSignal
  ): Promise<SummaryOutcome> {
    if (appId !== INSTALLED_APP_ID) return { status: 'not_found' };
    const release = this.#limiter.tryAcquire();
    if (!release) return { status: 'busy' };
    const started = performance.now();
    const deadline = createDeadline(requestAborted, this.#config.deadlineMs ?? LIMITS.deadlineMs);
    const { signal } = deadline;
    const capability = new SearchCapability(esClient);
    try {
      const pkg = await readPackage(this.#config.packagePath);
      if (pkg.manifest.id !== appId) return { status: 'not_found' };
      const packageMs = performance.now() - started;
      const { value, timings } = await invokeApp({
        dispatcherUrl: this.#config.dispatcherUrl,
        callerToken: this.#config.callerToken,
        pkg,
        capability,
        signal,
        createSocket: this.#config.createSocket,
      });
      const stats = capability.stats;
      // Host-owned truth: an ES authorization failure is a 403 whatever the app returned.
      if (stats.esDenied) return { status: 'es_forbidden' };
      const output = parseAppOutput(value);
      if (!output) return { status: 'invalid_output' };
      return {
        status: 'ok',
        body: { appId, version: pkg.manifest.version, ...output },
        timings: {
          totalMs: performance.now() - started,
          packageMs,
          connectMs: timings.connectMs,
          authMs: timings.authMs,
          invokeMs: timings.invokeMs,
          esMs: stats.esMs,
          callbacks: stats.calls,
          requestBytes: timings.requestBytes,
          responseBytes: timings.responseBytes,
          callbackRequestBytes: stats.requestBytes,
          callbackResponseBytes: stats.responseBytes,
        },
      };
    } catch (error) {
      return this.#failure(error, capability);
    } finally {
      capability.revoke();
      deadline.dispose();
      release();
    }
  }

  #failure(error: unknown, capability: SearchCapability): SummaryOutcome {
    if (error instanceof PackageError) {
      this.#logger.warn(`App package rejected before invocation: ${error.code}`);
      return { status: 'invalid_package', code: error.code };
    }
    if (capability.stats.esDenied) return { status: 'es_forbidden' };
    if (error instanceof InvokeError) {
      const mapped: Record<InvokeErrorCode, SummaryOutcome> = {
        deadline: { status: 'deadline' },
        aborted: { status: 'aborted' },
        disconnected: { status: 'remote_error', code: 'disconnected' },
        dispatcher_unauthorized: { status: 'remote_error', code: 'dispatcher_unauthorized' },
        remote_error: { status: 'remote_error', code: error.remoteCode ?? 'app_failed' },
      };
      const outcome = mapped[error.code];
      this.#logger.debug(`App invocation failed: ${error.code} ${error.remoteCode ?? ''}`);
      return outcome;
    }
    this.#logger.error('Unexpected App Host failure');
    return { status: 'remote_error', code: 'host_error' };
  }
}
