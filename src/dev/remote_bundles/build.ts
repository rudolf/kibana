/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { build } from 'esbuild';
import { getJsSourceSync } from '@kbn/peggy';
import { selectRemoteDeclarations } from '@kbn/core-remote-common';
import type {
  RemoteContributionSourceDigest,
  RemoteWorkerSpec,
  RemoteSelectionReport,
} from '@kbn/core-remote-common';
import { readRemoteManifest } from './manifest';
import { measureStepChunks, type StepChunkSize } from './step_chunk_sizes';
import { collectRemoteSourceDigests } from './source_digests';

const MAX_STEP_EXCLUSIVE_BYTES = 256 * 1024;

export interface RemoteBundle {
  readonly entry: string;
  readonly bytes: number;
  readonly reportingCeilingBytes?: number;
  readonly exceedsReportingCeiling?: boolean;
  readonly inputs: readonly string[];
  readonly spec: RemoteWorkerSpec;
  readonly selectionReport: readonly RemoteSelectionReport[];
  readonly stepChunks: readonly StepChunkSize[];
  readonly sourceDigests: readonly RemoteContributionSourceDigest[];
}

export interface BundleGraph {
  readonly id: string;
  readonly root: string;
  readonly dependencies: readonly string[];
  readonly contributions: readonly string[];
}

