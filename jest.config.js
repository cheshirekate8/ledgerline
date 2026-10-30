/**
 * The project's own test suite. Frozen acceptance tests are excluded: they are
 * written before their implementation exists and run separately through
 * tools/run-acceptance.sh.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/acceptance/'],
  collectCoverageFrom: ['src/**/*.ts'],
};
