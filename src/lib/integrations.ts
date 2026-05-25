/**
 * Integration registry — single source of truth for every external service
 * Signal can talk to. Each entry describes the env vars that configure it,
 * how critical it is (required vs optional), and what the user sees if it's
 * missing (banner copy, settings-panel description, signup link).
 *
 * Adding a new integration:
 *   1. Append an entry to `INTEGRATIONS` below.
 *   2. The status API (/api/integrations/status), missing-key banner, and
 *      settings panel all pick it up automatically — no further wiring.
 */

export type IntegrationCategory =
  | "auth" // sign-in / identity
  | "data" // database / storage
  | "ai" // LLM access
  | "scraping" // browser automation
  | "email" // outbound + tracking
  | "scheduling" // background jobs
  | "enrichment"; // company / person data providers

export type IntegrationSeverity =
  | "required" // app is broken without this — surface as banner
  | "optional"; // a specific feature is gated — surface in settings panel

export interface Integration {
  /** Stable id used by the API + components. */
  id: string;
  /** Display name (e.g. "Anthropic", "Browserbase"). */
  name: string;
  /** Grouping in the settings panel. */
  category: IntegrationCategory;
  /** Banner vs settings-panel-only treatment. */
  severity: IntegrationSeverity;
  /** Short user-facing description: "Chat & enrichment", "Outbound email". */
  feature: string;
  /** What breaks if this is missing — used in banner copy + panel tooltip. */
  consequence: string;
  /**
   * Env vars that must ALL be set for this integration to be configured.
   * If any one is empty, the integration is reported as "not configured".
   */
  envVars: string[];
  /**
   * Optional NEXT_PUBLIC_ env var for client-side detection (used by the
   * banner without a server round-trip). When omitted, the banner relies on
   * the /api/integrations/status fetch.
   */
  publicEnvVar?: string;
  /** Where to sign up / get keys. */
  signupUrl?: string;
  /** Where the user finds the keys once signed up. */
  keysUrl?: string;
  /** Suggested fix command — usually "pnpm setup" or "Add X to .env.local". */
  fixHint?: string;
}

