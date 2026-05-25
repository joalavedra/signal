import { generateObject } from "ai";
import { z } from "zod";

import { llm, MODELS } from "@/lib/ai/models";
import {
  estimateClaudeCostFromUsage,
  trackUsage,
} from "@/lib/services/cost-tracker";
import {
  UNTRUSTED_NOTICE,
  stringify,
  wrapUntrusted,
} from "@/lib/prompt-safety";

const MODEL_ID = MODELS.LIGHT;
const MODEL_LABEL = "deepseek";

interface SearchResultLike {
  title: string;
  url: string;
  text: string | null;
}

/**
 * Takes raw website fields (often noisy: duplicated nav copy, browser-compat
 * warnings, SEO boilerplate) and returns a clean 2-3 sentence summary.
 * Returns null on failure so callers can fall back to raw fields.
 */
export async function summarizeWebsite(input: {
  companyName: string;
  title?: string;
  description?: string;
  content?: string;
}): Promise<string | null> {
  const bodyText = [input.title, input.description, input.content]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 6000);

  if (!bodyText.trim()) return null;

  try {
    const { object, usage } = await generateObject({
      model: llm(MODEL_ID),
      schema: z.object({
        summary: z
          .string()
          .describe(
            "2-3 sentence overview of what the company does, plain prose.",
          ),
      }),
      prompt: `Summarize this company's website for a sales researcher. Target: 2-3 sentences, plain prose, no markdown, no bullet lists. Focus on what the company does and who they serve. Ignore navigation menus, browser-compatibility warnings, cookie banners, property listings, and repeated marketing copy.

${UNTRUSTED_NOTICE}

Company name: ${stringify(input.companyName)}

Raw scraped website text:
${wrapUntrusted(bodyText)}`,
    });

    trackUsage({
      service: "claude",
      operation: "summarize-website",
      tokens_input: usage.inputTokens ?? 0,
      tokens_output: usage.outputTokens ?? 0,
      estimated_cost_usd: estimateClaudeCostFromUsage(MODEL_LABEL, usage),
      metadata: { model: MODEL_LABEL, companyName: input.companyName },
    });

    return object.summary.trim() || null;
  } catch (err) {
    console.error("[summarize-website] failed:", err);
    return null;
  }
}

interface PersonSummaryInput {
  name: string;
  title?: string | null;
  companyName?: string | null;
  linkedinHeadline?: string | null;
  twitterBio?: string | null;
  linkedinPosts?: Array<{ text: string }>;
  tweets?: Array<{ text: string }>;
  news?: SearchResultLike[];
  articles?: SearchResultLike[];
  background?: SearchResultLike[];
}

/**
 * Generate a 2-3 sentence blurb describing who a person is and what they're
 * up to, drawn from their enrichment data. Surfaced at the top of the person
 * drawer so the user gets a quick read before scanning the raw signals.
 * Returns null on failure / no usable signal.
 */
