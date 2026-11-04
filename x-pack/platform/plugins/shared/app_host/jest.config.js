/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

module.exports = {
  preset: '@kbn/jest',
  rootDir: '../../../../..',
  roots: ['<rootDir>/x-pack/platform/plugins/shared/app_host'],
  // The isolated prototype tool package has its own toolchain and node_modules.
  modulePathIgnorePatterns: ['<rootDir>/x-pack/platform/plugins/shared/app_host/prototype/'],
  testPathIgnorePatterns: ['<rootDir>/x-pack/platform/plugins/shared/app_host/prototype/'],
};
