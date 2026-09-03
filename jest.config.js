/** @type {import('jest').Config} */
const runtimeProject = {
    displayName: 'runtime',
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['<rootDir>/src/__tests__/**/*.test.ts'],
    coveragePathIgnorePatterns: ['/node_modules/', '/tooling/'],
    moduleNameMapper: {
        '^N/(.*)$': '<rootDir>/src/__mocks__/netsuite/$1',
    },
};

const toolingProject = {
    displayName: 'tooling',
    testEnvironment: 'node',
    testMatch: ['<rootDir>/tooling/__tests__/**/*.test.ts'],
    coveragePathIgnorePatterns: ['/node_modules/', '/src/', '/tooling/cli/bin\\.ts$'],
    transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.tooling.test.json' }],
    },
    moduleNameMapper: {
        '^N/(.*)$': '<rootDir>/src/__mocks__/netsuite/$1',
    },
};

module.exports = {
    projects: [runtimeProject, toolingProject],
    collectCoverage: true,
    collectCoverageFrom: [
        'src/**/*.ts',
        'tooling/**/*.ts',
        '!src/__tests__/**',
        '!src/__mocks__/**',
        '!tooling/__tests__/**',
        '!tooling/cli/bin.ts',
    ],
    coverageThreshold: {
        global: {
            branches: 85,
            functions: 100,
            lines: 100,
            statements: 99,
        },
    },
};
