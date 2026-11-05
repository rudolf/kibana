/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Operator commands on the local approval file (not reachable through the bridge):
//   npm run ui:operator -- disable | enable | status | reset
// `reset` removes the approval (uninstall); the next approval starts a new version history.
// `disable` and `reset` raise the approval generation first (every earlier app session handle is
// then refused for good), then invalidate the app's session keys by name as Kibana's internal user
// (ES_URL, KIBANA_SYSTEM_AUTH) as cleanup. A failed or partial invalidation is reported and the
// command exits non-zero; the state stays as written.

import { rmSync } from 'node:fs';
import {
  AppKeyInvalidationError,
  invalidateAppKeys,
  type InvalidationFailure,
  type InvalidationResult,
} from './lib/app_keys';
import { CONSENT_FILE, readConsent, setAppEnabled } from './lib/approval';

const [command] = process.argv.slice(2);
const consent = readConsent();
let revoked: InvalidationResult | { readonly failed: InvalidationFailure } | undefined;
try {
  switch (command) {
    case 'disable':
    case 'enable':
      revoked = await setAppEnabled(command === 'enable');
      break;
    case 'reset':
      rmSync(CONSENT_FILE, { force: true });
      if (consent) revoked = await invalidateAppKeys({ appId: consent.appId });
      break;
    case 'status':
      break;
    default:
      throw new Error('Usage: ui:operator -- disable|enable|status|reset');
  }
} catch (error) {
  if (!(error instanceof AppKeyInvalidationError)) throw error;
  revoked = { failed: error.result };
  process.exitCode = 1;
}
const after = readConsent();
process.stdout.write(
  `${JSON.stringify({
    command,
    consent: after
      ? {
          enabled: after.enabled,
          version: after.approvedVersion,
          approvedBy: after.approvedBy,
          generation: after.generation,
        }
      : null,
    revoked,
  })}\n`
);
