/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Type, TypeOf } from '@kbn/config-schema';
import { schema } from '@kbn/config-schema';
import type { PluginConfigDescriptor } from '@kbn/core/server';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const whenEnabled = (type: Type<string>) =>
  schema.conditional(schema.siblingRef('enabled'), true, type, schema.maybe(type));

const configSchema = schema.object({
  // Core skips loading this plugin entirely when false.
  enabled: schema.boolean({ defaultValue: false }),
  // Operator-controlled directory holding manifest.json and <sha256>.js. Read per request.
  packagePath: whenEnabled(schema.string({ minLength: 1, maxLength: 4096 })),
  // Dispatcher RPC endpoint. wss:// is required except for loopback development.
  dispatcherUrl: whenEnabled(
    schema.string({
      minLength: 1,
      maxLength: 2048,
      validate: (value) => {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          return 'must be a valid URL';
        }
        if (url.protocol === 'wss:') return;
        if (url.protocol === 'ws:' && LOOPBACK_HOSTS.has(url.hostname)) return;
        return 'must use wss:// (ws:// is only allowed for a loopback dispatcher)';
      },
    })
  ),
  // Dedicated random deployment secret shared with the dispatcher. Never sent to app code.
  callerToken: whenEnabled(schema.string({ minLength: 32, maxLength: 256 })),
});

export type AppHostConfig = TypeOf<typeof configSchema>;

export const config: PluginConfigDescriptor<AppHostConfig> = {
  schema: configSchema,
};
