import { describe, expect, it } from "vitest";
import { NPM_PACKAGE_NAME, NPX_COMMAND, readPackument } from "./npm-package";

/**
 * The npx path is only offered once it exists.
 *
 * A download page that prints a command which fails for the reader is worse
 * than one that prints nothing: it costs them a terminal, a confusing error,
 * and some of their trust.
 */

describe("readPackument", () => {
  it("reads the published version from the registry's own dist-tags", () => {
    const read = readPackument({
      "dist-tags": { latest: "0.4.5" },
      modified: "2026-09-11T12:00:00.000Z",
    });
    expect(read).toEqual({ published: true, version: "0.4.5", modifiedAt: "2026-09-11T12:00:00.000Z" });
  });

  it("treats a package that does not exist yet as unpublished", () => {
    // What the registry answers today: 404, parsed as "nothing to offer".
    expect(readPackument({ error: "Not found" }).published).toBe(false);
    expect(readPackument(null).published).toBe(false);
    expect(readPackument("").published).toBe(false);
  });

  it("treats an entry with no latest tag as unpublished", () => {
    // An unpublished or fully deprecated package can still have a document.
    expect(readPackument({ "dist-tags": {} }).published).toBe(false);
    expect(readPackument({ "dist-tags": { latest: "" } }).published).toBe(false);
  });

  it("copes with a registry entry that states no modification time", () => {
    expect(readPackument({ "dist-tags": { latest: "1.0.0" } })).toEqual({
      published: true,
      version: "1.0.0",
      modifiedAt: null,
    });
  });

  it("prints the command a reader can paste", () => {
    expect(NPX_COMMAND).toBe(`npx ${NPM_PACKAGE_NAME}`);
    expect(NPM_PACKAGE_NAME).toBe("usage-miner");
  });
});
