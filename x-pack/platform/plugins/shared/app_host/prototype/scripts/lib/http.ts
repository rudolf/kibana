/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Small fetch wrapper for local ES/Kibana. Credentials are passed in, never logged.

export interface HttpResult {
  status: number;
  body: unknown;
  headers: Headers;
  ms: number;
}

export const basicAuth = (userPass: string) =>
  `Basic ${Buffer.from(userPass, 'utf8').toString('base64')}`;

export const userAuth = ({ username, password }: { username: string; password: string }) =>
  `${username}:${password}`;

export const http = async (
  url: string,
  options: {
    method?: string;
    auth?: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {}
): Promise<HttpResult> => {
  const headers: Record<string, string> = { ...options.headers };
  if (options.auth) headers.authorization = basicAuth(options.auth);
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  const started = performance.now();
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body,
    redirect: 'manual',
    signal: options.signal,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // Non-JSON body.
  }
  return {
    status: response.status,
    body: parsed,
    headers: response.headers,
    ms: performance.now() - started,
  };
};

export const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see README; never commit it)`);
  return value;
};
