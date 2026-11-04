/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Generates the local 32-byte caller secret (.local/caller_token, cloudflare/.dev.vars). Never prints it.

import { ensureLocalCallerToken } from './lib/secrets';

const { created } = ensureLocalCallerToken();
process.stdout.write(
  `${created ? 'Created' : 'Kept existing'} local caller secret (git-ignored).\n`
);
