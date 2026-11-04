/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import type { AppMountParameters, CoreStart } from '@kbn/core/public';
import { KibanaRenderContextProvider } from '@kbn/react-kibana-context-render';
import { UI_DEEP_LINK_PATH } from '../common/ui_protocol';
import { AppHostPage } from './components/app_host_page';
import { AppUiPage } from './components/app_ui_page';
import { createLeaseFactory } from './ui_host/lease_client';

const isUiPath = (pathname: string): boolean =>
  pathname === UI_DEEP_LINK_PATH || pathname.startsWith(`${UI_DEEP_LINK_PATH}/`);

const Router = ({ core, history }: { core: CoreStart; history: AppMountParameters['history'] }) => {
  const [pathname, setPathname] = useState(history.location.pathname);
  useEffect(() => history.listen((location) => setPathname(location.pathname)), [history]);
  return isUiPath(pathname) ? (
    <AppUiPage http={core.http} createLease={createLeaseFactory(core.http)} />
  ) : (
    <AppHostPage http={core.http} />
  );
};

export const renderApp = (core: CoreStart, { element, history }: AppMountParameters) => {
  ReactDOM.render(
    <KibanaRenderContextProvider {...core}>
      <Router core={core} history={history} />
    </KibanaRenderContextProvider>,
    element
  );
  return () => ReactDOM.unmountComponentAtNode(element);
};
