/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
  /** Receiver referenced only by the preconnect probe (exact TCP attribution, F6). */
  readonly preconnect: Receiver;
  /** Kibana served over local TLS with SameSite=None session cookies (A17 fixture run). */
  readonly tls: boolean;
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
      __PRECONNECT__: JSON.stringify(ctx.preconnect.origin),
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
  // TLS fixture: the local self-signed certificate is trusted for this context only.
  const context = await browser.newContext({ acceptDownloads: true, ignoreHTTPSErrors: ctx.tls });
  if (initScript) await context.addInitScript({ content: initScript });
  await login(context, ctx.kibana, user, { viaBrowser: ctx.tls });
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
    // Nothing to revoke server-side: the parent drops its handle when the page goes away.
    close: async () => {
      for (const open of context.pages()) {
        await open.close({ runBeforeUnload: true }).catch(() => undefined);
      }
      await new Promise((done) => setTimeout(done, 300));
      await browser.close();
    },
  };
};

export const readSeed = readUiSeed;

const REPO_ROOT = resolve(LOCAL_DIR, '..', '..', '..', '..', '..', '..', '..');
const PLUGIN_DIR = 'x-pack/platform/plugins/shared/app_host';

interface JestAssertion {
  readonly title: string;
  readonly ancestorTitles: readonly string[];
  readonly status: string;
}

/**
 * Runs the named plugin Jest files (repository runner) and records one check per required test
 * title: PASS only if that test actually ran and passed in this harness run.
 */
export const jestEvidence = async (
  ctx: SuiteContext,
  test: string,
  files: readonly string[],
  required: ReadonlyArray<readonly [check: string, title: string]>
): Promise<void> => {
  const outputFile = join(LOCAL_DIR, `jest-${test}-${Date.now()}.json`);
  const exitCode = await new Promise<number>((done) => {
    const child = spawn(
      process.execPath,
      [
        'scripts/jest',
        ...files.map((file) => `${PLUGIN_DIR}/${file}`),
        '--json',
        `--outputFile=${outputFile}`,
        '--forceExit',
      ],
      { cwd: REPO_ROOT, stdio: 'ignore' }
    );
    child.on('exit', (code) => done(code ?? 1));
    child.on('error', () => done(1));
  });
  const assertions: JestAssertion[] = existsSync(outputFile)
    ? (
        JSON.parse(readFileSync(outputFile, 'utf8')) as {
          testResults: Array<{ assertionResults: JestAssertion[] }>;
        }
      ).testResults.flatMap((file) => file.assertionResults)
    : [];
  for (const [check, title] of required) {
    const found = assertions.find((assertion) => assertion.title === title);
    ctx.report.expect(test, check, 'jest', found?.status === 'passed', {
      test: title,
      status: found?.status ?? 'not run',
      jestExit: exitCode,
    });
  }
};
