// Criterion 2: idempotencyWindowMs is honoured, can be forever, and is validated.
import { createLedgerline } from '../../../src/app/ledgerline';
import { FixedClock } from '../../../src/shared/clock';
import { HOUR, openStore, T0, tempDirectory } from './harness';

const YEAR = 365 * 24 * HOUR;

function create(windowMs: unknown) {
  return () =>
    createLedgerline({
      catalog: { prices: { MUG: 1_000 }, taxRates: { 'US-OR': 0 } },
      clock: new FixedClock(T0),
      ...({ idempotencyWindowMs: windowMs } as object),
    });
}

describe('criterion 2: the window option', () => {
  it('honours a 60-second window to the millisecond', async () => {
    const store = openStore({ extra: { idempotencyWindowMs: 60_000 } });
    await store.stock('MUG', 0);
    await store.run('ReceiveStock', { sku: 'MUG', quantity: 1 }, 'K');

    store.clock.set(T0 + 59_999);
    expect((await store.run('ReceiveStock', { sku: 'MUG', quantity: 1 }, 'K')).duplicate).toBe(true);
    store.clock.set(T0 + 60_000);
    expect((await store.run('ReceiveStock', { sku: 'MUG', quantity: 1 }, 'K')).duplicate).toBe(false);
  });

  it('remembers keys forever with Number.POSITIVE_INFINITY, including after a restart', async () => {
    const temp = tempDirectory();
    try {
      const extra = { idempotencyWindowMs: Number.POSITIVE_INFINITY };
      const first = openStore({ directory: temp.directory, extra, seed: 11 });
      await first.stock('MUG', 0);
      await first.run('ReceiveStock', { sku: 'MUG', quantity: 1 }, 'K');

      first.clock.set(T0 + 10 * YEAR);
      expect((await first.run('ReceiveStock', { sku: 'MUG', quantity: 1 }, 'K')).duplicate).toBe(true);

      const second = openStore({ directory: temp.directory, extra, seed: 22, clock: first.clock });
      expect((await second.run('ReceiveStock', { sku: 'MUG', quantity: 1 }, 'K')).duplicate).toBe(true);
    } finally {
      temp.remove();
    }
  });

  it('refuses invalid windows with a RangeError and accepts valid ones', () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, 2 ** 53, '86400000']) {
      let caught: unknown;
      try {
        create(invalid)();
      } catch (error) {
        caught = error;
      }
      expect({ value: String(invalid), rangeError: caught instanceof RangeError }).toEqual({
        value: String(invalid),
        rangeError: true,
      });
    }
    for (const valid of [1, Number.POSITIVE_INFINITY, 86_400_000]) {
      expect(create(valid)).not.toThrow();
    }
    expect(() =>
      createLedgerline({ catalog: { prices: { MUG: 1_000 }, taxRates: { 'US-OR': 0 } }, clock: new FixedClock(T0) }),
    ).not.toThrow();
  });
});
