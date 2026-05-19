import { tool } from "ai";
import { z } from "zod";
import { createClient, getSupabaseAndUser } from "@/lib/supabase/server";
import { ExaService } from "@/lib/services/exa-service";
import { sendMessage } from "@/lib/services/agentmail-service";
import { trackUsage } from "@/lib/services/cost-tracker";
import { syncOutreachStatusChange } from "@/lib/sync/attio-sync";
import { saveDraft } from "@/lib/email-composition/save";
import {
  applyPattern,
  emailMatchesName,
  getOrgPattern,
  inferPattern,
  isRolePrefix,
  mxCheck,
  recomputeOrgPattern,
  recordVerifiedEmail,
  splitName,
  SOURCE_WEIGHT,
  type VerifiedEmail,
} from "@/lib/services/email-pattern";

// ── Shared findEmail logic ─────────────────────────────────────────────────

const PATTERN_CONFIDENCE_THRESHOLD = 0.5;
// Cap for pattern-derived confidence. Stays strictly below the UI's
// "verified" threshold (0.9) so a pattern guess can never display as verified.
const PATTERN_DERIVED_CONFIDENCE_FACTOR = 0.85;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export async function findEmailForPerson(personId: string): Promise<{
  email: string | null;
  source?: string;
  confidence?: number;
  reason?: string;
  personId: string;
}> {
  const supabase = await createClient();

  const { data: person, error: personErr } = await supabase
    .from("people")
    .select(
      "id, name, title, work_email, personal_email, organization_id, work_email_source, work_email_confidence",
    )
    .eq("id", personId)
    .single();

  if (personErr || !person) {
    return { email: null, reason: "Person not found.", personId };
  }

  if (person.work_email) {
    return {
      email: person.work_email,
      source: person.work_email_source ?? "existing",
      confidence: person.work_email_confidence ?? undefined,
      personId,
    };
  }
  if (person.personal_email) {
    return { email: person.personal_email, source: "existing", personId };
  }

  let domain: string | null = null;
  if (person.organization_id) {
    const { data: org } = await supabase
      .from("organizations")
      .select("domain, name")
      .eq("id", person.organization_id)
      .single();
    domain = org?.domain ?? null;
  }

  const { first, last } = splitName(person.name);

  // ── 1) Pattern-first: if the org has a confident pattern, derive + MX-check.
  if (domain && person.organization_id && first) {
    const orgPattern = await getOrgPattern(supabase, person.organization_id);
    if (
      orgPattern?.pattern &&
      orgPattern.confidence >= PATTERN_CONFIDENCE_THRESHOLD
    ) {
      const derived = applyPattern(orgPattern.pattern, first, last, domain);
      if (
        derived &&
        !isRolePrefix(derived.split("@")[0]) &&
        emailMatchesName(derived, first, last)
      ) {
        const mxOk = await mxCheck(domain);
        if (mxOk) {
          const confidence =
            orgPattern.confidence * PATTERN_DERIVED_CONFIDENCE_FACTOR;
          await supabase
            .from("people")
            .update({
              work_email: derived,
              work_email_source: "pattern_derived",
              work_email_confidence: confidence,
            })
            .eq("id", personId);
          return {
            email: derived,
            source: "pattern_derived",
            confidence,
            personId,
          };
        }
      }
    }
  }

  // ── 2) Exa search — kept as the discovery path when pattern is missing/weak.
  const searchQuery = domain
    ? `"${person.name}" "${domain}" email`
    : `"${person.name}" email contact`;

  let foundEmail: string | null = null;
  let foundDomainMatched = false;

  try {
    const exa = new ExaService();
    const results = await exa.search(searchQuery, {
      numResults: 5,
      includeText: true,
    });

    for (const result of results.results) {
      if (!result.text) continue;
      const emails = result.text.match(EMAIL_REGEX) ?? [];
      for (const candidate of emails) {
        const lower = candidate.toLowerCase();
        const atIndex = lower.lastIndexOf("@");
        const candidateDomain = atIndex >= 0 ? lower.slice(atIndex + 1) : "";
        if (candidateDomain === "example.com") continue;
        const local = lower.split("@")[0];
        if (isRolePrefix(local)) continue;
        if (!emailMatchesName(lower, first, last)) continue;
        if (domain && lower.endsWith(`@${domain}`)) {
          foundEmail = lower;
          foundDomainMatched = true;
          break;
        }
        if (!foundEmail) foundEmail = lower;
      }
      if (foundEmail && foundDomainMatched) break;
    }

    trackUsage({
      service: "exa",
      operation: "find-email",
      estimated_cost_usd: 0.007,
      metadata: { personId, query: searchQuery },
    });
  } catch {
    // Exa search failed, fall through to on-the-fly pattern inference.
  }

  // ── 3) On-the-fly inference: if Exa whiffed, try inferring the pattern from
  //       any verified emails on the org RIGHT NOW (covers the case where the
  //       org has verified emails but the cached pattern hasn't been recomputed
  //       or sits below the confidence threshold).
  if (!foundEmail && domain && person.organization_id && first && last) {
    const { data: orgPeople } = await supabase
      .from("people")
      .select("name, work_email, work_email_source, work_email_verified_at")
      .eq("organization_id", person.organization_id)
      .not("work_email", "is", null)
      .not("work_email_verified_at", "is", null);

    const evidence: VerifiedEmail[] = [];
    for (const p of orgPeople ?? []) {
      if (!p.work_email || !p.work_email_source) continue;
      if (p.work_email_source === "pattern_derived") continue;
      const split = splitName(p.name);
      if (!split.first || !split.last) continue;
      evidence.push({
        email: p.work_email,
        firstName: split.first,
        lastName: split.last,
        source: p.work_email_source,
      });
    }

    if (evidence.length > 0) {
      const inferred = inferPattern(evidence);
      if (inferred.pattern) {
        const derived = applyPattern(inferred.pattern, first, last, domain);
        if (
          derived &&
          !isRolePrefix(derived.split("@")[0]) &&
          emailMatchesName(derived, first, last) &&
          (await mxCheck(domain))
        ) {
          const confidence =
            inferred.confidence * PATTERN_DERIVED_CONFIDENCE_FACTOR;
          await supabase
            .from("people")
            .update({
              work_email: derived,
              work_email_source: "pattern_derived",
              work_email_confidence: confidence,
            })
            .eq("id", personId);
          // Refresh the org's cached pattern so subsequent lookups in a bulk
          // run hit step 1 instead of re-doing this query + Exa search.
          await recomputeOrgPattern(supabase, person.organization_id);
          return {
            email: derived,
            source: "pattern_derived",
            confidence,
            personId,
          };
        }
      }
    }
  }

  // ── 4) Final fallback: blind {first}.{last}@domain when nothing else worked.
  // Goes through applyPattern (not raw interpolation) so the alphanumeric
  // stripping + edge-case handling matches the rest of the file.
  if (!foundEmail && domain && first && last) {
    const blind = applyPattern("{first}.{last}", first, last, domain);
    if (
      blind &&
      !isRolePrefix(blind.split("@")[0]) &&
      emailMatchesName(blind, first, last) &&
      (await mxCheck(domain))
    ) {
      await supabase
        .from("people")
        .update({
          work_email: blind,
          work_email_source: "pattern_derived",
          work_email_confidence: 0.2,
        })
        .eq("id", personId);
      return {
        email: blind,
        source: "pattern_derived",
        confidence: 0.2,
        personId,
      };
    }
  }

  if (!foundEmail) {
    return {
      email: null,
      reason: "Could not find an email address.",
      personId,
    };
  }

  // Exa hit — record as verified-source with the right weight.
  await recordVerifiedEmail(supabase, {
    personId,
    email: foundEmail,
    source: "exa_search",
  });
  return {
    email: foundEmail,
    source: "exa_search",
    confidence: SOURCE_WEIGHT.exa_search,
    personId,
  };
}

