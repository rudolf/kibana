/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TypeOf } from '@kbn/config-schema';
import { schema } from '@kbn/config-schema';
import { HOST_API_VERSION, INSTALLED_APP_ID, LIMITS, SYNTHETIC_INDEX } from '../../common';
import { UI_BRIDGE_API, UI_SCOPES, isUuid } from '../../common/ui_protocol';

const hex64 = () =>
  schema.string({
    minLength: 64,
    maxLength: 64,
    validate: (value) =>
      /^[0-9a-f]{64}$/.test(value) ? undefined : 'must be lowercase sha256 hex',
  });

/** Numeric major.minor.patch, each 0–65535, no prerelease/build metadata (UI releases only). */
export const UI_VERSION_PATTERN = /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/;

export const parseUiVersion = (version: string): [number, number, number] | undefined => {
  const match = UI_VERSION_PATTERN.exec(version);
  if (!match) return undefined;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parts.every((part) => part <= 65535) ? [parts[0], parts[1], parts[2]] : undefined;
};

/** Numeric comparison (never lexical): negative when a < b. */
export const compareUiVersions = (
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// Non-empty egress is rejected rather than ignored: arrays may not contain any entry.
const emptyList = () => schema.arrayOf(schema.string({ maxLength: 1 }), { maxSize: 0 });

const uiSchema = schema.object({
  entry: schema.string({ minLength: 67, maxLength: 67 }),
  digest: hex64(),
  bridgeApi: schema.literal(UI_BRIDGE_API),
  scopeMapDigest: hex64(),
  scopes: schema.arrayOf(
    schema.oneOf([
      schema.literal(UI_SCOPES[0]),
      schema.literal(UI_SCOPES[1]),
      schema.literal(UI_SCOPES[2]),
    ]),
    {
      minSize: 1,
      maxSize: 3,
      validate: (scopes) =>
        new Set(scopes).size === scopes.length ? undefined : 'duplicate scope',
    }
  ),
  egress: schema.object({ client: emptyList(), server: emptyList() }),
});

// Unknown keys are rejected by default at every level of @kbn/config-schema objects.
export const manifestSchema = schema.object({
  id: schema.literal(INSTALLED_APP_ID),
  title: schema.string({ minLength: 1, maxLength: LIMITS.titleLength }),
  version: schema.string({
    minLength: 1,
    maxLength: LIMITS.versionLength,
    validate: (value) =>
      /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(value) ? undefined : 'invalid version format',
  }),
  hostApi: schema.literal(HOST_API_VERSION),
  digest: hex64(),
  // S8: the only grantable index is the synthetic literal, enforced at parse time.
  permissions: schema.object({
    indices: schema.arrayOf(schema.literal(SYNTHETIC_INDEX), { minSize: 1, maxSize: 1 }),
    dashboardIds: schema.maybe(
      schema.arrayOf(
        schema.string({
          maxLength: 64,
          validate: (value) => (isUuid(value) ? undefined : 'must be a lowercase UUID'),
        }),
        { minSize: 1, maxSize: 1 }
      )
    ),
  }),
  routes: schema.arrayOf(
    schema.object({
      method: schema.literal('GET'),
      path: schema.literal('/summary'),
      handler: schema.literal('summary'),
    }),
    { minSize: 1, maxSize: 1 }
  ),
  ui: schema.maybe(uiSchema),
  releaseDigest: schema.maybe(hex64()),
});

export type AppManifest = TypeOf<typeof manifestSchema>;
export type UiEnvelope = TypeOf<typeof uiSchema>;

/** A manifest that carries a verified UI envelope and full release digest. */
export type UiAppManifest = AppManifest & {
  readonly ui: UiEnvelope;
  readonly releaseDigest: string;
  readonly permissions: AppManifest['permissions'] & { readonly dashboardIds: readonly [string] };
};

/** The exact backend fields the dispatcher's strict Worker-wire parser accepts. */
export interface WorkerWireManifest {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly hostApi: number;
  readonly digest: string;
  readonly permissions: { readonly indices: readonly string[] };
  readonly routes: AppManifest['routes'];
}

/**
 * Projects a verified manifest onto the existing Worker wire schema, excluding `ui`,
 * `releaseDigest` and `permissions.dashboardIds`. The Worker never receives UI grants.
 */
export const projectWorkerManifest = (manifest: AppManifest): WorkerWireManifest => ({
  id: manifest.id,
  title: manifest.title,
  version: manifest.version,
  hostApi: manifest.hostApi,
  digest: manifest.digest,
  permissions: { indices: [...manifest.permissions.indices] },
  routes: manifest.routes.map(({ method, path, handler }) => ({ method, path, handler })),
});
