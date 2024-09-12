/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { join } from 'path';
import { BehaviorSubject } from 'rxjs';
import { REPO_ROOT } from '@kbn/repo-info';
import { schema } from '@kbn/config-schema';
import { Env } from '@kbn/config';

import { configServiceMock, getEnvOptions } from '@kbn/config-mocks';
import type { CoreContext } from '@kbn/core-base-server-internal';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import type { NodeInfo } from '@kbn/core-node-server';
import { nodeServiceMock } from '@kbn/core-node-server-mocks';
import type { PluginManifest } from '@kbn/core-plugins-server';
import { PluginType } from '@kbn/core-base-common';
import { coreInternalLifecycleMock } from '@kbn/core-lifecycle-server-mocks';
import { createRuntimePluginContractResolverMock } from './test_helpers';
import { PluginWrapper } from './plugin';

import {
  createPluginInitializerContext,
  createPluginSetupContext,
  InstanceInfo,
} from './plugin_context';

const mockPluginInitializer = jest.fn();
const logger = loggingSystemMock.create();
jest.doMock(
  join('plugin-with-initializer-path', 'server'),
  () => ({ plugin: mockPluginInitializer }),
  { virtual: true }
);
jest.doMock(join('plugin-without-initializer-path', 'server'), () => ({}), {
  virtual: true,
});
jest.doMock(join('plugin-with-wrong-initializer-path', 'server'), () => ({ plugin: {} }), {
  virtual: true,
});

const OSS_PLUGIN_PATH_POSIX = '/kibana/src/plugins/ossPlugin';
const OSS_PLUGIN_PATH_WINDOWS = 'C:\\kibana\\src\\plugins\\ossPlugin';
const XPACK_PLUGIN_PATH_POSIX = '/kibana/x-pack/plugins/xPackPlugin';
const XPACK_PLUGIN_PATH_WINDOWS = 'C:\\kibana\\x-pack\\plugins\\xPackPlugin';

function createPluginManifest(manifestProps: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'some-plugin-id',
    version: 'some-version',
    configPath: 'path',
    kibanaVersion: '7.0.0',
    type: PluginType.standard,
    requiredPlugins: ['some-required-dep'],
    optionalPlugins: ['some-optional-dep'],
    requiredBundles: [],
    runtimePluginDependencies: ['some-runtime-dep'],
    server: true,
    ui: true,
    owner: { name: 'Core' },
    ...manifestProps,
  };
}

const configService = configServiceMock.create();
configService.atPath.mockReturnValue(new BehaviorSubject({ initialize: true }));

let coreId: symbol;
let env: Env;
let coreContext: CoreContext;
let instanceInfo: InstanceInfo;
let nodeInfo: NodeInfo;
let runtimeResolver: ReturnType<typeof createRuntimePluginContractResolverMock>;

const setupDeps = coreInternalLifecycleMock.createInternalSetup();

beforeEach(() => {
  coreId = Symbol('core');
  env = Env.createDefault(REPO_ROOT, getEnvOptions());
  instanceInfo = {
    uuid: 'instance-uuid',
  };
  nodeInfo = nodeServiceMock.createInternalPrebootContract();
  runtimeResolver = createRuntimePluginContractResolverMock();
  coreContext = { coreId, env, logger, configService: configService as any };
});

afterEach(() => {
  jest.clearAllMocks();
});

test('`constructor` correctly initializes plugin instance', () => {
  const manifest = createPluginManifest();
  const opaqueId = Symbol();
  const plugin = new PluginWrapper({
    path: 'some-plugin-path',
    manifest,
    opaqueId,
    initializerContext: createPluginInitializerContext({
      coreContext,
      opaqueId,
      manifest,
      instanceInfo,
      nodeInfo,
    }),
  });

  expect(plugin.name).toBe('some-plugin-id');
  expect(plugin.configPath).toBe('path');
  expect(plugin.path).toBe('some-plugin-path');
  expect(plugin.source).toBe('external'); // see below for test cases for non-external sources (OSS and X-Pack)
  expect(plugin.requiredPlugins).toEqual(['some-required-dep']);
  expect(plugin.optionalPlugins).toEqual(['some-optional-dep']);
  expect(plugin.runtimePluginDependencies).toEqual(['some-runtime-dep']);
});

