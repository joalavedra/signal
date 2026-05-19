import { createClient } from "@/lib/supabase/server";
import {
  upsertPerson,
  upsertCompany,
  findCompanyByDomain,
  upsertListEntry,
  updateListEntryStage,
  findListEntryByRecord,
  getListIdBySlug,
  type OutreachStage,
} from "@/lib/services/attio-service";

const SIGNAL_OUTREACH_LIST_SLUG = "signal_outreach";

function isConfigured(): boolean {
  return Boolean(process.env.ATTIO_API_TOKEN);
}

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
    if (!email) {
      console.warn(
        `[attio-sync] skipping ${campaignPeopleId}: no email on person ${person.id}`,
      );
      return;
    }

    const org = Array.isArray(person.organization)
      ? person.organization[0]
      : person.organization;

    if (org?.domain) {
      await upsertCompany({
        name: org.name ?? org.domain,
        domain: org.domain,
        description: org.description ?? undefined,
      });
    }

    const attioPerson = await upsertPerson({
      name: person.name,
      email,
      linkedinUrl: person.linkedin_url ?? undefined,
      jobTitle: person.title ?? undefined,
      companyDomain: org?.domain ?? undefined,
    });

    const listId = await getListIdBySlug(SIGNAL_OUTREACH_LIST_SLUG);
    if (!listId) {
      console.warn(
        `[attio-sync] list '${SIGNAL_OUTREACH_LIST_SLUG}' not found — create it in Attio with a 'stage' status attribute`,
      );
      return;
    }

    const existing = await findListEntryByRecord(
      listId,
      attioPerson.id.record_id,
    );

    if (existing) {
      await updateListEntryStage(listId, existing.id.entry_id, stage);
    } else {
      await upsertListEntry({
        listId,
        recordId: attioPerson.id.record_id,
        parentObject: "people",
        stage,
      });
    }
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
