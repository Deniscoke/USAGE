import { describe, expect, it } from "vitest";
import {
  isUsable,
  listImportProviders,
  listMiningProviders,
  listProviders,
  findProvider,
  providerForModel,
  supportsMethod,
  usableRoutes,
} from "./catalog";
import { getComputeGateway, unresolvedGatewayReferences } from "@/lib/compute/registry";

/**
 * The registry is the product's source of truth about what USAGE can do, so
 * these tests are mostly about one property: it must not overstate itself.
 */

describe("provider registry", () => {
  it("names every provider exactly once", () => {
    const slugs = listProviders().map((provider) => provider.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("covers the providers the platform is built for", () => {
    for (const slug of ["anthropic", "openai", "google", "mistral", "openrouter", "vercel"]) {
      expect(findProvider(slug), slug).not.toBeNull();
    }
    expect(findProvider("not-a-provider")).toBeNull();
  });

  it("separates the provider from the gateway that carries it", () => {
    // The correction this milestone exists for: Anthropic is reachable through
    // two gateways, and neither is a direct Anthropic integration.
    const anthropic = findProvider("anthropic")!;
    const gateways = anthropic.routes.map((route) => route.gateway);
    expect(gateways).toContain("vercel-ai-gateway");
    expect(gateways).toContain("openrouter");
    expect(gateways).not.toContain("anthropic");
  });

  it("lists each gateway at most once per provider", () => {
    for (const provider of listProviders()) {
      const gateways = provider.routes.map((route) => route.gateway);
      expect(new Set(gateways).size, provider.slug).toBe(gateways.length);
    }
  });

  it("never claims a route without an implementation behind it", () => {
    // The honesty rule, enforced: every route must name a gateway that exists.
    expect(unresolvedGatewayReferences()).toEqual([]);

    for (const provider of listProviders()) {
      for (const route of provider.routes) {
        expect(getComputeGateway(route.gateway), `${provider.slug}/${route.gateway}`).not.toBeNull();
      }
    }
  });

  it("claims `live` only where something has actually run in production", () => {
    // Anthropic through Vercel is the one route with a real production proof.
    const live = listProviders().flatMap((provider) =>
      provider.routes
        .filter((route) => route.status === "live")
        .map((route) => `${provider.slug}/${route.gateway}`),
    );
    expect(live.sort()).toEqual(["anthropic/vercel-ai-gateway", "vercel/vercel-ai-gateway"]);
  });

  it("explains every capability it does not have yet", () => {
    // A bare "coming soon" tells a user nothing. Each one carries a reason.
    for (const provider of listProviders()) {
      if (provider.import.status === "coming_soon") {
        expect(provider.import.note, `${provider.slug} import`).toBeTruthy();
      }
      for (const method of ["byok", "subscription"] as const) {
        if (provider[method].availability === "coming_soon") {
          expect(provider[method].note, `${provider.slug}.${method}`).toBeTruthy();
        }
      }
    }
  });

  it("says what an import actually is, so nobody mistakes it for a receipt", () => {
    const openai = findProvider("openai")!;
    expect(isUsable(openai.import.status)).toBe(true);
    expect(openai.import.granularity).toBe("provider_aggregate");
    expect(openai.import.source).toContain("/v1/organization/usage/completions");
    // Consumer accounts genuinely cannot do this, and the registry says so.
    expect(openai.import.accountRequirement.toLowerCase()).toContain("admin");
    expect(openai.import.accountRequirement.toLowerCase()).toContain("consumer");
  });

  it("keeps Anthropic and Mistral imports honest about their requirements", () => {
    for (const slug of ["anthropic", "mistral"]) {
      const provider = findProvider(slug)!;
      expect(isUsable(provider.import.status), slug).toBe(false);
      expect(provider.import.note, slug).toBeTruthy();
    }
    // Overstating Mistral would be easy: an admin API exists, but the account
    // requirements are unverified, so it is not offered.
    expect(findProvider("mistral")!.import.note!.toLowerCase()).toContain("not verified");
  });

  it("only offers tools whose capability the provider actually declares", () => {
    for (const provider of listProviders()) {
      for (const tool of provider.tools) {
        if (tool.availability !== "available") continue;
        if (tool.method === "routed_mining") {
          expect(usableRoutes(provider).length, `${provider.slug}/${tool.slug}`).toBeGreaterThan(0);
        }
        if (tool.method === "verified_import") {
          expect(isUsable(provider.import.status), `${provider.slug}/${tool.slug}`).toBe(true);
        }
      }
    }
  });

  it("derives its lists rather than keeping second copies", () => {
    const mining = listMiningProviders();
    for (const provider of listProviders()) {
      expect(mining.includes(provider)).toBe(supportsMethod(provider, "routed_mining"));
    }

    const imports = listImportProviders();
    expect(imports.map((provider) => provider.slug)).toEqual(["openai"]);
  });

  it("attributes a gateway model slug to its provider", () => {
    expect(providerForModel("anthropic/claude-haiku-4.5")?.slug).toBe("anthropic");
    expect(providerForModel("openai/gpt-5.4")?.slug).toBe("openai");
    // An unknown family is not silently attributed to anyone.
    expect(providerForModel("acme/whatever")).toBeNull();
  });

  it("only marks cost authoritative where the surface really reports one", () => {
    const vercelRoute = findProvider("anthropic")!.routes.find(
      (route) => route.gateway === "vercel-ai-gateway",
    )!;
    // The Anthropic-compatible surface returns no cost, and we do not invent one.
    expect(vercelRoute.costAvailability).toBe("unavailable");

    const openRouterRoute = findProvider("anthropic")!.routes.find(
      (route) => route.gateway === "openrouter",
    )!;
    expect(openRouterRoute.costAvailability).toBe("authoritative");
  });
});
