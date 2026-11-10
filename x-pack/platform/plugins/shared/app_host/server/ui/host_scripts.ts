/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Trusted, host-owned browser scripts served as fixed immutable assets. They are never package
// content and never interpolate request data: each reads server-derived values from a JSON data
// block in its own generated document. Kept as small ES2017 strings so the exact bytes are fixed.

import { readFileSync } from 'node:fs';
import {
  BRIDGE_ERROR_CODES,
  CAPNWEB_ASSET_FILE,
  UI_HANDSHAKE_PROTOCOL,
  UI_LIMITS,
} from '../../common/ui_protocol';

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

/**
 * Dedicated bridge Worker (trusted, same-origin, one per app frame; the parent terminates it on
 * teardown). It takes exactly one init message from its owner with its end of the bridge
 * MessageChannel, mints the app session, then serves the guest's capnweb session off the Kibana UI
 * thread. The session handle exists only in this Worker and in the request bodies it sends; the
 * parent receives lifecycle notices only. Seven typed methods, plain-data arguments only; the
 * server validates every operation strictly and runs it as the app session key. The Worker's only
 * bound is its receive queue: bytes of guest frames waiting for capnweb (2 bytes per UTF-16 code
 * unit); overflow ends the session.
 */
export const BRIDGE_WORKER_SCRIPT = `(function () {
  'use strict';
  importScripts(${JSON.stringify(CAPNWEB_ASSET_FILE)});
  var capnweb = self.capnweb;
  var CODES = ${JSON.stringify(BRIDGE_ERROR_CODES)};
  var MAX_QUEUED_BYTES = ${UI_LIMITS.receiveQueueBytes};
  var MAX_HANDLE_LENGTH = ${UI_LIMITS.handleBytes};
  var TERMINAL = ['app_disabled', 'app_stale', 'app_expired'];
  var HEADERS = {
    'content-type': 'application/json',
    'kbn-xsrf': 'app-host-bridge',
    'x-elastic-internal-origin': 'Kibana'
  };
  var notify = function (notice) { self.postMessage(notice); };

  // Stackless, fixed public code only (capnweb serializes any truthy stack; Firefox inherits one).
  var bridgeError = function (code) {
    var error = new Error(CODES.indexOf(code) >= 0 ? code : 'app_unavailable');
    Object.defineProperty(error, 'stack', {
      value: '', configurable: true, writable: true, enumerable: false
    });
    return error;
  };

  // JSON values only: functions, stubs, thenables, class instances and non-finite numbers fail.
  var isPlainData = function (value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return isFinite(value);
    if (typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.every(isPlainData);
    var proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.keys(value).every(function (key) { return isPlainData(value[key]); });
  };
  var isObject = function (value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) &&
      isPlainData(value);
  };

  class Transport {
    constructor(port, onEnd) {
      this.port = port;
      this.onEnd = onEnd;
      this.queue = [];
      this.bytes = 0;
      this.waiter = null;
      this.error = null;
      port.onmessage = (event) => this.onMessage(event.data);
      port.onmessageerror = () => this.end('messageerror');
    }
    send(message) {
      if (this.error) throw this.error;
      this.port.postMessage(message);
    }
    receive() {
      if (this.error) return Promise.reject(this.error);
      return new Promise((resolve, reject) => {
        this.waiter = { resolve: resolve, reject: reject };
        this.pump();
      });
    }
    abort() { this.end('aborted'); }
    pump() {
      if (this.error || !this.waiter || this.queue.length === 0) return;
      var next = this.queue.shift();
      this.bytes -= next.length * 2;
      var waiter = this.waiter;
      this.waiter = null;
      waiter.resolve(next);
    }
    onMessage(data) {
      if (this.error) return;
      if (typeof data !== 'string') { this.end('non_string_frame'); return; }
      this.bytes += data.length * 2;
      if (this.bytes > MAX_QUEUED_BYTES) { this.end('queue_overflow'); return; }
      this.queue.push(data);
      this.pump();
    }
    end(reason) {
      if (this.error) return;
      this.error = new Error('bridge_protocol_error:' + reason);
      this.port.onmessage = null;
      this.port.onmessageerror = null;
      try { this.port.close(); } catch (error) { /* closed */ }
      this.queue = [];
      this.bytes = 0;
      var waiter = this.waiter;
      this.waiter = null;
      if (waiter) waiter.reject(this.error);
      this.onEnd(reason);
    }
  }

  var start = async function (init, port) {
    var post = async function (url, body) {
      var response = await fetch(url, {
        method: 'POST', credentials: 'same-origin', headers: HEADERS, body: JSON.stringify(body)
      });
      var json;
      try { json = await response.json(); } catch (error) { json = undefined; }
      return { status: response.status, json: json };
    };
    var mint = async function () {
      try {
        var reply = await post(init.sessionUrl, {
          appId: init.appId, releaseDigest: init.releaseDigest
        });
        var handle = reply.json && reply.json.handle;
        return reply.status === 200 && typeof handle === 'string' && handle.length > 0 &&
          handle.length <= MAX_HANDLE_LENGTH ? handle : undefined;
      } catch (error) {
        return undefined;
      }
    };
    var run = async function (handle, operation) {
      try {
        var reply = await post(init.executeUrl, Object.assign({ handle: handle }, operation));
        var json = reply.json;
        if (reply.status === 200 && json && json.ok === true &&
            typeof json.result === 'object' && json.result !== null) {
          return { ok: true, result: json.result };
        }
        var code = json && json.attributes && json.attributes.code;
        return { ok: false, code: CODES.indexOf(code) >= 0 ? code : 'app_unavailable' };
      } catch (error) {
        return { ok: false, code: 'app_unavailable' };
      }
    };

    var handle = await mint();
    if (!handle) { notify({ t: 'end', reason: 'session_failed' }); return; }
    var ended = false;
    var end = function (reason) {
      if (ended) return;
      ended = true;
      notify({ t: 'end', reason: reason });
    };
    // An expired handle is re-minted once per call. A lifecycle refusal ends the session after
    // capnweb has sent it to the guest; the parent then terminates this Worker.
    var execute = async function (operation) {
      var outcome = await run(handle, operation);
      if (!outcome.ok && outcome.code === 'app_expired') {
        var next = await mint();
        if (next) { handle = next; outcome = await run(next, operation); }
      }
      if (outcome.ok) return outcome.result;
      if (TERMINAL.indexOf(outcome.code) >= 0) setTimeout(end, 0, outcome.code);
      throw bridgeError(outcome.code);
    };
    var request = function (args, arity, valid) {
      if (args.length !== arity || (arity === 1 && !isObject(args[0])) || !valid(args[0])) {
        throw bridgeError('bridge_invalid_request');
      }
    };
    var any = function () { return true; };
    var hasId = function (value) { return typeof value.id === 'string'; };

    // The only object the guest can call: exactly these methods, no state of its own.
    class AppBridge extends capnweb.RpcTarget {
      async callAppRoute() {
        request(arguments, 1, function (value) {
          return Object.keys(value).length === 2 && value.method === 'GET' &&
            value.path === '/summary';
        });
        return execute({ op: 'app.summary' });
      }
      async search(params) {
        request(arguments, 1, any);
        return execute({ op: 'es.search', params: params });
      }
      async getDashboardPreview(params) {
        request(arguments, 1, hasId);
        return execute({ op: 'kibana.dashboard.read', params: params });
      }
      async listDataViews() {
        request(arguments, 0, any);
        return execute({ op: 'kibana.dataViews.read', params: {} });
      }
      async getDataView(params) {
        request(arguments, 1, hasId);
        return execute({ op: 'kibana.dataViews.read', params: params });
      }
      async esql(params) {
        request(arguments, 1, any);
        return execute({ op: 'es.esql', params: params });
      }
      async getTheme() {
        request(arguments, 0, any);
        return JSON.parse(JSON.stringify(init.theme));
      }
    }

    var transport = new Transport(port, end);
    new capnweb.RpcSession(transport, new AppBridge(), {
      onSendError: function (error) { return bridgeError(error && error.message); }
    });
    notify({ t: 'ready' });
  };

  self.onmessage = function (event) {
    // Exactly one init message from the owning page; anything later is ignored.
    self.onmessage = null;
    var data = event.data;
    var port = event.ports && event.ports[0];
    if (!data || data.t !== 'init' || !port) { notify({ t: 'end', reason: 'session_failed' }); return; }
    start(data, port);
  };
})();
`;

let capnwebScript: string | undefined;

/**
 * capnweb's CommonJS build (no imports, no globals) wrapped as a classic script that defines
 * `self.capnweb` for the bridge Worker's `importScripts`. Read once from the installed package.
 */
export const capnwebWorkerScript = (): string => {
  if (capnwebScript === undefined) {
    const source = readFileSync(require.resolve('capnweb'), 'utf8').replace(
      /\n\/\/# sourceMappingURL=.*$/,
      ''
    );
    capnwebScript = `(function (exports) {\n${source}\n})(self.capnweb = {});\n`;
  }
  return capnwebScript;
};