export async function summarizePerson(
  input: PersonSummaryInput,
): Promise<string | null> {
  const sections: string[] = [];

  if (input.title) sections.push(`Current title: ${input.title}`);
  if (input.companyName) sections.push(`Company: ${input.companyName}`);
  if (input.linkedinHeadline)
    sections.push(`LinkedIn headline: ${input.linkedinHeadline}`);
  if (input.twitterBio) sections.push(`Twitter bio: ${input.twitterBio}`);

  const posts = (input.linkedinPosts ?? [])
    .slice(0, 3)
    .map((p) => p.text?.slice(0, 400))
    .filter(Boolean)
    .join("\n---\n");
  if (posts) sections.push(`Recent LinkedIn posts:\n${posts}`);

  const tweets = (input.tweets ?? [])
    .slice(0, 3)
    .map((t) => t.text?.slice(0, 280))
    .filter(Boolean)
    .join("\n---\n");
  if (tweets) sections.push(`Recent tweets:\n${tweets}`);

  const formatResults = (results?: SearchResultLike[]) =>
    (results ?? [])
      .slice(0, 3)
      .map((r) => `${r.title}\n${r.text?.slice(0, 600) ?? ""}`)
      .filter(Boolean)
      .join("\n---\n");

  const news = formatResults(input.news);
  if (news) sections.push(`News mentions:\n${news}`);
  const articles = formatResults(input.articles);
  if (articles) sections.push(`Articles & talks:\n${articles}`);
  const background = formatResults(input.background);
  if (background) sections.push(`Background results:\n${background}`);

  if (sections.length === 0) return null;

  const body = sections.join("\n\n").slice(0, 8000);

  try {
    const { object, usage } = await generateObject({
      model: llm(MODEL_ID),
      schema: z.object({
        summary: z
          .string()
          .describe(
            "2-3 sentence overview of who the person is and what they've been up to recently. Plain prose, no markdown.",
          ),
      }),
      prompt: `Summarize this person for a sales researcher who needs a quick read on who they are. Target: 2-3 sentences, plain prose, no markdown, no bullets. Cover their role and one or two notable threads from their background or recent activity. Skip generic platitudes ("results-driven leader") -- if the source material is thin, keep the summary short rather than padding it.

${UNTRUSTED_NOTICE}

Person: ${stringify(input.name)}

Source material:
${wrapUntrusted(body)}`,
    });

    trackUsage({
      service: "claude",
      operation: "summarize-person",
      tokens_input: usage.inputTokens ?? 0,
      tokens_output: usage.outputTokens ?? 0,
      estimated_cost_usd: estimateClaudeCostFromUsage(MODEL_LABEL, usage),
      metadata: { model: MODEL_LABEL, personName: input.name },
    });

    return object.summary.trim() || null;
  } catch (err) {
    console.error("[summarize-person] failed:", err);
    return null;
  }
}

/**
 * Batch-summarize search result texts. Returns the same array shape with a
 * `summary` field added. Failures leave the original result unchanged.
 */
export async function summarizeSearchResults<T extends SearchResultLike>(
  companyName: string,
  category: string,
  results: T[],
): Promise<Array<T & { summary?: string }>> {
  if (results.length === 0) return results;

  const payload = results
    .map((r, i) => {
      const text = r.text ? r.text.slice(0, 1500) : "";
      return `[${i}] ${r.title}\n${text}`;
    })
    .join("\n\n---\n\n");

  try {
    const { object, usage } = await generateObject({
      model: llm(MODEL_ID),
      schema: z.object({
        summaries: z.array(
          z.object({
            index: z.number().int(),
            summary: z
              .string()
              .describe("1-2 sentences, plain prose, no markdown."),
          }),
        ),
      }),
      prompt: `Summarize each search result below as 1-2 plain-prose sentences. No markdown, no headers, no bullet lists. Focus on what the result tells a sales researcher about the target company specifically.

${UNTRUSTED_NOTICE}

Target company: ${stringify(companyName)}
Category: ${stringify(category)}

Scraped search results:
${wrapUntrusted(payload)}`,
    });

    trackUsage({
      service: "claude",
      operation: "summarize-search-results",
      tokens_input: usage.inputTokens ?? 0,
      tokens_output: usage.outputTokens ?? 0,
      estimated_cost_usd: estimateClaudeCostFromUsage(MODEL_LABEL, usage),
      metadata: {
        model: MODEL_LABEL,
        companyName,
        category,
        count: results.length,
      },
    });

    const byIndex = new Map<number, string>();
    for (const s of object.summaries) {
      if (s.summary?.trim()) byIndex.set(s.index, s.summary.trim());
    }

    return results.map((r, i) => {
      const summary = byIndex.get(i);
      return summary ? { ...r, summary } : r;
    });
  } catch (err) {
    console.error("[summarize-search-results] failed:", err);
    return results;
  }
}
