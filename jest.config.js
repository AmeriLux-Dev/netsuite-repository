/** @type {import('jest').Config} */
const runtimeProject = {
    displayName: 'runtime',
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['<rootDir>/src/__tests__/**/*.test.ts'],
    coveragePathIgnorePatterns: ['/node_modules/', '<rootDir>/tooling/'],
    moduleNameMapper: {
        '^N/(.*)$': '<rootDir>/src/__mocks__/netsuite/$1',
    },
};

const toolingProject = {
    displayName: 'tooling',
    testEnvironment: 'node',
    testMatch: ['<rootDir>/tooling/__tests__/**/*.test.ts'],
    coveragePathIgnorePatterns: ['/node_modules/', '<rootDir>/src/', '<rootDir>/tooling/cli/bin\\.ts$'],
    transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.tooling.test.json' }],
    },
    moduleNameMapper: {
        '^N/(.*)$': '<rootDir>/src/__mocks__/netsuite/$1',
    },
};

module.exports = {
    projects: [runtimeProject, toolingProject],
    // No threshold: coverage is a report, not a gate. `npm run test:coverage` collects it on demand.
    collectCoverageFrom: [
        'src/**/*.ts',
        'tooling/**/*.ts',
        '!src/__tests__/**',
        '!src/__mocks__/**',
        '!tooling/__tests__/**',
        '!tooling/cli/bin.ts',
    ],
};
