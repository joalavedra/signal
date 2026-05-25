import { generateObject, tool } from "ai";
import { z } from "zod";
import { llm, MODELS } from "@/lib/ai/models";
import { getAdminClient } from "@/lib/supabase/admin";
import { ExaService, type SearchCategory } from "@/lib/services/exa-service";
import { WebExtractionService } from "@/lib/services/web-extraction-service";
import {
  estimateClaudeCostFromUsage,
  trackUsage,
} from "@/lib/services/cost-tracker";
import {
  findOrCreateOrganization,
  linkOrganizationToCampaign,
  mergeEnrichmentData,
  normalizeDomain,
} from "@/lib/services/knowledge-base";
import {
  UNTRUSTED_NOTICE,
  stringify,
  wrapUntrusted,
} from "@/lib/prompt-safety";
import type { ICP } from "@/lib/types/campaign";

// ── Directory / aggregator blocklist ──────────────────────────────────────
// Domains that list OTHER businesses. Results from these should never be
// stored as companies -- they're directories, not businesses themselves.
const DIRECTORY_DOMAINS = new Set([
  // Property
  "rightmove.co.uk",
  "zoopla.co.uk",
  "onthemarket.com",
  "primelocation.com",
  // Reviews / local
  "yell.com",
  "yelp.com",
  "yelp.co.uk",
  "tripadvisor.co.uk",
  "tripadvisor.com",
  "trustpilot.com",
  "google.com",
  "google.co.uk",
  "g.co",
  // Trades
  "checkatrade.com",
  "trustatrader.com",
  "mybuilder.com",
  "ratedpeople.com",
  "bark.com",
  // Healthcare
  "nhs.uk",
  "iwantgreatcare.org",
  // Legal
  "lawsociety.org.uk",
  "solicitors.guru",
  "chambers.com",
  "legal500.com",
  // Finance
  "unbiased.co.uk",
  "vouchedfor.co.uk",
  // B2B directories
  "clutch.co",
  "themanifest.com",
  "sortlist.co.uk",
  "goodfirms.co",
  "g2.com",
  "capterra.com",
  // Accelerators / investor portfolios / ecosystem trackers (scraped as
  // sources, never stored as companies themselves)
  "ycombinator.com",
  "producthunt.com",
  "a16zcrypto.com",
  "paradigm.xyz",
  "defillama.com",
  // General directories / aggregators
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "github.com",
  "tiktok.com",
  "youtube.com",
  "pinterest.com",
  "wikipedia.org",
  "crunchbase.com",
  "bloomberg.com",
  "forbes.com",
  "companieshouse.gov.uk",
  "endole.co.uk",
  "dnb.com",
  // Booking / marketplace
  "booking.com",
  "opentable.co.uk",
  "treatwell.co.uk",
  "fresha.com",
  "hitched.co.uk",
  "bridebook.com",
  // Recruitment
  "indeed.com",
  "reed.co.uk",
  "glassdoor.com",
  "glassdoor.co.uk",
  // Auto
  "autotrader.co.uk",
  "motors.co.uk",
  // Misc aggregators
  "scoot.co.uk",
  "thomsonlocal.com",
  "192.com",
  "cylex-uk.co.uk",
  "hotfrog.co.uk",
  "freeindex.co.uk",
  "thenewsshopper.co.uk",
]);

/** Check if a domain belongs to a known directory/aggregator. */
function isDirectoryDomain(domain: string | null): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  if (DIRECTORY_DOMAINS.has(d)) return true;
  // Check parent domain (e.g. "maps.google.com" → "google.com")
  const parts = d.split(".");
  if (parts.length > 2) {
    const parent = parts.slice(-2).join(".");
    if (DIRECTORY_DOMAINS.has(parent)) return true;
  }
  return false;
}

