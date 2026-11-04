/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_DIR } from './secrets';

/** Attacker-controlled synthetic content (T3): must always render as literal text. */
export const HOSTILE_RULE = `<img src=x onerror="parent.document.body.textContent='PWN'">`;
export const DASHBOARD_TITLE = 'Synthetic <b>dashboard</b> <img src=x onerror=alert(1)>';

export const UI_SEED_FILE = join(LOCAL_DIR, 'ui_seed.json');

export interface UiSeedState {
  readonly dashboardId: string;
  /** A second, existing synthetic dashboard that is never granted (T13 existence-oracle control). */
  readonly ungrantedDashboardId: string;
  readonly emptySpaceId: string;
}

export const readUiSeed = (): UiSeedState => {
  if (!existsSync(UI_SEED_FILE)) throw new Error('Run `npm run ui:seed` first');
  return JSON.parse(readFileSync(UI_SEED_FILE, 'utf8')) as UiSeedState;
};

export const writeUiSeed = (state: UiSeedState): void =>
  writeFileSync(UI_SEED_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
