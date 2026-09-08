import { describe, expect, it } from "vitest";
import {
  fetchOpenAiOrgUsage,
  importIdentity,
  normalizeOpenAiOrgUsage,
  OPENAI_ORG_ADAPTER_VERSION,
  type OpenAiOrgPayload,
} from "./adapter";
import { OpenAiAdminError, type FetchLike } from "./client";
import { issueImportProof } from "@/lib/imports/issue";
import { generateSigningKeyPair } from "@/lib/domain/signing";
import { verifyUsageReceipt } from "@/lib/domain/receipt";

/**
 * The first verified import.
 *
 * Fixtures are the real response shapes from the OpenAI organization usage and
 * costs endpoints. No live call is made here and none is needed: what has to be
 * right is the parsing, the identity, and the refusal to overstate what an
 * aggregate import is.
 */

const ORG = "org-Test000000000000000000";
const BUCKET_START = 1_757_289_600; // 2025-09-08T00:00:00Z
const BUCKET_END = BUCKET_START + 86_400;

function usagePage() {
  return {
    data: [
      {
        object: "bucket" as const,
        start_time: BUCKET_START,
        end_time: BUCKET_END,
        results: [
          {
            object: "organization.usage.completions.result" as const,
            input_tokens: 141_201,
            output_tokens: 9_756,
            input_cached_tokens: 41_201,
            num_model_requests: 470,
            project_id: "proj_abc",
            user_id: null,
            api_key_id: "key_xyz",
            model: "gpt-5.4",
            batch: false,
          },
          {
            object: "organization.usage.completions.result" as const,
            input_tokens: 0,
            output_tokens: 0,
            num_model_requests: 0,
            model: "gpt-5-nano",
          },
        ],
      },
    ],
    next_page: null,
  };
}

function costsPage() {
  return {
    data: [
      {
        object: "bucket" as const,
        start_time: BUCKET_START,
        end_time: BUCKET_END,
        results: [
          {
            object: "organization.costs.result" as const,
            amount: { value: 0.13080438340307526, currency: "usd" },
            line_item: null,
            project_id: null,
            organization_id: ORG,
          },
        ],
      },
    ],
    next_page: null,
  };
}

