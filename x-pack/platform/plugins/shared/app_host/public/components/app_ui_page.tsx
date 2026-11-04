/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { css } from '@emotion/react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCode,
  EuiDescriptionList,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPageTemplate,
  EuiPanel,
  EuiSpacer,
  EuiText,
  useEuiTheme,
} from '@elastic/eui';
import type { HttpStart } from '@kbn/core/public';
import { i18n } from '@kbn/i18n';
import { KbnDangerCallout, KbnWarningCallout } from '@kbn/ui-callout';
import type { UiAppMetadata, UiTheme } from '../../common/ui_protocol';
import { INSTALLED_APP_ID } from '../../common';
import { UI_LIMITS, uiMetadataPath } from '../../common/ui_protocol';
import { FrameHost, type FrameHostEndReason } from '../ui_host/frame_host';
import type { BridgeExecutor } from '../ui_host/bridge_root';

/** §1 required consent copy, shown in host chrome outside the frame. */
export const CONSENT_COPY = i18n.translate('xpack.appHost.ui.consentCopy', {
  defaultMessage:
    'Anything this app can read may leave your deployment. Possible channels include DNS, WebRTC, self-navigation and the app server. Network restrictions reduce opportunities; they do not guarantee confidentiality. Do not enter credentials into this app.',
});
export const LOCAL_PROCESSOR_COPY = i18n.translate('xpack.appHost.ui.localProcessorCopy', {
  defaultMessage:
    'This local demo runs its app server on local Wrangler. Cloudflare is a separate, not-yet-approved remote processor.',
});

export interface LeaseHandle {
  readonly executor: BridgeExecutor;
  readonly release: () => void;
}

/** Creates a parent-held lease for an approved release; undefined while not wired (U1). */
export type LeaseFactory = (metadata: UiAppMetadata) => Promise<LeaseHandle | undefined>;

interface PageProps {
  readonly http: HttpStart;
  readonly createLease?: LeaseFactory;
}

type FrameState =
  | { readonly status: 'none' }
  | { readonly status: 'loading' }
  | { readonly status: 'bound' }
  | {
      readonly status: 'ended';
      readonly reason: FrameHostEndReason | 'lease_failed';
      readonly detail?: string;
    };

const fingerprint = (digest: string): string => digest.slice(0, 16);

