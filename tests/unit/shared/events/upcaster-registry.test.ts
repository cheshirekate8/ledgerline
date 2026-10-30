import { StoredEvent } from '../../../../src/shared/events/domain-event';
import {
  MissingUpcasterError,
  UnknownEventTypeError,
  UnsupportedEventVersionError,
  UpcasterRegistry,
} from '../../../../src/shared/events/upcaster-registry';

function stored(type: string, version: number, payload: unknown): StoredEvent {
  return {
    type,
    version,
    payload,
    eventId: 'e-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    aggregateType: 'order',
    aggregateId: 'o-1',
    sequence: 1,
    position: 1,
  };
}

describe('UpcasterRegistry', () => {
  it('passes current-version events through untouched', () => {
    const registry = new UpcasterRegistry().declare('OrderPlaced');
    const event = stored('OrderPlaced', 1, { total: 5 });
    expect(registry.upcast(event)).toBe(event);
  });

  it('chains upcasters one version at a time up to the current version', () => {
    const registry = new UpcasterRegistry()
      .declare('OrderPlaced', 3)
      .register({
        type: 'OrderPlaced',
        fromVersion: 1,
        upcast: (payload) => ({ ...(payload as object), currency: 'USD' }),
      })
      .register({
        type: 'OrderPlaced',
        fromVersion: 2,
        upcast: (payload) => {
          const { total, ...rest } = payload as { total: number };
          return { ...rest, totalCents: total };
        },
      });

    const upcast = registry.upcast(stored('OrderPlaced', 1, { total: 5 }));
    expect(upcast.version).toBe(3);
    expect(upcast.payload).toEqual({ currency: 'USD', totalCents: 5 });
    expect(upcast.eventId).toBe('e-1');
    expect(Object.isFrozen(upcast)).toBe(true);

    expect(registry.upcast(stored('OrderPlaced', 2, { total: 7, currency: 'EUR' })).payload).toEqual({
      currency: 'EUR',
      totalCents: 7,
    });
  });

  it('fails loudly on a gap in the upcaster chain', () => {
    const registry = new UpcasterRegistry()
      .declare('OrderPlaced', 3)
      .register({ type: 'OrderPlaced', fromVersion: 2, upcast: (p) => p });
    expect(() => registry.upcast(stored('OrderPlaced', 1, {}))).toThrow(MissingUpcasterError);
  });

  it('refuses events newer than it understands', () => {
    const registry = new UpcasterRegistry().declare('OrderPlaced');
    expect(() => registry.upcast(stored('OrderPlaced', 2, {}))).toThrow(UnsupportedEventVersionError);
  });

  it('refuses undeclared event types', () => {
    const registry = new UpcasterRegistry();
    expect(() => registry.upcast(stored('Mystery', 1, {}))).toThrow(UnknownEventTypeError);
    expect(() => registry.currentVersion('Mystery')).toThrow(UnknownEventTypeError);
    expect(registry.isDeclared('Mystery')).toBe(false);
  });

  it('validates declarations and registrations', () => {
    const registry = new UpcasterRegistry().declare('OrderPlaced', 2);
    expect(() => registry.declare('OrderPlaced', 3)).toThrow(/already declared/);
    expect(() => registry.declare('Other', 0)).toThrow(RangeError);
    expect(() => registry.register({ type: 'OrderPlaced', fromVersion: 2, upcast: (p) => p })).toThrow(RangeError);
    registry.register({ type: 'OrderPlaced', fromVersion: 1, upcast: (p) => p });
    expect(() => registry.register({ type: 'OrderPlaced', fromVersion: 1, upcast: (p) => p })).toThrow(
      /already registered/,
    );
  });

  it('allows re-declaring a type at the same version', () => {
    const registry = new UpcasterRegistry().declare('OrderPlaced');
    expect(() => registry.declare('OrderPlaced', 1)).not.toThrow();
  });
});
