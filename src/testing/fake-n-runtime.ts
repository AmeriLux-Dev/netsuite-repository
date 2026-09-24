/**
 * An in-memory stand-in for the part of N/runtime the runtime reads: the current script's remaining usage, which the
 * governance guard checks between reads. Map `N/runtime` to the module-level `fakeNRuntime` in jest and queue the
 * values getRemainingUsage() answers, one per call, the last repeating.
 */
export class FakeNRuntimeModule {
    private remainingUsageAnswers: number[] = [];
    private lastRemainingUsage = 10000;

    /** Answers the next getRemainingUsage() calls with these values in order; the last repeats. */
    queueRemainingUsage(...values: number[]): void {
        this.remainingUsageAnswers.push(...values);
    }

    reset(): void {
        this.remainingUsageAnswers = [];
        this.lastRemainingUsage = 10000;
    }

    getCurrentScript(): { getRemainingUsage(): number } {
        return {
            getRemainingUsage: () => {
                const next = this.remainingUsageAnswers.shift();
                if (next !== undefined) {
                    this.lastRemainingUsage = next;
                }
                return this.lastRemainingUsage;
            },
        };
    }
}

export function createFakeNRuntimeModule(): FakeNRuntimeModule {
    return new FakeNRuntimeModule();
}

export const fakeNRuntime = createFakeNRuntimeModule();
