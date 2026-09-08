import { describe, expect, it } from "vitest";
import {
  listMiningProviders,
  listProviders,
  findProvider,
  providerForModel,
  supportsMethod,
  type ConnectionMethod,
} from "./catalog";
import { getComputeGateway, unresolvedGatewayReferences } from "@/lib/compute/registry";

/**
 * The registry is the product's source of truth about what USAGE can do, so
 * these tests are mostly about one property: it must not overstate itself.
 */

const METHODS: ConnectionMethod[] = ["routed_mining", "verified_import", "byok", "subscription"];

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

  it("declares every connection method for every provider", () => {
    for (const provider of listProviders()) {
      for (const method of METHODS) {
        expect(provider.methods[method], `${provider.slug}.${method}`).toBeDefined();
      }
    }
  });

  it("never claims an available capability without an implementation behind it", () => {
    // The honesty rule, enforced: "available via X" requires X to exist.
    expect(unresolvedGatewayReferences()).toEqual([]);

    for (const provider of listProviders()) {
      const routed = provider.methods.routed_mining;
      if (routed.availability !== "available") continue;
      expect(routed.via, `${provider.slug} claims mining with no gateway`).toBeTruthy();
      expect(getComputeGateway(routed.via!), provider.slug).not.toBeNull();
    }
  });

  it("explains every capability it does not have yet", () => {
    // A bare "coming soon" tells a user nothing. Each one carries a reason.
    for (const provider of listProviders()) {
      for (const method of METHODS) {
        const definition = provider.methods[method];
        if (definition.availability === "coming_soon") {
          expect(definition.note, `${provider.slug}.${method}`).toBeTruthy();
        }
      }
    }
  });

  it("only offers tools whose method the provider actually declares", () => {
    for (const provider of listProviders()) {
      for (const tool of provider.tools) {
        const declared = provider.methods[tool.method];
        expect(declared, `${provider.slug}/${tool.slug}`).toBeDefined();
        if (tool.availability === "available") {
          // A tool cannot be more available than the method that carries it.
          expect(declared.availability, `${provider.slug}/${tool.slug}`).toBe("available");
        }
      }
    }
  });

  it("derives the mining list rather than keeping a second one", () => {
    const mining = listMiningProviders();
    expect(mining.length).toBeGreaterThan(0);
    for (const provider of listProviders()) {
      expect(mining.includes(provider)).toBe(supportsMethod(provider, "routed_mining"));
    }
  });

  it("attributes a gateway model slug to its provider", () => {
    expect(providerForModel("anthropic/claude-haiku-4.5")?.slug).toBe("anthropic");
    expect(providerForModel("openai/gpt-5.4")?.slug).toBe("openai");
    // An unknown family is not silently attributed to anyone.
    expect(providerForModel("acme/whatever")).toBeNull();
  });

  it("keeps a planned provider planned everywhere", () => {
    const openrouter = findProvider("openrouter")!;
    expect(openrouter.status).toBe("planned");
    for (const method of METHODS) {
      expect(openrouter.methods[method].availability).not.toBe("available");
    }
  });
});
