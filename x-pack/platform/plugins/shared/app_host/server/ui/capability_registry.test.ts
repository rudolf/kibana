/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BRIDGE_V1_CAPABILITIES } from '../../common/ui_contract';
import { CapabilityRegistry } from './capability_registry';

const base = BRIDGE_V1_CAPABILITIES[1];

describe('CapabilityRegistry (T11)', () => {
  it.each(['mintsCredential', 'executesLater', 'egressSideEffect', 'acceptsReferences'] as const)(
    'refuses %s capabilities',
    (flag) => {
      expect(() =>
        new CapabilityRegistry().register({ ...base, [flag]: true }, () => undefined)
      ).toThrow();
    }
  );

  it('refuses capabilities outside the pinned contract or with altered semantics', () => {
    expect(() =>
      new CapabilityRegistry().register({ ...base, id: 'connector.execute' }, () => undefined)
    ).toThrow();
    expect(() =>
      new CapabilityRegistry().register({ ...base, input: '{index:*}' }, () => undefined)
    ).toThrow();
    expect(() =>
      new CapabilityRegistry().register(
        BRIDGE_V1_CAPABILITIES.find(({ kind }) => kind === 'parent') as never,
        () => undefined
      )
    ).toThrow();
    const registry = new CapabilityRegistry().freeze();
    expect(() => registry.register(base, () => undefined)).toThrow('frozen');
  });

  it('capability code never mints credentials or reaches connectors or inference; the session route is the only minting site', () => {
    const dirs = [__dirname, join(__dirname, '..', 'remote')];
    const files = dirs.flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }))
    );
    const pattern =
      /grantAsInternalUser|apiKeys\.|asInternalUser|actions-plugin|inference-plugin|getActionsClient/g;
    const hits = files.flatMap(({ name, text }) =>
      (text.match(pattern) ?? []).map((match) => `${name}:${match}`)
    );
    // Host-internal broker: one viewer-credential grant on consent, never an app capability.
    expect(hits.sort()).toEqual([
      'register_session_routes.ts:apiKeys.',
      'register_session_routes.ts:apiKeys.',
      'register_session_routes.ts:grantAsInternalUser',
    ]);
  });
});