describe('`constructor` correctly sets non-external source', () => {
  function createPlugin(path: string) {
    const manifest = createPluginManifest();
    const opaqueId = Symbol();
    return new PluginWrapper({
      path,
      manifest,
      opaqueId,
      initializerContext: createPluginInitializerContext({
        coreContext,
        opaqueId,
        manifest,
        instanceInfo,
        nodeInfo,
      }),
    });
  }

  test('for OSS plugin in POSIX', () => {
    const plugin = createPlugin(OSS_PLUGIN_PATH_POSIX);
    expect(plugin.source).toBe('oss');
  });

  test('for OSS plugin in Windows', () => {
    const plugin = createPlugin(OSS_PLUGIN_PATH_WINDOWS);
    expect(plugin.source).toBe('oss');
  });

  test('for X-Pack plugin in POSIX', () => {
    const plugin = createPlugin(XPACK_PLUGIN_PATH_POSIX);
    expect(plugin.source).toBe('x-pack');
  });

  test('for X-Pack plugin in Windows', () => {
    const plugin = createPlugin(XPACK_PLUGIN_PATH_WINDOWS);
    expect(plugin.source).toBe('x-pack');
  });
});

test('`setup` fails if the plugin has not been initialized', () => {
  const manifest = createPluginManifest();
  const opaqueId = Symbol();
  const plugin = new PluginWrapper({
    path: 'plugin-without-initializer-path',
    manifest,
    opaqueId,
    initializerContext: createPluginInitializerContext({
      coreContext,
      opaqueId,
      manifest,
      instanceInfo,
      nodeInfo,
    }),
  });

  expect(() =>
    plugin.setup(createPluginSetupContext({ deps: setupDeps, plugin, runtimeResolver }), {})
  ).toThrowErrorMatchingInlineSnapshot(
    `"The plugin is not initialized. Call the init method first."`
  );
});

test('`init` fails if `plugin` initializer is not exported', async () => {
  const manifest = createPluginManifest();
  const opaqueId = Symbol();
  const plugin = new PluginWrapper({
    path: 'plugin-without-initializer-path',
    manifest,
    opaqueId,
    initializerContext: createPluginInitializerContext({
      coreContext,
      opaqueId,
      manifest,
      instanceInfo,
      nodeInfo,
    }),
  });

  await expect(() => plugin.init()).rejects.toThrowErrorMatchingInlineSnapshot(
    `"Plugin \\"some-plugin-id\\" does not export \\"plugin\\" definition (plugin-without-initializer-path)."`
  );
});

test('`init` fails if plugin initializer is not a function', async () => {
  const manifest = createPluginManifest();
  const opaqueId = Symbol();
  const plugin = new PluginWrapper({
    path: 'plugin-with-wrong-initializer-path',
    manifest,
    opaqueId,
    initializerContext: createPluginInitializerContext({
      coreContext,
      opaqueId,
      manifest,
      instanceInfo,
      nodeInfo,
    }),
  });

  await expect(() => plugin.init()).rejects.toThrowErrorMatchingInlineSnapshot(
    `"Definition of plugin \\"some-plugin-id\\" should be a function (plugin-with-wrong-initializer-path)."`
  );
});

test('`init` fails if initializer does not return object', async () => {
  const manifest = createPluginManifest();
  const opaqueId = Symbol();
  const plugin = new PluginWrapper({
    path: 'plugin-with-initializer-path',
    manifest,
    opaqueId,
    initializerContext: createPluginInitializerContext({
      coreContext,
      opaqueId,
      manifest,
      instanceInfo,
      nodeInfo,
    }),
  });

  mockPluginInitializer.mockResolvedValue(null);

  await expect(() => plugin.init()).rejects.toThrowErrorMatchingInlineSnapshot(
    `"Initializer for plugin \\"some-plugin-id\\" is expected to return plugin instance, but returned \\"null\\"."`
  );
});

test('`init` fails if object returned from initializer does not define `setup` function', async () => {
  const manifest = createPluginManifest();
  const opaqueId = Symbol();
  const plugin = new PluginWrapper({
    path: 'plugin-with-initializer-path',
    manifest,
    opaqueId,
    initializerContext: createPluginInitializerContext({
      coreContext,
      opaqueId,
      manifest,
      instanceInfo,
      nodeInfo,
    }),
  });

  const mockPluginInstance = { run: jest.fn() };
  mockPluginInitializer.mockResolvedValue(mockPluginInstance);

  await expect(() => plugin.init()).rejects.toThrowErrorMatchingInlineSnapshot(
    `"Instance of plugin \\"some-plugin-id\\" does not define \\"setup\\" function."`
  );
});

test('`setup` initializes plugin and calls appropriate lifecycle hook', async () => {
  const manifest = createPluginManifest();
  const opaqueId = Symbol();
  const initializerContext = createPluginInitializerContext({
    coreContext,
    opaqueId,
    manifest,
    instanceInfo,
    nodeInfo,
  });
  const plugin = new PluginWrapper({
    path: 'plugin-with-initializer-path',
    manifest,
    opaqueId,
    initializerContext,
  });

  const mockPluginInstance = { setup: jest.fn().mockResolvedValue({ contract: 'yes' }) };
  mockPluginInitializer.mockResolvedValue(mockPluginInstance);

  await plugin.init();

  const setupContext = createPluginSetupContext({ deps: setupDeps, plugin, runtimeResolver });
  const setupDependencies = { 'some-required-dep': { contract: 'no' } };
  await expect(plugin.setup(setupContext, setupDependencies)).resolves.toEqual({ contract: 'yes' });

  expect(mockPluginInitializer).toHaveBeenCalledTimes(1);
  expect(mockPluginInitializer).toHaveBeenCalledWith(initializerContext);

  expect(mockPluginInstance.setup).toHaveBeenCalledTimes(1);
  expect(mockPluginInstance.setup).toHaveBeenCalledWith(setupContext, setupDependencies);
});

