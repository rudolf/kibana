/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { DEFAULT_APP_CATEGORIES, type CoreSetup, type Plugin } from '@kbn/core/public';
import { i18n } from '@kbn/i18n';
import { APP_PATH, PLUGIN_ID } from '../common';
import { UI_DEEP_LINK_ID, UI_DEEP_LINK_PATH } from '../common/ui_protocol';

/**
 * Registers the host page and a static `alert-digest` deep link. App-authored browser code only
 * ever runs inside the guardian-wrapped, opaque-origin frame on that deep link; never in Kibana's
 * origin.
 */
export class AppHostPublicPlugin implements Plugin {
  setup(core: CoreSetup) {
    core.application.register({
      id: PLUGIN_ID,
      title: i18n.translate('xpack.appHost.appTitle', { defaultMessage: 'App Host (prototype)' }),
      appRoute: APP_PATH,
      category: DEFAULT_APP_CATEGORIES.management,
      visibleIn: ['classicSideNav', 'globalSearch'],
      deepLinks: [
        {
          id: UI_DEEP_LINK_ID,
          title: i18n.translate('xpack.appHost.alertDigestDeepLink', {
            defaultMessage: 'Alert digest (third-party app)',
          }),
          path: UI_DEEP_LINK_PATH,
        },
      ],
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
