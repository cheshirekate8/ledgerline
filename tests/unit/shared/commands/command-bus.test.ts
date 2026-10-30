import { AggregateRepository } from '../../../../src/shared/aggregates/aggregate-repository';
import { FixedClock } from '../../../../src/shared/clock';
import { Command } from '../../../../src/shared/commands/command';
import {
  CommandBus,
  IdempotencyConflictError,
  UnknownCommandError,
} from '../../../../src/shared/commands/command-bus';
import { InMemoryIdempotencyStore } from '../../../../src/shared/commands/idempotency-store';
import { ConcurrencyError, ValidationError } from '../../../../src/shared/errors';
import { InMemoryEventStore } from '../../../../src/shared/events/in-memory-event-store';
import { SeededIdGenerator } from '../../../../src/shared/ids';
import { Counter, CounterEvent, CounterState, counterUpcasters } from '../../../support/counter';

type Increment = Command<'Increment', { counterId: string; by: number }>;

function setup() {
  const store = new InMemoryEventStore();
  const repository = new AggregateRepository<CounterState, CounterEvent, Counter>({
    aggregateType: 'counter',
    create: (id) => new Counter(id),
    store,
    upcasters: counterUpcasters(),
    ids: new SeededIdGenerator(2),
    clock: new FixedClock(0),
  });
  const idempotency = new InMemoryIdempotencyStore();
  const bus = new CommandBus<Increment>({ idempotency });
  const handler = jest.fn(async (command: Increment, context: { metadata: object }) => {
    if (command.payload.by <= 0) {
      throw new ValidationError('must increment by a positive amount');
    }
    const counter = repository.load(command.payload.counterId) ?? new Counter(command.payload.counterId);
    counter.increment(command.payload.by);
    const events = repository.save(counter, context.metadata);
    return { aggregateId: counter.id, version: counter.version, events };
  });
  bus.register('Increment', handler);
  return { store, repository, bus, handler, idempotency };
}

const increment = (key: string, by = 1, counterId = 'c-1'): Increment => ({
  type: 'Increment',
  idempotencyKey: key,
  payload: { counterId, by },
});

describe('CommandBus', () => {
  it('runs the handler and records the outcome', async () => {
    const { bus, store } = setup();
    const result = await bus.execute(increment('k-1', 3));
    expect(result).toMatchObject({ aggregateId: 'c-1', version: 1, duplicate: false });
    expect(result.eventIds).toHaveLength(1);
    expect(store.readAll()[0]!.metadata).toMatchObject({
      idempotencyKey: 'k-1',
      commandType: 'Increment',
      commandFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('applies a duplicate delivery only once', async () => {
    const { bus, handler, repository } = setup();
    const first = await bus.execute(increment('k-1', 3));
    const second = await bus.execute(increment('k-1', 3));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ ...first, duplicate: true });
    expect(repository.load('c-1')!.total).toBe(3);
  });

  it('applies concurrent duplicate deliveries only once', async () => {
    const { bus, handler, repository } = setup();
    const results = await Promise.all([bus.execute(increment('k-1')), bus.execute(increment('k-1'))]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.duplicate)).toEqual([false, true]);
    expect(repository.load('c-1')!.total).toBe(1);
  });

  it('refuses a reused key carrying a different command', async () => {
    const { bus } = setup();
    await bus.execute(increment('k-1', 1));
    await expect(bus.execute(increment('k-1', 2))).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('does not record failures, so the same key can succeed later', async () => {
    const { bus, idempotency } = setup();
    await expect(bus.execute(increment('k-bad', 0))).rejects.toBeInstanceOf(ValidationError);
    expect(idempotency.size).toBe(0);
  });

  it('retries a handler that lost an optimistic concurrency race', async () => {
    const { bus, handler } = setup();
    handler.mockImplementationOnce(async () => {
      throw new ConcurrencyError('counter:c-1', 0, 1);
    });
    await expect(bus.execute(increment('k-1'))).resolves.toMatchObject({ duplicate: false });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured number of conflict retries', async () => {
    const bus = new CommandBus<Increment>({ maxConflictRetries: 1 });
    const handler = jest.fn(async () => {
      throw new ConcurrencyError('counter:c-1', 0, 1);
    });
    bus.register('Increment', handler);
    await expect(bus.execute(increment('k-1'))).rejects.toBeInstanceOf(ConcurrencyError);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('rejects commands without a key or without a handler', async () => {
    const { bus } = setup();
    await expect(bus.execute(increment('  '))).rejects.toThrow(/idempotency key/);
    const unrouted = { type: 'Decrement', idempotencyKey: 'k', payload: {} } as unknown as Increment;
    await expect(bus.execute(unrouted)).rejects.toBeInstanceOf(UnknownCommandError);
  });

  it('refuses a second handler for the same command', () => {
    const { bus } = setup();
    expect(() => bus.register('Increment', jest.fn())).toThrow(/already registered/);
  });

  it('passes correlation and causation ids through to event metadata', async () => {
    const { bus, store } = setup();
    await bus.execute({ ...increment('k-1'), correlationId: 'corr-1', causationId: 'evt-9' });
    expect(store.readAll()[0]!.metadata).toMatchObject({ correlationId: 'corr-1', causationId: 'evt-9' });
  });
});
