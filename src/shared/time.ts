/** UTC calendar day (YYYY-MM-DD) of an ISO-8601 timestamp. */
export function utcDay(isoTimestamp: string): string {
  const millis = Date.parse(isoTimestamp);
  if (!Number.isFinite(millis)) {
    throw new RangeError(`Invalid timestamp: ${isoTimestamp}`);
  }
  return new Date(millis).toISOString().slice(0, 10);
}

/** True when `epochMillis` is at or after the instant named by `isoTimestamp`. */
export function hasReached(epochMillis: number, isoTimestamp: string): boolean {
  return epochMillis >= Date.parse(isoTimestamp);
}
