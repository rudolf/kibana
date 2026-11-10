/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { htmlSafeJson, renderFrameDocument, renderGuardianDocument } from './documents';
import { CHILD_BOOTSTRAP_SCRIPT, GUARDIAN_SCRIPT } from './host_scripts';
import { UI_LIMITS } from '../../common/ui_protocol';

describe('generated documents', () => {
  it('JSON data blocks cannot close the script element', () => {
    const encoded = htmlSafeJson({ x: '</script><script>alert(1)</script>&\u2028' });
    expect(encoded).not.toMatch(/[<>&\u2028]/);
    expect(JSON.parse(encoded).x).toBe('</script><script>alert(1)</script>&\u2028');
  });

  it('renders only fixed markup with the exact script URLs', () => {
    const guardian = renderGuardianDocument({
      guardianScript: 'http://localhost:5601/api/app_host/ui_assets/host-guardian.js',
      childUrl: `http://localhost:5601/api/app_host/ui/alert-digest/${'a'.repeat(64)}/frame`,
      parentOrigin: 'http://localhost:5601',
    });
    expect(guardian.match(/<script/g)).toHaveLength(2);
    expect(guardian).toContain('type="application/json"');
    const frame = renderFrameDocument({
      bootstrapScript: 'http://localhost:5601/api/app_host/ui_assets/host-child.js',
      uiScript: `http://localhost:5601/api/app_host/ui_assets/${'b'.repeat(64)}.js`,
    });
    expect(frame).not.toMatch(/on[a-z]+=/i);
  });

  it('refuses URLs outside the fixed character set', () => {
    expect(() =>
      renderFrameDocument({ bootstrapScript: 'http://x/"onload="x', uiScript: 'http://x/a.js' })
    ).toThrow();
  });

  it('host scripts are small and never touch event.data before checking event.source', () => {
    for (const script of [GUARDIAN_SCRIPT, CHILD_BOOTSTRAP_SCRIPT]) {
      expect(Buffer.byteLength(script)).toBeLessThan(UI_LIMITS.hostScriptBytes);
      expect(script).not.toMatch(/\beval\b|new Function|innerHTML/);
    }
    // Guardian: the source/origin checks precede every `event.data` read (S4).
    const onMessage = GUARDIAN_SCRIPT.slice(GUARDIAN_SCRIPT.indexOf('var onMessage'));
    expect(onMessage.indexOf('event.source')).toBeLessThan(onMessage.indexOf('onInit(event)'));
    expect(GUARDIAN_SCRIPT).toContain("window.removeEventListener('message', onMessage)");
  });
});
