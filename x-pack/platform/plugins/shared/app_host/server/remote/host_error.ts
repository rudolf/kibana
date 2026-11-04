/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** Fixed error codes that may cross the RPC boundary. Nothing else is sent to the dispatcher. */
export type HostErrorCode =
  | 'host_revoked'
  | 'callback_budget'
  | 'invalid_search'
  | 'index_not_granted'
  | 'es_forbidden'
  | 'es_failed'
  | 'host_error';

export class HostError extends Error {
  readonly code: HostErrorCode;

  constructor(code: HostErrorCode) {
    super(`app_host:${code}`);
    this.name = 'HostError';
    this.code = code;
  }
}

/**
 * An `Error` with no stack. capnweb serializes a replacement error's `stack` when `onSendError`
 * returns one that has it, which would disclose host source paths to the peer.
 */
export const stacklessError = (message: string): Error => {
  const error = new Error(message);
  delete error.stack;
  return error;
};

/** capnweb `onSendError`: replace every outbound error with a stackless, sanitized one. */
export const sanitizeOutboundError = (error: Error): Error =>
  stacklessError(error instanceof HostError ? error.message : 'app_host:host_error');
