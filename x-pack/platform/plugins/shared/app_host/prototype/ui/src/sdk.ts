/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Minimal guest-side SDK bundled into the app's UI IIFE: a string-only capnweb transport over the
// one MessagePort the host bootstrap hands over. This is app code, untrusted by the host.

import { RpcSession, type RpcTransport } from 'capnweb';

export interface Theme {
  mode: 'light' | 'dark';
  colors: { background: string; text: string; border: string; primary: string; danger: string };
}
export interface Summary {
  appId: string;
  version: string;
  label: string;
  counts: { high: number; low: number };
}
export interface SearchResult {
  total: number;
  records: Array<{ severity: string; rule: string }>;
}
/** `GET /api/dashboards/{id}` response, unchanged (typed only as far as this sample reads it). */
export interface DashboardResponse {
  id: string;
  data: { title: string };
}

/** `GET /api/data_views` response, unchanged. */
export interface DataViewListResponse {
  data_view: Array<{ id: string; name?: string; title: string; timeFieldName?: string }>;
}
export interface DataViewField {
  name: string;
  type: string;
  esTypes?: string[];
  aggregatable?: boolean;
  searchable?: boolean;
  runtimeField?: { type: string };
  format?: { id: string; params?: Record<string, unknown> };
}
/** `GET /api/data_views/data_view/{id}` response, unchanged. */
export interface DataViewResponse {
  data_view: {
    id: string;
    name?: string;
    title: string;
    timeFieldName?: string;
    fields: Record<string, DataViewField>;
    runtimeFieldMap?: Record<string, { type: string }>;
    fieldFormats?: Record<string, { id: string; params?: Record<string, unknown> }>;
  };
}
export type EsqlValue = string | number | boolean | null | Array<string | number | boolean | null>;
export interface EsqlResult {
  columns: Array<{ name: string; type: string }>;
  values: EsqlValue[][];
}

export interface Bridge {
  callAppRoute(request: { method: 'GET'; path: '/summary' }): Promise<Summary>;
  search(request: { index: string; size: number }): Promise<SearchResult>;
  getDashboardPreview(request: { id: string }): Promise<DashboardResponse>;
  listDataViews(): Promise<DataViewListResponse>;
  getDataView(request: { id: string }): Promise<DataViewResponse>;
  esql(request: { query: string }): Promise<EsqlResult>;
  getTheme(): Promise<Theme>;
}

class PortTransport implements RpcTransport {
  readonly #port: MessagePort;
  readonly #queue: string[] = [];
  #waiter: ((value: string) => void) | undefined;
  #fail: ((reason: Error) => void) | undefined;
  #closed: Error | undefined;

  constructor(port: MessagePort) {
    this.#port = port;
    port.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      if (this.#waiter) {
        const waiter = this.#waiter;
        this.#waiter = undefined;
        this.#fail = undefined;
        waiter(event.data);
      } else this.#queue.push(event.data);
    };
  }

  send(message: string): void {
    if (this.#closed) throw this.#closed;
    this.#port.postMessage(message);
  }

  receive(): Promise<string> {
    const next = this.#queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.#closed) return Promise.reject(this.#closed);
    return new Promise((resolve, reject) => {
      this.#waiter = resolve;
      this.#fail = reject;
    });
  }

  abort(reason: unknown): void {
    this.#closed = reason instanceof Error ? reason : new Error('aborted');
    this.#fail?.(this.#closed);
  }
}

declare global {
  interface Window {
    appHostBridgePort?: MessagePort | null;
  }
}

/** Takes the one bridge port (the bootstrap getter returns it once) and opens the RPC session. */
export const connectBridge = (): { bridge: Bridge; port: MessagePort } | undefined => {
  const port = window.appHostBridgePort;
  if (!port) return undefined;
  const session = new RpcSession<Bridge>(new PortTransport(port));
  return { bridge: session.getRemoteMain() as unknown as Bridge, port };
};

export const errorCode = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
