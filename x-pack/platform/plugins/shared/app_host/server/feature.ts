/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { DEFAULT_APP_CATEGORIES } from '@kbn/core/server';
import type { KibanaFeatureConfig } from '@kbn/features-plugin/common';
import { i18n } from '@kbn/i18n';
import { API_PRIVILEGE_READ, FEATURE_ID, PLUGIN_ID } from '../common';

const privilege = {
  app: [PLUGIN_ID],
  api: [API_PRIVILEGE_READ],
  savedObject: { all: [], read: [] },
  ui: ['show'],
};

/** Grants `read_app_host`. Elasticsearch index access for the app data is checked separately. */
export const appHostFeature: KibanaFeatureConfig = {
  id: FEATURE_ID,
  name: i18n.translate('xpack.appHost.featureName', { defaultMessage: 'App Host (prototype)' }),
  category: DEFAULT_APP_CATEGORIES.management,
  app: [PLUGIN_ID],
  privileges: {
    all: privilege,
    read: privilege,
  },
};
