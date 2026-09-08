/**
 * OpenAI Organization Usage and Costs APIs.
 *
 * Two endpoints, both admin-only:
 *
 *   GET /v1/organization/usage/completions   token counts, in time buckets
 *   GET /v1/organization/costs               money, in daily buckets
 *
 * Authenticated with an ORGANIZATION ADMIN key, which is not an ordinary API
 * key and is not something a consumer ChatGPT account has. The key is read from
 * server environment configuration and never leaves this module: it is not
 * logged, not stored, and not returned in any response.
 *
 * Only aggregate usage metadata is fetched. There is no prompt or completion
 * content on these endpoints, and none is requested.
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function openAiBaseUrl(): string {
  return (process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function openAiAdminKey(): string | null {
  return process.env.OPENAI_ADMIN_KEY?.trim() || null;
}

/** One aggregated usage row inside a time bucket. */
export interface OpenAiCompletionsResult {
  object: "organization.usage.completions.result";
  input_tokens?: number;
  output_tokens?: number;
  input_cached_tokens?: number;
  input_audio_tokens?: number;
  output_audio_tokens?: number;
  num_model_requests?: number;
  /** Opaque provider ids. Never a name or an email. */
  project_id?: string | null;
  user_id?: string | null;
  api_key_id?: string | null;
  model?: string | null;
  batch?: boolean | null;
}

export interface OpenAiCostsResult {
  object: "organization.costs.result";
  amount?: { value?: number; currency?: string } | null;
  line_item?: string | null;
  project_id?: string | null;
  organization_id?: string | null;
}

export interface OpenAiBucket<T> {
  object: "bucket";
  /** Unix seconds, inclusive. */
  start_time: number;
  /** Unix seconds, exclusive. */
  end_time: number;
  results: T[];
}

export interface OpenAiUsagePage<T> {
  data: OpenAiBucket<T>[];
  next_page?: string | null;
  has_more?: boolean;
}

export class OpenAiAdminError extends Error {
  constructor(
    readonly code: "unauthorized" | "forbidden" | "rate_limited" | "unavailable" | "malformed",
    message: string,
  ) {
    super(message);
    this.name = "OpenAiAdminError";
  }
}

function classify(status: number): OpenAiAdminError["code"] {
  if (status === 401) return "unauthorized";
  // 403 usually means a valid key without organization admin scope, which is a
  // different problem for the user to fix than a wrong key.
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  return "unavailable";
}

export interface UsageQuery {
  /** Unix seconds, inclusive. */
  startTime: number;
  /** Unix seconds, exclusive. */
  endTime?: number;
  bucketWidth?: "1m" | "1h" | "1d";
  groupBy?: readonly string[];
  limit?: number;
}

/** Injectable fetch, so tests exercise the real parsing against fixtures. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function getPage<T>(
  path: string,
  query: UsageQuery,
  page: string | null,
  adminKey: string,
  doFetch: FetchLike,
): Promise<OpenAiUsagePage<T>> {
  const params = new URLSearchParams();
  params.set("start_time", String(query.startTime));
  if (query.endTime !== undefined) params.set("end_time", String(query.endTime));
  params.set("bucket_width", query.bucketWidth ?? "1d");
  for (const field of query.groupBy ?? []) params.append("group_by", field);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (page) params.set("page", page);

  const response = await doFetch(`${openAiBaseUrl()}${path}?${params.toString()}`, {
    headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    // The upstream body may echo request configuration, so the message is ours.
    throw new OpenAiAdminError(
      classify(response.status),
      `OpenAI organization API returned HTTP ${response.status}.`,
    );
  }

  const payload = (await response.json()) as unknown;
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as OpenAiUsagePage<T>).data)) {
    throw new OpenAiAdminError("malformed", "OpenAI organization API returned an unexpected shape.");
  }
  return payload as OpenAiUsagePage<T>;
}

/** Page through an endpoint, bounded so a bad cursor cannot loop forever. */
async function getAllPages<T>(
  path: string,
  query: UsageQuery,
  adminKey: string,
  doFetch: FetchLike,
  maxPages = 50,
): Promise<OpenAiBucket<T>[]> {
  const buckets: OpenAiBucket<T>[] = [];
  let page: string | null = null;

  for (let index = 0; index < maxPages; index += 1) {
    const result: OpenAiUsagePage<T> = await getPage<T>(path, query, page, adminKey, doFetch);
    buckets.push(...result.data);
    page = result.next_page ?? null;
    if (!page) break;
  }
  return buckets;
}

export function fetchCompletionsUsage(
  query: UsageQuery,
  adminKey: string,
  doFetch: FetchLike = fetch,
): Promise<OpenAiBucket<OpenAiCompletionsResult>[]> {
  return getAllPages<OpenAiCompletionsResult>(
    "/organization/usage/completions",
    query,
    adminKey,
    doFetch,
  );
}

export function fetchCosts(
  query: UsageQuery,
  adminKey: string,
  doFetch: FetchLike = fetch,
): Promise<OpenAiBucket<OpenAiCostsResult>[]> {
  // The costs endpoint only supports daily buckets.
  return getAllPages<OpenAiCostsResult>(
    "/organization/costs",
    { ...query, bucketWidth: "1d" },
    adminKey,
    doFetch,
  );
}
