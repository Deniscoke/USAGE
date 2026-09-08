import { describe, expect, it } from "vitest";
import { assertSafeUrl, isPublicAddress, safeFetch, SsrfError } from "./ssrf";

/**
 * The guard that makes user-supplied provider URLs safe to accept.
 *
 * These tests are the reason the feature can exist at all: without them,
 * "connect any AI provider" is "make USAGE fetch any URL for you", which inside
 * a cloud network reaches instance metadata and internal services.
 */

const publicDns = async () => ["93.184.216.34"];
const privateDns = async () => ["10.0.0.5"];

describe("address classification", () => {
  it("accepts ordinary public addresses", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });

  it("rejects every private and special-use IPv4 range", () => {
    for (const address of [
      "127.0.0.1",
      "127.5.5.5",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // AWS/GCP/Azure instance metadata
      "0.0.0.0",
      "100.64.0.1", // carrier-grade NAT
      "192.0.2.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("rejects private IPv6, including IPv4 spelled as IPv6", () => {
    for (const address of [
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "ff02::1",
      "::ffff:127.0.0.1", // loopback wearing a different hat
      "::ffff:169.254.169.254",
      "2001:db8::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("rejects anything that is not an address at all", () => {
    expect(isPublicAddress("example.com")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
    expect(isPublicAddress("999.1.1.1")).toBe(false);
  });
});

describe("URL validation", () => {
  const safe = (url: string, resolve = publicDns) =>
    assertSafeUrl(url, { resolve, allowInsecure: false });

  it("accepts a normal https provider endpoint", async () => {
    const result = await safe("https://api.example.com/v1");
    expect(result.url.hostname).toBe("api.example.com");
    expect(result.addresses).toEqual(["93.184.216.34"]);
  });

  it("refuses plain http in production", async () => {
    await expect(safe("http://api.example.com")).rejects.toMatchObject({
      code: "protocol_not_allowed",
    });
  });

  it("refuses non-http protocols outright", async () => {
    for (const url of ["file:///etc/passwd", "gopher://example.com", "ftp://example.com"]) {
      await expect(safe(url), url).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it("refuses localhost by name, before DNS gets a say", async () => {
    // A resolver answering `localhost` with a public address should not help.
    await expect(safe("https://localhost/v1", publicDns)).rejects.toMatchObject({
      code: "hostname_not_allowed",
    });
  });

  it("refuses internal-only hostname suffixes", async () => {
    for (const host of ["api.internal", "svc.cluster.local", "printer.local"]) {
      await expect(safe(`https://${host}/v1`), host).rejects.toMatchObject({
        code: "hostname_not_allowed",
      });
    }
  });

  it("refuses cloud metadata by name and by address", async () => {
    await expect(safe("https://metadata.google.internal/v1")).rejects.toBeInstanceOf(SsrfError);
    await expect(safe("https://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({
      code: "private_address",
    });
  });

  it("refuses a public hostname that resolves to a private address", async () => {
    // The case a regex cannot catch: the name is fine, the answer is not.
    await expect(safe("https://evil.example.com/v1", privateDns)).rejects.toMatchObject({
      code: "private_address",
    });
  });

  it("refuses when any one answer is private", async () => {
    const mixed = async () => ["93.184.216.34", "127.0.0.1"];
    await expect(safe("https://split.example.com", mixed)).rejects.toMatchObject({
      code: "private_address",
    });
  });

  it("refuses unusual ports", async () => {
    await expect(safe("https://api.example.com:6379/")).rejects.toMatchObject({
      code: "port_not_allowed",
    });
    await expect(safe("https://api.example.com:22/")).rejects.toMatchObject({
      code: "port_not_allowed",
    });
  });

  it("refuses credentials smuggled into the URL", async () => {
    await expect(safe("https://user:secret@api.example.com/v1")).rejects.toMatchObject({
      code: "credentials_in_url",
    });
  });

  it("refuses a hostname that does not resolve", async () => {
    const failing = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(safe("https://nope.example.com", failing)).rejects.toMatchObject({
      code: "dns_failed",
    });
  });

  it("refuses garbage", async () => {
    await expect(safe("not a url")).rejects.toMatchObject({ code: "invalid_url" });
  });

  it("allows http and private addresses only under an explicit dev exception", async () => {
    const result = await assertSafeUrl("http://127.0.0.1:443/v1", {
      resolve: privateDns,
      allowInsecure: true,
    });
    expect(result.url.protocol).toBe("http:");
  });
});

describe("redirect handling", () => {
  function redirectingFetch(location: string) {
    let calls = 0;
    const impl = (async (url: string) => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, { status: 302, headers: { location } });
      }
      return new Response(JSON.stringify({ reached: url }), { status: 200 });
    }) as unknown as typeof fetch;
    return impl;
  }

  it("re-checks every hop, so a public URL cannot redirect inward", async () => {
    await expect(
      safeFetch(
        "https://api.example.com/v1/models",
        {},
        {
          resolve: publicDns,
          allowInsecure: false,
          fetchImpl: redirectingFetch("http://169.254.169.254/latest/meta-data/"),
        },
      ),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("refuses a redirect to a hostname that resolves privately", async () => {
    await expect(
      safeFetch(
        "https://api.example.com/v1/models",
        {},
        {
          resolve: async (hostname) =>
            hostname === "api.example.com" ? ["93.184.216.34"] : ["192.168.0.9"],
          allowInsecure: false,
          fetchImpl: redirectingFetch("https://inner.example.com/"),
        },
      ),
    ).rejects.toMatchObject({ code: "private_address" });
  });

  it("follows a redirect that stays public", async () => {
    const response = await safeFetch(
      "https://api.example.com/v1/models",
      {},
      {
        resolve: publicDns,
        allowInsecure: false,
        fetchImpl: redirectingFetch("https://cdn.example.com/models"),
      },
    );
    expect(response.status).toBe(200);
  });

  it("gives up rather than following a redirect loop", async () => {
    const looping = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://api.example.com/loop" },
      })) as unknown as typeof fetch;

    await expect(
      safeFetch(
        "https://api.example.com/v1",
        {},
        { resolve: publicDns, allowInsecure: false, fetchImpl: looping },
      ),
    ).rejects.toMatchObject({ code: "too_many_redirects" });
  });
});
