/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Operator commands on the local approval file (not reachable through the bridge):
//   npm run ui:operator -- disable | enable | status | reset
// `reset` removes the approval (uninstall); the next approval starts a new version history.

import { rmSync } from 'node:fs';
import { CONSENT_FILE, readConsent, writeConsent } from './lib/approval';

const [command] = process.argv.slice(2);
const consent = readConsent();
switch (command) {
  case 'disable':
  case 'enable':
    if (!consent) throw new Error('No approval to change');
    writeConsent({ ...consent, enabled: command === 'enable' });
    break;
  case 'reset':
    rmSync(CONSENT_FILE, { force: true });
    break;
  case 'status':
    break;
  default:
    throw new Error('Usage: ui:operator -- disable|enable|status|reset');
}
const after = readConsent();
process.stdout.write(
  `${JSON.stringify({
    command,
    consent: after
      ? { enabled: after.enabled, version: after.approvedVersion, approvedBy: after.approvedBy }
      : null,
  })}\n`
);
