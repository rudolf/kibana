/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RpcSession } from 'capnweb';
import type { BridgeErrorCode, UiTheme } from '../../common/ui_protocol';
import { UI_LIMITS } from '../../common/ui_protocol';
import type { BridgeExecutor, BridgeGrant } from './bridge_root';
import { AppBridge, sanitizeBridgeError } from './bridge_root';
import type { BridgeLifecycle } from './bridge_lifecycle';
import type { PortLike } from './port_transport';
import { BoundedPortTransport } from './port_transport';

export interface BridgeSessionOptions {
  readonly port: PortLike;
  readonly grant: BridgeGrant;
  readonly theme: () => UiTheme;
  readonly executor: BridgeExecutor | undefined;
  readonly lifecycle: BridgeLifecycle;
  /** Called once when the session must end (protocol violation or structural bound breach). */
  readonly onTerminate: (reason: string) => void;
  readonly onLocalRejection?: (method: string, code: BridgeErrorCode) => void;
}

export interface BridgeSession {
  readonly transport: BoundedPortTransport;
  readonly session: RpcSession;
}

/**
 * Wires the bounded string-only transport, the seven-method `AppBridge` and a capnweb `RpcSession`
 * on the parent's end of the bridge port.
 */
export const startBridgeSession = ({
  port,
  grant,
  theme,
  executor,
  lifecycle,
  onTerminate,
  onLocalRejection,
}: BridgeSessionOptions): BridgeSession => {
  const sessionRef: { current?: RpcSession } = {};
  // P1: every capnweb import/export counts, including protocol-only growth (retained pushes,
  // guest-exported stubs, unknown-method pipelines) that never reaches a bridge method.
  const withinStubCap = (): boolean => {
    if (!sessionRef.current) return true;
    const { imports, exports } = sessionRef.current.getStats();
    return imports + exports <= UI_LIMITS.liveRpcStubs;
  };
  const transport = new BoundedPortTransport(port, (reason) => onTerminate(reason), withinStubCap);
  const bridge = new AppBridge(
    grant,
    theme,
    executor,
    {
      beforeCall: () => {
        if (withinStubCap()) return true;
        transport.terminate('live_stubs');
        return false;
      },
      terminate: (reason) => onTerminate(reason),
      onLocalRejection,
    },
    lifecycle
  );
  const session = new RpcSession(transport, bridge, {
    limits: {
      maxDepth: UI_LIMITS.rpcMaxDepth,
      maxBigIntDigits: UI_LIMITS.rpcMaxBigIntDigits,
      maxMessageSize: UI_LIMITS.frameBytes,
    },
    onSendError: sanitizeBridgeError,
  });
  sessionRef.current = session;
  return { transport, session };
};
