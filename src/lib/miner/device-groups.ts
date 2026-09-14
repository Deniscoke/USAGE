/**
 * Which devices deserve a full card, and which are history.
 *
 * Every pairing is kept -- revoked rows and superseded pairings of the same PC
 * are the audit trail of which credentials ever existed -- but showing each one
 * with a full set of zeroed figures buries the one computer that matters. The
 * current devices get the space; the rest fold away, still one click from view.
 */

export interface GroupableDevice {
  revoked: boolean;
  previousPairing: boolean;
}

export interface DeviceGroups<T> {
  /** Live pairings: what the owner is running now. */
  current: T[];
  /** Revoked devices and superseded pairings, in the order given. */
  earlier: T[];
}

export function groupDeviceViews<T extends GroupableDevice>(views: readonly T[]): DeviceGroups<T> {
  const current: T[] = [];
  const earlier: T[] = [];
  for (const view of views) {
    (view.revoked || view.previousPairing ? earlier : current).push(view);
  }
  return { current, earlier };
}
