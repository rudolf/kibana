/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { HttpStart } from '@kbn/core/public';
import type { CreateLeaseResponse, UiAppMetadata } from '../../common/ui_protocol';
import {
  UI_LEASES_PATH,
  isBridgeErrorCode,
  isLeaseId,
  parseExecuteResponse,
  uiLeaseExecutePath,
  uiLeaseRevokePath,
} from '../../common/ui_protocol';
import type { LeaseFactory } from '../components/app_ui_page';
import type { ExecuteOutcome } from './bridge_root';

/** Maps any transport/framework failure to the fixed safe envelope; never forwards raw errors. */
const errorOutcome = (error: unknown): ExecuteOutcome => {
  const code = (error as { body?: { attributes?: { code?: unknown } } })?.body?.attributes?.code;
  return { ok: false, code: isBridgeErrorCode(code) ? code : 'app_unavailable' };
};

/**
 * Parent-held lease. The secret lives only in this closure: it is sent to Kibana in the execute
 * JSON body and never placed in window or port messages, URLs or headers.
 */
export const createLeaseFactory =
  (http: HttpStart): LeaseFactory =>
  async (metadata: UiAppMetadata) => {
    const created = await http.post<CreateLeaseResponse>(UI_LEASES_PATH, {
      body: JSON.stringify({ appId: metadata.appId, releaseDigest: metadata.releaseDigest }),
    });
    const { leaseId, secret } = created;
    if (!isLeaseId(leaseId) || typeof secret !== 'string' || secret.length !== 43) {
      throw new Error('app_unavailable');
    }
    let released = false;
    return {
      executor: async (operation, signal) => {
        if (released) return { ok: false, code: 'app_disabled' };
        try {
          const response = await http.post(uiLeaseExecutePath(leaseId), {
            body: JSON.stringify({ secret, operation }),
            signal,
          });
          return parseExecuteResponse(response) ?? { ok: false, code: 'app_unavailable' };
        } catch (error) {
          return errorOutcome(error);
        }
      },
      release: () => {
        if (released) return;
        released = true;
        http
          .post(uiLeaseRevokePath(leaseId), { body: JSON.stringify({ secret }), keepalive: true })
          .catch(() => undefined);
      },
    };
  };