/** Builds a placement-selected graph with one dynamic import boundary per implementation. */
export const buildRemoteBundle = async ({
  manifests,
  graph,
  outdir,
  sourceDigestKinds = [],
  reportingCeilingBytes,
}: {
  manifests: readonly string[];
  graph: BundleGraph;
  outdir: string;
  sourceDigestKinds?: readonly string[];
  reportingCeilingBytes?: number;
}): Promise<RemoteBundle> => {
  if (
    reportingCeilingBytes !== undefined &&
    (!Number.isSafeInteger(reportingCeilingBytes) || reportingCeilingBytes <= 0)
  ) {
    throw new Error('Remote bundle reporting ceiling must be a positive safe integer');
  }
  for (const kind of sourceDigestKinds) {
    if (!graph.contributions.includes(kind)) {
      throw new Error(`Source-digested contribution kind is not selected by graph: ${kind}`);
    }
  }
  const declarations = manifests.map(readRemoteManifest);
  const providers = declarations.flatMap((declaration) => declaration.providers);
  const {
    providers: selected,
    contributions,
    selectionReport,
  } = selectRemoteDeclarations(declarations, graph);
  for (const token of [graph.root, ...graph.dependencies]) {
    if (selected.filter((provider) => provider.token === token).length !== 1) {
      throw new Error(`Graph ${graph.id} requires exactly one provider for ${token}`);
    }
  }
  const root = selected.find(({ token }) => token === graph.root);
  if (!root || root.role !== 'root' || root.placement !== 'executor') {
    throw new Error(`Graph ${graph.id} requires an executor root`);
  }
  const reference = (provider: (typeof selected)[number]) => ({
    tokenId: provider.token,
    modulePath: provider.modulePath,
    exportName: provider.exportName,
  });
  const catalogs = selected.filter(({ role }) => role === 'catalog');
  if (catalogs.length > 1 || catalogs.some(({ placement }) => placement !== 'executor')) {
    throw new Error(`Graph ${graph.id} requires at most one executor catalog`);
  }
  const spec: RemoteWorkerSpec = {
    id: graph.id,
    root: reference(root),
    catalog: catalogs[0] ? reference(catalogs[0]) : undefined,
    executorProviders: selected
      .filter(({ placement, role }) => placement === 'executor' && (!role || role === 'default'))
      .map(reference),
    coordinatorTokenIds: selected
      .filter(({ placement }) => placement === 'coordinator')
      .map(({ token }) => token),
    contributions: contributions.map(({ kind, stepType, modulePath, exportName }) => ({
      kindId: kind,
      stepType,
      modulePath,
      exportName,
    })),
  };
  const implementations = new Set(
    [
      spec.root,
      ...(spec.catalog ? [spec.catalog] : []),
      ...spec.executorProviders,
      ...contributions,
    ].map(({ modulePath }) => modulePath)
  );
  const host = resolve('src/core/packages/remote/server-internal/src/remote_process_entry.ts');
  const entry = `import { isMainThread, workerData } from 'node:worker_threads';
    import { serveProcess, serveWorker } from ${JSON.stringify(host)};
    export const spec = ${JSON.stringify(spec)};
    export const implementations = {
      ${[...implementations]
        .map((path) => `${JSON.stringify(path)}: () => import(${JSON.stringify(path)})`)
        .join(',\n')}
    };
    if (process.send) serveProcess(spec, implementations);
    else if (!isMainThread && workerData?.__kbnRemoteBundlePort) serveWorker(spec, implementations);`;
  mkdirSync(outdir, { recursive: true });
  const lodashEsDir = resolve('node_modules/lodash-es');
  const pureWorkspacePackagePattern =
    /[\\/](?:kbn-workflows(?:-[a-z-]+)?|kbn-connector-specs(?:-runtime)?|kbn-config-schema|kbn-significant-events-runtime|kbn-securitysolution-esql-runtime|core[\\/]packages[\\/](?:di|remote))[\\/]/;
  const result = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: `${graph.id}.ts` },
    outdir,
    entryNames: 'graph',
    chunkNames: '[name]-[hash]',
    outExtension: { '.js': '.mjs' },
    bundle: true,
    splitting: true,
    minify: true,
    legalComments: 'none',
    platform: 'node',
    format: 'esm',
    target: 'node24',
    metafile: true,
    write: false,
    charset: 'ascii',
    loader: { '.text': 'text' },
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    plugins: [
      {
        name: 'peggy',
        setup(bundler) {
          bundler.onLoad({ filter: /\.peggy$/ }, ({ path }) => ({
            contents: getJsSourceSync({
              path,
              content: readFileSync(path, 'utf8'),
              format: 'commonjs',
            }).source,
            loader: 'js',
          }));
        },
      },
      {
        name: 'lodash-es-and-pure-workspace-side-effects',
        setup(bundler) {
          if (existsSync(lodashEsDir)) {
            bundler.onResolve({ filter: /^lodash(?:\/([a-zA-Z0-9_]+))?$/ }, (args) => {
              const fn = args.path === 'lodash' ? undefined : args.path.slice('lodash/'.length);
              if (!fn) {
                const indexFile = join(lodashEsDir, 'lodash.js');
                return existsSync(indexFile) ? { path: indexFile, sideEffects: false } : null;
              }
              const esFile = join(lodashEsDir, `${fn}.js`);
              return existsSync(esFile) ? { path: esFile, sideEffects: false } : null;
            });
          }
          bundler.onResolve({ filter: /^(?:@kbn\/|\.\.?\/)/ }, async (args) => {
            if (args.pluginData?.__pureSideEffectsChecked) return null;
            if (!args.resolveDir) return null;
            const resolved = await bundler.resolve(args.path, {
              kind: args.kind,
              resolveDir: args.resolveDir,
              importer: args.importer,
              pluginData: { ...args.pluginData, __pureSideEffectsChecked: true },
            });
            if (resolved.errors.length || !resolved.path) return null;
            if (pureWorkspacePackagePattern.test(resolved.path)) {
              return { ...resolved, sideEffects: false };
            }
            return null;
          });
        },
      },
    ],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
  const canonical = (path: string): string =>
    existsSync(path) ? realpathSync(path) : resolve(path);
  const coordinatorFiles = new Set(
    providers
      .filter(({ placement }) => placement === 'coordinator')
      .map(({ modulePath }) => canonical(modulePath))
  );
  const forbidden = Object.keys(result.metafile.inputs).filter(
    (path) =>
      coordinatorFiles.has(canonical(path)) ||
      /(?:kbn-repo-(?:info|packages)|@kbn\/repo-(?:info|packages))\//.test(path) ||
      /node_modules\/(?:@elastic\/(?:eui|charts)|@emotion\/|react(?:-dom)?\/|lodash(?:-es)?\/(?:lodash|fp)\.js|lodash\/fp\/index\.js)/.test(
        path
      )
  );
  writeFileSync(join(outdir, 'metafile.json'), JSON.stringify(result.metafile, null, 2));
  writeFileSync(join(outdir, 'forbidden_inputs.json'), JSON.stringify(forbidden, null, 2));
  if (forbidden.length) throw new Error(`Forbidden worker inputs:\n${forbidden.join('\n')}`);
  const stepChunks = measureStepChunks(result.metafile, contributions);
  writeFileSync(join(outdir, 'step_chunks.json'), JSON.stringify(stepChunks, null, 2));
  const oversized = stepChunks.filter(
    ({ exclusiveBytes }) => exclusiveBytes > MAX_STEP_EXCLUSIVE_BYTES
  );
  if (oversized.length) {
    throw new Error(
      `Worker step exclusive chunks exceed ${MAX_STEP_EXCLUSIVE_BYTES} bytes:\n${oversized
        .map(({ stepType, exclusiveBytes }) => `${stepType}: ${exclusiveBytes}`)
        .join('\n')}`
    );
  }
  const sourceDigests = collectRemoteSourceDigests(
    result.metafile,
    contributions.filter(({ kind }) => sourceDigestKinds.includes(kind))
  );
  writeFileSync(join(outdir, 'source_digests.json'), JSON.stringify(sourceDigests, null, 2));
  const escapeNonAscii = (text: string): string =>
    text.replace(/[^\x00-\x7f]/g, (ch) => {
      const code = ch.charCodeAt(0);
      return `\\u${code.toString(16).padStart(4, '0')}`;
    });
  const encodedOutputs = result.outputFiles.map((output) => {
    const raw = Buffer.from(output.contents).toString('utf8');
    const ascii = escapeNonAscii(raw);
    return { path: output.path, contents: Buffer.from(ascii, 'utf8') };
  });
  const bytes = encodedOutputs.reduce((sum, output) => sum + output.contents.length, 0);
  const sizeReport = {
    bytes,
    reportingCeilingBytes,
    exceedsReportingCeiling:
      reportingCeilingBytes === undefined ? undefined : bytes > reportingCeilingBytes,
  };
  writeFileSync(join(outdir, 'bundle_size.json'), JSON.stringify(sizeReport, null, 2));
  for (const output of encodedOutputs) writeFileSync(output.path, output.contents);
  writeFileSync(join(outdir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(outdir, 'selection_report.json'), JSON.stringify(selectionReport, null, 2));
  return {
    entry: join(outdir, 'graph.mjs'),
    ...sizeReport,
    inputs: Object.keys(result.metafile.inputs).map((path) =>
      relative(process.cwd(), resolve(path))
    ),
    spec,
    selectionReport,
    stepChunks,
    sourceDigests,
  };
};
