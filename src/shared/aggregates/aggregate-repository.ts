import { Clock, toIsoString } from '../clock';
import { EventData, EventMetadata, NewEvent, StoredEvent } from '../events/domain-event';
import { EventStore } from '../events/event-store';
import { UpcasterRegistry } from '../events/upcaster-registry';
import { IdGenerator } from '../ids';
import { DEFAULT_SNAPSHOT_POLICY, shouldSnapshot, SnapshotPolicy } from '../snapshots/snapshot-policy';
import { SnapshotStore } from '../snapshots/snapshot-store';
import { AggregateRoot } from './aggregate-root';

export interface AggregateRepositoryOptions<A> {
  readonly aggregateType: string;
  readonly create: (id: string) => A;
  readonly store: EventStore;
  readonly upcasters: UpcasterRegistry;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly snapshots?: SnapshotStore;
  readonly snapshotPolicy?: SnapshotPolicy;
  /** Bump when the aggregate's state shape changes, to retire old snapshots. */
  readonly snapshotSchemaVersion?: number;
}

/** What every domain repository needs from the composition root. */
export type RepositoryDependencies = Omit<AggregateRepositoryOptions<unknown>, 'aggregateType' | 'create'>;

/**
 * Loads aggregates by replaying their stream (from the latest snapshot when
 * snapshots are enabled) and saves their new events with an optimistic
 * concurrency check against the sequence they were loaded at.
 */
export class AggregateRepository<TState, TEvent extends EventData, A extends AggregateRoot<TState, TEvent>> {
  private readonly policy: SnapshotPolicy;
  private readonly schemaVersion: number;

  constructor(private readonly options: AggregateRepositoryOptions<A>) {
    this.policy = options.snapshotPolicy ?? DEFAULT_SNAPSHOT_POLICY;
    this.schemaVersion = options.snapshotSchemaVersion ?? 1;
  }

  /** Returns the aggregate, or undefined if its stream has no events. */
  load(id: string): A | undefined {
    const { aggregateType, store, upcasters } = this.options;
    const aggregate = this.options.create(id);
    const snapshot = this.loadSnapshot(id);
    if (snapshot) {
      aggregate.restoreSnapshot({ sequence: snapshot.sequence, state: snapshot.state as TState });
    }
    const events = store.readStream(aggregateType, id, aggregate.version).map((event) => upcasters.upcast(event));
    if (!snapshot && events.length === 0) {
      return undefined;
    }
    aggregate.rehydrate(events);
    return aggregate;
  }

  exists(id: string): boolean {
    return this.options.store.currentSequence(this.options.aggregateType, id) > 0;
  }

  /** Appends the aggregate's pending events and returns them as stored. */
  save(aggregate: A, metadata: EventMetadata = {}): readonly StoredEvent[] {
    const { aggregateType, store, ids, clock, upcasters } = this.options;
    const pending = aggregate.peekPendingEvents();
    if (pending.length === 0) {
      return [];
    }
    const occurredAt = toIsoString(clock.now());
    const newEvents: NewEvent[] = pending.map((event) => {
      const currentVersion = upcasters.currentVersion(event.type);
      if (event.version !== currentVersion) {
        throw new Error(`${event.type} must be written at v${currentVersion}, got v${event.version}`);
      }
      return { ...event, eventId: ids.next(), occurredAt, metadata };
    });
    const previousSequence = aggregate.version;
    const stored = store.append(aggregateType, aggregate.id, previousSequence, newEvents);
    const lastSequence = stored[stored.length - 1]?.sequence ?? previousSequence;
    aggregate.markCommitted(lastSequence);
    this.maybeSnapshot(aggregate, previousSequence, lastSequence);
    return stored;
  }

  private loadSnapshot(id: string) {
    const { snapshots, aggregateType } = this.options;
    if (!snapshots || !this.policy.enabled) {
      return undefined;
    }
    const snapshot = snapshots.load(aggregateType, id);
    return snapshot && snapshot.schemaVersion === this.schemaVersion ? snapshot : undefined;
  }

  private maybeSnapshot(aggregate: A, previousSequence: number, lastSequence: number): void {
    const { snapshots, aggregateType, clock } = this.options;
    if (!snapshots || !shouldSnapshot(this.policy, previousSequence, lastSequence)) {
      return;
    }
    const { sequence, state } = aggregate.takeSnapshot();
    snapshots.save({
      aggregateType,
      aggregateId: aggregate.id,
      sequence,
      schemaVersion: this.schemaVersion,
      takenAt: toIsoString(clock.now()),
      state,
    });
  }
}
