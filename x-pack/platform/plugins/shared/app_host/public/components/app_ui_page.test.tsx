/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { MessageChannel as NodeMessageChannel } from 'node:worker_threads';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@kbn/i18n-react';
import { httpServiceMock } from '@kbn/core/public/mocks';
import type { BridgeWorkerInit, BridgeWorkerNotice, UiAppMetadata } from '../../common/ui_protocol';
import type { BridgeWorkerLike } from '../ui_host/frame_host';
import { AppUiPage } from './app_ui_page';

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

class FakeWorker implements BridgeWorkerLike {
  onmessage: BridgeWorkerLike['onmessage'] = null;
  onerror: BridgeWorkerLike['onerror'] = null;
  onmessageerror: BridgeWorkerLike['onmessageerror'] = null;
  readonly posted: Array<{ message: BridgeWorkerInit; transfer: Transferable[] }> = [];
  terminated = false;
  postMessage(message: BridgeWorkerInit, transfer: Transferable[]) {
    this.posted.push({ message, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  notify(notice: BridgeWorkerNotice) {
    this.onmessage?.({ data: notice } as MessageEvent<BridgeWorkerNotice>);
  }
}

// jsdom has no MessageChannel; the frame host only creates and closes ports here.
beforeAll(() => {
  Object.assign(globalThis, { MessageChannel: NodeMessageChannel });
});

const setup = () => {
  const http = httpServiceMock.createStartContract();
  http.get.mockImplementation((async () => metadataFor(DIGEST_A)) as unknown as typeof http.get);
  const workers: FakeWorker[] = [];
  const createWorker = jest.fn(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const view = render(
    <I18nProvider>
      <AppUiPage http={http} createWorker={createWorker} />
    </I18nProvider>
  );
  const guardians = () => document.querySelectorAll('[data-test-subj="appHostGuardianFrame"]');
  return { http, view, workers, createWorker, guardians };
};

const allow = async () => {
  const button = await screen.findByTestId('appHostAllowVersion');
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
};

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

describe('AppUiPage bridge Worker lifecycle', () => {
  it('starts one Worker on consent with lifecycle data only, then mounts one frame when it is ready', async () => {
    const { workers, guardians } = setup();
    await allow();
    await waitFor(() => expect(workers).toHaveLength(1));
    const [{ message, transfer }] = workers[0].posted;
    expect(message).toMatchObject({
      t: 'init',
      appId: 'alert-digest',
      releaseDigest: DIGEST_A,
      sessionUrl: '/internal/app_host/ui/session',
      executeUrl: '/internal/app_host/ui/execute',
    });
    expect(transfer).toHaveLength(1);
    expect(guardians()).toHaveLength(0);
    await act(async () => workers[0].notify({ t: 'ready' }));
    await settle();
    expect(guardians()).toHaveLength(1);
  });

  it('Disable before the session is minted terminates the Worker and never mounts a frame', async () => {
    const { workers, guardians } = setup();
    await allow();
    await waitFor(() => expect(workers).toHaveLength(1));
    fireEvent.click(screen.getByTestId('appHostDisable'));
    expect(workers[0].terminated).toBe(true);
    await act(async () => workers[0].notify({ t: 'ready' }));
    await settle();
    expect(guardians()).toHaveLength(0);
  });

  it('unmount terminates the Worker', async () => {
    const { view, workers, guardians } = setup();
    await allow();
    await waitFor(() => expect(workers).toHaveLength(1));
    view.unmount();
    expect(workers[0].terminated).toBe(true);
    expect(guardians()).toHaveLength(0);
  });

  it('a server rejection or queue overflow ends the frame, terminates the Worker and the page keeps working', async () => {
    const { http, workers, guardians } = setup();
    await allow();
    await waitFor(() => expect(workers).toHaveLength(1));
    await act(async () => workers[0].notify({ t: 'ready' }));
    await act(async () => workers[0].notify({ t: 'end', reason: 'app_stale' }));
    await settle();
    expect(workers[0].terminated).toBe(true);
    expect(guardians()).toHaveLength(0);
    expect(screen.getByTestId('appHostFrameStatus').textContent).toBe('ended: stale');
    // S10: one metadata re-read after the rejection.
    expect(http.get).toHaveBeenCalledTimes(2);

    await allow();
    await waitFor(() => expect(workers).toHaveLength(2));
    await act(async () => workers[1].notify({ t: 'ready' }));
    await act(async () => workers[1].notify({ t: 'end', reason: 'queue_overflow' }));
    await settle();
    expect(workers[1].terminated).toBe(true);
    expect(guardians()).toHaveLength(0);
    expect(screen.getByTestId('appHostFrameStatus').textContent).toBe(
      'ended: protocol_error (queue_overflow)'
    );
    expect(screen.getByTestId('appHostAllowVersion')).not.toBeDisabled();
  });

  it('a Worker error ends the frame', async () => {
    const { workers, guardians } = setup();
    await allow();
    await waitFor(() => expect(workers).toHaveLength(1));
    await act(async () => workers[0].notify({ t: 'ready' }));
    await act(async () => workers[0].onerror?.({} as ErrorEvent));
    await settle();
    expect(workers[0].terminated).toBe(true);
    expect(guardians()).toHaveLength(0);
    expect(screen.getByTestId('appHostFrameStatus').textContent).toBe('ended: worker_error');
  });

  it('starts nothing before consent and never polls the metadata', async () => {
    const { http, createWorker } = setup();
    await screen.findByTestId('appHostAllowVersion');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise((resolve) => setTimeout(resolve, 2500));
    });
    expect(http.get).toHaveBeenCalledTimes(1);
    expect(createWorker).not.toHaveBeenCalled();
  });
});