/** Derive a brand-ish label from an apex domain, e.g. `mintlify.com` → `Mintlify`. */
function brandFromDomain(apex: string): string {
  const sld = apex.split(".")[0] ?? "";
  return sld ? sld.charAt(0).toUpperCase() + sld.slice(1) : "Unknown";
}

/** Check if a name looks like a directory listing, not a real business. */
function isDirectoryTitle(name: string): boolean {
  const lower = name.toLowerCase();
  const patterns = [
    /^(best|top|find)\s+\d*/,
    /\b(directory|directories)\b/,
    /\b(best|top)\s+(local|rated|reviewed)\b/,
    /\b\d+\s+(best|top)\b/,
    /\bagents?\s+(in|near|around)\s+/,
    /\bnear\s+(me|you)\b/,
    /\breview(s|ed)?\b.*\b(in|near)\b/,
  ];
  return patterns.some((p) => p.test(lower));
}

export const searchCompanies = tool({
  description:
    "Search for companies using Exa semantic search. Stores results in the shared knowledge base. When campaignId is provided, links results to the campaign and deduplicates against existing campaign companies.",
  inputSchema: z.object({
    campaignId: z
      .string()
      .uuid()
      .optional()
      .describe("Campaign to associate results with. Omit for ad-hoc search."),
    query: z.string().min(1).describe("Search query for finding companies"),
    numResults: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Number of results to return"),
    category: z
      .enum([
        "company",
        "research paper",
        "news",
        "pdf",
        "tweet",
        "personal site",
        "financial report",
        "people",
      ])
      .optional()
      .describe("Filter results by category"),
    includeText: z
      .boolean()
      .default(false)
      .describe("Include full page text for richer context"),
  }),
  execute: async (input) => {
    const exa = new ExaService();
    const supabase = getAdminClient();

    // Bias the query toward the campaign's ICP (industry + keywords) so ad-hoc
    // agent queries still return on-profile companies.
    const icp = await loadCampaignIcp(supabase, input.campaignId);
    const extraTerms = icpQueryTerms(icp, input.query);
    const effectiveQuery = extraTerms.length
      ? `${input.query} ${extraTerms.join(" ")}`
      : input.query;

    const searchResponse = await exa.search(effectiveQuery, {
      numResults: input.numResults,
      category: input.category as SearchCategory | undefined,
      includeText: input.includeText,
    });

    // Fetch existing organizations already linked to this campaign for dedup
    const existingDomains = new Set<string>();
    if (input.campaignId) {
      const { data: existingLinks } = await supabase
        .from("campaign_organizations")
        .select("organization:organizations(domain)")
        .eq("campaign_id", input.campaignId);
      for (const l of existingLinks || []) {
        const d = (
          l.organization as unknown as { domain: string | null } | null
        )?.domain;
        if (d) existingDomains.add(d);
      }
    }

    const results: Array<{
      name: string;
      domain: string | null;
      url: string;
      description: string | null;
    }> = [];
    let duplicatesSkipped = 0;
    const seenDomains = new Set<string>();

    let directoriesFiltered = 0;

    for (const result of searchResponse.results) {
      let domain: string | null = null;
      try {
        domain = normalizeDomain(new URL(result.url).hostname);
      } catch {
        // skip
      }

      // Skip directory / aggregator sites
      if (isDirectoryDomain(domain)) {
        directoriesFiltered++;
        continue;
      }

      // Dedup within batch and against campaign
      if (domain) {
        if (existingDomains.has(domain) || seenDomains.has(domain)) {
          duplicatesSkipped++;
          continue;
        }
        seenDomains.add(domain);
      }

      // Prefer a brand label derived from the apex domain over Exa's raw page
      // <title>, which is often messy ("Mintlify - The Intelligent Knowledge
      // Platform", "Introduction - Mintlify"). Title falls back to identifying
      // directory listings only.
      const name = domain ? brandFromDomain(domain) : result.title || "Unknown";

      if (isDirectoryTitle(result.title || name)) {
        directoriesFiltered++;
        continue;
      }
      const summary = result.summary || result.text?.slice(0, 500) || null;
      const description =
        result.title && summary && !summary.includes(result.title)
          ? `${result.title} — ${summary}`
          : summary || result.title || null;

      const org = await findOrCreateOrganization({
        name,
        domain,
        url: result.url,
        description,
        source: "exa",
      });

      if (input.campaignId) {
        await linkOrganizationToCampaign(org.id, input.campaignId);
      }

      results.push({ name, domain, url: result.url, description });
    }

    return {
      companies: results,
      totalFound: searchResponse.resultCount,
      newCompanies: results.length,
      duplicatesSkipped,
      directoriesFiltered,
      query: effectiveQuery,
    };
  },
});

