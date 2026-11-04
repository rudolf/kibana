/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { approveRelease, readConsent } from '../approval';
import { basicAuth } from '../http';
import { LOCAL_DIR } from '../secrets';
import { readUiSeed, type UiSeedState } from '../ui_seed_state';
import { buildUiRelease, releaseUiPackage, type UiManifest } from '../ui_release';
import type { Receiver, Report, UiUser, UiUsers } from '../ui_harness';
import { launch, login } from '../ui_harness';

export interface SuiteContext {
  readonly kibana: string;
  readonly es: string;
  readonly adminAuth: string;
  readonly packageDir: string;
  readonly engines: readonly string[];
  readonly users: UiUsers;
  readonly seed: UiSeedState;
  readonly report: Report;
  readonly receiver: Receiver;
  readonly collector: Receiver;
  /** Mutable: the currently installed release and its UI entry. */
  current: UiManifest | undefined;
  currentEntry: string | undefined;
  /** Monotonic version counter for this run (approval rejects downgrades). */
  nextVersion: () => string;
}

export const PACKAGE_DIR = resolve(join(LOCAL_DIR, 'package'));

export interface KibanaResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly text: string;
  readonly json: unknown;
}

/** Raw HTTP request (curl-equivalent) as a synthetic user; returns final-wire headers. */
export const kfetch = async (
  ctx: SuiteContext,
  path: string,
  {
    user,
    method = 'GET',
    headers = {},
    body,
  }: { user?: UiUser; method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<KibanaResponse> => {
  const all: Record<string, string> = { ...headers };
  if (user) all.authorization = basicAuth(`${user.username}:${user.password}`);
  if (body !== undefined) all['content-type'] = 'application/json';
  const response = await fetch(`${ctx.kibana}${path}`, {
    method,
    headers: all,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await response.text();
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    out[key] = value;
  });
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: out, text, json };
};

export interface ReleaseOptions {
  readonly label?: string;
  readonly serverLabel?: string;
  readonly entry?: string;
  readonly approve?: boolean;
  readonly mutate?: (manifest: Record<string, unknown>) => void;
  readonly version?: string;
}

/** Builds, releases and (optionally) approves a UI release as the local superuser installer. */
export const release = async (ctx: SuiteContext, options: ReleaseOptions = {}) => {
  const version = options.version ?? ctx.nextVersion();
  const built = await buildUiRelease({
    version,
    label: options.label ?? `Digest ${version}`,
    serverLabel: options.serverLabel,
    dashboardId: ctx.seed.dashboardId,
    uiEntry: options.entry,
    mutate: options.mutate,
    extraDefine: {
      __RECEIVER__: JSON.stringify(ctx.receiver.origin),
      __KIBANA__: JSON.stringify(ctx.kibana),
    },
  });
  await releaseUiPackage(ctx.packageDir, built);
  if (options.approve !== false) {
    await approveRelease({
      manifest: built.manifest,
      esUrl: ctx.es,
      kbUrl: ctx.kibana,
      esAuth: ctx.adminAuth,
      kbAuth: ctx.adminAuth,
    });
  }
  ctx.current = built.manifest;
  ctx.currentEntry = options.entry ?? 'ui/src/main.ts';
  return built;
};

export const consentNow = () => readConsent();

export interface Session {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly console: string[];
  close(): Promise<void>;
}

/** New browser + cookie session for `user`, with console capture. */
export const session = async (
  ctx: SuiteContext,
  engine: string,
  user: UiUser,
  initScript?: string
): Promise<Session> => {
  const browser = await launch(engine);
  const context = await browser.newContext({ acceptDownloads: true });
  if (initScript) await context.addInitScript({ content: initScript });
  await login(context, ctx.kibana, user);
  const page = await context.newPage();
  const consoleLines: string[] = [];
  page.on('console', (message) =>
    consoleLines.push(`${message.type()}: ${message.text()}`.slice(0, 400))
  );
  return {
    browser,
    context,
    page,
    console: consoleLines,
    // Graceful close: use the app's own Disable control so the parent revokes its lease (4 per
    // principal, 5-minute TTL), then close with beforeunload/pagehide.
    close: async () => {
      for (const open of context.pages()) {
        const disable = open.locator('[data-test-subj="appHostDisable"]');
        if (await disable.isEnabled({ timeout: 500 }).catch(() => false)) {
          await Promise.all([
            open
              .waitForResponse((r) => /\/revoke$/.test(r.url()), { timeout: 3000 })
              .catch(() => undefined),
            disable.click({ timeout: 1000 }).catch(() => undefined),
          ]);
        }
        await open.close({ runBeforeUnload: true }).catch(() => undefined);
      }
      await new Promise((done) => setTimeout(done, 300));
      await browser.close();
    },
  };
};

export const readSeed = readUiSeed;
