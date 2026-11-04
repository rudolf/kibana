/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ProtocolError, stacklessError } from '../../shared/protocol';

const CPU_LIMIT = /exceeded CPU|CPU time limit|cpu limit|exceededCpu/i;
const SUBREQUEST_LIMIT = /exceeded.*subrequest/i;
// capnweb deserialization limits and the bounded transport's frame/queue limits.
const RPC_LIMIT =
  /Deserialization exceeded maximum allowed message depth|Incoming message exceeds maximum size|exceeds the message size limit|Receive queue exceeded/;

/** Code for an internal failure; never forwards stacks or app/host details. */
const codeOf = (error: unknown): string => {
  if (error instanceof ProtocolError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  const known = /^app_host:([a-z_]+)$/.exec(message);
  if (known) return known[1];
  if (CPU_LIMIT.test(message)) return 'app_cpu_limit';
  if (SUBREQUEST_LIMIT.test(message)) return 'app_subrequest_limit';
  if (RPC_LIMIT.test(message)) return 'rpc_limit';
  return 'app_failed';
};

/** Maps internal failures to a fixed set of stackless `app_host:<code>` errors. */
export const sanitize = (error: unknown): Error => stacklessError(`app_host:${codeOf(error)}`);
