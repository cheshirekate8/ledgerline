/**
 * Jest configuration for the frozen acceptance tests, and only for them.
 *
 * It is self-contained on purpose: it does not extend jest.config.js, which a
 * task may change, so nothing a task edits can alter how its acceptance tests
 * are judged. Frozen path: listed in pipeline.config.json frozenPaths.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  rootDir: '..',
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/acceptance'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
};
