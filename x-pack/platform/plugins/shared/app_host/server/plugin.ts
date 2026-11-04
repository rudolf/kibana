/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, Logger, Plugin, PluginInitializerContext } from '@kbn/core/server';
import { AppRunner } from './app_runner';
import type { AppHostConfig } from './config';
import { appHostAlertDigestFeature, appHostFeature } from './feature';
import { registerRoutes } from './routes/register_routes';
import type { AppHostPluginSetup, AppHostPluginStart, AppHostSetupDependencies } from './types';
import { registerUiRoutes } from './ui/register_ui_routes';
import { registerSecurityHeadersHook, SurfaceDecisions } from './ui/security_headers';
import { UiUrls } from './ui/ui_context';

export class AppHostPlugin
  implements Plugin<AppHostPluginSetup, AppHostPluginStart, AppHostSetupDependencies>
{
  readonly #logger: Logger;
  readonly #config: AppHostConfig;

  constructor(context: PluginInitializerContext<AppHostConfig>) {
    this.#logger = context.logger.get();
    this.#config = context.config.get();
  }

  setup(core: CoreSetup, { features }: AppHostSetupDependencies): AppHostPluginSetup {
    const { packagePath, dispatcherUrl, callerToken, consentPath } = this.#config;
    if (!packagePath || !dispatcherUrl || !callerToken) {
      throw new Error('xpack.app_host requires packagePath, dispatcherUrl and callerToken');
    }
    features.registerKibanaFeature(appHostFeature);
    features.registerKibanaFeature(appHostAlertDigestFeature);
    const router = core.http.createRouter();
    const runner = new AppRunner({ packagePath, dispatcherUrl, callerToken }, this.#logger);

    // Registered after Core's response-header handler, so it composes the final-wire headers.
    const decisions = new SurfaceDecisions();
    registerSecurityHeadersHook(core.http, decisions);

    registerRoutes({ router, runner, packagePath, consentPath, logger: this.#logger });

    const { publicBaseUrl } = core.http.basePath;
    if (consentPath && publicBaseUrl) {
      registerUiRoutes({
        router,
        basePath: core.http.basePath,
        packagePath,
        consentPath,
        urls: new UiUrls(publicBaseUrl),
        decisions,
        logger: this.#logger.get('ui'),
      });
      this.#logger.info('App Host prototype enabled (third-party UI: synthetic local cut)');
    } else {
      this.#logger.info(
        'App Host prototype enabled (UI disabled: needs consentPath and publicBaseUrl)'
      );
    }
    return {};
  }

  start(): AppHostPluginStart {
    return {};
  }

  stop() {}
}
