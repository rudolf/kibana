/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { HttpStart } from '@kbn/core/public';
import type { CreateSessionResponse, UiAppMetadata, UiOperation } from '../../common/ui_protocol';
import {
  UI_EXECUTE_PATH,
  UI_LIMITS,
  UI_SESSION_PATH,
  isBridgeErrorCode,
  parseExecuteResponse,
} from '../../common/ui_protocol';
import type { SessionFactory } from '../components/app_ui_page';
import type { ExecuteOutcome } from './bridge_root';

/** Maps any transport/framework failure to the fixed safe envelope; never forwards raw errors. */
const errorOutcome = (error: unknown): ExecuteOutcome => {
  const code = (error as { body?: { attributes?: { code?: unknown } } })?.body?.attributes?.code;
  return { ok: false, code: isBridgeErrorCode(code) ? code : 'app_unavailable' };
};

/**
 * Parent-held app session. The handle (an encrypted reference to a server-only API key) lives only
 * in this closure: it is sent to Kibana in the execute JSON body and never placed in window or port
 * messages, URLs or headers. There is nothing to revoke on unmount: dropping the closure drops the
 * handle. An expired handle is re-minted once per call; the session only exists after this page's
 * consent, and a torn-down frame (aborted signal) never re-mints.
 */
export const createSessionFactory =
  (http: HttpStart): SessionFactory =>
  async (metadata: UiAppMetadata) => {
    const mint = async (): Promise<string> => {
      const { handle } = await http.post<CreateSessionResponse>(UI_SESSION_PATH, {
        body: JSON.stringify({ appId: metadata.appId, releaseDigest: metadata.releaseDigest }),
      });
      if (
        typeof handle !== 'string' ||
        handle.length === 0 ||
        handle.length > UI_LIMITS.handleBytes
      ) {
        throw new Error('app_unavailable');
      }
      return handle;
    };
    let handle = await mint();
    const run = async (operation: UiOperation, signal: AbortSignal): Promise<ExecuteOutcome> => {
      try {
        const response = await http.post(UI_EXECUTE_PATH, {
          body: JSON.stringify({ handle, ...operation }),
          signal,
        });
        return parseExecuteResponse(response) ?? { ok: false, code: 'app_unavailable' };
      } catch (error) {
        return errorOutcome(error);
      }
    };
    return {
      executor: async (operation, signal) => {
        const outcome = await run(operation, signal);
        if (outcome.ok || outcome.code !== 'app_expired' || signal.aborted) return outcome;
        try {
          handle = await mint();
        } catch (error) {
          return errorOutcome(error);
        }
        return signal.aborted ? outcome : run(operation, signal);
      },
    };
  };
