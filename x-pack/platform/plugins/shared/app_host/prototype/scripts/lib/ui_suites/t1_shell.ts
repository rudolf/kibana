/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// T1 — shell and direct-open (S1, S2, S3, S6, S7): final-wire headers on every app surface,
// unchanged Core headers on a normal route, iframe attribute snapshots, opaque origin, exact script
// URLs, fetch-metadata gate, attachment assets and no CSP reports from app surfaces.

import { UI_SECURITY_PROFILE } from '../../../../common/ui_contract';
import {
  APP_URL,
  childFrame,
  pollFrame,
  guardianFrame,
  openAndAllow,
  sleep,
  waitForChild,
  waitForStatus,
} from '../ui_harness';
import { kfetch, release, session, type KibanaResponse, type SuiteContext } from './context';

const T = 'T1';

export const splitPolicies = (header: string | undefined): string[] =>
  (header ?? '')
    .split(',')
    .map((policy) => policy.trim())
    .filter(Boolean);

const directive = (policy: string, name: string): string | undefined =>
  policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.split(/\s+/)[0] === name);

/** Checks the composed headers every app surface must carry (S1/S2), returning failures. */
export const appSurfaceProblems = (response: KibanaResponse, surfacePolicy: string): string[] => {
  const problems: string[] = [];
  const { headers } = response;
  const policies = splitPolicies(headers['content-security-policy']);
  if (policies.length !== 2) problems.push(`expected 2 policies, got ${policies.length}`);
  const [core, strict] = policies;
  if (!core || !/script-src 'self'/.test(core)) problems.push('core policy restrictions missing');
  if (/report-uri|report-to|'report-sample'/.test(headers['content-security-policy'] ?? '')) {
    problems.push('reporting directive/sample token present');
  }
  if (strict !== surfacePolicy) problems.push(`strict policy mismatch: ${strict}`);
  if ((headers['content-security-policy-report-only'] ?? '') !== '') {
    problems.push('active report-only policy');
  }
  if (headers['referrer-policy'] !== 'no-referrer') problems.push('referrer-policy');
  if (headers['permissions-policy'] !== UI_SECURITY_PROFILE.permissionsPolicy) {
    problems.push('permissions-policy');
  }
  if (headers['x-dns-prefetch-control'] !== 'off') problems.push('x-dns-prefetch-control');
  if (!/no-store/.test(headers['cache-control'] ?? '')) problems.push('cache-control');
  if (headers['x-content-type-options'] !== 'nosniff') problems.push('nosniff');
  return problems;
};

export const guardianPolicyFor = (ctx: SuiteContext, releaseDigest: string) =>
  UI_SECURITY_PROFILE.guardianCsp
    .replace('{guardianScript}', `${ctx.kibana}/api/app_host/ui_assets/host-guardian.js`)
    .replace('{childDocument}', `${ctx.kibana}/api/app_host/ui/alert-digest/${releaseDigest}/frame`)
    .replace('{origin}', ctx.kibana);

export const childPolicyFor = (ctx: SuiteContext, uiDigest: string) =>
  UI_SECURITY_PROFILE.childCsp
    .replace('{bootstrapScript}', `${ctx.kibana}/api/app_host/ui_assets/host-child.js`)
    .replace('{uiScript}', `${ctx.kibana}/api/app_host/ui_assets/${uiDigest}.js`)
    .replace('{origin}', ctx.kibana);

const dump = (response: KibanaResponse) => ({
  status: response.status,
  headers: Object.fromEntries(
    Object.entries(response.headers).filter(
      ([key]) =>
        !['date', 'connection', 'keep-alive', 'kbn-license-sig', 'server-timing'].includes(key)
    )
  ),
});

export const headerDumps: Record<string, unknown> = {};