// ── findEmail ──────────────────────────────────────────────────────────────

export const findEmail = tool({
  description:
    "Discover the email address for a contact using Exa search and common email pattern guessing. Returns the email if already known. Use this before writeEmail if the contact has no email.",
  inputSchema: z.object({
    personId: z.string().uuid().describe("Person ID to find email for."),
  }),
  execute: async ({ personId }) => findEmailForPerson(personId),
});

// ── findEmails (batch) ─────────────────────────────────────────────────────

export const findEmails = tool({
  description:
    "Batch-discover email addresses for multiple contacts. Skips contacts that already have emails. Returns found and not-found lists.",
  inputSchema: z.object({
    personIds: z.array(z.string().uuid()).describe("Array of person IDs."),
  }),
  execute: async ({ personIds }) => {
    const found: Array<{ personId: string; email: string }> = [];
    const notFound: string[] = [];

    for (const personId of personIds) {
      try {
        const result = await findEmailForPerson(personId);
        if (result.email) {
          found.push({ personId, email: result.email });
        } else {
          notFound.push(personId);
        }
      } catch {
        notFound.push(personId);
      }
    }

    return {
      found,
      notFound,
      summary: `Found emails for ${found.length} of ${personIds.length} contacts. ${notFound.length} not found.`,
    };
  },
});

