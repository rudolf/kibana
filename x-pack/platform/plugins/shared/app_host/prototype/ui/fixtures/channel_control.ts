/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Positive-control bundle: the exact T4 channel probes, loaded by an ordinary page on the receiver's
// origin (no app policy, no sandbox) to prove each probe really issues a request in this engine.

import { runChannels } from './channels';

(window as unknown as { __runChannels: typeof runChannels }).__runChannels = runChannels;
