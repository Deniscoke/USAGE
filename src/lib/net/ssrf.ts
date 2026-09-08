import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Outbound request guard.
 *
 * Accepting user-supplied base URLs turns USAGE's server into a request proxy,
 * and a request proxy inside a cloud network is an SSRF primitive: it can reach
 * the instance metadata endpoint, internal service meshes, databases on private
 * addresses, and anything else the deployment can see but the internet cannot.
 *
 * THE RULE: a destination is allowed only if every IP address its hostname
 * resolves to is a public unicast address, over https, on a normal port. Not
 * "does not look private" -- resolved and checked, because a hostname the
 * attacker controls can point anywhere, and a regex cannot see DNS.
 *
 * DNS REBINDING is the subtle one. Validating a hostname and then handing it to
 * an HTTP client that resolves it AGAIN is not protection: an attacker's
 * resolver can answer publicly on the first lookup and 127.0.0.1 on the second,
 * and the connection goes wherever the second answer points. A preflight lookup
 * alone would be security theatre.
 *
 * So the connection is PINNED. `assertSafeUrl` returns the addresses it
 * validated, and `safeFetch` connects through a dispatcher whose DNS lookup can
 * only ever return those addresses. The TLS handshake and Host header still use
 * the hostname, so certificate validation is unaffected -- only the destination
 * IP is fixed, to the one that was actually checked.
 *
 * Redirects are re-checked, because a public URL that 302s to
 * http://169.254.169.254/ is exactly as dangerous as pointing there directly.
 */

export type SsrfRejection =
  | "invalid_url"
  | "protocol_not_allowed"
  | "port_not_allowed"
  | "credentials_in_url"
  | "hostname_not_allowed"
  | "dns_failed"
  | "private_address"
  | "too_many_redirects";

export class SsrfError extends Error {
  constructor(
    readonly code: SsrfRejection,
    message: string,
  ) {
    super(message);
    this.name = "SsrfError";
  }
}

/** Ports a legitimate provider API is served on. */
const ALLOWED_PORTS = new Set([443, 80]);

/**
 * Hostnames that never reach a real provider, blocked before DNS.
 *
 * Belt and braces: the address checks below would catch these anyway, but a
 * resolver that answers `localhost` with a public address should not get a
 * chance to be clever.
 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  // Cloud instance metadata, by name.
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

/** Suffixes that only ever name something inside a private network. */
const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".home.arpa", ".cluster.local"];

function ipv4ToParts(address: string): number[] | null {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts;
}

/**
 * Is this address one the public internet can route to?
 *
 * Written as an allowlist of "not special" rather than a blocklist of known-bad
 * ranges: a new special-use range should fail closed, not slip through.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const parts = ipv4ToParts(address);
  if (!parts) return false;
  const [a, b] = parts;

  if (a === 0) return false; // "this network"
  if (a === 10) return false; // RFC1918
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 192 && b === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 88) return false; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51) return false; // TEST-NET-2
  if (a === 203 && b === 0) return false; // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return false; // unspecified, loopback

  // IPv4-mapped and IPv4-compatible addresses inherit the IPv4 verdict --
  // ::ffff:127.0.0.1 is loopback however it is spelled.
  const mapped = /^::(?:ffff:(?:0{1,4}:)?)?(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPublicIpv4(mapped[1]);

  if (normalized.startsWith("fe8") || normalized.startsWith("fe9")) return false; // link-local
  if (normalized.startsWith("fea") || normalized.startsWith("feb")) return false;
  if (/^f[cd]/.test(normalized)) return false; // unique local
  if (normalized.startsWith("ff")) return false; // multicast
  if (normalized.startsWith("64:ff9b")) return false; // NAT64
  if (normalized.startsWith("2001:db8")) return false; // documentation
  return true;
}

export interface SafeUrlOptions {
  /**
   * Allow http and private addresses. ONLY for local development against a
   * fake provider; never true in production.
   */
  allowInsecure?: boolean;
  /** Injectable resolver, so tests do not depend on real DNS. */
  resolve?: (hostname: string) => Promise<string[]>;
}