// ── writeEmail ─────────────────────────────────────────────────────────────

export const writeEmail = tool({
  description:
    "Compose an email draft and save it to the database. This does NOT send the email -- it creates a draft for the user to review. The user must confirm before you call sendEmail.",
  inputSchema: z.object({
    campaignId: z.string().uuid().describe("Campaign ID."),
    personId: z.string().uuid().describe("Person ID (from campaign contacts)."),
    subject: z.string().describe("Email subject line."),
    bodyHtml: z.string().describe("Email body as HTML."),
    bodyText: z
      .string()
      .optional()
      .describe("Plain text version of the email body."),
    sequenceId: z
      .string()
      .uuid()
      .optional()
      .describe("Sequence ID if this draft is part of a sequence."),
    sequenceStepId: z
      .string()
      .uuid()
      .optional()
      .describe("Sequence step ID for this draft."),
    enrollmentId: z
      .string()
      .uuid()
      .optional()
      .describe("Sequence enrollment ID for the contact."),
    aiReasoning: z
      .string()
      .optional()
      .describe("Explanation of why the email was written this way."),
  }),
  execute: async (input) => {
    const ctx = await getSupabaseAndUser();
    if (!ctx) {
      return {
        error:
          "No authenticated session available in tool context. Ask the user to sign in.",
      };
    }
    const { supabase, user } = ctx;

    const { data: campaignRow } = await supabase
      .from("campaigns")
      .select("user_id")
      .eq("id", input.campaignId)
      .single();
    const userId: string = campaignRow?.user_id ?? user.id;

    const result = await saveDraft(supabase, { ...input, userId });

    if (!result.ok) {
      return { error: result.error };
    }

    return {
      draftId: result.draftId,
      to: result.to,
      subject: result.subject,
      status: "draft",
      message:
        "Draft saved. Show it to the user and wait for confirmation before calling sendEmail.",
    };
  },
});

// ── sendEmail ──────────────────────────────────────────────────────────────

export const sendEmail = tool({
  description:
    "Send a previously written email draft via AgentMail. Only call this after the user has reviewed and confirmed the draft.",
  inputSchema: z.object({
    draftId: z.string().uuid().describe("Draft ID to send."),
  }),
  execute: async ({ draftId }) => {
    const supabase = await createClient();

    const { data: draft, error: draftErr } = await supabase
      .from("email_drafts")
      .select("*")
      .eq("id", draftId)
      .single();

    if (draftErr || !draft) {
      return { error: "Draft not found." };
    }

    if (draft.status !== "draft") {
      return {
        error: `This draft has already been ${draft.status}. Cannot send again.`,
      };
    }

    const { data: settings } = await supabase
      .from("user_settings")
      .select("agentmail_inbox_id, from_name, reply_to_email")
      .single();

    if (!settings?.agentmail_inbox_id) {
      return {
        error:
          "Email is not configured. Go to Settings > Email and select an AgentMail inbox first.",
      };
    }

    let messageId: string;
    let threadId: string | null = null;
    try {
      const result = await sendMessage(settings.agentmail_inbox_id, {
        to: draft.to_email,
        subject: draft.subject,
        html: draft.body_html,
        text: draft.body_text ?? undefined,
      });
      messageId = result.messageId ?? crypto.randomUUID();
      threadId = result.threadId ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { error: `Failed to send email: ${msg}` };
    }

    const now = new Date().toISOString();

    await supabase.from("sent_emails").insert({
      agentmail_message_id: messageId,
      agentmail_thread_id: threadId,
      draft_id: draftId,
      campaign_people_id: draft.campaign_people_id,
      campaign_id: draft.campaign_id,
      person_id: draft.person_id,
      user_id: draft.user_id,
      to_email: draft.to_email,
      from_email: settings.agentmail_inbox_id,
      subject: draft.subject,
      status: "sent",
      sent_at: now,
    });

    await supabase
      .from("email_drafts")
      .update({ status: "sent", sent_at: now, updated_at: now })
      .eq("id", draftId);

    await supabase
      .from("campaign_people")
      .update({ outreach_status: "sent" })
      .eq("id", draft.campaign_people_id);

    void syncOutreachStatusChange(draft.campaign_people_id, "sent");

    trackUsage({
      service: "agentmail",
      operation: "send-email",
      estimated_cost_usd: 0.0004,
      campaign_id: draft.campaign_id,
      metadata: {
        draftId,
        to: draft.to_email,
      },
    });

    return {
      emailId: messageId,
      to: draft.to_email,
      subject: draft.subject,
      status: "sent",
    };
  },
});