export const INTEGRATIONS: Integration[] = [
  // ─── REQUIRED ────────────────────────────────────────────────────────────
  {
    id: "clerk",
    name: "Clerk",
    category: "auth",
    severity: "required",
    feature: "Sign-in, user identity, JWTs for Supabase RLS",
    consequence:
      "Without all three set, you're in Keyless dev mode: sign-in works but Supabase RLS rejects Clerk-issued JWTs, so every dashboard query returns empty.",
    envVars: [
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      "CLERK_SECRET_KEY",
      "CLERK_FRONTEND_API_DOMAIN",
    ],
    publicEnvVar: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    signupUrl: "https://clerk.com",
    keysUrl: "https://dashboard.clerk.com (API Keys → Frontend API URL)",
    fixHint:
      "Run `pnpm setup` (option [2]) or paste the keys + frontend API domain into .env.local",
  },
  {
    id: "supabase",
    name: "Supabase",
    category: "data",
    severity: "required",
    feature: "Database, storage, RLS",
    consequence:
      "The app can't read or write data. Every page will fail or show empty state.",
    envVars: [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
    ],
    publicEnvVar: "NEXT_PUBLIC_SUPABASE_URL",
    signupUrl: "https://supabase.com/dashboard",
    keysUrl: "https://supabase.com/dashboard (Project Settings → API)",
    fixHint: "Run `pnpm setup` or paste keys into .env.local",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    category: "ai",
    severity: "required",
    feature: "Chat, enrichment, email drafts",
    consequence:
      "Every chat request will fail with a 500. The agent and email composer are non-functional.",
    envVars: ["DEEPSEEK_API_KEY"],
    signupUrl: "https://platform.deepseek.com",
    keysUrl: "https://platform.deepseek.com/api_keys",
    fixHint: "Add `DEEPSEEK_API_KEY=sk-...` to .env.local",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    category: "ai",
    severity: "required",
    feature: "Stagehand vision (browser DOM reasoning)",
    consequence:
      "Stagehand-based signals (hiring scraper, browser_script steps) will fail.",
    envVars: ["GEMINI_API_KEY"],
    signupUrl: "https://aistudio.google.com",
    keysUrl: "https://aistudio.google.com/apikey",
    fixHint: "Add `GEMINI_API_KEY=...` to .env.local",
  },

  // ─── OPTIONAL ────────────────────────────────────────────────────────────
  {
    id: "browserbase",
    name: "Browserbase",
    category: "scraping",
    severity: "required",
    feature: "Web scraping, YC scraper, hiring signals",
    consequence:
      "Any signal that needs browser automation will fail with 'not configured'.",
    envVars: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"],
    signupUrl: "https://www.browserbase.com",
    keysUrl: "https://www.browserbase.com/settings",
    fixHint: "Add BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID to .env.local",
  },
  {
    id: "agentmail",
    name: "AgentMail",
    category: "email",
    severity: "optional",
    feature: "Outbound email + delivery tracking",
    consequence:
      "Outreach sequences can be drafted but not sent. Delivery / reply tracking is disabled.",
    envVars: ["AGENTMAIL_API_KEY"],
    signupUrl: "https://agentmail.to",
    keysUrl: "https://agentmail.to/dashboard",
    fixHint: "Add `AGENTMAIL_API_KEY=am_...` to .env.local",
  },
  {
    id: "agentmail_webhook",
    name: "AgentMail webhooks",
    category: "email",
    severity: "optional",
    feature: "Inbound reply / delivery callbacks",
    consequence:
      "Email status updates (opened, clicked, replied) won't be recorded — outreach pipeline can't progress contacts automatically.",
    envVars: ["AGENTMAIL_WEBHOOK_SECRET"],
    keysUrl: "https://agentmail.to/dashboard (webhook settings)",
    fixHint: "Add `AGENTMAIL_WEBHOOK_SECRET=whsec_...` to .env.local",
  },
  {
    id: "qstash",
    name: "QStash",
    category: "scheduling",
    severity: "optional",
    feature: "Scheduled signal runs, background jobs",
    consequence:
      "Signals run only when triggered manually from the UI — no scheduled cadence.",
    envVars: [
      "QSTASH_TOKEN",
      "QSTASH_CURRENT_SIGNING_KEY",
      "QSTASH_NEXT_SIGNING_KEY",
    ],
    signupUrl: "https://upstash.com",
    keysUrl: "https://console.upstash.com/qstash",
    fixHint:
      "Add QSTASH_TOKEN + QSTASH_CURRENT_SIGNING_KEY + QSTASH_NEXT_SIGNING_KEY",
  },
  {
    id: "exa",
    name: "Exa",
    category: "enrichment",
    severity: "required",
    feature: "Neural web search inside chat",
    consequence:
      "Chat web-search and Exa-backed signals (changelog monitor, etc.) will return 'not configured'.",
    envVars: ["EXA_API_KEY"],
    signupUrl: "https://exa.ai",
    keysUrl: "https://dashboard.exa.ai/api-keys",
    fixHint: "Add `EXA_API_KEY=...` to .env.local",
  },
  {
    id: "google_places",
    name: "Google Places",
    category: "enrichment",
    severity: "optional",
    feature: "Google reviews + Places enrichment signal",
    consequence: "Google Reviews signal fails; falls back to no rating data.",
    envVars: ["GOOGLE_API_KEY"],
    signupUrl:
      "https://developers.google.com/maps/documentation/places/web-service",
    keysUrl: "https://console.cloud.google.com/apis/credentials",
    fixHint: "Add `GOOGLE_API_KEY=...` to .env.local",
  },
  {
    id: "apify",
    name: "Apify",
    category: "enrichment",
    severity: "optional",
    feature: "LinkedIn + X profile enrichment",
    consequence: "Contact enrichment skips LinkedIn / X data.",
    envVars: ["APIFY_API_TOKEN"],
    signupUrl: "https://apify.com",
    keysUrl: "https://console.apify.com/account/integrations",
    fixHint: "Add `APIFY_API_TOKEN=apify_api_...` to .env.local",
  },
  {
    id: "apollo",
    name: "Apollo.io",
    category: "enrichment",
    severity: "optional",
    feature:
      "Verified contact discovery + Apollo Sequences (optional outreach engine)",
    consequence:
      "People search falls back to Exa; cannot push contacts to Apollo Sequences.",
    envVars: ["APOLLO_API_KEY"],
    signupUrl: "https://apollo.io",
    keysUrl: "https://app.apollo.io/#/settings/integrations/api",
    fixHint:
      "Add `APOLLO_API_KEY=...` to .env.local. Toggle 'Set as master key' when creating it — sequence endpoints require it.",
  },
  {
    id: "attio",
    name: "Attio",
    category: "enrichment",
    severity: "optional",
    feature:
      "CRM source-of-truth sync (People, Companies, signal_outreach list)",
    consequence:
      "Approved contacts and outreach events stay in Signal only; no CRM mirror.",
    envVars: ["ATTIO_API_TOKEN"],
    signupUrl: "https://attio.com",
    keysUrl: "https://app.attio.com/settings/developers/api-keys",
    fixHint: "Add `ATTIO_API_TOKEN=...` to .env.local",
  },
  {
    id: "github",
    name: "GitHub",
    category: "enrichment",
    severity: "optional",
    feature: "GitHub commit activity / release cadence signals",
    consequence:
      "GitHub-based signals (stargazers, commit activity, releases) will fail.",
    envVars: ["GITHUB_TOKEN"],
    signupUrl: "https://github.com/settings/tokens",
    keysUrl: "https://github.com/settings/tokens",
    fixHint: "Generate a fine-grained token with read-only public_repo scope",
  },
];

/**
 * Group integrations by category for the settings panel.
 */
export function groupIntegrationsByCategory(): Record<
  IntegrationCategory,
  Integration[]
> {
  const out = {} as Record<IntegrationCategory, Integration[]>;
  for (const integration of INTEGRATIONS) {
    if (!out[integration.category]) out[integration.category] = [];
    out[integration.category].push(integration);
  }
  return out;
}

/** Display name for a category. */
export const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  auth: "Auth",
  data: "Database",
  ai: "AI",
  scraping: "Web automation",
  email: "Email",
  scheduling: "Background jobs",
  enrichment: "Enrichment",
};
