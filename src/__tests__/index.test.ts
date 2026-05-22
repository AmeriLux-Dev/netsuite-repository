import { repository, createContext } from '../index';
import { createNetSuiteContext } from '../context';
import { RecordUpdater } from '../record-updater';
import { QueryBuilder } from '../query';
import { customerConfig } from './fixtures';
import * as NsRecord from 'N/record';
import * as NsQuery from 'N/query';

const mockSubmitFields = NsRecord.submitFields as unknown as jest.Mock;
const mockRunSuiteQL = NsQuery.runSuiteQL as unknown as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('repository()', () => {
    it('.query() returns a QueryBuilder', () => {
        const repo = repository(customerConfig);
        expect(repo.query()).toBeInstanceOf(QueryBuilder);
    });

    it('.update(id) returns a RecordUpdater when no patch provided', () => {
        const repo = repository(customerConfig);
        const updater = repo.update(1);
        expect(updater).toBeInstanceOf(RecordUpdater);
    });

    it('.update(id, patch) submits immediately and returns an UpdateResult', () => {
        mockSubmitFields.mockReturnValue(1);
        const repo = repository(customerConfig);
        const result = repo.update(1, { name: 'Acme' });
        expect(result).toMatchObject({ success: true });
        expect(mockSubmitFields).toHaveBeenCalled();
    });

    it('.update(id, patch, options) applies options before submitting', () => {
        mockSubmitFields.mockReturnValue(1);
        const repo = repository(customerConfig);
        const result = repo.update(1, { name: 'X' }, { enableSourcing: true });
        expect(result).toMatchObject({ success: true });
        expect(mockSubmitFields).toHaveBeenCalledWith(
            expect.objectContaining({
                options: expect.objectContaining({ enableSourcing: true }),
            })
        );
    });
});

describe('createContext', () => {
    it('is an alias for createNetSuiteContext', () => {
        expect(createContext).toBe(createNetSuiteContext);
    });

    it('creates a context from a schema', () => {
        const ctx = createContext({ customers: customerConfig });
        expect((ctx as any).customers).toBeDefined();
    });
});
