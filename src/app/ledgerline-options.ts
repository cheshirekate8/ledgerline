import { PricingCatalog, PricingCatalogConfig } from '../pricing/pricing-catalog';
import { Clock } from '../shared/clock';
import { EventStore } from '../shared/events/event-store';
import { UpcasterRegistry } from '../shared/events/upcaster-registry';
import { IdGenerator } from '../shared/ids';
import { Logger } from '../shared/logger';
import { RetryPolicy } from '../shared/messaging/retry-policy';
import { SnapshotPolicy } from '../shared/snapshots/snapshot-policy';
import { SnapshotStore } from '../shared/snapshots/snapshot-store';

export type PersistenceOptions =
  | { readonly kind: 'memory' }
  | { readonly kind: 'json-file'; readonly path: string; readonly durable?: boolean }
  | { readonly kind: 'custom'; readonly store: EventStore };

export interface LedgerlineOptions {
  /** Prices, tax rates, discount codes and coupons. */
  readonly catalog: PricingCatalogConfig | PricingCatalog;
  /** Defaults to the system clock. Inject a FixedClock for deterministic runs. */
  readonly clock?: Clock;
  /** Defaults to random UUIDs. Inject a SeededIdGenerator for deterministic runs. */
  readonly ids?: IdGenerator;
  /** Defaults to JSON lines on stdout. */
  readonly logger?: Logger;
  /** Defaults to an in-memory event store. */
  readonly persistence?: PersistenceOptions;
  /** Snapshots are off unless `enabled` is set. */
  readonly snapshots?: Partial<SnapshotPolicy>;
  readonly snapshotStore?: SnapshotStore;
  /** Number of messages processed concurrently. Defaults to 4. */
  readonly workers?: number;
  readonly retry?: Partial<RetryPolicy>;
  readonly visibilityTimeoutMs?: number;
  /** How long a placed order holds its stock unpaid. Defaults to 15 minutes. */
  readonly reservationTtlMs?: number;
  /** Hook for declaring newer event versions and registering their upcasters. */
  readonly configureUpcasters?: (registry: UpcasterRegistry) => void;
}

export const DEFAULT_WORKERS = 4;
