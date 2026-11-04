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
  manifestBytes: 16 * 1024,
  bundleBytes: 64 * 1024,
  titleLength: 80,
  versionLength: 32,
  labelLength: 80,
  callbackResultBytes: 16 * 1024,
  callbackRecords: 100,
  ruleLength: 128,
  callbacksPerInvocation: 1,
  concurrentInvocations: 4,
  deadlineMs: 5000,
  maxCount: 100,
} as const;

export const RPC_LIMITS = {
  maxMessageSize: 256 * 1024,
  maxDepth: 32,
  maxBigIntDigits: 64,
} as const;
