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
import type { AppRunner } from '../app_runner';
import { PackageError } from '../package/package_error';
import { readManifest } from '../package/read_package';
import { toSummaryResponse } from './summary_response';

export interface RouteDependencies {
  readonly router: IRouter;
  readonly runner: AppRunner;
  readonly packagePath: string;
  readonly logger: Logger;
}

const requestAbortSignal = (request: KibanaRequest) => {
  const controller = new AbortController();
  const subscription = request.events.aborted$.subscribe(() => controller.abort());
  return { signal: controller.signal, dispose: () => subscription.unsubscribe() };
};

export const registerRoutes = ({ router, runner, packagePath, logger }: RouteDependencies) => {
  router.get(
    {
      path: INTERNAL_APPS_PATH,
      security: { authz: { requiredPrivileges: [API_PRIVILEGE_READ] } },
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
      security: { authz: { requiredPrivileges: [API_PRIVILEGE_READ] } },
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
      const esClient = (await context.core).elasticsearch.client.asCurrentUser;
      const aborted = requestAbortSignal(request);
      try {
        const outcome = await runner.runSummary(request.params.appId, esClient, aborted.signal);
        return toSummaryResponse(response, outcome, runner.dispatcher);
      } finally {
        aborted.dispose();
      }
    }
  );
};
