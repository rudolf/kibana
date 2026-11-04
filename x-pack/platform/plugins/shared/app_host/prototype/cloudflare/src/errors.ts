/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ProtocolError } from '../../shared/protocol';

/** Maps internal failures to a fixed set of codes; never forwards stacks or app/host details. */
export const sanitize = (error: unknown): Error => {
  if (error instanceof ProtocolError) return new Error(`app_host:${error.code}`);
  const message = error instanceof Error ? error.message : String(error);
  if (/^app_host:[a-z_]+$/.test(message)) return new Error(message);
  if (/exceeded CPU|CPU time limit|cpu limit/i.test(message)) {
    return new Error('app_host:app_cpu_limit');
  }
  if (/exceeded.*subrequest/i.test(message)) return new Error('app_host:app_subrequest_limit');
  return new Error('app_host:app_failed');
};
