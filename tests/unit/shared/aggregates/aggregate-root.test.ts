import { OutOfOrderEventError } from '../../../../src/shared/errors';
import { StoredEvent } from '../../../../src/shared/events/domain-event';
import { Counter } from '../../../support/counter';

function history(...amounts: number[]): StoredEvent[] {
  return amounts.map((by, index) => ({
    type: 'CounterIncremented',
    version: 1,
    payload: { by },
    eventId: `e-${index}`,
    occurredAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    aggregateType: 'counter',
    aggregateId: 'c-1',
    sequence: index + 1,
    position: index + 1,
  }));
}

describe('AggregateRoot', () => {
  it('applies raised events immediately and keeps them pending', () => {
    const counter = new Counter('c-1');
    counter.increment(2);
    counter.increment(3);
    expect(counter.total).toBe(5);
    expect(counter.version).toBe(0);
    expect(counter.peekPendingEvents().map((e) => e.type)).toEqual(['CounterIncremented', 'CounterIncremented']);
  });

  it('rebuilds the same state from history', () => {
    const counter = new Counter('c-1');
    counter.rehydrate(history(2, 3, 4));
    expect(counter.total).toBe(9);
    expect(counter.version).toBe(3);
    expect(counter.hasPendingEvents).toBe(false);
  });

  it('refuses history with a gap or reordering', () => {
    const events = history(1, 2, 3);
    expect(() => new Counter('c-1').rehydrate([events[0]!, events[2]!])).toThrow(OutOfOrderEventError);
    expect(() => new Counter('c-1').rehydrate([events[1]!, events[0]!])).toThrow(OutOfOrderEventError);
  });

  it('clears pending events once committed', () => {
    const counter = new Counter('c-1');
    counter.increment(1);
    counter.markCommitted(1);
    expect(counter.hasPendingEvents).toBe(false);
    expect(counter.version).toBe(1);
  });

  it('round-trips through a snapshot without sharing state', () => {
    const original = new Counter('c-1');
    original.rehydrate(history(5, 5));
    const snapshot = original.takeSnapshot();

    const restored = new Counter('c-1');
    restored.restoreSnapshot(snapshot);
    restored.increment(1);
    expect(restored.total).toBe(11);
    expect(restored.version).toBe(2);
    expect(original.total).toBe(10);
  });

  it('refuses to snapshot with unsaved events or restore into a used aggregate', () => {
    const counter = new Counter('c-1');
    counter.increment(1);
    expect(() => counter.takeSnapshot()).toThrow(/unsaved events/);
    expect(() => counter.restoreSnapshot({ sequence: 1, state: { total: 1, increments: 1 } })).toThrow(/fresh/);
  });
});
