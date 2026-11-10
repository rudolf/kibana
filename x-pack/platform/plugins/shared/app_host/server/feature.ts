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
import { API_PRIVILEGE_APP_ALERT_DIGEST, APP_FEATURE_ID } from '../common/ui_protocol';

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

const appPrivilege = {
  app: [],
  api: [API_PRIVILEGE_APP_ALERT_DIGEST],
  savedObject: { all: [], read: [] },
  ui: [],
};

/**
 * Fixed per-app privilege `read_app_alert_digest`, registered at setup. Required in addition to
 * `read_app_host` for the app's metadata, UI documents, leases, execution and native summary.
 */
export const appHostAlertDigestFeature: KibanaFeatureConfig = {
  id: APP_FEATURE_ID,
  name: i18n.translate('xpack.appHost.alertDigestFeatureName', {
    defaultMessage: 'App Host app: Alert digest (prototype)',
  }),
  category: DEFAULT_APP_CATEGORIES.management,
  app: [],
  privileges: {
    all: appPrivilege,
    read: appPrivilege,
  },
};
