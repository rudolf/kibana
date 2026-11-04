/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Sample alert-digest UI: renders its version plus three panels (app summary, raw synthetic ES
// records, one dashboard title). All data is rendered with textContent, never as markup.

import { connectBridge, errorCode, type Theme } from './sdk';

declare const __UI_VERSION__: string;
declare const __UI_LABEL__: string;
declare const __DASHBOARD_ID__: string;

const root = document.getElementById('app-root') ?? document.body;

const panel = (id: string, title: string): HTMLElement => {
  const section = document.createElement('section');
  section.id = id;
  section.style.cssText = 'margin:8px 0;padding:8px;border:1px solid currentColor;';
  const heading = document.createElement('h3');
  heading.textContent = title;
  heading.style.margin = '0 0 4px';
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = 'loading';
  section.append(heading, body);
  root.append(section);
  return body;
};

const header = document.createElement('div');
header.id = 'ui-version';
header.textContent = `${__UI_LABEL__} UI ${__UI_VERSION__}`;
header.style.cssText = 'font:600 16px sans-serif;margin-bottom:8px;';
root.append(header);

const applyTheme = ({ colors }: Theme) => {
  document.body.style.cssText = `margin:8px;font:14px sans-serif;background:${colors.background};color:${colors.text};`;
};

const run = async () => {
  const connection = connectBridge();
  if (!connection) {
    header.textContent += ' (no bridge)';
    return;
  }
  const { bridge } = connection;
  const status = panel('bridge-status', 'Bridge');
  try {
    applyTheme(await bridge.getTheme());
    status.textContent = 'connected';
  } catch (error) {
    status.textContent = `theme: ${errorCode(error)}`;
  }
  const summary = panel('panel-summary', 'App summary (remote app code)');
  const records = panel('panel-records', 'Synthetic records (raw)');
  const dashboard = panel('panel-dashboard', 'Dashboard');
  try {
    const result = await bridge.callAppRoute({ method: 'GET', path: '/summary' });
    summary.textContent = `${result.label} ${result.version}: high ${result.counts.high}, low ${result.counts.low}`;
  } catch (error) {
    summary.textContent = `error ${errorCode(error)}`;
  }
  try {
    const result = await bridge.search({ index: 'kbn-apps-prototype-alerts', size: 100 });
    records.textContent = '';
    const list = document.createElement('ul');
    for (const record of result.records) {
      const item = document.createElement('li');
      item.textContent = `${record.severity}: ${record.rule}`;
      list.append(item);
    }
    records.append(list);
  } catch (error) {
    records.textContent = `error ${errorCode(error)}`;
  }
  try {
    const result = await bridge.getDashboardPreview({ id: __DASHBOARD_ID__ });
    dashboard.textContent = result.title;
  } catch (error) {
    dashboard.textContent = `error ${errorCode(error)}`;
  }
  document.body.setAttribute('data-ready', 'true');
};

run();
