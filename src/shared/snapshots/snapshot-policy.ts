/** When to snapshot aggregates. Off unless explicitly enabled. */
export interface SnapshotPolicy {
  readonly enabled: boolean;
  /** Take a snapshot each time a stream's sequence crosses a multiple of this. */
  readonly interval: number;
}

export const DEFAULT_SNAPSHOT_POLICY: SnapshotPolicy = Object.freeze({ enabled: false, interval: 50 });

export function snapshotPolicy(overrides: Partial<SnapshotPolicy> = {}): SnapshotPolicy {
  const policy = { ...DEFAULT_SNAPSHOT_POLICY, ...overrides };
  if (!Number.isInteger(policy.interval) || policy.interval < 1) {
    throw new RangeError(`Snapshot interval must be a positive integer, got ${policy.interval}`);
  }
  return Object.freeze(policy);
}

export function shouldSnapshot(policy: SnapshotPolicy, previousSequence: number, newSequence: number): boolean {
  if (!policy.enabled || newSequence <= previousSequence) {
    return false;
  }
  return Math.floor(newSequence / policy.interval) > Math.floor(previousSequence / policy.interval);
}
