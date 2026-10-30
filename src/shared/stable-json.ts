import { createHash } from 'node:crypto';

/** JSON serialization with object keys sorted, so equal values serialize equally. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/** A SHA-256 digest of the stable serialization of `value`. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** Recursively freezes a value so stored records cannot be mutated in place. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) {
        result[key] = normalize(source[key]);
      }
    }
    return result;
  }
  return value;
}
