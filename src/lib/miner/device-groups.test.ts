import { describe, expect, it } from "vitest";
import { groupDeviceViews } from "./device-groups";

const view = (id: string, revoked = false, previousPairing = false) => ({ id, revoked, previousPairing });

describe("groupDeviceViews", () => {
  it("gives live pairings the space and folds the history away", () => {
    const groups = groupDeviceViews([
      view("current"),
      view("superseded", false, true),
      view("revoked-1", true),
      view("revoked-2", true),
    ]);
    expect(groups.current.map((v) => v.id)).toEqual(["current"]);
    expect(groups.earlier.map((v) => v.id)).toEqual(["superseded", "revoked-1", "revoked-2"]);
  });

  it("keeps an offline device that is still the latest pairing current", () => {
    // Offline is not history: the app is simply closed.
    expect(groupDeviceViews([view("laptop"), view("desktop")]).current).toHaveLength(2);
  });

  it("shows only history when every device was revoked", () => {
    const groups = groupDeviceViews([view("a", true)]);
    expect(groups).toEqual({ current: [], earlier: [view("a", true)] });
  });
});