export const getCompanies = tool({
  description:
    "Fetch stored companies for a campaign, with optional filtering by status. Returns a THIN list (no enrichment_data) so context stays small. For deep detail on one company, call getCompanyDetail(organizationId).",
  inputSchema: z.object({
    campaignId: z.string().uuid().describe("Campaign ID"),
    status: z
      .enum(["discovered", "qualified", "disqualified"])
      .optional()
      .describe("Filter by company status"),
  }),
  execute: async (input) => {
    const supabase = getAdminClient();

    let query = supabase
      .from("campaign_organizations")
      .select("*, organization:organizations(*)")
      .eq("campaign_id", input.campaignId)
      .order("relevance_score", { ascending: false });

    if (input.status) {
      query = query.eq("status", input.status);
    }

    const { data, error } = await query;

    if (error) throw new Error(`Failed to get companies: ${error.message}`);

    // Flatten for backwards compat with agent expectations
    const companies = (data || []).map((row) => {
      const org = row.organization as Record<string, unknown>;
      return {
        id: row.id,
        organization_id: row.organization_id,
        campaign_id: row.campaign_id,
        name: org.name,
        domain: org.domain,
        url: org.url,
        industry: org.industry,
        location: org.location,
        description: org.description,
        enrichment_status: org.enrichment_status,
        relevance_score: row.relevance_score,
        score_reason: row.score_reason,
        status: row.status,
        source: org.source,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    });

    return { companies };
  },
});

export const getCompanyDetail = tool({
  description:
    "Fetch full enrichment detail for ONE company (website extract, Exa results, team data). Use when drafting email content that references the company specifically. Call per-draft, not in a loop.",
  inputSchema: z.object({
    organizationId: z
      .string()
      .uuid()
      .describe("organizations.id (not campaign_organizations.id)."),
  }),
  execute: async ({ organizationId }) => {
    const supabase = getAdminClient();

    const { data, error } = await supabase
      .from("organizations")
      .select(
        "id, name, domain, url, industry, location, description, enrichment_data, enrichment_status",
      )
      .eq("id", organizationId)
      .single();

    if (error || !data) {
      return { error: `Company not found: ${error?.message ?? "no rows"}` };
    }

    return data;
  },
});

export const getCampaignSummary = tool({
  description:
    "Get summary stats for a campaign: companies found, contacts enriched, status breakdown.",
  inputSchema: z.object({
    campaignId: z.string().uuid().describe("Campaign ID"),
  }),
  execute: async (input) => {
    const supabase = getAdminClient();

    const [campaignResult, companiesResult, contactsResult] = await Promise.all(
      [
        supabase
          .from("campaigns")
          .select("*")
          .eq("id", input.campaignId)
          .single(),
        supabase
          .from("campaign_organizations")
          .select("id, status")
          .eq("campaign_id", input.campaignId),
        supabase
          .from("campaign_people")
          .select("id, person:people(enrichment_status)")
          .eq("campaign_id", input.campaignId),
      ],
    );

    if (campaignResult.error)
      throw new Error(`Campaign not found: ${campaignResult.error.message}`);

    const companies = companiesResult.data || [];
    const contacts = contactsResult.data || [];

    const companyStatusCounts = companies.reduce(
      (acc, c) => {
        acc[c.status] = (acc[c.status] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    const contactStatusCounts = contacts.reduce(
      (acc, c) => {
        const status =
          (c.person as unknown as { enrichment_status: string } | null)
            ?.enrichment_status || "pending";
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    return {
      campaign: campaignResult.data,
      stats: {
        totalCompanies: companies.length,
        companiesByStatus: companyStatusCounts,
        totalContacts: contacts.length,
        contactsByStatus: contactStatusCounts,
      },
    };
  },
});

// ── Ecosystem source knowledge base ───────────────────────────────────────
// Maps developer / crypto / fintech categories to authoritative "list" pages
// (accelerator directories, investor portfolios, ecosystem trackers) that
// enumerate companies. The tool builds targeted site: queries against these,
// producing higher-signal results than a bare "list of companies" search.
const DISCOVERY_SOURCES: Record<string, string[]> = {
  // Early-stage tech, broad
  startup: ["ycombinator.com", "producthunt.com"],
  saas: ["ycombinator.com", "producthunt.com"],
  "developer tools": ["ycombinator.com", "producthunt.com"],
  // Fintech & payments
  fintech: ["ycombinator.com", "producthunt.com"],
  payments: ["ycombinator.com", "producthunt.com"],
  // Crypto / web3 — investor portfolios + ecosystem trackers
  crypto: ["a16zcrypto.com", "paradigm.xyz", "ycombinator.com"],
  web3: ["a16zcrypto.com", "paradigm.xyz", "ycombinator.com"],
  blockchain: ["a16zcrypto.com", "paradigm.xyz"],
  defi: ["defillama.com", "a16zcrypto.com"],
  stablecoin: ["a16zcrypto.com", "ycombinator.com"],
  wallet: ["a16zcrypto.com", "ycombinator.com"],
};

// Known apex domains for wallet / auth / account-abstraction platforms whose
// public customer & case-study pages list companies that already buy this
// category -- prime "switch" targets. Used to build competitor-customer queries.
const COMPETITOR_DOMAINS: Record<string, string> = {
  thirdweb: "thirdweb.com",
  privy: "privy.io",
  dynamic: "dynamic.xyz",
  magic: "magic.link",
  web3auth: "web3auth.io",
  biconomy: "biconomy.io",
  alchemy: "alchemy.com",
};

/**
 * Look up ecosystem source domains for an industry/keyword string. Tries exact
 * match first, then partial keyword matching in either direction.
 */
function findSourcesForIndustry(industry: string): string[] {
  const lower = industry.toLowerCase();
  if (DISCOVERY_SOURCES[lower]) return DISCOVERY_SOURCES[lower];
  for (const [key, sources] of Object.entries(DISCOVERY_SOURCES)) {
    if (lower.includes(key) || key.includes(lower)) return sources;
  }
  return [];
}

/** Resolve a free-text competitor name to its apex domain, if known. */
function competitorDomain(name: string): string | null {
  const lower = name.toLowerCase().trim();
  if (COMPETITOR_DOMAINS[lower]) return COMPETITOR_DOMAINS[lower];
  for (const [key, domain] of Object.entries(COMPETITOR_DOMAINS)) {
    if (lower.includes(key)) return domain;
  }
  return null;
}

/**
 * Load a campaign's ICP so discovery can bias queries toward fit. Returns null
 * for ad-hoc (no campaign) searches or when the campaign has no ICP set.
 */
async function loadCampaignIcp(
  supabase: ReturnType<typeof getAdminClient>,
  campaignId?: string,
): Promise<ICP | null> {
  if (!campaignId) return null;
  const { data } = await supabase
    .from("campaigns")
    .select("icp")
    .eq("id", campaignId)
    .maybeSingle();
  const icp = data?.icp as ICP | null | undefined;
  return icp && Object.keys(icp).length > 0 ? icp : null;
}

/**
 * Compact ICP terms (industry + keywords) for blending into a search query.
 * Skips any term already present in the base query so we don't duplicate.
 */
function icpQueryTerms(icp: ICP | null, baseQuery: string): string[] {
  if (!icp) return [];
  const base = baseQuery.toLowerCase();
  const candidates = [icp.industry, ...(icp.keywords ?? [])].filter(
    (t): t is string => Boolean(t),
  );
  return candidates.filter((t) => !base.includes(t.toLowerCase()));
}

export const discoverCompanies = tool({
  description:
    "Discover companies by finding authoritative 'list' pages (YC and Product Hunt directories, investor portfolios like a16z crypto / Paradigm, ecosystem trackers like DefiLlama, 'awesome-*' GitHub lists) and scraping them to extract individual companies. Best for B2B / tech / crypto / fintech segments. To find companies that already use a competing product (prime switch targets), pass `competitors` (e.g. ['Privy','thirdweb']) and it will mine their public customer / case-study pages. Pass `location` only when geography genuinely matters (most software/crypto ICPs are global). Use `searchCompanies` for open-ended semantic search and `searchYCCompanies` for batch/region filters. Works with or without a campaign; when a campaignId is set, queries are biased toward the campaign ICP.",
  inputSchema: z.object({
    campaignId: z
      .string()
      .uuid()
      .optional()
      .describe("Campaign to associate results with. Omit for ad-hoc search."),
    industry: z
      .string()
      .describe(
        "Segment or category, e.g. 'crypto payments', 'consumer crypto apps', 'stablecoin fintech', 'web3 wallets'",
      ),
    location: z
      .string()
      .optional()
      .describe(
        "Optional geographic area. Omit for global software/crypto searches; only set it when the ICP is region-specific.",
      ),
    competitors: z
      .array(z.string())
      .optional()
      .describe(
        "Competing products whose customers are switch targets, e.g. ['Privy','thirdweb','Dynamic','Magic']. Mines their public customer / case-study pages.",
      ),
    additionalContext: z
      .string()
      .optional()
      .describe(
        "Extra qualifier for extraction, e.g. 'Series A+ only', 'EVM chains'",
      ),
  }),
  execute: async (input) => {
    const exa = new ExaService();
    const extractor = new WebExtractionService();
    const supabase = getAdminClient();

    // Fetch existing domains linked to this campaign for dedup
    const existingDomains = new Set<string>();
    if (input.campaignId) {
      const { data: existingLinks } = await supabase
        .from("campaign_organizations")
        .select("organization:organizations(domain)")
        .eq("campaign_id", input.campaignId);
      for (const l of existingLinks || []) {
        const d = (
          l.organization as unknown as { domain: string | null } | null
        )?.domain;
        if (d) existingDomains.add(d);
      }
    }

    // Step 1: Build smart discovery queries, biased toward the campaign ICP.
    const icp = await loadCampaignIcp(supabase, input.campaignId);
    const icpKeywords = [icp?.industry, ...(icp?.keywords ?? [])].filter(
      (t): t is string => Boolean(t),
    );
    // ICP terms not already implied by the industry argument.
    const icpExtra = icpKeywords
      .filter((t) => !input.industry.toLowerCase().includes(t.toLowerCase()))
      .slice(0, 4)
      .join(" ");

    const geo = input.location ? ` ${input.location}` : "";
    const base = `${input.industry}${icpExtra ? ` ${icpExtra}` : ""}`;

    const directoryQueries: string[] = [];

    // Targeted site: queries against known ecosystem sources (highest signal).
    const knownSources = findSourcesForIndustry(input.industry);
    for (const src of knownSources.slice(0, 3)) {
      directoryQueries.push(`${base}${geo} site:${src}`);
    }

    // Competitor-customer mining: companies already buying this category.
    for (const c of (input.competitors ?? []).slice(0, 3)) {
      const dom = competitorDomain(c);
      if (dom) directoryQueries.push(`${c} customers case studies site:${dom}`);
      directoryQueries.push(`companies using ${c}${geo}`);
    }

    // Generic semantic fallbacks that work for tech/crypto segments.
    directoryQueries.push(
      `list of ${base} companies${geo}`,
      `${base} startups${geo}`,
    );

    const directoryResults = await Promise.allSettled(
      directoryQueries.map((q) =>
        exa.search(q, { numResults: 5, includeText: true }),
      ),
    );

    // Collect all directory/list pages to scrape
    const pagesToScrape: Array<{
      url: string;
      title: string;
      text: string | null;
    }> = [];
    const seenUrls = new Set<string>();

    for (const result of directoryResults) {
      if (result.status !== "fulfilled") continue;
      for (const r of result.value.results) {
        if (seenUrls.has(r.url)) continue;
        seenUrls.add(r.url);
        pagesToScrape.push({ url: r.url, title: r.title, text: r.text });
      }
    }

    // Step 2: Scrape directory pages for richer content
    const scrapedContent: Array<{ url: string; content: string }> = [];

    const toScrape = pagesToScrape.slice(0, 6);
    const scrapeResults = await Promise.allSettled(
      toScrape.map(async (page) => {
        if (page.text && page.text.length > 500) {
          return { url: page.url, content: page.text };
        }
        const extracted = await extractor.extract(page.url, {
          includeLinks: true,
        });
        if (extracted.success) {
          return {
            url: page.url,
            content: extracted.data.content.slice(0, 5000),
          };
        }
        return { url: page.url, content: page.text || "" };
      }),
    );

    for (const result of scrapeResults) {
      if (result.status === "fulfilled" && result.value.content) {
        scrapedContent.push(result.value);
      }
    }

    if (scrapedContent.length === 0) {
      return {
        companies: [],
        totalFound: 0,
        newCompanies: 0,
        duplicatesSkipped: 0,
        directoriesSearched: pagesToScrape.length,
        message:
          "No directory pages could be scraped. Try a different location or industry.",
      };
    }

    // Step 3: Use LLM to extract individual companies from the scraped content
    const combinedContent = scrapedContent
      .map((s) => `--- Source: ${s.url} ---\n${s.content}`)
      .join("\n\n");

    const { object: extracted, usage } = await generateObject({
      model: llm(MODELS.LIGHT),
      schema: z.object({
        companies: z.array(
          z.object({
            name: z.string().describe("Business name"),
            domain: z
              .string()
              .nullable()
              .describe("Website domain without protocol, e.g. 'acme.co.uk'"),
            url: z.string().nullable().describe("Full website URL if found"),
            location: z
              .string()
              .nullable()
              .describe("Specific location/address if mentioned"),
            industry: z
              .string()
              .nullable()
              .describe("Industry or specialization"),
            description: z
              .string()
              .nullable()
              .describe("Brief description if available"),
          }),
        ),
      }),
      prompt: `Extract individual ${stringify(input.industry)} companies from the following list / directory / portfolio / customer pages.${input.location ? ` Only include companies based in or near ${stringify(input.location)}.` : ""}${input.additionalContext ? ` Additional filter: ${stringify(input.additionalContext)}` : ""}

${UNTRUSTED_NOTICE}

Rules:
- Only extract ACTUAL individual companies, not directory sites, investor funds, or aggregator platforms
- Each company should be a distinct entity (not a duplicate with a slightly different name)
- Clean up names: remove taglines and suffixes, remove "Inc"/"Ltd" unless part of the brand
- Extract the company's own website domain, NOT the source/list URL
- If a company appears multiple times across sources, only include it once
- Skip anything that doesn't match the target segment${input.location ? " or location" : ""}

Scraped source content:
${wrapUntrusted(combinedContent.slice(0, 15000))}`,
    });

    trackUsage({
      service: "deepseek",
      operation: "discoverCompanies-extract",
      tokens_input: usage.inputTokens ?? 0,
      tokens_output: usage.outputTokens ?? 0,
      estimated_cost_usd: estimateClaudeCostFromUsage("deepseek", usage),
      metadata: { model: "deepseek-v4-flash" },
    });

    // Step 4: Deduplicate and store via knowledge base
    const seenDomains = new Set<string>();
    const newCompanies: typeof extracted.companies = [];
    let duplicatesSkipped = 0;

    for (const c of extracted.companies) {
      const domain = c.domain ? normalizeDomain(c.domain) : null;

      // Skip directory/aggregator domains that the LLM mistakenly extracted
      if (isDirectoryDomain(domain)) continue;
      // Skip names that look like directory listings
      if (isDirectoryTitle(c.name)) continue;

      if (domain) {
        if (existingDomains.has(domain) || seenDomains.has(domain)) {
          duplicatesSkipped++;
          continue;
        }
        seenDomains.add(domain);
      }
      newCompanies.push(c);
    }

    // Create orgs and link to campaign
    for (const c of newCompanies) {
      const domain = c.domain ? normalizeDomain(c.domain) : null;
      const org = await findOrCreateOrganization({
        name: c.name,
        domain,
        url: c.url || (domain ? `https://${domain}` : null),
        location: c.location,
        industry: c.industry || input.industry,
        description: c.description,
        source: "directory_discovery",
      });
      if (input.campaignId) {
        await linkOrganizationToCampaign(org.id, input.campaignId);
      }
    }

    return {
      companies: newCompanies.map((c) => ({
        name: c.name,
        domain: c.domain,
        url: c.url,
        location: c.location,
        industry: c.industry,
        description: c.description,
      })),
      totalFound: extracted.companies.length,
      newCompanies: newCompanies.length,
      duplicatesSkipped,
      directoriesSearched: scrapedContent.length,
      queries: directoryQueries,
    };
  },
});

export const searchYCCompanies = tool({
  description:
    "Search Y Combinator's company directory for startups by batch, industry, region, or keywords. Checks the local database first for cached results. If not cached, scrapes the YC directory with a browser. Stores results in the knowledge base. When campaignId is provided, links results to the campaign.",
  inputSchema: z.object({
    campaignId: z
      .string()
      .uuid()
      .optional()
      .describe("Campaign to associate results with. Omit for ad-hoc search."),
    batch: z
      .string()
      .optional()
      .describe(
        "YC batch filter, e.g. 'Winter 2025', 'Summer 2025'. Use full season + year format.",
      ),
    industry: z
      .string()
      .optional()
      .describe(
        "Industry filter, e.g. 'B2B', 'Consumer', 'Fintech', 'Healthcare', 'Education', 'Industrials'",
      ),
    region: z
      .string()
      .optional()
      .describe(
        "Region filter, e.g. 'America / Canada', 'Europe', 'South Asia', 'Remote'",
      ),
    teamSize: z
      .string()
      .optional()
      .describe("Team size filter, e.g. '1-10', '11-50', '51-200'"),
    isHiring: z
      .boolean()
      .optional()
      .describe("Only show companies that are currently hiring"),
    query: z
      .string()
      .optional()
      .describe("Free text search query, e.g. 'AI infrastructure'"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(30)
      .describe("Maximum number of companies to return"),
  }),
  execute: async (input) => {
    const supabase = getAdminClient();

    // ── Step 1: Check cache ──────────────────────────────────────────────
    let cacheQuery = supabase
      .from("organizations")
      .select("*")
      .eq("source", "yc_directory");

    if (input.batch) {
      cacheQuery = cacheQuery.eq(
        "enrichment_data->yc->>batch",
        input.batch.toUpperCase(),
      );
    }
    if (input.industry) {
      cacheQuery = cacheQuery.ilike("industry", `%${input.industry}%`);
    }

    const { data: cached } = await cacheQuery.limit(input.maxResults);
    const cachedOrgs = cached || [];

    if (cachedOrgs.length > 0) {
      let newlyLinked = 0;
      if (input.campaignId) {
        const { data: existingLinks } = await supabase
          .from("campaign_organizations")
          .select("organization_id")
          .eq("campaign_id", input.campaignId);

        const alreadyLinked = new Set(
          (existingLinks || []).map((l) => l.organization_id),
        );

        for (const org of cachedOrgs) {
          if (!alreadyLinked.has(org.id)) {
            await linkOrganizationToCampaign(org.id, input.campaignId);
            newlyLinked++;
          }
        }
      }

      return {
        source: "cache" as const,
        companies: cachedOrgs.map((org) => ({
          name: org.name,
          domain: org.domain,
          url: org.url,
          industry: org.industry,
          location: org.location,
          description: org.description,
          yc: (org.enrichment_data as Record<string, unknown>)?.yc || null,
        })),
        totalFound: cachedOrgs.length,
        newlyLinked,
      };
    }

    // ── Step 2: Cache miss -- scrape ─────────────────────────────────────
    const { scrapeYCCompanies } = await import("@/lib/services/yc-scraper");

    const result = await scrapeYCCompanies(
      {
        batch: input.batch,
        industry: input.industry,
        region: input.region,
        teamSize: input.teamSize,
        isHiring: input.isHiring,
        query: input.query,
      },
      input.maxResults,
    );

    // Dedup against existing campaign orgs
    const existingDomains = new Set<string>();
    if (input.campaignId) {
      const { data: existingLinks } = await supabase
        .from("campaign_organizations")
        .select("organization:organizations(domain)")
        .eq("campaign_id", input.campaignId);
      for (const l of existingLinks || []) {
        const d = (
          l.organization as unknown as { domain: string | null } | null
        )?.domain;
        if (d) existingDomains.add(d);
      }
    }

    const seenDomains = new Set<string>();
    const stored: typeof result.companies = [];
    let duplicatesSkipped = 0;

    for (const company of result.companies) {
      const domain = company.url
        ? normalizeDomain(
            company.url.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
          )
        : null;

      if (domain) {
        if (existingDomains.has(domain) || seenDomains.has(domain)) {
          duplicatesSkipped++;
          continue;
        }
        seenDomains.add(domain);
      }

      const org = await findOrCreateOrganization({
        name: company.name,
        domain,
        url: company.url,
        industry: company.industry,
        location: company.location,
        description: company.oneLiner,
        source: "yc_directory",
      });

      await mergeEnrichmentData("organizations", org.id, {
        yc: {
          batch: company.batch,
          ycUrl: company.ycUrl,
          longDescription: company.longDescription,
          founders: company.founders,
          teamSize: company.teamSize,
          isHiring: company.isHiring,
          scrapedAt: new Date().toISOString(),
        },
      });

      if (input.campaignId) {
        await linkOrganizationToCampaign(org.id, input.campaignId);
      }
      stored.push(company);
    }

    return {
      source: "scrape" as const,
      companies: stored.map((c) => ({
        name: c.name,
        domain: c.url
          ? normalizeDomain(
              c.url.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
            )
          : null,
        url: c.url,
        industry: c.industry,
        location: c.location,
        description: c.oneLiner,
        yc: {
          batch: c.batch,
          ycUrl: c.ycUrl,
          longDescription: c.longDescription,
          founders: c.founders,
          teamSize: c.teamSize,
          isHiring: c.isHiring,
        },
      })),
      totalFound: result.totalCards,
      newCompanies: stored.length,
      duplicatesSkipped,
      directoryUrl: result.directoryUrl,
    };
  },
});
