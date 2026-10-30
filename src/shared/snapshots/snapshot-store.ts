import { streamKey } from '../events/domain-event';
import { deepClone, deepFreeze } from '../stable-json';

export interface Snapshot<TState = unknown> {
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Sequence of the last event folded into `state`. */
  readonly sequence: number;
  /** Version of the state shape; a snapshot with a different version is ignored. */
  readonly schemaVersion: number;
  readonly takenAt: string;
  readonly state: TState;
}

/** Holds the latest snapshot per aggregate. A cache: losing it loses nothing. */
export interface SnapshotStore {
  load(aggregateType: string, aggregateId: string): Snapshot | undefined;
  save(snapshot: Snapshot): void;
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, Snapshot>();

  load(aggregateType: string, aggregateId: string): Snapshot | undefined {
    return this.snapshots.get(streamKey(aggregateType, aggregateId));
  }

  save(snapshot: Snapshot): void {
    const key = streamKey(snapshot.aggregateType, snapshot.aggregateId);
    const existing = this.snapshots.get(key);
    if (existing && existing.sequence > snapshot.sequence) {
      return;
    }
    this.snapshots.set(key, deepFreeze(deepClone(snapshot)));
  }

  get size(): number {
    return this.snapshots.size;
  }
}
