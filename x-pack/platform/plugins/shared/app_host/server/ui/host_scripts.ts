/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Trusted, host-owned browser scripts served as fixed immutable assets. They are never package
// content and never interpolate request data: each reads server-derived values from a JSON data
// block in its own generated document. Kept as small ES2017 strings so the exact bytes are fixed.

import { UI_HANDSHAKE_PROTOCOL } from '../../common/ui_protocol';

/**
 * Guardian (same-origin, unsandboxed, trusted). Accepts exactly two handshake messages, checking
 * `event.source` (and origin) before reading `event.data`: the parent's init (carrying the RPC
 * port and a dedicated control port) and the child's challenge reply. It then transfers the RPC
 * port to the child once and removes its window listeners. A subsequent child load revokes; the
 * guardian never rebinds. Lifecycle notices travel over the control port only.
 */
export const GUARDIAN_SCRIPT = `(function () {
  'use strict';
  var PROTOCOL = ${JSON.stringify(UI_HANDSHAKE_PROTOCOL)};
  var configElement = document.getElementById('app-host-guardian-config');
  var config = JSON.parse(configElement.textContent);
  var parentWindow = window.parent;
  var state = 'await_init';
  var rpcPort = null;
  var control = null;
  var challenge = null;
  var child = null;
  var loads = 0;
  var isRecord = function (value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  };
  var notify = function (type) {
    if (!control) return;
    try { control.postMessage({ t: type, p: PROTOCOL }); } catch (error) { /* closed */ }
  };
  var stopListening = function () {
    window.removeEventListener('message', onMessage);
    window.removeEventListener('messageerror', onMessageError);
  };
  var revoke = function (reason) {
    if (state === 'revoked') return;
    state = 'revoked';
    stopListening();
    if (rpcPort) { try { rpcPort.close(); } catch (error) { /* closed */ } rpcPort = null; }
    notify(reason);
    if (control) { try { control.close(); } catch (error) { /* closed */ } control = null; }
    if (child) { child.remove(); child = null; }
  };
  var createChild = function () {
    child = document.createElement('iframe');
    child.setAttribute('sandbox', 'allow-scripts');
    child.setAttribute('referrerpolicy', 'no-referrer');
    child.setAttribute('title', config.title);
    child.addEventListener('load', function () {
      loads += 1;
      if (loads === 1 && state === 'await_child') {
        child.contentWindow.postMessage({ t: 'challenge', p: PROTOCOL, c: challenge }, '*');
        return;
      }
      revoke('child_reloaded');
    });
    child.src = config.childUrl;
    document.body.appendChild(child);
  };
  var onInit = function (event) {
    var data = event.data;
    var ports = event.ports;
    if (!isRecord(data) || data.t !== 'init' || data.p !== PROTOCOL ||
        typeof data.c !== 'string' || data.c.length < 32 || data.c.length > 64 ||
        !ports || ports.length !== 2) {
      revoke('bad_init');
      return;
    }
    rpcPort = ports[0];
    control = ports[1];
    challenge = data.c;
    state = 'await_child';
    createChild();
  };
  var onReady = function (event) {
    var data = event.data;
    if (!isRecord(data) || data.t !== 'ready' || data.p !== PROTOCOL || data.c !== challenge ||
        loads !== 1) {
      revoke('bad_ready');
      return;
    }
    state = 'bound';
    stopListening();
    child.contentWindow.postMessage({ t: 'port', p: PROTOCOL, c: challenge }, '*', [rpcPort]);
    rpcPort = null;
    challenge = null;
    notify('bound');
  };
  var onMessage = function (event) {
    var source = event.source;
    if (state === 'await_init') {
      if (source !== parentWindow || event.origin !== config.parentOrigin) return;
      onInit(event);
      return;
    }
    if (state === 'await_child') {
      if (!child || source !== child.contentWindow || event.origin !== 'null') return;
      onReady(event);
    }
  };
  var onMessageError = function (event) {
    if (state === 'await_init' && event.source === parentWindow) revoke('messageerror');
    if (state === 'await_child' && child && event.source === child.contentWindow) {
      revoke('messageerror');
    }
  };
  window.addEventListener('message', onMessage);
  window.addEventListener('messageerror', onMessageError);
})();
`;

/**
 * Host-owned child bootstrap (runs in the opaque, sandboxed frame before any app code). Clears the
 * initial window.name, answers the guardian's one-time challenge, receives the RPC port once, then
 * loads only the verified UI bundle URL. The app may set window.name again; that is not a boundary.
 */
export const CHILD_BOOTSTRAP_SCRIPT = `(function () {
  'use strict';
  var PROTOCOL = ${JSON.stringify(UI_HANDSHAKE_PROTOCOL)};
  try { window.name = ''; } catch (error) { /* ignore */ }
  var configElement = document.getElementById('app-host-frame-config');
  var config = JSON.parse(configElement.textContent);
  var parentWindow = window.parent;
  var phase = 'await_challenge';
  var challenge = null;
  var isRecord = function (value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  };
  var deliver = function (port) {
    var taken = false;
    Object.defineProperty(window, 'appHostBridgePort', {
      configurable: false,
      get: function () {
        if (taken) return null;
        taken = true;
        return port;
      }
    });
    var script = document.createElement('script');
    script.src = config.uiUrl;
    document.head.appendChild(script);
  };
  var onMessage = function (event) {
    if (event.source !== parentWindow) return;
    var data = event.data;
    if (!isRecord(data) || data.p !== PROTOCOL) return;
    if (phase === 'await_challenge' && data.t === 'challenge' && typeof data.c === 'string') {
      challenge = data.c;
      phase = 'await_port';
      parentWindow.postMessage({ t: 'ready', p: PROTOCOL, c: challenge }, '*');
      return;
    }
    if (phase === 'await_port' && data.t === 'port' && data.c === challenge &&
        event.ports && event.ports.length === 1) {
      phase = 'done';
      window.removeEventListener('message', onMessage);
      deliver(event.ports[0]);
    }
  };
  window.addEventListener('message', onMessage);
})();
`;
