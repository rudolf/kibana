/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Shared helpers for the ui:security Playwright harness. Browser checks use real Kibana cookie
// sessions (basic provider login into the context's cookie jar), never context-wide Authorization
// headers. Credentials are read from git-ignored files and never printed.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, BrowserType, Frame, Page } from '@playwright/test';
import { chromium, firefox, webkit } from '@playwright/test';
import { basicAuth } from './http';
import { LOCAL_DIR } from './secrets';

export type Status = 'PASS' | 'FAIL' | 'NOT_VERIFIED' | 'KNOWN_LEAK' | 'DIAGNOSTIC' | 'SKIPPED';

export interface CheckResult {
  readonly test: string;
  readonly check: string;
  readonly engine: string;
  readonly status: Status;
  readonly evidence: unknown;
}

export class Report {
  readonly results: CheckResult[] = [];

  add(test: string, check: string, engine: string, status: Status, evidence: unknown = null): void {
    this.results.push({ test, check, engine, status, evidence });
    const mark = status === 'PASS' ? 'ok ' : status === 'FAIL' ? 'XX ' : '.. ';
    process.stderr.write(`${mark}${test} ${check} [${engine}] ${status}\n`);
  }

  /** Records PASS when `ok` holds, otherwise FAIL, with the observed evidence. */
  expect(test: string, check: string, engine: string, ok: boolean, evidence: unknown = null): void {
    this.add(test, check, engine, ok ? 'PASS' : 'FAIL', evidence);
  }

  async guard(
    test: string,
    check: string,
    engine: string,
    run: () => Promise<void>
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.add(test, check, engine, 'FAIL', { exception: String(error).slice(0, 500) });
    }
  }

  summary() {
    const by = (status: Status) => this.results.filter((r) => r.status === status).length;
    return {
      pass: by('PASS'),
      fail: by('FAIL'),
      notVerified: by('NOT_VERIFIED'),
      knownLeak: by('KNOWN_LEAK'),
      diagnostic: by('DIAGNOSTIC'),
      skipped: by('SKIPPED'),
    };
  }
}

export interface UiUser {
  readonly username: string;
  readonly password: string;
}
export type UiUsers = Record<
  | 'viewer'
  | 'viewer2'
  | 'noIndex'
  | 'noDashboard'
  | 'globalOnly'
  | 'superuser'
  | 'nonSuperInstaller',
  UiUser
>;

export const readUiUsers = (): UiUsers => {
  const file = join(LOCAL_DIR, 'ui_users.json');
  if (!existsSync(file)) throw new Error('Run `npm run ui:seed` first');
  return JSON.parse(readFileSync(file, 'utf8')) as UiUsers;
};

export const authOf = ({ username, password }: UiUser): string =>
  basicAuth(`${username}:${password}`);

export const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit };

export const launch = (engine: string): Promise<Browser> => {
  const type = ENGINES[engine];
  if (!type) throw new Error(`Unknown engine ${engine}`);
  return type.launch();
};

/** Logs in through Kibana's basic provider; the session cookie lands in the context's jar. */
export const login = async (
  context: BrowserContext,
  kibana: string,
  user: UiUser
): Promise<void> => {
  const response = await context.request.post(`${kibana}/internal/security/login`, {
    headers: {
      'kbn-xsrf': 'ui-security',
      'x-elastic-internal-origin': 'Kibana',
      'content-type': 'application/json',
    },
    data: {
      providerType: 'basic',
      providerName: 'basic',
      currentURL: `${kibana}/login`,
      params: { username: user.username, password: user.password },
    },
  });
  if (response.status() !== 200) throw new Error(`login failed: ${response.status()}`);
};

export const APP_URL = '/app/appHost/alert-digest';

/** Opens the deep link, clicks "Allow this version" and waits for the bound handshake. */
export const openAndAllow = async (page: Page, kibana: string, timeout = 120_000) => {
  await page.goto(`${kibana}${APP_URL}`, { waitUntil: 'domcontentloaded' });
  const allow = page.locator('[data-test-subj="appHostAllowVersion"]');
  await allow.waitFor({ timeout });
  await page.waitForFunction(
    () =>
      !document.querySelector('[data-test-subj="appHostAllowVersion"]')?.hasAttribute('disabled'),
    undefined,
    { timeout: 30_000 }
  );
  await allow.click();
};

export const frameStatus = (page: Page) =>
  page.locator('[data-test-subj="appHostFrameStatus"]').innerText();

export const waitForStatus = async (page: Page, pattern: RegExp, timeout = 30_000) => {
  await page.waitForFunction(
    (source) =>
      new RegExp(source).test(
        document.querySelector('[data-test-subj="appHostFrameStatus"]')?.textContent ?? ''
      ),
    pattern.source,
    { timeout }
  );
};

export const childFrame = (page: Page): Frame | undefined =>
  page
    .frames()
    .find((frame) => /\/api\/app_host\/ui\/[^/]+\/[0-9a-f]{64}\/frame(?:#.*)?$/.test(frame.url()));

export const guardianFrame = (page: Page): Frame | undefined =>
  page
    .frames()
    .find((frame) => /\/api\/app_host\/ui\/[^/]+\/[0-9a-f]{64}\/guardian$/.test(frame.url()));

export const waitForChild = async (page: Page, timeout = 30_000): Promise<Frame> => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const frame = childFrame(page);
    if (frame) return frame;
    await page.waitForTimeout(100);
  }
  throw new Error('child frame did not appear');
};

/** Header map from a fetch Response, lower-cased. */
export const headersOf = (response: Response): Record<string, string> => {
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

export { Receiver } from './receiver';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `predicate` with plain evaluate calls. `frame.waitForFunction` compiles its predicate with
 * eval inside the page, which the app frame's CSP (correctly) forbids.
 */
export const pollFrame = async <T>(
  frame: Frame,
  predicate: () => T,
  timeout = 60_000
): Promise<NonNullable<T>> => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await frame.evaluate(predicate).catch(() => undefined);
    if (value) return value as NonNullable<T>;
    await sleep(200);
  }
  throw new Error('pollFrame timed out');
};