export const runT1Http = async (ctx: SuiteContext) => {
  const { report } = ctx;
  const engine = 'http';
  const manifest = ctx.current;
  if (!manifest) throw new Error('no current release');
  const viewer = ctx.users.viewer;
  const base = `/api/app_host/ui/alert-digest/${manifest.releaseDigest}`;
  const iframe = { 'sec-fetch-dest': 'iframe' };

  const guardian = await kfetch(ctx, `${base}/guardian`, { user: viewer, headers: iframe });
  headerDumps.guardian = dump(guardian);
  report.expect(
    T,
    'guardian 200 html',
    engine,
    guardian.status === 200 && /^text\/html/.test(guardian.headers['content-type'] ?? ''),
    guardian.status
  );
  const guardianProblems = appSurfaceProblems(
    guardian,
    guardianPolicyFor(ctx, manifest.releaseDigest)
  );
  report.expect(
    T,
    'guardian final-wire headers (S1/S2)',
    engine,
    guardianProblems.length === 0,
    guardianProblems
  );
  report.expect(
    T,
    'guardian exact guardian script URL, no self script grant',
    engine,
    directive(splitPolicies(guardian.headers['content-security-policy'])[1] ?? '', 'script-src') ===
      `script-src ${ctx.kibana}/api/app_host/ui_assets/host-guardian.js`
  );

  const frame = await kfetch(ctx, `${base}/frame`, { user: viewer, headers: iframe });
  headerDumps.frame = dump(frame);
  const childProblems = appSurfaceProblems(frame, childPolicyFor(ctx, manifest.ui.digest));
  report.expect(
    T,
    'frame 200 + composed child policy incl. sandbox allow-scripts',
    engine,
    frame.status === 200 && childProblems.length === 0,
    childProblems
  );
  const childStrict = splitPolicies(frame.headers['content-security-policy'])[1] ?? '';
  report.expect(
    T,
    'frame exact bootstrap+UI script URLs (no self)',
    engine,
    directive(childStrict, 'script-src') ===
      `script-src ${ctx.kibana}/api/app_host/ui_assets/host-child.js ${ctx.kibana}/api/app_host/ui_assets/${manifest.ui.digest}.js`,
    directive(childStrict, 'script-src')
  );
  report.expect(
    T,
    'frame connect-src none, img-src data:, sandbox first',
    engine,
    /^sandbox allow-scripts;/.test(childStrict) &&
      /connect-src 'none'/.test(childStrict) &&
      /img-src data:;/.test(childStrict)
  );

  for (const [name, dest] of [
    ['missing', undefined],
    ['document', 'document'],
    ['embed', 'embed'],
    ['object', 'object'],
  ] as const) {
    for (const doc of ['guardian', 'frame']) {
      const response = await kfetch(ctx, `${base}/${doc}`, {
        user: viewer,
        headers: dest ? { 'sec-fetch-dest': dest } : {},
      });
      if (name === 'missing' && doc === 'guardian')
        headerDumps.guardianStandalone403 = dump(response);
      const problems = appSurfaceProblems(response, UI_SECURITY_PROFILE.jsonCsp);
      report.expect(
        T,
        `${doc} Sec-Fetch-Dest ${name} → 403 JSON, no HTML, composed (S1)`,
        engine,
        response.status === 403 && !/<html|<script/i.test(response.text) && problems.length === 0,
        { status: response.status, problems }
      );
    }
  }

  const canary = 'MARKUPCANARY';
  const s7: Array<[string, string]> = [
    ['query string', `${base}/frame?x=1`],
    ['unapproved digest', `/api/app_host/ui/alert-digest/${'0'.repeat(64)}/frame`],
    ['malformed digest', '/api/app_host/ui/alert-digest/zz/guardian'],
    ['other app', `/api/app_host/ui/other-app/${manifest.releaseDigest}/guardian`],
    [
      'markup canary in path',
      `/api/app_host/ui/%3Cscript%3E${canary}/${manifest.releaseDigest}/guardian`,
    ],
    ['unknown document', `${base}/index.html`],
  ];
  for (const [name, path] of s7) {
    const response = await kfetch(ctx, path, { user: viewer, headers: iframe });
    report.expect(
      T,
      `S7 ${name} → no HTML body`,
      engine,
      response.status >= 400 &&
        !/<html|<script/i.test(response.text) &&
        !response.text.includes(canary) &&
        appSurfaceProblems(response, UI_SECURITY_PROFILE.jsonCsp).length === 0,
      { status: response.status }
    );
  }

  for (const [name, file] of [
    ['guardian asset', 'host-guardian.js'],
    ['child bootstrap asset', 'host-child.js'],
    ['ui asset', `${manifest.ui.digest}.js`],
  ] as const) {
    const response = await kfetch(ctx, `/api/app_host/ui_assets/${file}`);
    if (name === 'ui asset') headerDumps.asset = dump(response);
    const problems = appSurfaceProblems(response, UI_SECURITY_PROFILE.assetCsp);
    report.expect(
      T,
      `${name}: JS + attachment + nosniff + sandbox (unauthenticated)`,
      engine,
      response.status === 200 &&
        /^application\/javascript/.test(response.headers['content-type'] ?? '') &&
        /^attachment/.test(response.headers['content-disposition'] ?? '') &&
        problems.length === 0,
      { status: response.status, problems }
    );
  }
  for (const [name, file] of [
    ['unknown digest', `${'a'.repeat(64)}.js`],
    ['server bundle digest (not the UI digest)', `${manifest.digest}.js`],
    ['html file', 'index.html'],
    ['svg file', 'x.svg'],
    ['query string', `host-guardian.js?x=1`],
  ] as const) {
    const response = await kfetch(ctx, `/api/app_host/ui_assets/${file}`);
    report.expect(
      T,
      `S6 asset ${name} → 404 (never 401/403)`,
      engine,
      response.status === 404 && !/<html/i.test(response.text),
      response.status
    );
  }

  const metadata = await kfetch(ctx, '/internal/app_host/ui/apps/alert-digest', {
    user: viewer,
    headers: { 'x-elastic-internal-origin': 'Kibana' },
  });
  headerDumps.json = dump(metadata);
  report.expect(
    T,
    'JSON surface: application/json + sandbox JSON policy',
    engine,
    metadata.status === 200 &&
      /^application\/json/.test(metadata.headers['content-type'] ?? '') &&
      appSurfaceProblems(metadata, UI_SECURITY_PROFILE.jsonCsp).length === 0
  );

  for (const path of ['/api/status', '/app/home']) {
    const control = await kfetch(ctx, path, { user: viewer });
    if (path === '/app/home') headerDumps.controlKibanaRoute = dump(control);
    const csp = control.headers['content-security-policy'] ?? '';
    report.expect(
      T,
      `control ${path}: Core headers untouched`,
      engine,
      splitPolicies(csp).length === 1 &&
        /report-uri/.test(csp) &&
        /'report-sample'/.test(csp) &&
        (control.headers['content-security-policy-report-only'] ?? '').length > 0 &&
        control.headers['referrer-policy'] === 'strict-origin-when-cross-origin' &&
        control.headers['x-dns-prefetch-control'] === undefined &&
        control.headers['permissions-policy'] !== UI_SECURITY_PROFILE.permissionsPolicy,
      { status: control.status }
    );
  }
};

