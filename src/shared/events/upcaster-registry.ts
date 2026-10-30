import { deepFreeze } from '../stable-json';
import { StoredEvent } from './domain-event';

/** Converts the payload of `type` at `fromVersion` into the `fromVersion + 1` shape. */
export interface Upcaster {
  readonly type: string;
  readonly fromVersion: number;
  upcast(payload: unknown): unknown;
}

export class UnknownEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`Event type ${eventType} has not been declared`);
    this.name = 'UnknownEventTypeError';
  }
}

export class UnsupportedEventVersionError extends Error {
  constructor(
    readonly eventType: string,
    readonly version: number,
    readonly currentVersion: number,
  ) {
    super(`Event ${eventType} v${version} is newer than the supported v${currentVersion}`);
    this.name = 'UnsupportedEventVersionError';
  }
}

export class MissingUpcasterError extends Error {
  constructor(
    readonly eventType: string,
    readonly fromVersion: number,
  ) {
    super(`No upcaster registered for ${eventType} v${fromVersion}`);
    this.name = 'MissingUpcasterError';
  }
}

/**
 * Knows the current schema version of every event type and how to bring an
 * older stored event up to it, one version at a time. Stored events are
 * never rewritten; upcasting happens on read.
 */
export class UpcasterRegistry {
  private readonly currentVersions = new Map<string, number>();
  private readonly upcasters = new Map<string, Upcaster>();

  declare(type: string, currentVersion = 1): this {
    if (!Number.isInteger(currentVersion) || currentVersion < 1) {
      throw new RangeError(`Event versions start at 1, got ${currentVersion} for ${type}`);
    }
    const existing = this.currentVersions.get(type);
    if (existing !== undefined && existing !== currentVersion) {
      throw new Error(`Event type ${type} is already declared at v${existing}`);
    }
    this.currentVersions.set(type, currentVersion);
    return this;
  }

  declareAll(types: readonly string[]): this {
    for (const type of types) {
      this.declare(type);
    }
    return this;
  }

  register(upcaster: Upcaster): this {
    const current = this.currentVersion(upcaster.type);
    if (!Number.isInteger(upcaster.fromVersion) || upcaster.fromVersion < 1 || upcaster.fromVersion >= current) {
      throw new RangeError(
        `Upcaster for ${upcaster.type} must start between v1 and v${current - 1}, got v${upcaster.fromVersion}`,
      );
    }
    const key = upcasterKey(upcaster.type, upcaster.fromVersion);
    if (this.upcasters.has(key)) {
      throw new Error(`An upcaster for ${upcaster.type} v${upcaster.fromVersion} is already registered`);
    }
    this.upcasters.set(key, upcaster);
    return this;
  }

  isDeclared(type: string): boolean {
    return this.currentVersions.has(type);
  }

  currentVersion(type: string): number {
    const version = this.currentVersions.get(type);
    if (version === undefined) {
      throw new UnknownEventTypeError(type);
    }
    return version;
  }

  upcast<E extends StoredEvent>(event: E): E {
    const current = this.currentVersion(event.type);
    if (event.version > current) {
      throw new UnsupportedEventVersionError(event.type, event.version, current);
    }
    if (event.version === current) {
      return event;
    }
    let payload: unknown = event.payload;
    for (let version = event.version; version < current; version += 1) {
      const upcaster = this.upcasters.get(upcasterKey(event.type, version));
      if (!upcaster) {
        throw new MissingUpcasterError(event.type, version);
      }
      payload = upcaster.upcast(payload);
    }
    return deepFreeze({ ...event, version: current, payload });
  }
}

function upcasterKey(type: string, fromVersion: number): string {
  return `${type}@${fromVersion}`;
}
