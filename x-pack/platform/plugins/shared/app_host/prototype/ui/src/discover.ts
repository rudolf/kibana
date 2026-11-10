/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Mini Discover tile: data view picker, field list, editable ES|QL query, results table and a
// count-over-time bar chart. Plain DOM; every data value is set with textContent or a numeric
// style, never as markup. Progress is exposed as data-* attributes on the tile for the tests.

import { errorCode, type Bridge, type EsqlResult, type EsqlValue } from './sdk';

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  id?: string,
  css?: string
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (id) node.id = id;
  if (css) node.style.cssText = css;
  return node;
};

const IDENTIFIER = /^[@A-Za-z_][A-Za-z0-9_.@]*$/;
/** ES|QL identifier: as-is when simple, otherwise backtick-quoted. */
const ident = (name: string) => (IDENTIFIER.test(name) ? name : `\`${name.replace(/`/g, '``')}\``);

const cellText = (value: EsqlValue): string =>
  value === null ? '' : Array.isArray(value) ? value.map(String).join(', ') : String(value);

export const mountDiscover = (root: HTMLElement, bridge: Bridge): void => {
  const tile = el('section', 'discover', 'margin:8px 0;padding:8px;border:1px solid currentColor;');
  const heading = el('h3', undefined, 'margin:0 0 4px');
  heading.textContent = 'Mini Discover';
  const picker = el('select', 'dv-picker');
  const placeholder = el('option');
  placeholder.value = '';
  placeholder.textContent = 'Select a data view';
  picker.append(placeholder);
  const fields = el(
    'div',
    'dv-fields',
    'font-size:12px;margin:4px 0;max-height:72px;overflow:auto;'
  );
  const query = el(
    'textarea',
    'esql-query',
    'width:100%;box-sizing:border-box;font:12px monospace;'
  );
  query.rows = 2;
  const run = el('button', 'esql-run');
  run.textContent = 'Run';
  const status = el('div', 'esql-status', 'font-size:12px;margin:4px 0;');
  const chart = el('div', 'esql-chart', 'display:flex;align-items:flex-end;gap:1px;height:60px;');
  const table = el('table', 'esql-results', 'border-collapse:collapse;font-size:12px;width:100%;');
  tile.append(heading, picker, fields, query, run, status, chart, table);
  root.append(tile);

  const fail = (where: string, error: unknown) => {
    const code = errorCode(error);
    status.textContent = `${where}: error ${code}`;
    tile.setAttribute('data-error', code);
  };

  const renderTable = ({ columns, values }: EsqlResult) => {
    table.textContent = '';
    const head = el('tr');
    for (const column of columns) {
      const th = el('th', undefined, 'text-align:left;border-bottom:1px solid currentColor;');
      th.textContent = column.name;
      head.append(th);
    }
    table.append(head);
    for (const row of values) {
      const tr = el('tr');
      for (const value of row) {
        const td = el('td', undefined, 'padding:1px 4px;vertical-align:top;');
        td.textContent = cellText(value);
        tr.append(td);
      }
      table.append(tr);
    }
    tile.setAttribute('data-rows', String(values.length));
  };

  const renderChart = ({ columns, values }: EsqlResult) => {
    chart.textContent = '';
    const countAt = columns.findIndex(({ name }) => name === 'c');
    const bucketAt = columns.findIndex(({ name }) => name === 'b');
    const counts = values.map((row) => Number(row[countAt]) || 0);
    const max = Math.max(1, ...counts);
    values.forEach((row, i) => {
      const bar = el('div', undefined, 'flex:1;background:currentColor;opacity:0.6;');
      bar.style.height = `${Math.round((counts[i] / max) * 100)}%`;
      bar.className = 'bar';
      bar.title = `${cellText(row[bucketAt])}: ${counts[i]}`;
      chart.append(bar);
    });
    tile.setAttribute('data-buckets', String(values.length));
    tile.setAttribute('data-bucket-total', String(counts.reduce((sum, count) => sum + count, 0)));
  };

  const runQuery = async () => {
    tile.removeAttribute('data-rows');
    tile.removeAttribute('data-error');
    status.textContent = 'running';
    try {
      const result = await bridge.esql({ query: query.value });
      renderTable(result);
      status.textContent = `${result.values.length} rows`;
    } catch (error) {
      table.textContent = '';
      fail('esql', error);
    }
  };

  const runHistogram = async (title: string, timeField: string) => {
    tile.removeAttribute('data-buckets');
    try {
      renderChart(
        await bridge.esql({
          query: `FROM ${title} | STATS c = COUNT(*) BY b = BUCKET(${ident(
            timeField
          )}, 1 hour) | SORT b`,
        })
      );
    } catch (error) {
      chart.textContent = '';
      fail('histogram', error);
    }
  };

  picker.addEventListener('change', async () => {
    const id = picker.value;
    fields.textContent = '';
    table.textContent = '';
    chart.textContent = '';
    for (const name of [
      'data-fields',
      'data-runtime-fields',
      'data-rows',
      'data-buckets',
      'data-error',
    ]) {
      tile.removeAttribute(name);
    }
    if (!id) return;
    try {
      const { data_view: view } = await bridge.getDataView({ id });
      const list = Object.values(view.fields).sort((a, b) => a.name.localeCompare(b.name));
      fields.textContent = list
        .map(
          ({ name, type, runtimeField }) => `${name} (${type}${runtimeField ? ', runtime' : ''})`
        )
        .join(', ');
      tile.setAttribute('data-fields', String(list.length));
      tile.setAttribute(
        'data-runtime-fields',
        String(Object.keys(view.runtimeFieldMap ?? {}).length)
      );
      const sort = view.timeFieldName ? ` | SORT ${ident(view.timeFieldName)} DESC` : '';
      query.value = `FROM ${view.title}${sort} | LIMIT 50`;
      await Promise.all([
        runQuery(),
        view.timeFieldName ? runHistogram(view.title, view.timeFieldName) : undefined,
      ]);
    } catch (error) {
      fail('data view', error);
    }
  });
  run.addEventListener('click', () => runQuery());

  bridge.listDataViews().then(
    ({ data_view: views }) => {
      for (const view of views) {
        const option = el('option');
        option.value = view.id;
        option.textContent = `${view.name || view.title} (${view.title})`;
        picker.append(option);
      }
      tile.setAttribute('data-views', String(views.length));
    },
    (error) => fail('data views', error)
  );
};
