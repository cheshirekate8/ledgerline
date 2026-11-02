import { FixedClock, HOUR_MS } from '../../../../src/shared/clock';
import { CommandBus } from '../../../../src/shared/commands/command-bus';
import {
  DEFAULT_IDEMPOTENCY_WINDOW_MS,
  hydrateIdempotencyStore,
  idempotencyWindowMs,
  InMemoryIdempotencyStore,
} from '../../../../src/shared/commands/idempotency-store';
import { InMemoryEventStore } from '../../../../src/shared/events/in-memory-event-store';
import { newEvent } from '../../../support/counter';

const OCCURRED_AT = '2026-01-01T00:00:00.000Z';
const RAN_AT = Date.parse(OCCURRED_AT);

const record = (key: string, overrides: { fingerprint?: string; ranAt?: number } = {}) => ({
  key,
  commandType: 'X',
  fingerprint: overrides.fingerprint ?? 'f',
  aggregateId: 'a',
  version: 2,
  eventIds: ['e'],
  ranAt: overrides.ranAt ?? RAN_AT,
});

describe('idempotencyWindowMs', () => {
  it('defaults to 24 hours and accepts a positive safe integer or forever', () => {
    expect(idempotencyWindowMs(undefined)).toBe(DEFAULT_IDEMPOTENCY_WINDOW_MS);
    expect(DEFAULT_IDEMPOTENCY_WINDOW_MS).toBe(24 * HOUR_MS);
    expect(idempotencyWindowMs(1)).toBe(1);
    expect(idempotencyWindowMs(60_000)).toBe(60_000);
    expect(idempotencyWindowMs(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it('refuses anything that is not a positive safe integer of milliseconds', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, 2 ** 53, '86400000', null]) {
      expect(() => idempotencyWindowMs(bad)).toThrow(RangeError);
    }
  });
});

describe('InMemoryIdempotencyStore', () => {
  it('stores and returns records by key', () => {
    const store = new InMemoryIdempotencyStore({ clock: new FixedClock(RAN_AT) });
    store.put(record('k'));
    expect(store.get('k')).toEqual(record('k'));
    expect(store.get('other')).toBeUndefined();
    expect(Object.isFrozen(store.get('k'))).toBe(true);
  });

  it('stops returning a record once its window has passed', () => {
    const clock = new FixedClock(RAN_AT);
    const store = new InMemoryIdempotencyStore({ clock, windowMs: 60_000 });
    store.put(record('k'));

    clock.advance(59_999);
    expect(store.get('k')).toBeDefined();
    clock.advance(1);
    expect(store.get('k')).toBeUndefined();
  });

  it('keeps a record forever when the window is infinite', () => {
    const clock = new FixedClock(RAN_AT);
    const store = new InMemoryIdempotencyStore({ clock, windowMs: Number.POSITIVE_INFINITY });
    store.put(record('k'));

    clock.advance(10 * 365 * 24 * HOUR_MS);
    store.forgetExpired();
    expect(store.get('k')).toBeDefined();
    expect(store.size).toBe(1);
  });

  it('counts what it holds, not what the clock would filter out', () => {
    const clock = new FixedClock(RAN_AT);
    const store = new InMemoryIdempotencyStore({ clock, windowMs: 60_000 });
    store.put(record('live', { ranAt: RAN_AT + 60_000 }));
    store.put(record('expiring'));

    clock.advance(60_000);
    expect(store.get('expiring')).toBeUndefined();
    expect(store.size).toBe(2);

    store.forgetExpired();
    expect(store.size).toBe(1);
    expect(store.get('live')).toBeDefined();
  });
});

describe('hydrateIdempotencyStore', () => {
  it('rebuilds one record per idempotency key from event metadata', () => {
    const events = new InMemoryEventStore();
    const metadata = { idempotencyKey: 'k-1', commandType: 'Place', commandFingerprint: 'fp-1' };
    events.append('order', 'o-1', 0, [newEvent('A', {}, { metadata }), newEvent('B', {}, { metadata })]);
    events.append('order', 'o-2', 0, [newEvent('C', {}, { metadata: {} })]);

    const store = new InMemoryIdempotencyStore({ clock: new FixedClock(RAN_AT) });
    expect(hydrateIdempotencyStore(events, store)).toBe(1);
    expect(store.get('k-1')).toEqual({
      key: 'k-1',
      commandType: 'Place',
      fingerprint: 'fp-1',
      aggregateId: 'o-1',
      version: 2,
      eventIds: events.readStream('order', 'o-1').map((e) => e.eventId),
      ranAt: RAN_AT,
    });
  });

  it('rebuilds a key as its latest use, not its first', () => {
    const events = new InMemoryEventStore();
    const key = 'k-1';
    events.append('order', 'o-1', 0, [
      newEvent('A', {}, { metadata: { idempotencyKey: key, commandType: 'Place', commandFingerprint: 'fp-1' } }),
    ]);
    const later = '2026-01-03T00:00:00.000Z';
    events.append('order', 'o-2', 0, [
      newEvent('B', {}, {
        occurredAt: later,
        metadata: { idempotencyKey: key, commandType: 'Ship', commandFingerprint: 'fp-2' },
      }),
    ]);

    const store = new InMemoryIdempotencyStore({ clock: new FixedClock(later) });
    hydrateIdempotencyStore(events, store);
    expect(store.get(key)).toMatchObject({
      commandType: 'Ship',
      fingerprint: 'fp-2',
      aggregateId: 'o-2',
      ranAt: Date.parse(later),
    });
    expect(store.get(key)!.eventIds).toHaveLength(1);
  });

  it('does not rebuild a key whose window had already passed', () => {
    const events = new InMemoryEventStore();
    const metadata = { idempotencyKey: 'k-1', commandType: 'Place', commandFingerprint: 'fp-1' };
    events.append('order', 'o-1', 0, [newEvent('A', {}, { metadata })]);

    const clock = new FixedClock(RAN_AT + 24 * HOUR_MS);
    const store = new InMemoryIdempotencyStore({ clock, windowMs: 24 * HOUR_MS });
    expect(hydrateIdempotencyStore(events, store)).toBe(0);
    expect(store.size).toBe(0);
  });

  it('lets a command bus recognise work done before a restart', async () => {
    const events = new InMemoryEventStore();
    const clock = new FixedClock(RAN_AT);
    const bus = new CommandBus({ clock });
    const handler = jest.fn(async (_command: unknown, context: { metadata: object }) => {
      const stored = events.append('order', 'o-1', events.currentSequence('order', 'o-1'), [
        newEvent('Placed', {}, { occurredAt: OCCURRED_AT, metadata: context.metadata }),
      ]);
      return { aggregateId: 'o-1', version: stored[0]!.sequence, events: stored };
    });
    bus.register('Place', handler);
    await bus.execute({ type: 'Place', idempotencyKey: 'k-1', payload: {} });

    const restartedStore = new InMemoryIdempotencyStore({ clock });
    hydrateIdempotencyStore(events, restartedStore);
    const restarted = new CommandBus({ idempotency: restartedStore, clock });
    restarted.register('Place', handler);
    const result = await restarted.execute({ type: 'Place', idempotencyKey: 'k-1', payload: {} });

    expect(result.duplicate).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
