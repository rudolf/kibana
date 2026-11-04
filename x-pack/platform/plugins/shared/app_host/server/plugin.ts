/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, Logger, Plugin, PluginInitializerContext } from '@kbn/core/server';
import { AppRunner } from './app_runner';
import type { AppHostConfig } from './config';
import { appHostFeature } from './feature';
import { registerRoutes } from './routes/register_routes';
import type { AppHostPluginSetup, AppHostPluginStart, AppHostSetupDependencies } from './types';

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
    const { packagePath, dispatcherUrl, callerToken } = this.#config;
    if (!packagePath || !dispatcherUrl || !callerToken) {
      throw new Error('xpack.app_host requires packagePath, dispatcherUrl and callerToken');
    }
    features.registerKibanaFeature(appHostFeature);
    const runner = new AppRunner({ packagePath, dispatcherUrl, callerToken }, this.#logger);
    registerRoutes({ router: core.http.createRouter(), runner, packagePath, logger: this.#logger });
    this.#logger.info('App Host prototype enabled');
    return {};
  }

  start(): AppHostPluginStart {
    return {};
  }

  stop() {}
}
