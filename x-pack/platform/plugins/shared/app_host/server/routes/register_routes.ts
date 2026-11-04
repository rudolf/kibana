/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type { IRouter, KibanaRequest, Logger } from '@kbn/core/server';
import type { ListAppsResponse } from '../../common';
import { API_PRIVILEGE_READ, INTERNAL_APPS_PATH, SUMMARY_PATH } from '../../common';
import { API_PRIVILEGE_APP_ALERT_DIGEST } from '../../common/ui_protocol';
import type { AppRunner, RunSummaryOptions } from '../app_runner';
import { readUiReleaseState } from '../ui/consent';
import { PackageError } from '../package/package_error';
import { readManifest } from '../package/read_package';
import { toSummaryResponse } from './summary_response';

export interface RouteDependencies {
  readonly router: IRouter;
  readonly runner: AppRunner;
  readonly packagePath: string;
  readonly consentPath: string | undefined;
  readonly logger: Logger;
}

/** The host gate plus the fixed per-app privilege; both are required for app data. */
const PRIVILEGES = [API_PRIVILEGE_READ, API_PRIVILEGE_APP_ALERT_DIGEST];

type SummaryGate =
  | { readonly allowed: true; readonly options: RunSummaryOptions }
  | { readonly allowed: false; readonly code: 'app_disabled' | 'app_stale' };

/**
 * The native summary honours UI approval/enablement: once an operator approval file exists, only
 * the enabled, approved release runs. Without one, only legacy backend-only manifests run.
 */
const summaryGate = async (
  packagePath: string,
  consentPath: string | undefined
): Promise<SummaryGate> => {
  const state = await readUiReleaseState(packagePath, consentPath);
  switch (state.status) {
    case 'not_installed':
      return { allowed: true, options: { legacyOnly: true } };
    case 'approved':
      return { allowed: true, options: { expectedReleaseDigest: state.manifest.releaseDigest } };
    case 'disabled':
      return { allowed: false, code: 'app_disabled' };
    default:
      return { allowed: false, code: 'app_stale' };
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
      const gate = await summaryGate(packagePath, consentPath);
      if (!gate.allowed) {
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
        return toSummaryResponse(response, outcome, runner.dispatcher);
      } finally {
        aborted.dispose();
      }
    }
  );
};
