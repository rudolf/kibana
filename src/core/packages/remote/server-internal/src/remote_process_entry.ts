/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { openPortSession, type RemoteWorkerSpec } from '@kbn/core-remote-common';
import { buildExecutor } from './build_executor';
import { createBridge } from './executor_bridge';
import { openIpcSession } from './ipc_session';
import { graphSignature } from './graph_signature';

interface CoordinatorApi {
  getCapability(tokenId: string): object;
}

export type ImplementationImports = Readonly<Record<string, () => Promise<Record<string, object>>>>;

/** Instantiates a statically bundled graph directly in the current thread (no IPC/RPC). */
export const createInProcessExecutor = async (
  spec: RemoteWorkerSpec,
  implementations: ImplementationImports,
  getCapability: (tokenId: string) => object
): Promise<{ executor: object; loaded: string[] }> => {
  const coordinator = new Map(
    spec.coordinatorTokenIds.map((tokenId) => [tokenId, getCapability(tokenId)])
  );
  const loaded: string[] = [];
  const executor = await buildExecutor(spec, coordinator, loaded, async (path, exportName) => {
    const load = implementations[path];
    if (!load) throw new Error(`Implementation absent from worker bundle: ${path}`);
    const implementation = (await load())[exportName];
    if (!implementation) throw new Error(`Missing bundled export: ${exportName}`);
    loaded.push(path);
    return implementation;
  });
  return { executor, loaded };
};

/** Hosts a statically bundled graph; no source transpiler or plugin discovery runs in the child. */
export const serveProcess = (
  spec: RemoteWorkerSpec,
  implementations: ImplementationImports
): void => {
  const { send } = process;
  if (!send) throw new Error('Remote process host requires fork IPC');
  const channel = {
    send: send.bind(process),
    on: process.on.bind(process),
    off: process.off.bind(process),
  };
  const bridge = createBridge();
  const session = openIpcSession<CoordinatorApi>(channel, bridge.rpc);
  let executor: (object & { [Symbol.asyncDispose]?: () => Promise<void> }) | undefined;
  let disconnected = false;
  process.once('disconnect', () => {
    disconnected = true;
    // Keep this timer referenced: active RPC methods need not settle when the session closes.
    setTimeout(() => process.exit(0), 1000);
    void executor?.[Symbol.asyncDispose]?.().catch(() => undefined);
    session.close();
  });
  const onInit = async (message: { kind: string; signature: string }): Promise<void> => {
    if (message.kind !== 'init') return;
    process.off('message', onInit);
    try {
      if (message.signature !== graphSignature(spec)) {
        throw new Error('Remote bundle registration mismatch');
      }
      const coordinator = new Map(
        spec.coordinatorTokenIds.map((tokenId) => [tokenId, session.remote.getCapability(tokenId)])
      );
      const loaded: string[] = [];
      executor = await buildExecutor(spec, coordinator, loaded, async (path, exportName) => {
        const load = implementations[path];
        if (!load) throw new Error(`Implementation absent from worker bundle: ${path}`);
        const implementation = (await load())[exportName];
        if (!implementation) throw new Error(`Missing bundled export: ${exportName}`);
        loaded.push(path);
        return implementation;
      });
      if (disconnected) {
        await executor[Symbol.asyncDispose]?.();
        return;
      }
      bridge.attach(executor, loaded);
      channel.send({ kind: 'ready' });
    } catch (error) {
      channel.send({
        kind: 'boot-error',
        message: error instanceof Error ? error.message : String(error),
      });
      session.close();
      process.disconnect();
      process.exitCode = 1;
    }
  };
  process.on('message', onInit);
};

/** Hosts a statically bundled graph inside a `worker_threads` Worker (same bundle as `serveProcess`). */
export const serveWorker = (
  spec: RemoteWorkerSpec,
  implementations: ImplementationImports
): void => {
  const data = workerData as { __kbnRemoteBundlePort?: MessagePort; signature?: string } | null;
  const port = data?.__kbnRemoteBundlePort;
  if (!parentPort || !port) {
    throw new Error('Remote worker bundle host requires parentPort and __kbnRemoteBundlePort');
  }
  const bridge = createBridge();
  const gateway = openPortSession<CoordinatorApi>(port, bridge.rpc);
  void (async () => {
    try {
      if (data.signature && data.signature !== graphSignature(spec)) {
        throw new Error('Remote bundle registration mismatch');
      }
      const coordinator = new Map(
        spec.coordinatorTokenIds.map((tokenId) => [tokenId, gateway.getCapability(tokenId)])
      );
      const loaded: string[] = [];
      const executor = await buildExecutor(spec, coordinator, loaded, async (path, exportName) => {
        const load = implementations[path];
        if (!load) throw new Error(`Implementation absent from worker bundle: ${path}`);
        const implementation = (await load())[exportName];
        if (!implementation) throw new Error(`Missing bundled export: ${exportName}`);
        loaded.push(path);
        return implementation;
      });
      bridge.attach(executor, loaded);
      parentPort.postMessage({ kind: 'ready' });
    } catch (error) {
      parentPort.postMessage({
        kind: 'boot-error',
        message: error instanceof Error ? error.message : String(error),
      });
      port.close();
      process.exitCode = 1;
    }
  })();
};
