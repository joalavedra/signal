import { createClient } from "@/lib/supabase/server";
import {
  upsertPerson,
  upsertCompany,
  findCompanyByDomain,
  upsertListEntry,
  getListIdBySlug,
  type OutreachStage,
} from "@/lib/services/attio-service";

const DEFAULT_LIST_SLUG = "signal_outreach";
const DEFAULT_STAGE_ATTR = "stage";

function getListSlug(): string {
  return process.env.ATTIO_OUTREACH_LIST_SLUG ?? DEFAULT_LIST_SLUG;
}

function getStageAttr(): string {
  return process.env.ATTIO_OUTREACH_STAGE_ATTR ?? DEFAULT_STAGE_ATTR;
}

function isConfigured(): boolean {
  return Boolean(process.env.ATTIO_API_TOKEN);
}

/**
 * Convert an OutreachStage enum to the literal title stored in Attio.
 * Attio's status attributes match by title (case-sensitive), so we
 * mirror exactly what the user configured on the list.
 */
const STAGE_TITLE: Record<OutreachStage, string> = {
  discovered: "Discovered",
  approved: "Approved",
  in_sequence: "in_sequence",
  sent: "sent",
  opened: "opened",
  replied: "replied",
  bounced: "bounced",
  completed: "completed",
};

/**
 * Map Signal's outreach_status to the Attio list stage. Returns null when
 * the status doesn't move the pipeline forward (e.g. not_contacted).
 */
function mapOutreachStatusToStage(
  outreachStatus: string,
): OutreachStage | null {
  switch (outreachStatus) {
    case "queued":
      return "in_sequence";
    case "sent":
      return "sent";
    case "delivered":
      return "sent";
    case "opened":
      return "opened";
    case "clicked":
      return "opened";
    case "replied":
      return "replied";
    case "bounced":
      return "bounced";
    default:
      return null;
  }
}

/**
 * Push a single campaign person to Attio with a given pipeline stage.
 * Upserts the Person + Company by primary key (email / domain) so it's
 * safe to call repeatedly — Attio dedups for us.
 *
 * Fire-and-forget: errors are logged but never thrown back to the caller.
 * Attio sync should never break Signal's own pipeline.
 */
export async function syncCampaignPersonToCrm(
  campaignPeopleId: string,
  stage: OutreachStage,
): Promise<void> {
  if (!isConfigured()) return;

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("campaign_people")
      .select(
        "id, person:people(id, name, work_email, personal_email, linkedin_url, title, organization:organizations(id, name, domain, description))",
      )
      .eq("id", campaignPeopleId)
      .maybeSingle();

    if (error || !data) return;

    const rawPerson = data.person as unknown;
    const person = (Array.isArray(rawPerson) ? rawPerson[0] : rawPerson) as {
      id: string;
      name: string;
      work_email: string | null;
      personal_email: string | null;
      linkedin_url: string | null;
      title: string | null;
      organization:
        | {
            id: string;
            name: string | null;
            domain: string | null;
            description: string | null;
          }
        | {
            id: string;
            name: string | null;
            domain: string | null;
            description: string | null;
          }[]
        | null;
    } | null;

    if (!person) return;

    const email = person.work_email ?? person.personal_email;

    const org = Array.isArray(person.organization)
      ? person.organization[0]
      : person.organization;

    if (!org?.domain) {
      console.warn(
        `[attio-sync] skipping ${campaignPeopleId}: no organization domain — list is company-parented`,
      );
      return;
    }

    const company = await upsertCompany({
      name: org.name ?? org.domain,
      domain: org.domain,
      description: org.description ?? undefined,
    });

    if (email) {
      await upsertPerson({
        name: person.name,
        email,
        linkedinUrl: person.linkedin_url ?? undefined,
        jobTitle: person.title ?? undefined,
        companyDomain: org.domain,
      });
    }

    const listSlug = getListSlug();
    const stageAttr = getStageAttr();
    const listId = await getListIdBySlug(listSlug);
    if (!listId) {
      console.warn(
        `[attio-sync] list '${listSlug}' not found — set ATTIO_OUTREACH_LIST_SLUG to your list's api_slug`,
      );
      return;
    }

    await upsertListEntry({
      listId,
      recordId: company.id.record_id,
      parentObject: "companies",
      stageAttr,
      stageValue: STAGE_TITLE[stage],
    });
  } catch (err) {
    console.error(
      `[attio-sync] syncCampaignPersonToCrm(${campaignPeopleId}, ${stage}) failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Bridge between Signal's outreach_status flips and Attio stage updates.
 * Call this immediately after a `campaign_people.update({ outreach_status })`
 * so Attio mirrors the pipeline state without delay.
 */
export async function syncOutreachStatusChange(
  campaignPeopleId: string,
  newOutreachStatus: string,
): Promise<void> {
  const stage = mapOutreachStatusToStage(newOutreachStatus);
  if (!stage) return;
  await syncCampaignPersonToCrm(campaignPeopleId, stage);
}

/**
 * Check whether a domain is already known to the CRM. Used by search tools
 * to warn the user before adding a current customer to a prospecting campaign.
 *
 * Returns null when Attio isn't configured or the domain isn't found.
 */
export async function checkAttioDedup(
  domain: string,
): Promise<{ existsInCrm: boolean; recordId?: string } | null> {
  if (!isConfigured()) return null;

  try {
    const company = await findCompanyByDomain(domain);
    if (!company) return { existsInCrm: false };
    return { existsInCrm: true, recordId: company.id.record_id };
  } catch (err) {
    console.error(
      `[attio-sync] checkAttioDedup(${domain}) failed:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
