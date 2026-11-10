/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import { randomUUID } from 'node:crypto';
import type { IBasePath, IRouter, KibanaRequest, Logger } from '@kbn/core/server';
import type { ListAppsResponse } from '../../common';
import { API_PRIVILEGE_READ, INTERNAL_APPS_PATH, SUMMARY_PATH } from '../../common';
import { API_PRIVILEGE_APP_ALERT_DIGEST } from '../../common/ui_protocol';
import type { AppRunner, RunSummaryOptions, SummaryOutcome } from '../app_runner';
import type { AuditReason, BridgeAuditEvent, BridgeAuditLogger } from '../ui/audit';
import { readUiReleaseState } from '../ui/consent';
import { isDefaultSpace } from '../ui/ui_context';
import { PackageError } from '../package/package_error';
import { readManifest } from '../package/read_package';
import { toSummaryResponse } from './summary_response';

export interface RouteDependencies {
  readonly router: IRouter;
  readonly runner: AppRunner;
  readonly packagePath: string;
  readonly consentPath: string | undefined;
  readonly logger: Logger;
  readonly basePath: IBasePath;
  /** F7: one `app_host.bridge` record (`via: native`) per native summary call. */
  readonly audit: BridgeAuditLogger;
  readonly userNameOf: (request: KibanaRequest) => Promise<string | undefined>;
}

/** The host gate plus the fixed per-app privilege; both are required for app data. */
const PRIVILEGES = [API_PRIVILEGE_READ, API_PRIVILEGE_APP_ALERT_DIGEST];

type GateApp = BridgeAuditEvent['app'];

type SummaryGate =
  | { readonly allowed: true; readonly options: RunSummaryOptions; readonly app: GateApp }
  | {
      readonly allowed: false;
      readonly code: 'app_disabled' | 'app_stale';
      readonly app: GateApp;
    };

/**
 * The native summary honours UI approval/enablement: once an operator approval file exists, only
 * the enabled, approved release runs. Without one, only legacy backend-only manifests run.
 */
const summaryGate = async (
  packagePath: string,
  consentPath: string | undefined
): Promise<SummaryGate> => {
  const state = await readUiReleaseState(packagePath, consentPath);
  // Attribution comes from the verified approved release only (legacy mode has none).
  const app: GateApp =
    state.status === 'approved' || state.status === 'disabled'
      ? {
          id: state.manifest.id,
          version: state.manifest.version,
          releaseDigest: state.manifest.releaseDigest,
        }
      : undefined;
  switch (state.status) {
    case 'not_installed':
      return { allowed: true, options: { legacyOnly: true }, app };
    case 'approved':
      return {
        allowed: true,
        options: { expectedReleaseDigest: state.manifest.releaseDigest },
        app,
      };
    case 'disabled':
      return { allowed: false, code: 'app_disabled', app };
    default:
      return { allowed: false, code: 'app_stale', app };
  }
};

const nativeReason = (outcome: SummaryOutcome): AuditReason => {
  switch (outcome.status) {
    case 'ok':
      return 'ok';
    case 'es_forbidden':
      return 'native_denied';
    case 'aborted':
      return 'aborted';
    case 'release_mismatch':
      return 'stale_release';
    default:
      return 'native_failed';
  }
};

const requestAbortSignal = (request: KibanaRequest) => {
  const controller = new AbortController();
  const subscription = request.events.aborted$.subscribe(() => controller.abort());
  return { signal: controller.signal, dispose: () => subscription.unsubscribe() };
};

export const registerRoutes = ({
  router,
  runner,
  packagePath,
  consentPath,
  logger,
  basePath,
  audit,
  userNameOf,
}: RouteDependencies) => {
  router.get(
    {
      path: INTERNAL_APPS_PATH,
      security: { authz: { requiredPrivileges: PRIVILEGES } },
      options: { access: 'internal' },
      validate: false,
    },
    async (_context, _request, response) => {
      try {
        const { id, title, version } = await readManifest(packagePath);
        const body: ListAppsResponse = { apps: [{ id, title, version }] };
        return response.ok({ body, headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        const code = error instanceof PackageError ? error.code : 'package_unavailable';
        logger.warn(`App package rejected: ${code}`);
        return response.customError({
          statusCode: 500,
          body: { message: 'Installed app package is invalid', attributes: { code } },
        });
      }
    }
  );

  router.get(
    {
      path: SUMMARY_PATH,
      security: { authz: { requiredPrivileges: PRIVILEGES } },
      options: {
        access: 'public',
        summary: 'Run the installed app summary handler',
        description:
          'Prototype. Runs the installed app in a fresh remote worker with a request-scoped, read-only Elasticsearch capability for the current user.',
      },
      validate: {
        params: schema.object({ appId: schema.string({ minLength: 1, maxLength: 64 }) }),
      },
    },
    async (context, request, response) => {
      // F7: default space only (as for the UI lease path); other spaces see no app.
      if (!isDefaultSpace(basePath, request)) return response.notFound();
      const correlationId = randomUUID();
      const userName = await userNameOf(request);
      const record = (app: GateApp, outcome: 'success' | 'failure', reason: AuditReason) =>
        audit.log({
          app,
          userName,
          spaceId: 'default',
          capability: 'app.summary',
          outcome,
          reason,
          correlationId,
          via: 'native',
        });
      const gate = await summaryGate(packagePath, consentPath);
      if (!gate.allowed) {
        record(gate.app, 'failure', gate.code === 'app_disabled' ? 'disabled' : 'not_approved');
        return response.forbidden({
          body: {
            message: 'App release is not approved or is disabled',
            attributes: { code: gate.code },
          },
        });
      }
      const esClient = (await context.core).elasticsearch.client.asCurrentUser;
      const aborted = requestAbortSignal(request);
      try {
        const outcome = await runner.runSummary(
          request.params.appId,
          esClient,
          aborted.signal,
          gate.options
        );
        const reason = nativeReason(outcome);
        record(gate.app, reason === 'ok' ? 'success' : 'failure', reason);
        return toSummaryResponse(response, outcome, runner.dispatcher);
      } finally {
        aborted.dispose();
      }
    }
  );
};
