/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';

export interface TlsMaterial {
  readonly key: Buffer;
  readonly cert: Buffer;
}

/** Local receiver: counts hits per marker; used for egress and CSP-report observations. */
export class Receiver {
  readonly hits: Array<{ path: string; method: string; cookie: boolean; body: string }> = [];
  readonly port: number;
  /** TCP connections accepted (a preconnect opens one without sending any HTTP request). */
  connections = 0;
  /** Fixed harness-owned documents (control pages, control bundles), keyed by exact path. */
  readonly static = new Map<string, { readonly type: string; readonly body: string }>();
  readonly #tls: TlsMaterial | undefined;
  readonly #host: string;
  #server: Server | undefined;

  constructor(
    port: number,
    { tls, host = '127.0.0.1' }: { tls?: TlsMaterial; host?: string } = {}
  ) {
    this.port = port;
    this.#tls = tls;
    this.#host = host;
  }

  public get origin(): string {
    return `${this.#tls ? 'https' : 'http'}://${this.#host}:${this.port}`;
  }

  async start(): Promise<void> {
    const handler: RequestListener = (request: IncomingMessage, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        if (chunks.reduce((n, c) => n + c.length, 0) < 64 * 1024) chunks.push(chunk);
      });
      request.on('end', () => {
        this.hits.push({
          path: request.url ?? '',
          method: request.method ?? '',
          cookie: Boolean(request.headers.cookie),
          body: Buffer.concat(chunks).toString('utf8').slice(0, 4096),
        });
        const fixed = this.static.get((request.url ?? '').split('?')[0]);
        if (fixed) {
          response.writeHead(200, { 'content-type': fixed.type, 'cache-control': 'no-store' });
          response.end(fixed.body);
          return;
        }
        if (request.url === '/nav-control') {
          // Positive control without the guardian: a sandboxed child may navigate itself anywhere.
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<!doctype html><iframe sandbox="allow-scripts" src="/nav-child"></iframe>');
          return;
        }
        if (request.url === '/nav-child') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(
            "<!doctype html><script>location.href='/hit?m=navcontrol-'+Date.now()</script>"
          );
          return;
        }
        const embed = /^\/embed-page\?src=(.+)$/.exec(request.url ?? '');
        if (embed) {
          // External-site embedding attempt (frame-ancestors control).
          const src = decodeURIComponent(embed[1]).replace(/"/g, '');
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(
            `<!doctype html><iframe id="victim" src="${src}" width="800" height="600"></iframe>`
          );
          return;
        }
        response.writeHead(200, {
          'content-type': 'text/plain',
          'access-control-allow-origin': '*',
        });
        response.end('ok');
      });
    };
    this.#server = this.#tls ? createTlsServer(this.#tls, handler) : createServer(handler);
    this.#server.on('connection', () => {
      this.connections += 1;
    });
    await new Promise<void>((resolve) => this.#server?.listen(this.port, '127.0.0.1', resolve));
  }

  count(marker: string): number {
    return this.hits.filter((hit) => hit.path.includes(marker) || hit.body.includes(marker)).length;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }
}
