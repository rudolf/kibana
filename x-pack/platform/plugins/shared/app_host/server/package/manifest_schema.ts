/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TypeOf } from '@kbn/config-schema';
import { schema } from '@kbn/config-schema';
import { HOST_API_VERSION, INSTALLED_APP_ID, LIMITS, SYNTHETIC_INDEX } from '../../common';

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
  digest: schema.string({
    minLength: 64,
    maxLength: 64,
    validate: (value) =>
      /^[0-9a-f]{64}$/.test(value) ? undefined : 'must be lowercase sha256 hex',
  }),
  permissions: schema.object({
    indices: schema.arrayOf(schema.literal(SYNTHETIC_INDEX), { minSize: 1, maxSize: 1 }),
  }),
  routes: schema.arrayOf(
    schema.object({
      method: schema.literal('GET'),
      path: schema.literal('/summary'),
      handler: schema.literal('summary'),
    }),
    { minSize: 1, maxSize: 1 }
  ),
});

export type AppManifest = TypeOf<typeof manifestSchema>;
