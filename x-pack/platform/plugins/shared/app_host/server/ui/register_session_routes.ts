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
import { kibanaRequestFactory } from '@kbn/core-http-server-utils';
import { UI_EXECUTE_PATH, UI_LIMITS, UI_SESSION_PATH } from '../../common/ui_protocol';
import type { AppKey } from './app_key';
import type { BridgeService, CallerContext, ServiceResponse } from './bridge_service';
import { APP_UI_PRIVILEGES } from './register_ui_routes';
import { isDefaultSpace, spaceIdOf, type UiUrls } from './ui_context';

export interface SessionRouteDependencies {
  readonly router: IRouter;
  readonly basePath: IBasePath;
  readonly urls: UiUrls;
  readonly service: BridgeService;
  readonly getStart: () => Promise<CoreStart>;
}

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

const apiKeyAuthorization = ({ id, apiKey }: AppKey): string =>
  `ApiKey ${Buffer.from(`${id}:${apiKey}`).toString('base64')}`;

/**
 * Parent-only app session API. Requires authentication (session cookie or basic), both
 * privileges, normal XSRF (Kibana core), the exact configured same-origin `Origin`, the default
 * space and no run_as. The handle travels in the JSON body, never in a header or URL (S11).
 */
export const registerSessionRoutes = ({
  router,
  basePath,
  urls,
  service,
  getStart,
}: SessionRouteDependencies) => {
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
      grantKey: async (keyRequest) => {
        // No refresh wait: a key that a concurrent name-based invalidation misses is still
        // unusable, because its handle carries the superseded approval generation.
        const granted = await start.security.authc.apiKeys.grantAsInternalUser(
          request,
          { ...keyRequest, role_descriptors: { ...keyRequest.role_descriptors } },
          { refresh: false }
        );
        return granted ? { id: granted.id, apiKey: granted.api_key } : null;
      },
      invalidateKey: async (id) => {
        await start.security.authc.apiKeys.invalidateAsInternalUser({ ids: [id] });
      },
      asKey: (key) => {
        const headers = { authorization: apiKeyAuthorization(key) };
        return {
          esClient: start.elasticsearch.client.asScoped({ headers }).asCurrentUser,
          selfClient: start.http.selfClient.asScoped(kibanaRequestFactory({ headers })),
        };
      },
      selfPathname: (path) => `${basePath.serverBasePath}${path}`,
    };
  };

  router.post(
    {
      path: UI_SESSION_PATH,
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
        return respond(response, await service.createSession(caller, appId, releaseDigest));
      } finally {
        aborted.dispose();
      }
    }
  );

  router.post(
    {
      path: UI_EXECUTE_PATH,
      security: { authz: { requiredPrivileges: [...APP_UI_PRIVILEGES] } },
      options: { access: 'internal' },
      validate: {
        // The operation is parsed strictly by the closed union; config-schema only bounds it.
        body: schema.object({
          handle: schema.string({ minLength: 1, maxLength: UI_LIMITS.handleBytes }),
          op: schema.string({ minLength: 1, maxLength: 32 }),
          params: schema.maybe(
            schema.recordOf(schema.string({ maxLength: 16 }), schema.any(), {
              validate: (value) => (Object.keys(value).length <= 4 ? undefined : 'too many fields'),
            })
          ),
        }),
      },
    },
    async (_context, request, response) => {
      const aborted = abortSignalOf(request);
      try {
        const caller = await callerOf(request, aborted.signal);
        const { handle, op, params } = request.body;
        const operation = params === undefined ? { op } : { op, params };
        return respond(response, await service.execute(caller, handle, operation));
      } finally {
        aborted.dispose();
      }
    }
  );
};
