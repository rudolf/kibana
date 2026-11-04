/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROTOTYPE_ROOT } from './build';

// Local secrets live in git-ignored files and are never printed.
export const LOCAL_DIR = resolve(PROTOTYPE_ROOT, '.local');
export const CALLER_TOKEN_FILE = resolve(LOCAL_DIR, 'caller_token');
export const DEV_VARS_FILE = resolve(PROTOTYPE_ROOT, 'cloudflare/.dev.vars');
export const USERS_FILE = resolve(LOCAL_DIR, 'users.json');

const writePrivate = (path: string, content: string) => {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
};

/** Creates the local caller secret and wrangler `.dev.vars` if absent. Returns nothing secret. */
export const ensureLocalCallerToken = (): { created: boolean } => {
  mkdirSync(LOCAL_DIR, { recursive: true });
  if (existsSync(CALLER_TOKEN_FILE) && existsSync(DEV_VARS_FILE)) return { created: false };
  const token = existsSync(CALLER_TOKEN_FILE)
    ? readFileSync(CALLER_TOKEN_FILE, 'utf8').trim()
    : randomBytes(32).toString('base64url');
  writePrivate(CALLER_TOKEN_FILE, `${token}\n`);
  writePrivate(DEV_VARS_FILE, `KIBANA_CALLER_TOKEN=${token}\n`);
  return { created: true };
};

/** Reads the caller token from APP_HOST_CALLER_TOKEN or the local secret file. */
export const readCallerToken = (): string => {
  const fromEnv = process.env.APP_HOST_CALLER_TOKEN;
  if (fromEnv) return fromEnv;
  if (!existsSync(CALLER_TOKEN_FILE)) {
    throw new Error('No caller token: set APP_HOST_CALLER_TOKEN or run `npm run secret:local`.');
  }
  return readFileSync(CALLER_TOKEN_FILE, 'utf8').trim();
};

export interface LocalUsers {
  readonly reader: { username: string; password: string };
  readonly noIndex: { username: string; password: string };
  readonly noFeature: { username: string; password: string };
}

export const readOrCreateUsers = (): LocalUsers => {
  mkdirSync(LOCAL_DIR, { recursive: true });
  if (existsSync(USERS_FILE)) return JSON.parse(readFileSync(USERS_FILE, 'utf8')) as LocalUsers;
  const password = () => randomBytes(18).toString('base64url');
  const users: LocalUsers = {
    reader: { username: 'app_host_reader', password: password() },
    noIndex: { username: 'app_host_no_index', password: password() },
    noFeature: { username: 'app_host_no_feature', password: password() },
  };
  writePrivate(USERS_FILE, JSON.stringify(users, null, 2));
  return users;
};

export const readUsers = (): LocalUsers => {
  if (!existsSync(USERS_FILE)) throw new Error('No local users: run `npm run seed` first.');
  return JSON.parse(readFileSync(USERS_FILE, 'utf8')) as LocalUsers;
};
