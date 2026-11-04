/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { DEFAULT_APP_CATEGORIES, type CoreSetup, type Plugin } from '@kbn/core/public';
import { i18n } from '@kbn/i18n';
import { APP_PATH, PLUGIN_ID } from '../common';

/** Registers one static, host-rendered page. No app-authored browser code is ever loaded. */
export class AppHostPublicPlugin implements Plugin {
  setup(core: CoreSetup) {
    core.application.register({
      id: PLUGIN_ID,
      title: i18n.translate('xpack.appHost.appTitle', { defaultMessage: 'App Host (prototype)' }),
      appRoute: APP_PATH,
      category: DEFAULT_APP_CATEGORIES.management,
      visibleIn: ['classicSideNav', 'globalSearch'],
      mount: async (params) => {
        const [coreStart] = await core.getStartServices();
        const { renderApp } = await import('./application');
        return renderApp(coreStart, params);
      },
    });
    return {};
  }

  start() {
    return {};
  }

  stop() {}
}