export interface SafeUrl {
  url: URL;
  /** Every address the hostname resolved to, all validated public. */
  addresses: string[];
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

export function allowInsecureDestinations(): boolean {
  // Off unless explicitly enabled AND not in production, so a stray env var in
  // a production deployment cannot open the guard.
  return (
    process.env.NODE_ENV !== "production" && process.env.USAGE_ALLOW_INSECURE_PROVIDERS === "true"
  );
}

/**
 * Validate a destination before anything is sent to it.
 *
 * Throws SsrfError with a specific code so the UI can explain the problem
 * without echoing an internal address back to the user.
 */
export async function assertSafeUrl(
  candidate: string,
  options: SafeUrlOptions = {},
): Promise<SafeUrl> {
  const allowInsecure = options.allowInsecure ?? allowInsecureDestinations();

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new SsrfError("invalid_url", "That is not a valid URL.");
  }

  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) {
    throw new SsrfError("protocol_not_allowed", "Provider URLs must use https.");
  }

  // Credentials in the URL would be a second, unmanaged place secrets live.
  if (url.username || url.password) {
    throw new SsrfError("credentials_in_url", "Put credentials in the API key field, not the URL.");
  }

  // Standard ports only: an arbitrary port is how an SSRF reaches Redis,
  // Postgres or an internal admin service. The dev exception exists so a fake
  // provider on a random loopback port can be used locally.
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!allowInsecure && !ALLOWED_PORTS.has(port)) {
    throw new SsrfError("port_not_allowed", "Only the standard http(s) ports are allowed.");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!allowInsecure) {
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      throw new SsrfError("hostname_not_allowed", "That hostname is not reachable from USAGE.");
    }
    if (BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
      throw new SsrfError("hostname_not_allowed", "That hostname is not reachable from USAGE.");
    }
  }

  // A literal IP still has to be public; a hostname is resolved and every
  // answer checked, because one private answer is enough to be dangerous.
  const literal = isIP(hostname) ? [hostname] : null;
  let addresses: string[];
  if (literal) {
    addresses = literal;
  } else {
    try {
      addresses = await (options.resolve ?? defaultResolve)(hostname);
    } catch {
      throw new SsrfError("dns_failed", "That hostname could not be resolved.");
    }
    if (addresses.length === 0) {
      throw new SsrfError("dns_failed", "That hostname could not be resolved.");
    }
  }

  if (!allowInsecure) {
    for (const address of addresses) {
      if (!isPublicAddress(address)) {
        // Deliberately vague: echoing the resolved address back would confirm
        // internal topology to whoever was probing for it.
        throw new SsrfError(
          "private_address",
          "That hostname resolves to an address USAGE will not connect to.",
        );
      }
    }
  }

  return { url, addresses };
}

const MAX_REDIRECTS = 3;

export interface SafeFetchOptions extends SafeUrlOptions {
  /** Injectable transport, for tests. Production uses the pinned dispatcher. */
  fetchImpl?: typeof fetch;
}

/**
 * A transport that can only connect to `addresses`.
 *
 * The lookup hook is the whole point: undici asks it instead of the system
 * resolver, so there is no second resolution to poison. A fresh agent per
 * request keeps one destination's pin from leaking into another's.
 */
function pinnedFetch(addresses: readonly string[]): typeof fetch {
  const agent = new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        const family = options?.family;
        const candidates = addresses
          .map((address) => ({ address, family: isIP(address) }))
          .filter((entry) => entry.family === 4 || entry.family === 6)
          .filter((entry) => !family || family === 0 || entry.family === family);

        if (candidates.length === 0) {
          callback(new Error("No validated address available"), "", 4);
          return;
        }
        callback(null, candidates);
      },
    },
  });

  return ((input: string | URL | Request, init?: RequestInit) =>
    undiciFetch(input as string, { ...init, dispatcher: agent } as never)) as unknown as typeof fetch;
}

/**
 * Fetch a validated destination, re-validating every redirect.
 *
 * Redirects are followed manually because the platform's automatic following
 * would jump to a private address without asking us. Each hop goes through the
 * same guard as the first.
 */
export async function safeFetch(
  target: string,
  init: RequestInit,
  options: SafeFetchOptions = {},
): Promise<Response> {
  let current = target;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const safe = await assertSafeUrl(current, options);

    // Connect to the address that was validated, not to whatever a second
    // resolution would return. Every hop is pinned to its own answer.
    const transport = options.fetchImpl ?? pinnedFetch(safe.addresses);
    const response = await transport(safe.url.toString(), { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get("location");
    if (!location) return response;

    // Re-enter the loop, so the next hop is validated and pinned from scratch.
    current = new URL(location, safe.url).toString();
    // A redirect chain that keeps going is a chain designed to exhaust checks.
  }

  throw new SsrfError("too_many_redirects", "That endpoint redirected too many times.");
}
