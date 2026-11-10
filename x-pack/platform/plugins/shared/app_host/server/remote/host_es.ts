/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { remotable } from '@kbn/core-remote-common';
import type { HostEsSearchResult, SearchCapability } from './search_capability';

/**
 * The only object exposed to remote app code. One instance per invocation; its prototype has a
 * single public method. All state lives in a private field and in the non-exposed capability.
 */
@remotable()
export class HostEs {
  readonly #capability: SearchCapability;

  constructor(capability: SearchCapability) {
    this.#capability = capability;
  }

  search(params: unknown): Promise<HostEsSearchResult> {
    return this.#capability.search(params);
  }
}