test('`start` fails if setup is not called first', () => {
  const manifest = createPluginManifest();
  const opaqueId = Symbol();
  const plugin = new PluginWrapper({
    path: 'some-plugin-path',
    manifest,
    opaqueId,
    initializerContext: createPluginInitializerContext({
      coreContext,
      opaqueId,
      manifest,
      instanceInfo,
      nodeInfo,
    }),
  });

  expect(() => plugin.start({} as any, {} as any)).toThrowErrorMatchingInlineSnapshot(
    `"Plugin \\"some-plugin-id\\" can't be started since it isn't set up."`
  );
});

test('`start` fails invoked for the `preboot` plugin', async () => {
  const manifest = createPluginManifest({ type: PluginType.preboot });
  const opaqueId = Symbol();
  const plugin = new PluginWrapper({
    path: 'plugin-with-initializer-path',
    manifest,
    opaqueId,
    initializerContext: createPluginInitializerContext({
      coreContext,
      opaqueId,
      manifest,
      instanceInfo,
      nodeInfo,
    }),
  });

  const mockPluginInstance = { setup: jest.fn() };
  mockPluginInitializer.mockResolvedValue(mockPluginInstance);

  await plugin.init();
  await plugin.setup({} as any, {} as any);

  expect(() => plugin.start({} as any, {} as any)).toThrowErrorMatchingInlineSnapshot(
    `"Plugin \\"some-plugin-id\\" is a preboot plugin and cannot be started."`
  );
});

test('`start` calls plugin.start with context and dependencies', async () => {
  const manifest = createPluginManifest();
  const opaqueId = Symbol();
  const plugin = new PluginWrapper({
    path: 'plugin-with-initializer-path',
    manifest,
    opaqueId,
    initializerContext: createPluginInitializerContext({
      coreContext,
      opaqueId,
      manifest,
      instanceInfo,
      nodeInfo,
    }),
  });
  const context = { any: 'thing' } as any;
  const deps = { otherDep: 'value' };

  const pluginStartContract = { contract: 'start-contract' };
  const mockPluginInstance = {
    setup: jest.fn(),
    start: jest.fn().mockResolvedValue(pluginStartContract),
  };
  mockPluginInitializer.mockResolvedValue(mockPluginInstance);

  await plugin.init();
  await plugin.setup({} as any, {} as any);

  const startContract = await plugin.start(context, deps);

  expect(startContract).toBe(pluginStartContract);
  expect(mockPluginInstance.start).toHaveBeenCalledWith(context, deps);
});

test("`start` resolves `startDependencies` Promise after plugin's start", async () => {
  expect.assertions(2);

  const manifest = createPluginManifest();
  const opaqueId = Symbol();
  const plugin = new PluginWrapper({
    path: 'plugin-with-initializer-path',
    manifest,
    opaqueId,
    initializerContext: createPluginInitializerContext({
      coreContext,
      opaqueId,
      manifest,
      instanceInfo,
      nodeInfo,
    }),
  });
  const startContext = { any: 'thing' } as any;
  const pluginDeps = { someDep: 'value' };
  const pluginStartContract = {
    someApi: () => 'foo',
  };

  let startDependenciesResolved = false;

  const mockPluginInstance = {
    setup: jest.fn(),
    start: async () => {
      // delay to ensure startDependencies is not resolved until after the plugin instance's start resolves.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(startDependenciesResolved).toBe(false);
      return pluginStartContract;
    },
  };
  mockPluginInitializer.mockResolvedValue(mockPluginInstance);

  await plugin.init();
  await plugin.setup({} as any, {} as any);

  const startDependenciesCheck = plugin.startDependencies.then((resolvedStartDeps) => {
    startDependenciesResolved = true;
    expect(resolvedStartDeps).toEqual([startContext, pluginDeps, pluginStartContract]);
  });

  await plugin.start(startContext, pluginDeps);
  await startDependenciesCheck;
});

