import { afterEach, describe, expect, it, vi } from "vitest";
import { isRecoverableBuildError, reactErrorNumber, scrubMessage, shouldReloadOnce, toRecord } from "./diagnostics";

/**
 * M16B.1 — client diagnostics never leak, and stale-build recovery reloads
 * exactly once.
 */

describe("client diagnostics", () => {
  it("scrubs bearer tokens, JWTs, sk- keys and apikey params out of messages", () => {
    const m = scrubMessage("failed: Bearer abc.def.ghi and sk-or-v1-abcdefghij and eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U and ?apikey=secret");
    expect(m).not.toMatch(/abc\.def|sk-or-v1|eyJ|secret/);
    expect(m).toMatch(/\[redacted\]/);
  });

  it("extracts the minified React error number and the Next digest", () => {
    expect(reactErrorNumber("Minified React error #412; visit https://react.dev/errors/412")).toBe(412);
    expect(reactErrorNumber("plain")).toBeNull();
    const record = toRecord("test", Object.assign(new Error("boom"), { digest: "abc123" }), { pathname: "/dashboard", navigation: "push /dashboard" });
    expect(record).toMatchObject({ source: "test", name: "Error", message: "boom", digest: "abc123", pathname: "/dashboard", navigation: "push /dashboard", reactError: null });
  });

  it("recognises stale-build failures and nothing else", () => {
    expect(isRecoverableBuildError("Minified React error #412; Connection closed.")).toBe(true);
    expect(isRecoverableBuildError("ChunkLoadError: Loading chunk 123 failed")).toBe(true);
    expect(isRecoverableBuildError("@supabase/ssr: Your project's URL and API key are required")).toBe(false);
    expect(isRecoverableBuildError("TypeError: x is undefined")).toBe(false);
  });

  it("allows exactly one reload per five-minute window, and never loops", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(shouldReloadOnce(1_000_000, storage)).toBe(true);
    expect(shouldReloadOnce(1_000_500, storage)).toBe(false);
    expect(shouldReloadOnce(1_000_000 + 4 * 60 * 1000, storage)).toBe(false);
    expect(shouldReloadOnce(1_000_000 + 6 * 60 * 1000, storage)).toBe(true);
    const broken = { getItem: () => { throw new Error("no storage"); }, setItem: () => { throw new Error("no storage"); } };
    expect(shouldReloadOnce(0, broken)).toBe(false);
  });
});

describe("browser Supabase client never throws on an incomplete environment (the M16B.1 crash)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.resetModules();
  });

  it("returns null when neither public key name is set, and a client when the publishable key is", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    vi.resetModules();
    const missing = await import("@/lib/supabase/client");
    expect(missing.createBrowserSupabase()).toBeNull();
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
    vi.resetModules();
    const present = await import("@/lib/supabase/client");
    expect(present.createBrowserSupabase()).not.toBeNull();
  });
});
