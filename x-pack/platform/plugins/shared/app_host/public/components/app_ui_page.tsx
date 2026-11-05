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

export interface AppSession {
  readonly executor: BridgeExecutor;
}

/** Mints the parent-held app session for an approved release; undefined while not wired (U1). */
export type SessionFactory = (metadata: UiAppMetadata) => Promise<AppSession | undefined>;

interface PageProps {
  readonly http: HttpStart;
  readonly createSession?: SessionFactory;
}

type FrameState =
  | { readonly status: 'none' }
  | { readonly status: 'loading' }
  | { readonly status: 'bound' }
  | {
      readonly status: 'ended';
      readonly reason: FrameHostEndReason | 'session_failed';
      readonly detail?: string;
    };

const fingerprint = (digest: string): string => digest.slice(0, 16);

export const AppUiPage = ({ http, createSession }: PageProps) => {
  const { euiTheme, colorMode } = useEuiTheme();
  const [metadata, setMetadata] = useState<UiAppMetadata | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  // Ephemeral viewer consent: bound to this page session and this exact release digest.
  const [consentedDigest, setConsentedDigest] = useState<string | undefined>();
  const [frame, setFrame] = useState<FrameState>({ status: 'none' });
  const containerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<FrameHost | undefined>();
  const themeRef = useRef<UiTheme>();
  const metadataRef = useRef<UiAppMetadata | undefined>();
  // Bumped by every teardown (Disable, unmount, release change, disable/unapproval). An async mount
  // only proceeds if its generation is still current after the session request settles.
  const generationRef = useRef(0);

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
    generationRef.current += 1;
    const host = hostRef.current;
    hostRef.current = undefined;
    host?.end(reason);
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

  // No polling: metadata is read on load and after a server rejection that ends the frame. The
  // server rejects the next call authoritatively; unmount or navigation just drops the handle.
  useEffect(() => {
    refreshMetadata();
    return () => unmountFrame('unmounted');
  }, [refreshMetadata, unmountFrame]);

  const mountFrame = useCallback(
    async (current: UiAppMetadata) => {
      const container = containerRef.current;
      if (!container || hostRef.current) return;
      const generation = generationRef.current;
      setFrame({ status: 'loading' });
      let session: AppSession | undefined;
      try {
        session = createSession ? await createSession(current) : undefined;
      } catch {
        if (generation === generationRef.current) {
          setFrame({ status: 'ended', reason: 'session_failed' });
          refreshMetadata();
        }
        return;
      }
      // P1: consent was withdrawn, the page unmounted or the release changed while the session was
      // being minted. A stale session never mounts or binds a frame; its handle is dropped.
      const latest = metadataRef.current;
      if (
        generation !== generationRef.current ||
        hostRef.current ||
        !containerRef.current?.isConnected ||
        !latest ||
        latest.releaseDigest !== current.releaseDigest ||
        !latest.approved ||
        !latest.enabled
      ) {
        return;
      }
      // Server rejection on the next call is authoritative: lifecycle codes tear the frame down and
      // re-read the metadata once (a new release needs a new consent prompt, S10).
      const terminal: Partial<Record<string, FrameHostEndReason>> = {
        app_disabled: 'disabled',
        app_stale: 'stale',
        app_expired: 'expired',
      };
      const executor: BridgeExecutor | undefined = session
        ? async (operation, signal) => {
            const outcome = await session.executor(operation, signal);
            const reason = outcome.ok ? undefined : terminal[outcome.code];
            if (reason) {
              setTimeout(() => {
                host.end(reason);
                refreshMetadata();
              }, 0);
            }
            return outcome;
          }
        : undefined;
      const host: FrameHost = new FrameHost({
        container,
        guardianUrl: http.basePath.prepend(current.guardianPath),
        kibanaOrigin: window.location.origin,
        grant: { scopes: current.scopes, dashboardIds: current.dashboardIds },
        theme: () => themeRef.current as UiTheme,
        executor,
        onBound: () => setFrame({ status: 'bound' }),
        onEnded: (reason, detail) => {
          if (hostRef.current === host) hostRef.current = undefined;
          // A new explicit click is required after any teardown.
          setConsentedDigest(undefined);
          setFrame({ status: 'ended', reason, detail });
        },
      });
      hostRef.current = host;
      host.start();
    },
    [createSession, http.basePath, refreshMetadata]
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
