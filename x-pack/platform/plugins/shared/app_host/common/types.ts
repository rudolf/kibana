/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export interface InstalledAppSummary {
  readonly id: string;
  readonly title: string;
  readonly version: string;
}

export interface ListAppsResponse {
  readonly apps: readonly InstalledAppSummary[];
}

export interface SeverityCounts {
  readonly high: number;
  readonly low: number;
}

export interface AppSummaryResponse {
  readonly appId: string;
  readonly version: string;
  readonly label: string;
  readonly counts: SeverityCounts;
}
