/**
 * Which day a nightly settlement may act on.
 *
 * Framework-free and dependency-free on purpose: the scheduled route, the
 * operator script and the tests all need this answer, and the route's own
 * module cannot be imported outside a server component. A decision this small
 * and this consequential should be readable and testable on its own.
 *
 * Everything here is UTC. An epoch is a UTC day, so a deployment's region must
 * never change which day gets settled.
 */

/** The most recent day that is definitely over. */
export function lastCompleteDay(now: Date = new Date()): string {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Is this day fully over?
 *
 * A day still in progress has usage yet to arrive, and settled allocations are
 * immutable -- so crediting it early would credit a partial day and then
 * refuse the rest of it forever.
 */
export function isDayComplete(day: string, now: Date = new Date()): boolean {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start)) return false;
  return now.getTime() >= start + 24 * 60 * 60 * 1000;
}
