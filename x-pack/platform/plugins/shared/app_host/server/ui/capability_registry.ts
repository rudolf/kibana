/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CapabilityDescriptor } from '../../common/ui_contract';
import { BRIDGE_V1_CAPABILITIES } from '../../common/ui_contract';

/**
 * Closed, versioned registry of server capabilities. Registration refuses credential minting,
 * deferred execution and egress side effects outright, and refuses reference-accepting capabilities
 * (those need a new reviewed capability, not a boolean escape hatch). Only descriptors that are
 * byte-identical to the pinned bridgeApi 1 contract can be registered.
 */
export class CapabilityRegistry<Handler> {
  readonly #handlers = new Map<string, Handler>();
  #frozen = false;

  register(descriptor: CapabilityDescriptor, handler: Handler): void {
    if (this.#frozen) throw new Error('Capability registry is frozen');
    if (descriptor.mintsCredential || descriptor.executesLater || descriptor.egressSideEffect) {
      throw new Error(`Capability ${descriptor.id} is never delegable`);
    }
    if (descriptor.acceptsReferences) {
      throw new Error(`Capability ${descriptor.id} accepts references; needs a reviewed contract`);
    }
    const pinned = BRIDGE_V1_CAPABILITIES.find(({ id }) => id === descriptor.id);
    if (
      !pinned ||
      JSON.stringify(pinned) !== JSON.stringify(descriptor) ||
      pinned.kind !== 'server'
    ) {
      throw new Error(`Capability ${descriptor.id} is not part of the pinned bridgeApi 1 contract`);
    }
    if (this.#handlers.has(descriptor.id)) throw new Error(`Capability ${descriptor.id} exists`);
    this.#handlers.set(descriptor.id, handler);
  }

  freeze(): this {
    this.#frozen = true;
    return this;
  }

  get(id: string): Handler | undefined {
    return this.#handlers.get(id);
  }

  ids(): string[] {
    return [...this.#handlers.keys()];
  }
}
