/**
 * Client diagnostics (M16B.1): safe, minimal, never secrets.
 *
 * What is recorded: timestamp, pathname, error name, a truncated message,
 * the minified React error number when present, the Next digest when
 * present, navigation type, and the build identifier. Never cookies, tokens,
 * headers, session data, prompts, responses or credentials.
 */
export interface ClientErrorRecord {
  at: string;
  pathname: string;
  source: string;
  name: string;
  message: string;
  reactError: number | null;
  digest: string | null;
  navigation: string | null;
  build: string;
}

export const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "unknown";

const SECRET_PATTERNS = [/bearer\s+[a-z0-9._-]+/gi, /sk-[a-z0-9-]{8,}/gi, /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, /apikey=[^&\s]+/gi];

/** Strip anything that could be a token before a message is kept anywhere. */
export function scrubMessage(message: string): string {
  let out = message;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out.slice(0, 300);
}

export function reactErrorNumber(message: string): number | null {
  const m = /Minified React error #(\d+)/.exec(message);
  return m ? Number(m[1]) : null;
}

export function toRecord(source: string, error: unknown, extra: { pathname?: string; navigation?: string | null } = {}): ClientErrorRecord {
  const e = error as { name?: unknown; message?: unknown; digest?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : String(error);
  return {
    at: new Date().toISOString(),
    pathname: extra.pathname ?? (typeof window !== "undefined" ? window.location.pathname : ""),
    source,
    name: typeof e?.name === "string" ? e.name : "Error",
    message: scrubMessage(message),
    reactError: reactErrorNumber(message),
    digest: typeof e?.digest === "string" ? e.digest : null,
    navigation: extra.navigation ?? null,
    build: BUILD_ID,
  };
}

/** Kept in memory for the session and echoed to the console; no network call. */
export const clientErrorLog: ClientErrorRecord[] = [];

export function reportClientError(source: string, error: unknown, extra?: { pathname?: string; navigation?: string | null }): ClientErrorRecord {
  const record = toRecord(source, error, extra);
  clientErrorLog.push(record);
  if (clientErrorLog.length > 50) clientErrorLog.shift();
  try {
    console.warn("[usage:client-error]", JSON.stringify(record));
  } catch {
    // never let diagnostics throw
  }
  return record;
}

/**
 * Stale-build recovery. When a client running an old build meets a new
 * deployment, chunk or RSC fetches can fail in ways React cannot recover
 * from (#412 "Connection closed", ChunkLoadError). Exactly one full reload
 * is allowed per session window; the guard prevents reload loops.
 */
const RELOAD_KEY = "usage:stale-build-reload";
const RELOAD_WINDOW_MS = 5 * 60 * 1000;

export function isRecoverableBuildError(message: string): boolean {
  return /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Minified React error #412|Connection closed|Failed to load static/.test(message);
}

export function shouldReloadOnce(now: number, storage: Pick<Storage, "getItem" | "setItem">): boolean {
  try {
    const last = Number(storage.getItem(RELOAD_KEY) ?? "0");
    if (now - last < RELOAD_WINDOW_MS) return false;
    storage.setItem(RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}
