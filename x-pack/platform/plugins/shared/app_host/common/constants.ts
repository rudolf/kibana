/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const PLUGIN_ID = 'appHost';
export const FEATURE_ID = 'appHost';
export const APP_PATH = '/app/appHost';
export const API_PRIVILEGE_READ = 'read_app_host';

/** The only app id this prototype installs. */
export const INSTALLED_APP_ID = 'alert-digest';
export const SYNTHETIC_INDEX = 'kbn-apps-prototype-alerts';
export const HOST_API_VERSION = 1;

export const INTERNAL_APPS_PATH = '/internal/app_host/apps';
export const SUMMARY_PATH = '/api/apps/{appId}/summary';
export const summaryPath = (appId: string): string =>
  `/api/apps/${encodeURIComponent(appId)}/summary`;

export const LIMITS = {
  titleLength: 80,
  versionLength: 32,
  labelLength: 80,
  ruleLength: 128,
} as const;

/**
 * The one bound on every bridge transport (backend dispatcher session and UI Worker): bytes of
 * frames received but not yet read by capnweb, counted as 2 bytes per UTF-16 code unit. Overflow
 * ends the session, so a hostile peer cannot exhaust memory.
 */
export const RECEIVE_QUEUE_BYTES = 8 * 1024 * 1024;
