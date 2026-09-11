import { describe, expect, it } from "vitest";
import { OTHER_PLATFORM_NOTE, detectPlatform } from "./platform";

/**
 * M16D §14: a Windows visitor sees the download; a non-Windows visitor is told
 * why it will not help them -- and can still take it.
 */

const AGENTS = {
  windows11:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  windowsFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
  macos:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36",
  curl: "curl/8.9.1",
};

describe("detectPlatform", () => {
  it("recognises Windows", () => {
    expect(detectPlatform(AGENTS.windows11)).toBe("windows");
    expect(detectPlatform(AGENTS.windowsFirefox)).toBe("windows");
  });

  it("recognises the platforms the miner does not run on", () => {
    expect(detectPlatform(AGENTS.macos)).toBe("other");
    expect(detectPlatform(AGENTS.linux)).toBe("other");
    expect(detectPlatform(AGENTS.iphone)).toBe("other");
    expect(detectPlatform(AGENTS.android)).toBe("other");
  });

  it("admits to not knowing rather than guessing", () => {
    // Unknown must render as the plain page: a download offered, no warning.
    expect(detectPlatform(AGENTS.curl)).toBe("unknown");
    expect(detectPlatform(null)).toBe("unknown");
    expect(detectPlatform("")).toBe("unknown");
  });

  it("says which platform is available without telling anyone to go away", () => {
    expect(OTHER_PLATFORM_NOTE).toContain("available for Windows");
    expect(OTHER_PLATFORM_NOTE).not.toMatch(/cannot download|not allowed/i);
  });
});
