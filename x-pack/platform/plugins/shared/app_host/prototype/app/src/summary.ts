/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Plain app logic: no Workers, capnweb or Kibana imports. Receives its host by constructor injection.

export interface SummaryHost {
  search(params: { index: string; size: number }): Promise<{
    total: number;
    records: ReadonlyArray<{ severity: string; rule: string }>;
  }>;
}

export interface SummaryOutput {
  label: string;
  counts: { high: number; low: number };
}

export class Summary {
  readonly #host: SummaryHost;
  readonly #label: string;

  constructor(host: SummaryHost, label: string) {
    this.#host = host;
    this.#label = label;
  }

  async compute(): Promise<SummaryOutput> {
    const { records } = await this.#host.search({ index: 'kbn-apps-prototype-alerts', size: 100 });
    const counts = { high: 0, low: 0 };
    for (const { severity } of records) {
      if (severity === 'high') counts.high += 1;
      else if (severity === 'low') counts.low += 1;
    }
    return { label: this.#label, counts };
  }
}
