import { backoffDelay, DEFAULT_RETRY_POLICY, retryPolicy } from '../../../../src/shared/messaging/retry-policy';

describe('backoffDelay', () => {
  it('grows exponentially up to the cap', () => {
    const strategy = { kind: 'exponential', initialDelayMs: 100, multiplier: 2, maxDelayMs: 1_000 } as const;
    expect([1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(strategy, attempt))).toEqual([
      100, 200, 400, 800, 1_000, 1_000,
    ]);
  });

  it('stays constant for a fixed strategy', () => {
    expect(backoffDelay({ kind: 'fixed', delayMs: 250 }, 1)).toBe(250);
    expect(backoffDelay({ kind: 'fixed', delayMs: 250 }, 9)).toBe(250);
  });

  it('requires a positive attempt count', () => {
    expect(() => backoffDelay({ kind: 'fixed', delayMs: 1 }, 0)).toThrow(RangeError);
  });
});

describe('retryPolicy', () => {
  it('defaults to five attempts with exponential backoff', () => {
    expect(retryPolicy()).toEqual(DEFAULT_RETRY_POLICY);
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(5);
  });

  it('accepts overrides', () => {
    expect(retryPolicy({ maxAttempts: 2, backoff: { kind: 'fixed', delayMs: 0 } })).toEqual({
      maxAttempts: 2,
      backoff: { kind: 'fixed', delayMs: 0 },
    });
  });

  it.each([
    [{ maxAttempts: 0 }],
    [{ maxAttempts: 1.5 }],
    [{ backoff: { kind: 'fixed', delayMs: -1 } as const }],
    [{ backoff: { kind: 'exponential', initialDelayMs: 10, multiplier: 0.5, maxDelayMs: 100 } as const }],
  ])('rejects %p', (overrides) => {
    expect(() => retryPolicy(overrides)).toThrow(RangeError);
  });
});
