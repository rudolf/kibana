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
import { AppUiPage, type LeaseHandle } from './app_ui_page';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

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

interface HeldLease {
  readonly resolve: (handle: LeaseHandle) => void;
}

const setup = () => {
  const http = httpServiceMock.createStartContract();
  let current = metadataFor(DIGEST_A);
  http.get.mockImplementation((async () => current) as unknown as typeof http.get);
  const held: HeldLease[] = [];
  const createLease = jest.fn(
    () =>
      new Promise<LeaseHandle | undefined>((resolve) => {
        held.push({ resolve });
      })
  );
  const release = jest.fn();
  const handle = (expiresAt = Date.now() + 5 * 60 * 1000): LeaseHandle => ({
    executor: async () => ({ ok: false, code: 'app_denied' }),
    release,
    expiresAt,
  });
  const view = render(
    <I18nProvider>
      <AppUiPage http={http} createLease={createLease} />
    </I18nProvider>
  );
  const setMetadata = (next: UiAppMetadata) => {
    current = next;
  };
  const guardians = () => document.querySelectorAll('[data-test-subj="appHostGuardianFrame"]');
  return { http, view, held, createLease, release, handle, setMetadata, guardians };
};

const allow = async () => {
  const button = await screen.findByTestId('appHostAllowVersion');
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
};

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

describe('AppUiPage lease lifecycle (P1)', () => {
  it('a lease that resolves after Disable never mounts a frame and is released', async () => {
    const { held, createLease, release, handle, guardians } = setup();
    await allow();
    await waitFor(() => expect(createLease).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('appHostDisable'));
    await act(async () => held[0].resolve(handle()));
    await settle();
    expect(guardians()).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a lease that resolves after unmount never mounts a frame and is released', async () => {
    const { view, held, createLease, release, handle, guardians } = setup();
    await allow();
    await waitFor(() => expect(createLease).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => held[0].resolve(handle()));
    await settle();
    expect(guardians()).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a lease that resolves after a release change never mounts a frame and is released', async () => {
    const { held, createLease, release, handle, setMetadata, guardians } = setup();
    await allow();
    await waitFor(() => expect(createLease).toHaveBeenCalledTimes(1));
    setMetadata(metadataFor(DIGEST_B));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.getByTestId('appHostAllowVersion')).not.toBeDisabled());
    await act(async () => held[0].resolve(handle()));
    await settle();
    expect(guardians()).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('positive control: a lease that resolves while consent is current mounts exactly one frame', async () => {
    const { held, createLease, release, handle, guardians } = setup();
    await allow();
    await waitFor(() => expect(createLease).toHaveBeenCalledTimes(1));
    await act(async () => held[0].resolve(handle()));
    await settle();
    expect(guardians()).toHaveLength(1);
    expect(release).not.toHaveBeenCalled();
  });

  it('tears down an idle frame and releases the lease when the lease expires', async () => {
    const { held, createLease, release, handle, guardians } = setup();
    await allow();
    await waitFor(() => expect(createLease).toHaveBeenCalledTimes(1));
    await act(async () => held[0].resolve(handle(Date.now() + 150)));
    await settle();
    expect(guardians()).toHaveLength(1);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(guardians()).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('appHostFrameStatus')).toHaveTextContent('ended: expired');
  });
});