const snapshotAttributes = (element: Element | null) =>
  element ? Object.fromEntries(Array.from(element.attributes).map((a) => [a.name, a.value])) : null;

/** Browser half of T1 with the normal sample UI (runs per engine). */
export const runT1Browser = async (ctx: SuiteContext, engine: string) => {
  const { report } = ctx;
  const manifest = ctx.current;
  if (!manifest) throw new Error('no current release');
  const s = await session(ctx, engine, ctx.users.viewer);
  try {
    const { page } = s;
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.goto(`${ctx.kibana}${APP_URL}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-test-subj="appHostAllowVersion"]').waitFor({ timeout: 180_000 });
    await sleep(2500);
    report.expect(
      T,
      'before consent: no guest frame, port or lease',
      engine,
      (await page.locator('iframe').count()) === 0 &&
        !requests.some((url) => /\/api\/app_host\/ui\/|\/internal\/app_host\/ui\/leases/.test(url)),
      { iframes: await page.locator('iframe').count() }
    );
    const consent = await page.locator('[data-test-subj="appHostConsentCopy"]').innerText();
    report.expect(
      T,
      'required consent copy + four channels outside the frame',
      engine,
      consent.includes('Anything this app can read may leave your deployment.') &&
        ['DNS', 'WebRTC', 'self-navigation', 'app server'].every((word) =>
          consent.includes(word)
        ) &&
        consent.includes('Do not enter credentials into this app.')
    );
    await openAndAllow(page, ctx.kibana);
    await waitForStatus(page, /^bound$/);
    const child = await waitForChild(page);
    await child.waitForSelector('#ui-version', { timeout: 20_000 });
    const guardianAttributes = await page.evaluate(() => {
      const element = document.querySelector('[data-test-subj="appHostGuardianFrame"]');
      return element
        ? Object.fromEntries(Array.from(element.attributes).map((a) => [a.name, a.value]))
        : null;
    });
    const guardianSnapshot: Record<string, string> = {
      ...(guardianAttributes ?? {}),
      src: '<guardian>',
      style: '<fixed>',
    };
    report.expect(
      T,
      'S3 guardian iframe attribute snapshot',
      engine,
      JSON.stringify(Object.keys(guardianSnapshot).sort()) ===
        JSON.stringify(['data-test-subj', 'referrerpolicy', 'src', 'style', 'title']) &&
        guardianSnapshot.referrerpolicy === 'no-referrer',
      guardianSnapshot
    );
    const guardian = guardianFrame(page);
    const childAttributes = await guardian?.evaluate(() => {
      const element = document.querySelector('iframe');
      return element
        ? Object.fromEntries(Array.from(element.attributes).map((a) => [a.name, a.value]))
        : null;
    });
    report.expect(
      T,
      'child iframe exact attributes (sandbox=allow-scripts, no allow/fullscreen)',
      engine,
      JSON.stringify(Object.keys(childAttributes ?? {}).sort()) ===
        JSON.stringify(['referrerpolicy', 'sandbox', 'src', 'title']) &&
        childAttributes?.sandbox === 'allow-scripts' &&
        childAttributes?.referrerpolicy === 'no-referrer',
      childAttributes
    );
    const inside = await child.evaluate(() => ({
      origin: self.origin,
      version: document.getElementById('ui-version')?.textContent,
      windowName: window.name,
    }));
    report.expect(
      T,
      'effective origin null + classic UI asset loaded in frame',
      engine,
      inside.origin === 'null' &&
        inside.version === `Digest ${manifest.version} UI ${manifest.version}`,
      inside
    );
    report.expect(
      T,
      'trusted label outside frames',
      engine,
      (await page.locator('[data-test-subj="appHostTrustedLabel"]').count()) === 1 &&
        (await child.locator('[data-test-subj="appHostTrustedLabel"]').count()) === 0
    );
    void snapshotAttributes;

    // Direct-open: top-level navigation to entry documents and assets.
    const direct = await s.context.newPage();
    for (const doc of ['guardian', 'frame']) {
      const response = await direct.goto(
        `${ctx.kibana}/api/app_host/ui/alert-digest/${manifest.releaseDigest}/${doc}`
      );
      const body = (await direct.content()).slice(0, 2000);
      report.expect(
        T,
        `top-level navigation to ${doc} → 403, no app HTML`,
        engine,
        response?.status() === 403 &&
          !body.includes('app-host-frame-config') &&
          !body.includes('app-host-guardian-config'),
        { status: response?.status() }
      );
    }
    const assetUrl = `${ctx.kibana}/api/app_host/ui_assets/${manifest.ui.digest}.js`;
    const downloadPromise = direct
      .waitForEvent('download', { timeout: 10_000 })
      .catch(() => undefined);
    const navigation = await direct.goto(assetUrl).then(
      (response) => ({ status: response?.status() ?? 0, error: '' }),
      (error) => ({ status: 0, error: String(error).slice(0, 120) })
    );
    const download = await downloadPromise;
    report.expect(
      T,
      'top-level navigation to asset → attachment download, not rendered',
      engine,
      Boolean(download) || /download/i.test(navigation.error),
      { navigation, download: download ? download.suggestedFilename() : null }
    );
    const badAsset = await direct.goto(`${ctx.kibana}/api/app_host/ui_assets/${'b'.repeat(64)}.js`);
    const stillLoggedIn = await s.context.request.get(`${ctx.kibana}/internal/security/me`, {
      headers: { 'x-elastic-internal-origin': 'Kibana' },
    });
    report.expect(
      T,
      'S6 bad-digest asset top-level → 404, no reset_session redirect, session kept',
      engine,
      badAsset?.status() === 404 &&
        !/reset_session|login/.test(direct.url()) &&
        stillLoggedIn.status() === 200,
      { status: badAsset?.status(), url: direct.url().slice(0, 120) }
    );
  } finally {
    await s.close();
  }
};

/** T1 execution/CSP-report probes with the hostile fixture installed (per engine). */
export const runT1Hostile = async (ctx: SuiteContext, engine: string) => {
  const { report } = ctx;
  const before = ctx.collector.hits.length;
  const s = await session(ctx, engine, ctx.users.viewer);
  try {
    const { page } = s;
    await openAndAllow(page, ctx.kibana);
    await waitForStatus(page, /^bound$/);
    const child = await waitForChild(page);
    await pollFrame(
      child,
      () => (window as unknown as { __probe?: { done: boolean } }).__probe?.done
    );
    const probe = (await child.evaluate(
      () => (window as unknown as { __probe: unknown }).__probe
    )) as {
      results: Record<string, string>;
      violations: string[];
    };
    const r = probe.results;
    const blocked = (key: string) => (r[key] ?? '').startsWith('blocked');
    report.expect(
      T,
      'eval / Function / string timer blocked',
      engine,
      blocked('eval') &&
        blocked('function') &&
        !(await child.evaluate(
          () => (window as unknown as { __timeoutRan?: number }).__timeoutRan
        )),
      { eval: r.eval, function: r.function }
    );
    report.expect(
      T,
      'WebAssembly compile/instantiate blocked',
      engine,
      blocked('wasmCompile') && blocked('wasmInstantiate'),
      { compile: r.wasmCompile, instantiate: r.wasmInstantiate }
    );
    report.expect(
      T,
      'dynamic imports blocked',
      engine,
      blocked('dynamicImportReceiver') && blocked('dynamicImportGuardian'),
      { a: r.dynamicImportReceiver, b: r.dynamicImportGuardian }
    );
    report.expect(
      T,
      'other-app/bundle/receiver script injection blocked',
      engine,
      blocked('scriptReceiver') && blocked('scriptOtherHostAsset') && blocked('scriptKibanaBundle'),
      {
        receiver: r.scriptReceiver,
        hostAsset: r.scriptOtherHostAsset,
        bundle: r.scriptKibanaBundle,
      }
    );
    report.expect(
      T,
      'inline script and inline handler blocked',
      engine,
      r.inlineScript === 'blocked' && r.inlineHandler === 'blocked'
    );
    await sleep(3000);
    // Kibana's own page deliberately triggers one inline-script report on load; only reports whose
    // document is an app surface count against the app.
    const appReports = ctx.collector.hits
      .slice(before)
      .filter((hit) => /\/api\/app_host\//.test(hit.body));
    report.expect(
      T,
      'no CSP report/sample from app HTML/assets/JSON despite violations',
      engine,
      appReports.length === 0 && probe.violations.length > 0,
      {
        appSurfaceReports: appReports.length,
        allReports: ctx.collector.hits.length - before,
        violationsObservedInFrame: probe.violations.length,
      }
    );
    // Positive control: a violation in an ordinary Kibana page does reach the collector.
    const control = await s.context.newPage();
    await control.goto(`${ctx.kibana}/app/home`, { waitUntil: 'domcontentloaded' });
    const controlBefore = ctx.collector.hits.length;
    await control.evaluate((src) => {
      const script = document.createElement('script');
      script.src = src;
      document.head.append(script);
    }, `${ctx.receiver.origin}/csp-control.js`);
    await sleep(3000);
    const controlReports = ctx.collector.hits
      .slice(controlBefore)
      .filter((hit) => hit.body.includes('csp-control.js'));
    report.expect(
      T,
      'control: normal Kibana page violation reaches the configured collector',
      engine,
      controlReports.length > 0,
      { reports: controlReports.length }
    );
    void childFrame;
  } finally {
    await s.close();
  }
};

export const runT1 = async (ctx: SuiteContext) => {
  await release(ctx);
  await runT1Http(ctx);
  for (const engine of ctx.engines)
    await ctx.report.guard(T, 'browser', engine, () => runT1Browser(ctx, engine));
  await release(ctx, { entry: 'ui/fixtures/hostile.ts' });
  for (const engine of ctx.engines)
    await ctx.report.guard(T, 'hostile', engine, () => runT1Hostile(ctx, engine));
};
