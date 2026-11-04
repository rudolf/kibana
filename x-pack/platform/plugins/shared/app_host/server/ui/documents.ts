/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Fixed generated HTML for the guardian and the opaque frame. Never package-supplied HTML. The only
// dynamic content is server-derived values, JSON-encoded into a non-executable data block.

import { UI_HANDSHAKE_PROTOCOL } from '../../common/ui_protocol';

/** JSON safe to embed in an HTML data block: no `<`, `>`, `&` or line separators survive. */
export const htmlSafeJson = (value: Readonly<Record<string, string>>): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

/** Attribute-safe for our own fixed absolute URLs (validated hex/path characters only). */
const assertUrl = (value: string): string => {
  if (!/^https?:\/\/[A-Za-z0-9.:[\]-]+\/[A-Za-z0-9._~/-]*$/.test(value)) {
    throw new Error('App Host: refusing to render an unexpected URL');
  }
  return value;
};

export const FRAME_TITLE = 'Third-party app (untrusted content)';

export const renderGuardianDocument = ({
  guardianScript,
  childUrl,
  parentOrigin,
}: {
  readonly guardianScript: string;
  readonly childUrl: string;
  readonly parentOrigin: string;
}): string => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>App Host guardian</title>
<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}iframe{display:block;border:0;width:100%;height:100%}</style>
</head>
<body>
<script type="application/json" id="app-host-guardian-config">${htmlSafeJson({
  childUrl: assertUrl(childUrl),
  parentOrigin,
  title: FRAME_TITLE,
  protocol: UI_HANDSHAKE_PROTOCOL,
})}</script>
<script src="${assertUrl(guardianScript)}"></script>
</body>
</html>
`;

export const renderFrameDocument = ({
  bootstrapScript,
  uiScript,
}: {
  readonly bootstrapScript: string;
  readonly uiScript: string;
}): string => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>App</title>
<script type="application/json" id="app-host-frame-config">${htmlSafeJson({
  uiUrl: assertUrl(uiScript),
  protocol: UI_HANDSHAKE_PROTOCOL,
})}</script>
<script src="${assertUrl(bootstrapScript)}"></script>
</head>
<body><div id="app-root"></div></body>
</html>
`;
