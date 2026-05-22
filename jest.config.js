/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/src/__tests__/**/*.test.ts'],
    moduleNameMapper: {
        '^N/(.*)$': '<rootDir>/src/__mocks__/netsuite/$1',
    },
    collectCoverage: true,
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/__tests__/**',
        '!src/__mocks__/**',
    ],
    coverageThreshold: {
        global: {
            branches: 85,
            functions: 100,
            lines: 100,
            statements: 99,
        },
    },
    ts: {
        tsconfig: {
            rootDir: '.',
        },
    },
};
