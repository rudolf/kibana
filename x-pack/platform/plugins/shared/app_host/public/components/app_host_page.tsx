/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  EuiBasicTable,
  EuiButton,
  EuiPageTemplate,
  EuiSpacer,
  EuiText,
  type EuiBasicTableColumn,
} from '@elastic/eui';
import type { HttpSetup } from '@kbn/core/public';
import { i18n } from '@kbn/i18n';
import { FormattedMessage } from '@kbn/i18n-react';
import { KbnDangerCallout } from '@kbn/ui-callout';
import type { AppSummaryResponse, InstalledAppSummary, ListAppsResponse } from '../../common';
import { INSTALLED_APP_ID, INTERNAL_APPS_PATH, summaryPath } from '../../common';

interface SeverityRow {
  readonly severity: string;
  readonly count: number;
}

interface PageState {
  readonly loading: boolean;
  readonly app?: InstalledAppSummary;
  readonly summary?: AppSummaryResponse;
  readonly error?: string;
}

const columns: Array<EuiBasicTableColumn<SeverityRow>> = [
  {
    field: 'severity',
    name: i18n.translate('xpack.appHost.page.severityColumn', { defaultMessage: 'Severity' }),
  },
  {
    field: 'count',
    name: i18n.translate('xpack.appHost.page.countColumn', { defaultMessage: 'Alerts' }),
    dataType: 'number',
  },
];

/** Host-owned error text: HTTP status plus an optional fixed error code; never app HTML. */
const describeError = (error: unknown): string => {
  const { response, body } = error as {
    response?: { status?: number };
    body?: { attributes?: { code?: unknown } };
  };
  const code = typeof body?.attributes?.code === 'string' ? ` (${body.attributes.code})` : '';
  return `${response?.status ?? 'error'}${code}`;
};

export const AppHostPage = ({ http }: { http: HttpSetup }) => {
  const [state, setState] = useState<PageState>({ loading: true });

  const refresh = useCallback(async () => {
    setState((previous) => ({ ...previous, loading: true }));
    try {
      const [{ apps }, summary] = await Promise.all([
        http.get<ListAppsResponse>(INTERNAL_APPS_PATH),
        http.get<AppSummaryResponse>(summaryPath(INSTALLED_APP_ID)),
      ]);
      setState({ loading: false, app: apps[0], summary });
    } catch (error) {
      setState({ loading: false, error: describeError(error) });
    }
  }, [http]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const { loading, app, summary, error } = state;
  const rows: SeverityRow[] = summary
    ? [
        { severity: 'high', count: summary.counts.high },
        { severity: 'low', count: summary.counts.low },
      ]
    : [];

  return (
    <EuiPageTemplate>
      <EuiPageTemplate.Header
        pageTitle={
          app?.title ??
          i18n.translate('xpack.appHost.page.defaultTitle', { defaultMessage: 'App Host' })
        }
        description={
          app ? (
            <FormattedMessage
              id="xpack.appHost.page.version"
              defaultMessage="Installed version {version}"
              values={{ version: app.version }}
            />
          ) : undefined
        }
        rightSideItems={[
          <EuiButton
            key="refresh"
            iconType="refresh"
            isLoading={loading}
            onClick={refresh}
            data-test-subj="appHostRefresh"
          >
            <FormattedMessage id="xpack.appHost.page.refresh" defaultMessage="Refresh" />
          </EuiButton>,
        ]}
      />
      <EuiPageTemplate.Section>
        {error ? (
          <KbnDangerCallout
            title={i18n.translate('xpack.appHost.page.errorTitle', {
              defaultMessage: 'The app could not be run',
            })}
            text={i18n.translate('xpack.appHost.page.errorBody', {
              defaultMessage: 'Kibana returned {error}.',
              values: { error },
            })}
            data-test-subj="appHostError"
          />
        ) : null}
        {summary ? (
          <>
            <EuiText data-test-subj="appHostLabel">
              <h3>{summary.label}</h3>
            </EuiText>
            <EuiSpacer size="m" />
          </>
        ) : null}
        <EuiBasicTable<SeverityRow>
          tableCaption={i18n.translate('xpack.appHost.page.tableCaption', {
            defaultMessage: 'Synthetic alerts by severity, computed by the app in a remote worker',
          })}
          items={rows}
          columns={columns}
          loading={loading}
          data-test-subj="appHostSeverityTable"
        />
      </EuiPageTemplate.Section>
    </EuiPageTemplate>
  );
};
