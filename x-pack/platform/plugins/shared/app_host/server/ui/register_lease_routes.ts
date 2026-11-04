/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type {
  CoreStart,
  IBasePath,
  IRouter,
  KibanaRequest,
  KibanaResponseFactory,
} from '@kbn/core/server';
import {
  UI_LEASES_PATH,
  UI_LEASE_EXECUTE_ROUTE,
  UI_LEASE_REVOKE_ROUTE,
} from '../../common/ui_protocol';
import type { BridgeService, CallerContext, ServiceResponse } from './bridge_service';
import { APP_UI_PRIVILEGES } from './register_ui_routes';
import { isDefaultSpace, spaceIdOf, type UiUrls } from './ui_context';

export interface LeaseRouteDependencies {
  readonly router: IRouter;
  readonly basePath: IBasePath;
  readonly urls: UiUrls;
  readonly service: BridgeService;
  readonly getStart: () => Promise<CoreStart>;
}

const leaseId = schema.string({
  minLength: 22,
  maxLength: 64,
  validate: (v) => (/^[A-Za-z0-9_-]+$/.test(v) ? undefined : 'invalid'),
});
const secret = schema.string({ minLength: 43, maxLength: 43 });

const abortSignalOf = (request: KibanaRequest) => {
  const controller = new AbortController();
  const subscription = request.events.aborted$.subscribe(() => controller.abort());
  return { signal: controller.signal, dispose: () => subscription.unsubscribe() };
};

const respond = (response: KibanaResponseFactory, result: ServiceResponse) => {
  const { status, body } = result;
  if (status === 200) return response.ok({ body });
  const code = 'code' in body ? body.code : 'app_unavailable';
  // Bounded, stackless: only a fixed code; never native bodies, headers or WWW-Authenticate.
  return response.customError({
    statusCode: status,
    body: { message: code, attributes: { code } },
  });
};

/**
 * Parent-only lease API. Requires authentication, both privileges, normal XSRF (Kibana core), the
 * exact configured same-origin `Origin`, the default space and no run_as. The lease secret travels
 * in the JSON body, never in a header (S11: Kibana's response logger does not redact custom headers).
 */
export const registerLeaseRoutes = ({
  router,
  basePath,
  urls,
  service,
  getStart,
}: LeaseRouteDependencies) => {
  const callerOf = async (request: KibanaRequest, signal: AbortSignal): Promise<CallerContext> => {
    const start = await getStart();
    const user = start.security.authc.getCurrentUser(request);
    const runAs =
      request.headers['es-security-runas-user'] !== undefined ||
      request.url.searchParams.has('run_as') ||
      request.url.searchParams.has('es-security-runas-user');
    return {
      principal: user
        ? JSON.stringify([
            user.authentication_realm.type,
            user.authentication_realm.name,
            user.username,
          ])
        : undefined,
      userName: user?.username,
      spaceId: spaceIdOf(basePath, request),
      isDefaultSpace: isDefaultSpace(basePath, request),
      originOk: request.headers.origin === urls.origin,
      runAs,
      requestAborted: signal,
      esClient: () => start.elasticsearch.client.asScoped(request).asCurrentUser,
      selfClient: () => start.http.selfClient.asScoped(request),
      dashboardPathname: (id) =>
        `${basePath.serverBasePath}/api/dashboards/${encodeURIComponent(id)}`,
    };
  };

  router.post(
    {
      path: UI_LEASES_PATH,
      security: { authz: { requiredPrivileges: [...APP_UI_PRIVILEGES] } },
      options: { access: 'internal', body: { maxBytes: 1024 } },
      validate: {
        body: schema.object({
          appId: schema.string({ minLength: 1, maxLength: 64 }),
          releaseDigest: schema.string({ minLength: 1, maxLength: 64 }),
        }),
      },
    },
    async (_context, request, response) => {
      const aborted = abortSignalOf(request);
      try {
        const caller = await callerOf(request, aborted.signal);
        const { appId, releaseDigest } = request.body;
        return respond(response, await service.createLease(caller, appId, releaseDigest));
      } finally {
        aborted.dispose();
      }
    }
  );

  router.post(
    {
      path: UI_LEASE_EXECUTE_ROUTE,
      security: { authz: { requiredPrivileges: [...APP_UI_PRIVILEGES] } },
      options: { access: 'internal', body: { maxBytes: 4096 } },
      validate: {
        params: schema.object({ leaseId }),
        // The operation is parsed strictly by the closed union; config-schema only bounds it.
        body: schema.object({
          secret,
          operation: schema.recordOf(schema.string({ maxLength: 16 }), schema.any(), {
            validate: (value) => (Object.keys(value).length <= 4 ? undefined : 'too many fields'),
          }),
        }),
      },
    },
    async (_context, request, response) => {
      const aborted = abortSignalOf(request);
      try {
        const caller = await callerOf(request, aborted.signal);
        const { secret: leaseSecret, operation } = request.body;
        return respond(
          response,
          await service.execute(caller, request.params.leaseId, leaseSecret, operation)
        );
      } finally {
        aborted.dispose();
      }
    }
  );

  router.post(
    {
      path: UI_LEASE_REVOKE_ROUTE,
      security: { authz: { requiredPrivileges: [...APP_UI_PRIVILEGES] } },
      options: { access: 'internal', body: { maxBytes: 1024 } },
      validate: { params: schema.object({ leaseId }), body: schema.object({ secret }) },
    },
    async (_context, request, response) => {
      const caller = await callerOf(request, new AbortController().signal);
      return respond(
        response,
        service.revokeLease(caller, request.params.leaseId, request.body.secret)
      );
    }
  );
};
