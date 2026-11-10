/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export interface Env {
  LOADER: WorkerLoader;
  KIBANA_CALLER_TOKEN?: string;
  DEPLOYMENT_ID: string;
}

/** The Kibana-side host capability, as seen through a capnweb stub. */
export interface HostStub {
  search(params: unknown): Promise<unknown>;
}

export const MIN_TOKEN_LENGTH = 32;
export const MAX_TOKEN_LENGTH = 256;

/** Name of the native WorkerEntrypoint export every app bundle must provide. */
export const APP_ENTRYPOINT = 'App';