test('`stop` fails if plugin is not set up', async () => {
  const manifest = createPluginManifest();
  const opaqueId = Symbol();
  const plugin = new PluginWrapper({
    path: 'plugin-with-initializer-path',
    manifest,
    opaqueId,
    initializerContext: createPluginInitializerContext({
      coreContext,
      opaqueId,
      manifest,
      instanceInfo,
      nodeInfo,
    }),
  });

  const mockPluginInstance = { setup: jest.fn(), stop: jest.fn() };
  mockPluginInitializer.mockResolvedValue(mockPluginInstance);

  await expect(plugin.stop()).rejects.toMatchInlineSnapshot(
    `[Error: Plugin "some-plugin-id" can't be stopped since it isn't set up.]`
  );
  expect(mockPluginInstance.stop).not.toHaveBeenCalled();
});

test('`stop` does nothing if plugin does not define `stop` function', async () => {
  const manifest = createPluginManifest();
  const opaqueId = Symbol();
  const plugin = new PluginWrapper({
    path: 'plugin-with-initializer-path',
    manifest,
    opaqueId,
    initializerContext: createPluginInitializerContext({
      coreContext,
      opaqueId,
      manifest,
      instanceInfo,
      nodeInfo,
    }),
  });

  mockPluginInitializer.mockResolvedValue({ setup: jest.fn() });
  await plugin.init();
  await plugin.setup(createPluginSetupContext({ deps: setupDeps, plugin, runtimeResolver }), {});

  await expect(plugin.stop()).resolves.toBeUndefined();
});

test('`stop` calls `stop` defined by the plugin instance', async () => {
  const manifest = createPluginManifest();
  const opaqueId = Symbol();
  const plugin = new PluginWrapper({
    path: 'plugin-with-initializer-path',
    manifest,
    opaqueId,
    initializerContext: createPluginInitializerContext({
      coreContext,
      opaqueId,
      manifest,
      instanceInfo,
      nodeInfo,
    }),
  });

  const mockPluginInstance = { setup: jest.fn(), stop: jest.fn() };
  mockPluginInitializer.mockResolvedValue(mockPluginInstance);
  await plugin.init();
  await plugin.setup(createPluginSetupContext({ deps: setupDeps, plugin, runtimeResolver }), {});

  await expect(plugin.stop()).resolves.toBeUndefined();
  expect(mockPluginInstance.stop).toHaveBeenCalledTimes(1);
});

describe('#getConfigSchema()', () => {
  it('reads config schema from plugin', () => {
    const pluginSchema = schema.any();
    const configDescriptor = {
      schema: pluginSchema,
    };
    jest.doMock(
      join('plugin-with-schema', 'server'),
      () => ({
        config: configDescriptor,
      }),
      { virtual: true }
    );
    const manifest = createPluginManifest();
    const opaqueId = Symbol();
    const plugin = new PluginWrapper({
      path: 'plugin-with-schema',
      manifest,
      opaqueId,
      initializerContext: createPluginInitializerContext({
        coreContext,
        opaqueId,
        manifest,
        instanceInfo,
        nodeInfo,
      }),
    });

    expect(plugin.getConfigDescriptor()).toBe(configDescriptor);
  });

  it('returns null if config definition not specified', () => {
    jest.doMock(join('plugin-with-no-definition', 'server'), () => ({}), { virtual: true });
    const manifest = createPluginManifest();
    const opaqueId = Symbol();
    const plugin = new PluginWrapper({
      path: 'plugin-with-no-definition',
      manifest,
      opaqueId,
      initializerContext: createPluginInitializerContext({
        coreContext,
        opaqueId,
        manifest,
        instanceInfo,
        nodeInfo,
      }),
    });
    expect(plugin.getConfigDescriptor()).toBe(null);
  });

  it('returns null for plugins without a server part', () => {
    const manifest = createPluginManifest({ server: false });
    const opaqueId = Symbol();
    const plugin = new PluginWrapper({
      path: 'plugin-with-no-definition',
      manifest,
      opaqueId,
      initializerContext: createPluginInitializerContext({
        coreContext,
        opaqueId,
        manifest,
        instanceInfo,
        nodeInfo,
      }),
    });
    expect(plugin.getConfigDescriptor()).toBe(null);
  });

  it('throws if plugin contains invalid schema', () => {
    jest.doMock(
      join('plugin-invalid-schema', 'server'),
      () => ({
        config: {
          schema: {
            validate: () => null,
          },
        },
      }),
      { virtual: true }
    );
    const manifest = createPluginManifest();
    const opaqueId = Symbol();
    const plugin = new PluginWrapper({
      path: 'plugin-invalid-schema',
      manifest,
      opaqueId,
      initializerContext: createPluginInitializerContext({
        coreContext,
        opaqueId,
        manifest,
        instanceInfo,
        nodeInfo,
      }),
    });
    expect(() => plugin.getConfigDescriptor()).toThrowErrorMatchingInlineSnapshot(
      `"Configuration schema expected to be an instance of Type"`
    );
  });
});