function fakeFetch(
  usage: unknown = usagePage(),
  costs: unknown = costsPage(),
  seen: string[] = [],
): FetchLike {
  return async (url: string) => {
    seen.push(url);
    const body = url.includes("/organization/costs") ? costs : usage;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const WINDOW = {
  since: new Date(BUCKET_START * 1000),
  until: new Date(BUCKET_END * 1000),
};

async function fetchPayload(fetchImpl: FetchLike): Promise<OpenAiOrgPayload> {
  return fetchOpenAiOrgUsage(
    { organizationId: ORG, adminKey: "sk-admin-secret", fetchImpl },
    WINDOW,
  );
}

describe("OpenAI organization client", () => {
  it("asks for the documented window, bucket width and grouping", async () => {
    const seen: string[] = [];
    await fetchPayload(fakeFetch(usagePage(), costsPage(), seen));

    const usageUrl = seen.find((url) => url.includes("/organization/usage/completions"))!;
    expect(usageUrl).toContain(`start_time=${BUCKET_START}`);
    expect(usageUrl).toContain(`end_time=${BUCKET_END}`);
    expect(usageUrl).toContain("bucket_width=1d");
    expect(usageUrl).toContain("group_by=model");
    expect(usageUrl).toContain("group_by=project_id");
    expect(seen.some((url) => url.includes("/organization/costs"))).toBe(true);
  });

  it("never puts the admin key in the URL", async () => {
    const seen: string[] = [];
    await fetchPayload(fakeFetch(usagePage(), costsPage(), seen));
    for (const url of seen) expect(url).not.toContain("sk-admin-secret");
  });

  it("distinguishes a wrong key from a key without admin scope", async () => {
    const status = async (code: number): Promise<OpenAiAdminError> => {
      const failing: FetchLike = async () => new Response("{}", { status: code });
      try {
        await fetchPayload(failing);
        throw new Error(`HTTP ${code} did not raise`);
      } catch (error) {
        return error as OpenAiAdminError;
      }
    };

    expect((await status(401)).code).toBe("unauthorized");
    // A valid key without organization admin rights is a different problem for
    // the user to fix, and saying "unauthorized" would send them the wrong way.
    expect((await status(403)).code).toBe("forbidden");
    expect((await status(429)).code).toBe("rate_limited");
  });

  it("refuses a response that is not the documented shape", async () => {
    const wrong: FetchLike = async () => new Response(JSON.stringify({ oops: true }), { status: 200 });
    await expect(fetchPayload(wrong)).rejects.toMatchObject({ code: "malformed" });
  });

  it("never leaks the admin key into an error message", async () => {
    const failing: FetchLike = async () => new Response("{}", { status: 500 });
    await expect(fetchPayload(failing)).rejects.toThrow(
      expect.not.stringContaining("sk-admin-secret") as unknown as string,
    );
  });
});

describe("OpenAI organization normalization", () => {
  it("turns a usage bucket into a verified record", async () => {
    const records = normalizeOpenAiOrgUsage(await fetchPayload(fakeFetch()));

    expect(records).toHaveLength(1);
    const [record] = records;

    expect(record.verificationType).toBe("verified");
    expect(record.verificationStatus).toBe("confirmed");
    expect(record.model).toBe("openai/gpt-5.4");
    expect(record.requests).toBe(470);
    // input_tokens is inclusive of cached, so the fresh remainder is stored.
    expect(record.inputTokens).toBe(100_000);
    expect(record.cachedInputTokens).toBe(41_201);
    expect(record.outputTokens).toBe(9_756);
    expect(record.occurredAt).toBe(new Date(BUCKET_START * 1000).toISOString());
    // Nobody executed this on the user's behalf.
    expect(record.gatewayId).toBeNull();
  });

  it("says out loud that it is an aggregate, not a receipt", async () => {
    const [record] = normalizeOpenAiOrgUsage(await fetchPayload(fakeFetch()));
    expect(record.rawMetadata.granularity).toBe("provider_aggregate");
    expect(record.rawMetadata.bucket_width).toBe("1d");
    expect(record.rawMetadata.bucket_start).toBe(BUCKET_START);
    expect(record.source).toBe("org_analytics_api");
  });

  it("keeps provider dimensions opaque and carries no human identity", async () => {
    const [record] = normalizeOpenAiOrgUsage(await fetchPayload(fakeFetch()));
    expect(record.rawMetadata.project_id).toBe("proj_abc");
    expect(record.rawMetadata.api_key_id).toBe("key_xyz");

    const serialized = JSON.stringify(record).toLowerCase();
    // No email address, no display name, no conversation content anywhere.
    expect(serialized).not.toMatch(/[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/);
    for (const forbidden of ["email", "display_name", "prompt", "message", "content"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("drops a bucket row with no tokens instead of storing an empty proof", async () => {
    const records = normalizeOpenAiOrgUsage(await fetchPayload(fakeFetch()));
    expect(records.some((record) => record.model === "openai/gpt-5-nano")).toBe(false);
  });

  it("attributes the bucket cost by token share and says it is estimated", async () => {
    const [record] = normalizeOpenAiOrgUsage(await fetchPayload(fakeFetch()));
    // The costs endpoint does not break spend down by model, so a share is the
    // honest answer -- and its basis says so rather than claiming authority.
    expect(record.actualCostBasis).toBe("estimated");
    expect(record.actualCostMicros).toBe(130_804);
  });

  it("leaves cost unknown when the costs endpoint says nothing", async () => {
    const noCosts = await fetchPayload(fakeFetch(usagePage(), { data: [], next_page: null }));
    const [record] = normalizeOpenAiOrgUsage(noCosts);
    expect(record.actualCostMicros).toBeNull();
    expect(record.actualCostBasis).toBe("unavailable");
  });

  it("prices the compute from the protocol snapshot, not from the bill", async () => {
    const [record] = normalizeOpenAiOrgUsage(await fetchPayload(fakeFetch()));
    // Same pricing path as any routed proof. Mining never uses the invoice.
    expect(record.protocolPricingVersion).toBeTruthy();
    expect(record.protocolComputeMicros).toBeGreaterThan(0);
    expect(record.protocolComputeMicros).not.toBe(record.actualCostMicros);
  });
});

describe("import identity", () => {
  const base = {
    organizationId: ORG,
    bucketStart: BUCKET_START,
    bucketWidth: "1d",
    model: "gpt-5.4",
    projectId: "proj_abc",
    userId: null,
    apiKeyId: "key_xyz",
  };

  it("is deterministic, so re-importing a window changes nothing", () => {
    expect(importIdentity(base)).toBe(importIdentity({ ...base }));
    expect(importIdentity(base)).toMatch(/^openai_org:[0-9a-f]{32}$/);
  });

  it("changes when any authoritative dimension changes", () => {
    const identity = importIdentity(base);
    expect(importIdentity({ ...base, bucketStart: BUCKET_START + 86_400 })).not.toBe(identity);
    expect(importIdentity({ ...base, model: "gpt-5-nano" })).not.toBe(identity);
    expect(importIdentity({ ...base, projectId: "proj_other" })).not.toBe(identity);
    expect(importIdentity({ ...base, apiKeyId: "key_other" })).not.toBe(identity);
    expect(importIdentity({ ...base, bucketWidth: "1h" })).not.toBe(identity);
  });

  it("distinguishes an absent dimension from an empty one", () => {
    // "not grouped by project" is not the same fact as "project id is empty".
    expect(importIdentity({ ...base, projectId: null })).not.toBe(
      importIdentity({ ...base, projectId: "" }),
    );
  });

  it("is versioned, so a change in normalization cannot silently collide", () => {
    expect(OPENAI_ORG_ADAPTER_VERSION).toBe("openai-org@1");
  });

  it("does not depend on when the import ran", async () => {
    const first = normalizeOpenAiOrgUsage(await fetchPayload(fakeFetch()));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = normalizeOpenAiOrgUsage(await fetchPayload(fakeFetch()));
    expect(first[0].externalReference).toBe(second[0].externalReference);
  });
});

describe("import trust boundary", () => {
  const KEY = generateSigningKeyPair("import-key");
  const ISSUER = "usage://issuer/production";

  it("is CONFIRMED only when trusted infrastructure signs it", async () => {
    const [record] = normalizeOpenAiOrgUsage(await fetchPayload(fakeFetch()));

    const unsigned = issueImportProof(record, { userId: "u1", issuance: null });
    expect(unsigned.proof.proofStatus).toBe("observed");
    expect(unsigned.proof.signature).toBeNull();
    // An unsigned import is real usage but not trusted evidence, so it must not
    // carry economic weight either.
    expect(unsigned.record.economicStatus).toBe("ineligible");

    const signed = issueImportProof(record, {
      userId: "u1",
      issuance: { issuer: ISSUER, keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 },
    });
    expect(signed.proof.proofStatus).toBe("confirmed");
    expect(signed.record.economicStatus).toBe("eligible");
  });

  it("signs a receipt anyone can verify with the public key", async () => {
    const [record] = normalizeOpenAiOrgUsage(await fetchPayload(fakeFetch()));
    const issued = issueImportProof(record, {
      userId: "u1",
      issuance: { issuer: ISSUER, keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 },
    });

    const result = verifyUsageReceipt(
      {
        receipt: issued.receipt,
        canonicalHash: issued.proof.proofHash!,
        signature: issued.proof.signature!,
        signedAt: issued.proof.signedAt!,
      },
      { publicKeys: { [KEY.keyId]: KEY.publicKeyBase64 }, expectedIssuer: ISSUER },
    );
    expect(result.valid).toBe(true);
  });

  it("records provenance that does not pretend to be a routed receipt", async () => {
    const [record] = normalizeOpenAiOrgUsage(await fetchPayload(fakeFetch()));
    const issued = issueImportProof(record, {
      userId: "u1",
      issuance: { issuer: ISSUER, keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 },
    });

    expect(issued.proof.proofKind).toBe("provider_usage_import");
    expect(issued.receipt.gatewayId).toBeNull();
    expect(issued.receipt.generationIdSource).toBe("import_identity");
    expect(issued.receipt.clientType).toBe("import");
  });
});
