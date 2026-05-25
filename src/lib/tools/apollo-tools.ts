import { tool } from "ai";
import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import {
  searchPeople as apolloSearchPeopleApi,
  enrichPerson as apolloEnrichPersonApi,
  listSequences as apolloListSequences,
  getEmailAccounts as apolloGetEmailAccounts,
  createContact as apolloCreateContact,
  findContactByEmail as apolloFindContactByEmail,
  addContactsToSequence as apolloAddToSequence,
  type ApolloPerson,
} from "@/lib/services/apollo-service";
import {
  findOrCreateOrganization,
  findOrCreatePerson,
  linkPersonToCampaign,
  mergeEnrichmentData,
} from "@/lib/services/knowledge-base";
import {
  syncCampaignPersonToCrm,
  checkAttioDedup,
} from "@/lib/sync/attio-sync";

function fullName(p: ApolloPerson): string {
  if (p.name) return p.name;
  return [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
}

/**
 * Apollo-backed people search. Prefer this over `searchPeople` (Exa) when
 * you know specific titles, seniorities, or company domains — Apollo returns
 * verified contacts with email status, where Exa returns LinkedIn URL guesses.
 */
export const apolloSearchPeople = tool({
  description:
    "Search Apollo's verified-contact database for people at companies. PREFER this over searchPeople when filtering by job title, seniority, or specific company domain — Apollo returns verified emails and titles. Falls back to searchPeople only when Apollo returns zero matches. Stores results in the knowledge base and optionally links to a campaign.",
  inputSchema: z.object({
    campaignId: z
      .string()
      .uuid()
      .optional()
      .describe("Campaign to associate results with"),
    personTitles: z
      .array(z.string())
      .optional()
      .describe(
        "Job titles to filter on, e.g. ['CTO', 'VP Engineering', 'Head of Platform']. Combined with OR.",
      ),
    personSeniorities: z
      .array(z.string())
      .optional()
      .describe(
        "Seniority levels to filter on. Valid values: c_suite, vp, director, manager, senior, entry, owner, partner, founder, intern.",
      ),
    organizationDomains: z
      .array(z.string())
      .optional()
      .describe("Company domains to filter on, e.g. ['stripe.com']"),
    keywords: z
      .string()
      .optional()
      .describe(
        "Free-text keyword search across name/title/company. Combine with title/seniority filters for best results.",
      ),
    perPage: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("How many results per page (max 100)"),
  }),
  async execute({
    campaignId,
    personTitles,
    personSeniorities,
    organizationDomains,
    keywords,
    perPage,
  }) {
    const { people, total } = await apolloSearchPeopleApi({
      person_titles: personTitles,
      person_seniorities: personSeniorities,
      organization_domains: organizationDomains,
      q_keywords: keywords,
      per_page: perPage,
    });

    if (people.length === 0) {
      return {
        ok: true,
        total: 0,
        stored: 0,
        message:
          "Apollo returned no matches. Consider trying `searchPeople` (Exa) as a fallback for novel companies not in Apollo's database.",
      };
    }

    const stored = [];
    const alreadyInCrm: string[] = [];
    for (const p of people) {
      let organizationId: string | null = null;
      if (p.organization?.name) {
        const org = await findOrCreateOrganization({
          name: p.organization.name,
          domain: p.organization.primary_domain ?? null,
          url: p.organization.website_url ?? null,
          source: "apollo",
        });
        organizationId = org.id;
        if (p.organization.primary_domain) {
          const dedup = await checkAttioDedup(p.organization.primary_domain);
          if (dedup?.existsInCrm) {
            alreadyInCrm.push(p.organization.name);
          }
        }
      }

      const person = await findOrCreatePerson({
        name: fullName(p) || "(unknown)",
        linkedin_url: p.linkedin_url ?? null,
        work_email: p.email ?? null,
        title: p.title ?? null,
        organization_id: organizationId,
        source: "apollo",
      });

      await mergeEnrichmentData("people", person.id, {
        apollo: {
          id: p.id,
          email_status: p.email_status,
          headline: p.headline,
          city: p.city,
          country: p.country,
          photo_url: p.photo_url,
        },
      });

      if (campaignId) {
        await linkPersonToCampaign(person.id, campaignId);
      }

      stored.push({
        id: person.id,
        name: fullName(p),
        title: p.title,
        company: p.organization?.name,
        email: p.email,
        email_status: p.email_status,
      });
    }

    const unique = Array.from(new Set(alreadyInCrm));
    return {
      ok: true,
      total,
      stored: stored.length,
      people: stored,
      ...(unique.length > 0
        ? {
            warning: `${unique.length} compan${unique.length === 1 ? "y" : "ies"} already exist in Attio CRM: ${unique.join(", ")}. Consider whether to prospect them or not.`,
          }
        : {}),
    };
  },
});

/**
 * Enrich a single known person via Apollo's people/match endpoint.
 * Costs 1 Apollo credit per successful match — only use when you have a
 * specific LinkedIn URL or email and the person isn't already enriched.
 */
export const apolloEnrichPerson = tool({
  description:
    "Enrich a single person via Apollo. Costs 1 credit per successful match. Use when the person has a LinkedIn URL or email but no verified work email or title yet. Merges results into the person's enrichment_data alongside LinkedIn/Twitter/Exa data.",
  inputSchema: z.object({
    personId: z.string().uuid().describe("The Signal person ID to enrich"),
    revealPersonalEmails: z
      .boolean()
      .default(false)
      .describe(
        "Whether to spend extra credits to reveal personal email addresses",
      ),
    revealPhoneNumber: z
      .boolean()
      .default(false)
      .describe("Whether to spend extra credits to reveal phone number"),
  }),
  async execute({ personId, revealPersonalEmails, revealPhoneNumber }) {
    const supabase = getAdminClient();
    const { data: person, error } = await supabase
      .from("people")
      .select(
        "id, name, linkedin_url, work_email, personal_email, organization_id, organizations(domain)",
      )
      .eq("id", personId)
      .maybeSingle();

    if (error || !person) {
      return { ok: false, error: error?.message ?? "Person not found" };
    }

    const orgDomain = (person.organizations as { domain?: string } | null)
      ?.domain;
    const result = await apolloEnrichPersonApi({
      linkedinUrl: person.linkedin_url ?? undefined,
      email: person.work_email ?? person.personal_email ?? undefined,
      organizationDomain: orgDomain,
      revealPersonalEmails,
      revealPhoneNumber,
    });

    if (!result) {
      return { ok: true, matched: false, message: "Apollo had no match" };
    }

    await mergeEnrichmentData("people", personId, {
      apollo: {
        id: result.id,
        email_status: result.email_status,
        headline: result.headline,
        city: result.city,
        country: result.country,
        photo_url: result.photo_url,
        last_enriched_via_apollo: new Date().toISOString(),
      },
    });

    if (result.email && !person.work_email) {
      await supabase
        .from("people")
        .update({ work_email: result.email })
        .eq("id", personId);
    }

    return {
      ok: true,
      matched: true,
      person: {
        id: personId,
        email: result.email,
        email_status: result.email_status,
        title: result.title,
      },
    };
  },
});

/**
 * List the team's Apollo sequences so the user can pick one for enrollment.
 */
export const listApolloSequences = tool({
  description:
    "List the team's existing Apollo sequences (a.k.a. emailer_campaigns). Use this when the user wants to push contacts into Apollo for outbound — they need to pick a sequence by ID. Returns each sequence's active state so you can warn if they're picking an inactive one.",
  inputSchema: z.object({
    onlyActive: z
      .boolean()
      .default(false)
      .describe("If true, filter to only active (non-paused) sequences"),
  }),
  async execute({ onlyActive }) {
    const seqs = await apolloListSequences({ onlyActive });
    return {
      ok: true,
      count: seqs.length,
      sequences: seqs.map((s) => ({
        id: s.id,
        name: s.name,
        active: s.active,
        last_used_at: s.last_used_at,
      })),
    };
  },
});

/**
 * Push approved campaign contacts into an Apollo sequence. This is the
 * "alternative to AgentMail" path: Apollo handles all sending, tracking,
 * and step cadence. Signal-side state is updated to reflect the handoff.
 */
export const pushToApolloSequence = tool({
  description:
    "Enroll one or more campaign contacts into an Apollo sequence. Apollo will handle sending, scheduling, opens/replies. Use this INSTEAD of AgentMail (createSequence/sendEmail) when the user wants Apollo to own outreach. Requires the campaign_people IDs (not raw person IDs) and an Apollo sequence ID. If emailAccountId is omitted, the first connected mailbox is used.",
  inputSchema: z.object({
    campaignPeopleIds: z
      .array(z.string().uuid())
      .min(1)
      .describe(
        "campaign_people link IDs to enroll. These must be 'approved' status; pending contacts are rejected.",
      ),
    sequenceId: z
      .string()
      .min(1)
      .describe("Apollo sequence ID (from listApolloSequences)"),
    emailAccountId: z
      .string()
      .optional()
      .describe(
        "Apollo email account ID to send from. If omitted, the first connected mailbox is used.",
      ),
    sendUnverified: z
      .boolean()
      .default(false)
      .describe(
        "Allow contacts whose email Apollo marks 'unverified' to be enrolled",
      ),
  }),
  async execute({
    campaignPeopleIds,
    sequenceId,
    emailAccountId,
    sendUnverified,
  }) {
    const supabase = getAdminClient();

    const { data: rows, error } = await supabase
      .from("campaign_people")
      .select(
        "id, status, person_id, people(id, name, work_email, personal_email, linkedin_url, organizations(name, primary_domain:domain))",
      )
      .in("id", campaignPeopleIds);

    if (error || !rows) {
      return { ok: false, error: error?.message ?? "Lookup failed" };
    }

    const notApproved = rows.filter((r) => r.status !== "approved");
    if (notApproved.length > 0) {
      return {
        ok: false,
        error: `${notApproved.length} of ${rows.length} contacts are not approved. Approve them first via updateCampaignPersonStatus.`,
      };
    }

    let mailboxId = emailAccountId;
    if (!mailboxId) {
      const accounts = await apolloGetEmailAccounts();
      if (accounts.length === 0) {
        return {
          ok: false,
          error:
            "No Apollo email accounts connected. Connect one in Apollo settings.",
        };
      }
      mailboxId = accounts[0].id;
    }

    const apolloContactIds: string[] = [];
    const skipped: { name: string; reason: string }[] = [];

    for (const row of rows) {
      const rawPeople = row.people as unknown;
      const person = (Array.isArray(rawPeople) ? rawPeople[0] : rawPeople) as {
        id: string;
        name: string;
        work_email: string | null;
        personal_email: string | null;
        linkedin_url: string | null;
        organizations:
          | { name: string | null }
          | { name: string | null }[]
          | null;
      } | null;
      if (!person) {
        skipped.push({ name: "(unknown)", reason: "Missing person record" });
        continue;
      }

      const email = person.work_email ?? person.personal_email;
      let apolloContactId: string | null = null;

      if (email) {
        const existing = await apolloFindContactByEmail(email);
        if (existing) apolloContactId = existing.id;
      }

      if (!apolloContactId) {
        const [firstName, ...rest] = (person.name ?? "").split(" ");
        const org = Array.isArray(person.organizations)
          ? person.organizations[0]
          : person.organizations;
        const contact = await apolloCreateContact({
          firstName: firstName || undefined,
          lastName: rest.join(" ") || undefined,
          organizationName: org?.name ?? undefined,
          email: email ?? undefined,
          linkedinUrl: person.linkedin_url ?? undefined,
        });
        apolloContactId = contact.id;
      }

      apolloContactIds.push(apolloContactId);
    }

    if (apolloContactIds.length === 0) {
      return { ok: false, error: "No contacts could be prepared", skipped };
    }

    const { added, failed } = await apolloAddToSequence(
      sequenceId,
      apolloContactIds,
      {
        emailAccountId: mailboxId,
        status: "active",
        sequenceUnverifiedEmail: sendUnverified,
      },
    );

    await supabase
      .from("campaign_people")
      .update({ outreach_status: "queued" })
      .in("id", campaignPeopleIds);

    for (const id of campaignPeopleIds) {
      void syncCampaignPersonToCrm(id, "in_sequence");
    }

    return {
      ok: true,
      enrolled: added.length,
      failed: failed.length,
      failures: failed,
      skipped,
      sequenceId,
      mailboxId,
    };
  },
});
