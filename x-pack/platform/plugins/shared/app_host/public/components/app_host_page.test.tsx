/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@kbn/i18n-react';
import { httpServiceMock } from '@kbn/core/public/mocks';
import { AppHostPage } from './app_host_page';

const respond = (http: ReturnType<typeof httpServiceMock.createStartContract>, label: string) => {
  http.get.mockImplementation((async (path: string) =>
    path === '/internal/app_host/apps'
      ? { apps: [{ id: 'alert-digest', title: 'Alert digest', version: '1.0.0' }] }
      : {
          appId: 'alert-digest',
          version: '1.0.0',
          label,
          counts: { high: 2, low: 1 },
        }) as typeof http.get);
};

const renderPage = (http: ReturnType<typeof httpServiceMock.createStartContract>) =>
  render(
    <I18nProvider>
      <AppHostPage http={http} />
    </I18nProvider>
  );

describe('AppHostPage', () => {
  it('renders host-owned title, version, label and severity table', async () => {
    const http = httpServiceMock.createStartContract();
    respond(http, 'Digest v1');
    renderPage(http);
    expect(await screen.findByText('Alert digest')).toBeInTheDocument();
    expect(screen.getByText('Installed version 1.0.0')).toBeInTheDocument();
    expect(screen.getByTestId('appHostLabel')).toHaveTextContent('Digest v1');
    const table = screen.getByTestId('appHostSeverityTable');
    expect(table).toHaveTextContent('high');
    expect(table).toHaveTextContent('2');
    expect(table).toHaveTextContent('low');
    expect(http.get).toHaveBeenCalledWith('/api/apps/alert-digest/summary');
  });

  it('refreshes and renders app-supplied text as text, not HTML', async () => {
    const http = httpServiceMock.createStartContract();
    respond(http, 'Digest v1');
    renderPage(http);
    await screen.findByText('Digest v1');
    respond(http, '<img src=x onerror=alert(1)>');
    fireEvent.click(screen.getByTestId('appHostRefresh'));
    await waitFor(() =>
      expect(screen.getByTestId('appHostLabel')).toHaveTextContent('<img src=x onerror=alert(1)>')
    );
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('shows the host error code when the invocation fails', async () => {
    const http = httpServiceMock.createStartContract();
    http.get.mockRejectedValue({
      response: { status: 502 },
      body: { attributes: { code: 'app_failed' } },
    });
    renderPage(http);
    expect(await screen.findByTestId('appHostError')).toHaveTextContent('502 (app_failed)');
  });
});