export const AppUiPage = ({ http, createLease }: PageProps) => {
  const { euiTheme, colorMode } = useEuiTheme();
  const [metadata, setMetadata] = useState<UiAppMetadata | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  // Ephemeral viewer consent: bound to this page session and this exact release digest.
  const [consentedDigest, setConsentedDigest] = useState<string | undefined>();
  const [frame, setFrame] = useState<FrameState>({ status: 'none' });
  const containerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<FrameHost | undefined>();
  const leaseRef = useRef<LeaseHandle | undefined>();
  const themeRef = useRef<UiTheme>();
  const metadataRef = useRef<UiAppMetadata | undefined>();

  themeRef.current = {
    mode: colorMode === 'DARK' ? 'dark' : 'light',
    colors: {
      background: String(euiTheme.colors.backgroundBasePlain),
      text: String(euiTheme.colors.textParagraph),
      border: String(euiTheme.colors.borderBasePlain),
      primary: String(euiTheme.colors.primary),
      danger: String(euiTheme.colors.danger),
    },
  };

  const unmountFrame = useCallback((reason: FrameHostEndReason) => {
    const host = hostRef.current;
    hostRef.current = undefined;
    host?.end(reason);
    leaseRef.current?.release();
    leaseRef.current = undefined;
  }, []);

  const refreshMetadata = useCallback(async () => {
    try {
      const next = await http.get<UiAppMetadata>(uiMetadataPath(INSTALLED_APP_ID));
      const previous = metadataRef.current;
      // S10: a different release unmounts the old frame (synchronously) before the new release's
      // consent prompt can render; consent is never inherited.
      if (previous && previous.releaseDigest !== next.releaseDigest) {
        unmountFrame('stale');
        setConsentedDigest(undefined);
      }
      if (!next.approved) unmountFrame('stale');
      else if (!next.enabled) unmountFrame('disabled');
      metadataRef.current = next;
      setLoadError(undefined);
      setMetadata(next);
    } catch (error) {
      unmountFrame('disabled');
      metadataRef.current = undefined;
      setMetadata(undefined);
      setLoadError(
        String((error as { response?: { status?: number } }).response?.status ?? 'error')
      );
    }
  }, [http, unmountFrame]);

  // Parent polling is UI cleanup only; the server rejects the next call authoritatively.
  useEffect(() => {
    refreshMetadata();
    const interval = setInterval(refreshMetadata, UI_LIMITS.pollIntervalMs);
    window.addEventListener('focus', refreshMetadata);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', refreshMetadata);
      unmountFrame('unmounted');
    };
  }, [refreshMetadata, unmountFrame]);

  const mountFrame = useCallback(
    async (current: UiAppMetadata) => {
      const container = containerRef.current;
      if (!container || hostRef.current) return;
      setFrame({ status: 'loading' });
      let lease: LeaseHandle | undefined;
      try {
        lease = createLease ? await createLease(current) : undefined;
      } catch {
        setFrame({ status: 'ended', reason: 'lease_failed' });
        return;
      }
      leaseRef.current = lease;
      const host = new FrameHost({
        container,
        guardianUrl: http.basePath.prepend(current.guardianPath),
        kibanaOrigin: window.location.origin,
        grant: { scopes: current.scopes, dashboardIds: current.dashboardIds },
        theme: () => themeRef.current as UiTheme,
        executor: lease?.executor,
        onBound: () => setFrame({ status: 'bound' }),
        onEnded: (reason, detail) => {
          if (hostRef.current === host) {
            hostRef.current = undefined;
            leaseRef.current?.release();
            leaseRef.current = undefined;
          }
          // A new explicit click is required after any teardown.
          setConsentedDigest(undefined);
          setFrame({ status: 'ended', reason, detail });
        },
      });
      hostRef.current = host;
      host.start();
    },
    [createLease, http.basePath]
  );

  const usable = metadata?.approved && metadata.enabled;
  const consented = usable && metadata && consentedDigest === metadata.releaseDigest;

  useEffect(() => {
    if (consented && metadata && !hostRef.current && frame.status === 'none') mountFrame(metadata);
  }, [consented, metadata, frame.status, mountFrame]);

  const allow = () => {
    if (!metadata) return;
    setFrame({ status: 'none' });
    setConsentedDigest(metadata.releaseDigest);
  };
  const disable = () => {
    setConsentedDigest(undefined);
    unmountFrame('unmounted');
    setFrame({ status: 'none' });
  };

  return (
    <EuiPageTemplate>
      <EuiPageTemplate.Header
        data-test-subj="appHostUiHeader"
        pageTitle={i18n.translate('xpack.appHost.ui.pageTitle', {
          defaultMessage: 'Third-party app',
        })}
        description={i18n.translate('xpack.appHost.ui.pageDescription', {
          defaultMessage:
            'Trusted Kibana chrome. Everything inside the bordered area below is untrusted app content.',
        })}
      />
      <EuiPageTemplate.Section>
        {loadError ? (
          <KbnDangerCallout
            data-test-subj="appHostUiUnavailable"
            title={i18n.translate('xpack.appHost.ui.unavailable', {
              defaultMessage: 'The app is not available ({status}).',
              values: { status: loadError },
            })}
          />
        ) : null}
        {metadata ? (
          <EuiPanel hasBorder data-test-subj="appHostTrustedLabel">
            <EuiDescriptionList
              compressed
              type="column"
              listItems={[
                {
                  title: i18n.translate('xpack.appHost.ui.appLabel', { defaultMessage: 'App' }),
                  description: <span data-test-subj="appHostUiTitle">{metadata.title}</span>,
                },
                {
                  title: i18n.translate('xpack.appHost.ui.publisherLabel', {
                    defaultMessage: 'Publisher',
                  }),
                  description: metadata.publisher,
                },
                {
                  title: i18n.translate('xpack.appHost.ui.versionLabel', {
                    defaultMessage: 'Approved version',
                  }),
                  description: <span data-test-subj="appHostUiVersion">{metadata.version}</span>,
                },
                {
                  title: i18n.translate('xpack.appHost.ui.releaseLabel', {
                    defaultMessage: 'Release fingerprint',
                  }),
                  description: <EuiCode>{fingerprint(metadata.releaseDigest)}</EuiCode>,
                },
                {
                  title: i18n.translate('xpack.appHost.ui.scopesLabel', {
                    defaultMessage: 'Scopes',
                  }),
                  description: (
                    <span data-test-subj="appHostUiScopes">
                      {metadata.scopes.map((scope) => (
                        <EuiBadge key={scope}>{scope}</EuiBadge>
                      ))}
                    </span>
                  ),
                },
                {
                  title: i18n.translate('xpack.appHost.ui.resourcesLabel', {
                    defaultMessage: 'Resources',
                  }),
                  description: [
                    ...metadata.indices.map((index) => `index ${index}`),
                    ...metadata.dashboardIds.map((id) => `dashboard ${id}`),
                  ].join(', '),
                },
                {
                  title: i18n.translate('xpack.appHost.ui.egressLabel', {
                    defaultMessage: 'Declared egress',
                  }),
                  description: i18n.translate('xpack.appHost.ui.egressNone', {
                    defaultMessage:
                      'None declared (enforced for tested fetch, resource and navigation channels; not a proof of zero DNS, WebRTC or timing leakage)',
                  }),
                },
                {
                  title: i18n.translate('xpack.appHost.ui.statusLabel', {
                    defaultMessage: 'Operator status',
                  }),
                  description: metadata.approved
                    ? metadata.enabled
                      ? i18n.translate('xpack.appHost.ui.statusEnabled', {
                          defaultMessage: 'Approved and enabled',
                        })
                      : i18n.translate('xpack.appHost.ui.statusDisabled', {
                          defaultMessage: 'Disabled by the operator',
                        })
                    : i18n.translate('xpack.appHost.ui.statusNotApproved', {
                        defaultMessage: 'This release is not approved by the operator',
                      }),
                },
              ]}
            />
            <EuiSpacer size="m" />
            <KbnWarningCallout
              data-test-subj="appHostConsentCopy"
              title={i18n.translate('xpack.appHost.ui.consentTitle', {
                defaultMessage: 'Before you allow this app',
              })}
              text={
                <>
                  <p>{CONSENT_COPY}</p>
                  <p>{LOCAL_PROCESSOR_COPY}</p>
                </>
              }
            />
            <EuiSpacer size="m" />
            <EuiFlexGroup gutterSize="s" responsive={false}>
              <EuiFlexItem grow={false}>
                <EuiButton
                  fill
                  data-test-subj="appHostAllowVersion"
                  isDisabled={!usable || Boolean(consented)}
                  onClick={allow}
                >
                  {i18n.translate('xpack.appHost.ui.allowVersion', {
                    defaultMessage: 'Allow this version',
                  })}
                </EuiButton>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiButtonEmpty
                  color="danger"
                  data-test-subj="appHostDisable"
                  isDisabled={!consented}
                  onClick={disable}
                >
                  {i18n.translate('xpack.appHost.ui.disable', { defaultMessage: 'Disable' })}
                </EuiButtonEmpty>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiText size="s" data-test-subj="appHostFrameStatus">
                  {frame.status === 'ended'
                    ? `${frame.status}: ${frame.reason}${frame.detail ? ` (${frame.detail})` : ''}`
                    : frame.status}
                </EuiText>
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiPanel>
        ) : null}
        <EuiSpacer size="m" />
        <EuiText size="xs" color="subdued" data-test-subj="appHostFrameLabel">
          {i18n.translate('xpack.appHost.ui.frameLabel', {
            defaultMessage:
              'Untrusted app area. Kibana never asks for credentials inside this area.',
          })}
        </EuiText>
        <div
          ref={containerRef}
          data-test-subj="appHostFrameContainer"
          css={css`
            position: relative;
            overflow: hidden;
            height: ${UI_LIMITS.frameHeightPx + 4}px;
            border: 2px dashed ${euiTheme.colors.borderBaseFloating};
          `}
        />
      </EuiPageTemplate.Section>
    </EuiPageTemplate>
  );
};
