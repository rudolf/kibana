/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@kbn/i18n-react';
import { httpServiceMock } from '@kbn/core/public/mocks';
import type { UiAppMetadata } from '../../common/ui_protocol';
import { AppUiPage, type AppSession } from './app_ui_page';

const DIGEST_A = 'a'.repeat(64);

const metadataFor = (releaseDigest: string, enabled = true): UiAppMetadata => ({
  appId: 'alert-digest',
  title: 'Alert digest',
  publisher: 'Local synthetic demo publisher',
  version: '2.0.0',
  releaseDigest,
  uiDigest: 'c'.repeat(64),
  scopes: ['app.summary'],
  indices: ['kbn-apps-prototype-alerts'],
  dashboardIds: [],
  egress: { client: [], server: [] },
  enabled,
  approved: true,
  guardianPath: `/api/app_host/ui/alert-digest/${releaseDigest}/guardian`,
});

interface HeldSession {
  readonly resolve: (session: AppSession) => void;
}

const setup = () => {
  const http = httpServiceMock.createStartContract();
  http.get.mockImplementation((async () => metadataFor(DIGEST_A)) as unknown as typeof http.get);
  const held: HeldSession[] = [];
  const createSession = jest.fn(
    () =>
      new Promise<AppSession | undefined>((resolve) => {
        held.push({ resolve });
      })
  );
  const session = (): AppSession => ({
    executor: async () => ({ ok: false, code: 'app_denied' }),
  });
  const view = render(
    <I18nProvider>
      <AppUiPage http={http} createSession={createSession} />
    </I18nProvider>
  );
  const guardians = () => document.querySelectorAll('[data-test-subj="appHostGuardianFrame"]');
  return { http, view, held, createSession, session, guardians };
};

const allow = async () => {
  const button = await screen.findByTestId('appHostAllowVersion');
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
};

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

describe('AppUiPage app session lifecycle (P1)', () => {
  it('a session that resolves after Disable never mounts a frame', async () => {
    const { held, createSession, session, guardians } = setup();
    await allow();
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('appHostDisable'));
    await act(async () => held[0].resolve(session()));
    await settle();
    expect(guardians()).toHaveLength(0);
  });

  it('a session that resolves after unmount never mounts a frame', async () => {
    const { view, held, createSession, session, guardians } = setup();
    await allow();
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => held[0].resolve(session()));
    await settle();
    expect(guardians()).toHaveLength(0);
  });

  it('positive control: a session that resolves while consent is current mounts exactly one frame', async () => {
    const { held, createSession, session, guardians } = setup();
    await allow();
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    await act(async () => held[0].resolve(session()));
    await settle();
    expect(guardians()).toHaveLength(1);
  });

  it('mints nothing before consent and never polls the metadata', async () => {
    const { http, createSession } = setup();
    await screen.findByTestId('appHostAllowVersion');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise((resolve) => setTimeout(resolve, 2500));
    });
    expect(http.get).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalled();
  });
});
