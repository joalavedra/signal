import { AsyncLocalStorage } from "node:async_hooks";

import { getAdminClient } from "@/lib/supabase/admin";

// ── Pricing constants (USD) ──────────────────────────────────────────────
// Last verified 2026-03-29. Sources:
//   Claude  -- https://docs.anthropic.com/en/docs/about-claude/pricing
//   Exa     -- https://exa.ai/pricing (March 2026: contents bundled into search)
//   Apify   -- https://apify.com/pricing (pay-per-result actors)
//   BB      -- https://browserbase.com/pricing
export const PRICING = {
  // Claude Sonnet 4 (per million tokens)
  claude_sonnet_input: 3.0,
  claude_sonnet_output: 15.0,
  claude_sonnet_cache_read: 0.3,
  claude_sonnet_cache_write: 3.75,
  // Claude Haiku 4.5 (per million tokens)
  claude_haiku_input: 1.0,
  claude_haiku_output: 5.0,
  claude_haiku_cache_read: 0.1,
  claude_haiku_cache_write: 1.25,
  // DeepSeek V4 Flash, non-thinking (per million tokens).
  // Verified 2026-05-25: https://api-docs.deepseek.com/quick_start/pricing.
  // DeepSeek has no separate cache-write surcharge -- cache misses (including
  // the first write) bill at the standard input rate.
  deepseek_input: 0.14,
  deepseek_output: 0.28,
  deepseek_cache_read: 0.0028,
  // Exa -- $7 per 1,000 searches (text + highlights for 10 results included)
  exa_search: 0.007,
  // Apify -- pay-per-result pricing (~20 posts per profile scrape)
  apify_linkedin: 0.05,
  // Apify tweet scraper -- $0.40/1k tweets, ~$0.04 for 100 tweets
  apify_twitter: 0.04,
  // Browserbase Fetch API with proxies -- $4 per 1,000 requests
  browserbase_fetch: 0.004,
  // Browserbase browser session -- billed by time, $0.10/hr
  browserbase_session_per_hr: 0.1,
  // Google Places API (New) -- Text Search with reviews field mask
  google_places_search: 0.032,
  // AgentMail -- usage-based pricing, ~$0.40 per 1,000 emails
  agentmail_email: 0.0004,
  // Apollo -- credit-based; 1 credit ≈ $0.10 on Basic, less on higher tiers.
  apollo_enrichment: 0.1,
  apollo_search: 0.0,
  apollo_sequence_enroll: 0.0,
  // Attio -- no per-call charge on standard plans
  attio_request: 0.0,
} as const;

// ── Action context (AsyncLocalStorage) ───────────────────────────────────
// Route handlers wrap their work in `withAction()`. Every `trackUsage` call
// inside automatically inherits the action_id + label -- no signature changes
// needed on any service.

interface ActionContext {
  action_id: string;
  action_label: string;
}

const actionStore = new AsyncLocalStorage<ActionContext>();

/**
 * Run `fn` inside an action context. All `trackUsage` calls made during `fn`
 * (including from nested service calls) will be tagged with this action.
 *
 * Usage:
 *   return withAction("Enrich person: John Smith", async () => { ... });
 */
export function withAction<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return actionStore.run(
    { action_id: crypto.randomUUID(), action_label: label },
    fn,
  );
}

export type ServiceName =
  | "deepseek"
  | "exa"
  | "apify"
  | "browserbase"
  | "google"
  | "agentmail"
  | "apollo"
  | "attio";

interface UsageEntry {
  service: ServiceName;
  operation: string;
  tokens_input?: number;
  tokens_output?: number;
  estimated_cost_usd: number;
  metadata?: Record<string, unknown>;
  campaign_id?: string;
  user_id?: string;
}

export type ClaudeModel = "sonnet" | "haiku" | "deepseek";

export interface ClaudeCostParams {
  model: ClaudeModel;
  /** Total input tokens (AI SDK's `usage.inputTokens`, already includes cache reads + writes). */
  inputTokens: number;
  outputTokens: number;
  /** Tokens read from the prompt cache, billed at 10% of uncached input. */
  cacheReadTokens?: number;
  /** Tokens written to the prompt cache, billed at 125% of uncached input. */
  cacheCreationTokens?: number;
}

/**
 * Estimate Claude API cost from token counts with cache-aware pricing.
 * `inputTokens` is the total (cache reads + cache writes + uncached); we subtract
 * the cache buckets to get the uncached remainder, then bill each at its own rate.
 */
const MODEL_RATES: Record<
  ClaudeModel,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  sonnet: {
    input: PRICING.claude_sonnet_input,
    output: PRICING.claude_sonnet_output,
    cacheRead: PRICING.claude_sonnet_cache_read,
    cacheWrite: PRICING.claude_sonnet_cache_write,
  },
  haiku: {
    input: PRICING.claude_haiku_input,
    output: PRICING.claude_haiku_output,
    cacheRead: PRICING.claude_haiku_cache_read,
    cacheWrite: PRICING.claude_haiku_cache_write,
  },
  deepseek: {
    input: PRICING.deepseek_input,
    output: PRICING.deepseek_output,
    cacheRead: PRICING.deepseek_cache_read,
    // No separate write surcharge -- written/missed tokens bill at input rate.
    cacheWrite: PRICING.deepseek_input,
  },
};

export function estimateClaudeCost(params: ClaudeCostParams): number {
  const rates = MODEL_RATES[params.model];
  const uncachedRate = rates.input;
  const cacheReadRate = rates.cacheRead;
  const cacheWriteRate = rates.cacheWrite;
  const outputRate = rates.output;

  const cacheRead = params.cacheReadTokens ?? 0;
  const cacheWrite = params.cacheCreationTokens ?? 0;
  const uncached = Math.max(0, params.inputTokens - cacheRead - cacheWrite);

  return (
    (uncached / 1_000_000) * uncachedRate +
    (cacheRead / 1_000_000) * cacheReadRate +
    (cacheWrite / 1_000_000) * cacheWriteRate +
    (params.outputTokens / 1_000_000) * outputRate
  );
}

interface AiSdkUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  cachedInputTokens?: number;
}

/**
 * Convenience wrapper: pulls cache breakdown from AI SDK's `usage` object so
 * call sites don't have to reach into `providerMetadata.anthropic` manually.
 */
export function estimateClaudeCostFromUsage(
  model: ClaudeModel,
  usage: AiSdkUsageLike,
): number {
  return estimateClaudeCost({
    model,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens:
      usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens,
    cacheCreationTokens: usage.inputTokenDetails?.cacheWriteTokens,
  });
}

/**
 * Log an API usage entry. Fire-and-forget -- errors are swallowed so callers
 * are never disrupted by tracking failures.
 *
 * Automatically picks up action_id/action_label from the nearest `withAction`
 * context if one exists.
 */
export function trackUsage(entry: UsageEntry): void {
  const ctx = actionStore.getStore();

  void (async () => {
    try {
      const { error } = await getAdminClient()
        .from("api_usage")
        .insert({
          service: entry.service,
          operation: entry.operation,
          tokens_input: entry.tokens_input ?? null,
          tokens_output: entry.tokens_output ?? null,
          estimated_cost_usd: entry.estimated_cost_usd,
          metadata: entry.metadata ?? {},
          campaign_id: entry.campaign_id ?? null,
          user_id: entry.user_id ?? null,
          action_id: ctx?.action_id ?? null,
          action_label: ctx?.action_label ?? null,
        });
      if (error) console.error("[cost-tracker] insert failed:", error.message);
    } catch (err) {
      console.error("[cost-tracker] unexpected error:", err);
    }
  })();
}
