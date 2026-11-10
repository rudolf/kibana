/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { PluginInitializerContext } from '@kbn/core/server';
import type { AppHostConfig } from './config';

export { config } from './config';
export type { AppHostConfig } from './config';
export type { AppHostPluginSetup, AppHostPluginStart } from './types';

export const plugin = async (context: PluginInitializerContext<AppHostConfig>) => {
  const { AppHostPlugin } = await import('./plugin');
  return new AppHostPlugin(context);
};