// ── listDrafts ─────────────────────────────────────────────────────────────

export const listDrafts = tool({
  description: "List unsent email drafts, optionally filtered by campaign.",
  inputSchema: z.object({
    campaignId: z
      .string()
      .uuid()
      .optional()
      .describe("Filter drafts by campaign ID."),
  }),
  execute: async ({ campaignId }) => {
    const supabase = await createClient();

    let query = supabase
      .from("email_drafts")
      .select(
        "id, campaign_id, person_id, to_email, subject, status, created_at",
      )
      .eq("status", "draft")
      .order("created_at", { ascending: false });

    if (campaignId) {
      query = query.eq("campaign_id", campaignId);
    }

    const { data, error } = await query;
    if (error) return { error: error.message };

    return { drafts: data ?? [], count: data?.length ?? 0 };
  },
});

// ── discardDraft ───────────────────────────────────────────────────────────

export const discardDraft = tool({
  description: "Discard an email draft so it won't be sent.",
  inputSchema: z.object({
    draftId: z.string().uuid().describe("Draft ID to discard."),
  }),
  execute: async ({ draftId }) => {
    const supabase = await createClient();

    const { error } = await supabase
      .from("email_drafts")
      .update({
        status: "discarded",
        updated_at: new Date().toISOString(),
      })
      .eq("id", draftId)
      .eq("status", "draft");

    if (error) return { error: error.message };
    return { draftId, status: "discarded" };
  },
});

// ── sendBulkEmails ─────────────────────────────────────────────────────────

export const sendBulkEmails = tool({
  description:
    "Send multiple email drafts at once. If no draftIds provided, sends all unsent drafts for the campaign. Only call after user confirms sending all drafts.",
  inputSchema: z.object({
    campaignId: z.string().uuid().describe("Campaign ID."),
    draftIds: z
      .array(z.string().uuid())
      .optional()
      .describe(
        "Specific draft IDs to send. If omitted, sends all drafts for the campaign.",
      ),
  }),
  execute: async ({ campaignId, draftIds }) => {
    const supabase = await createClient();

    let query = supabase
      .from("email_drafts")
      .select("*")
      .eq("campaign_id", campaignId)
      .eq("status", "draft");

    if (draftIds && draftIds.length > 0) {
      query = query.in("id", draftIds);
    }

    const { data: drafts, error } = await query;
    if (error) return { error: error.message };
    if (!drafts || drafts.length === 0) {
      return { error: "No drafts found to send." };
    }

    const { data: settings } = await supabase
      .from("user_settings")
      .select("agentmail_inbox_id")
      .single();

    if (!settings?.agentmail_inbox_id) {
      return {
        error: "Email not configured. Go to Settings > Email first.",
      };
    }

    const results: Array<{ draftId: string; status: string; error?: string }> =
      [];

    for (const draft of drafts) {
      try {
        const result = await sendMessage(settings.agentmail_inbox_id, {
          to: draft.to_email,
          subject: draft.subject,
          html: draft.body_html,
          text: draft.body_text ?? undefined,
        });

        const messageId = result.messageId ?? crypto.randomUUID();
        const threadId = result.threadId ?? null;
        const now = new Date().toISOString();

        await supabase.from("sent_emails").insert({
          agentmail_message_id: messageId,
          agentmail_thread_id: threadId,
          draft_id: draft.id,
          campaign_people_id: draft.campaign_people_id,
          campaign_id: draft.campaign_id,
          person_id: draft.person_id,
          user_id: draft.user_id,
          to_email: draft.to_email,
          from_email: settings.agentmail_inbox_id,
          subject: draft.subject,
          status: "sent",
          sent_at: now,
        });

        await supabase
          .from("email_drafts")
          .update({ status: "sent", sent_at: now, updated_at: now })
          .eq("id", draft.id);

        await supabase
          .from("campaign_people")
          .update({ outreach_status: "sent" })
          .eq("id", draft.campaign_people_id);

        trackUsage({
          service: "agentmail",
          operation: "send-email",
          estimated_cost_usd: 0.0004,
          campaign_id: campaignId,
          metadata: { draftId: draft.id, to: draft.to_email },
        });

        results.push({ draftId: draft.id, status: "sent" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        results.push({ draftId: draft.id, status: "failed", error: msg });
      }
    }

    const sent = results.filter((r) => r.status === "sent").length;
    const failed = results.filter((r) => r.status === "failed").length;

    return {
      sent,
      failed,
      total: drafts.length,
      results,
      summary: `Sent ${sent} of ${drafts.length} emails.${failed > 0 ? ` ${failed} failed.` : ""}`,
    };
  },
});
