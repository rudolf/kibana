/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

class DeadlineExceeded extends Error {
  constructor() {
    super('App invocation deadline exceeded');
    this.name = 'DeadlineExceeded';
  }
}

export const isDeadlineReason = (reason: unknown): boolean => reason instanceof DeadlineExceeded;

/** One signal that aborts on request abort or after `deadlineMs`, whichever comes first. */
export const createDeadline = (requestAborted: AbortSignal, deadlineMs: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DeadlineExceeded()), deadlineMs);
  const onRequestAbort = () => controller.abort(new Error('Request aborted'));
  if (requestAborted.aborted) onRequestAbort();
  else requestAborted.addEventListener('abort', onRequestAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      requestAborted.removeEventListener('abort', onRequestAbort);
    },
  };
};
