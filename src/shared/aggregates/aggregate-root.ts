import { OutOfOrderEventError } from '../errors';
import { EventData, StoredEvent, streamKey } from '../events/domain-event';
import { deepClone } from '../stable-json';

export interface AggregateSnapshot<TState> {
  readonly sequence: number;
  readonly state: TState;
}

/**
 * Base class for event-sourced aggregates. State only ever changes through
 * `evolve`, both when a new decision is raised and when history is replayed,
 * so a rebuilt aggregate is indistinguishable from the original.
 *
 * State must be plain, structured-cloneable data so it can be snapshotted.
 */
export abstract class AggregateRoot<TState, TEvent extends EventData> {
  abstract readonly aggregateType: string;

  private persistedSequence = 0;
  private pending: TEvent[] = [];

  protected constructor(
    readonly id: string,
    private currentState: TState,
  ) {}

  /** Sequence of the last persisted event; the expected sequence for the next append. */
  get version(): number {
    return this.persistedSequence;
  }

  get hasPendingEvents(): boolean {
    return this.pending.length > 0;
  }

  protected get state(): TState {
    return this.currentState;
  }

  protected abstract evolve(state: TState, event: TEvent): TState;

  protected raise(event: TEvent): void {
    this.currentState = this.evolve(this.currentState, event);
    this.pending.push(event);
  }

  /** Replays persisted events, refusing any gap or reordering in the stream. */
  rehydrate(events: readonly StoredEvent[]): void {
    for (const event of events) {
      const expected = this.persistedSequence + 1;
      if (event.sequence !== expected) {
        throw new OutOfOrderEventError(streamKey(this.aggregateType, this.id), expected, event.sequence);
      }
      this.currentState = this.evolve(this.currentState, event as unknown as TEvent);
      this.persistedSequence = event.sequence;
    }
  }

  restoreSnapshot(snapshot: AggregateSnapshot<TState>): void {
    if (this.persistedSequence !== 0 || this.pending.length > 0) {
      throw new Error('A snapshot can only be restored into a fresh aggregate');
    }
    this.currentState = deepClone(snapshot.state);
    this.persistedSequence = snapshot.sequence;
  }

  takeSnapshot(): AggregateSnapshot<TState> {
    if (this.pending.length > 0) {
      throw new Error('Cannot snapshot an aggregate with unsaved events');
    }
    return { sequence: this.persistedSequence, state: deepClone(this.currentState) };
  }

  /** Hands the unsaved events to the repository. */
  peekPendingEvents(): readonly TEvent[] {
    return [...this.pending];
  }

  markCommitted(sequence: number): void {
    this.persistedSequence = sequence;
    this.pending = [];
  }
}
