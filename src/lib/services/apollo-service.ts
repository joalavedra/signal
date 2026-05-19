import { PRICING, trackUsage } from "@/lib/services/cost-tracker";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

const APOLLO_BASE = "https://api.apollo.io/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ApolloPerson {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  title?: string | null;
  linkedin_url?: string | null;
  email?: string | null;
  email_status?: string | null;
  organization?: {
    id?: string;
    name?: string | null;
    website_url?: string | null;
    primary_domain?: string | null;
  } | null;
  city?: string | null;
  country?: string | null;
  headline?: string | null;
  photo_url?: string | null;
}

export interface ApolloContact extends ApolloPerson {
  contact_id?: string;
}

export interface ApolloSequence {
  id: string;
  name: string;
  active: boolean;
  archived: boolean;
  num_steps?: number;
  last_used_at?: string | null;
}

export interface ApolloEmailAccount {
  id: string;
  email: string;
  user_id?: string;
}

export interface ApolloSearchParams {
  q_keywords?: string;
  person_titles?: string[];
  person_seniorities?: string[];
  organization_domains?: string[];
  organization_locations?: string[];
  page?: number;
  per_page?: number;
}

export interface AddToSequenceOptions {
  emailAccountId: string;
  status?: "active" | "paused";
  sendEmailFromUserId?: string;
  sequenceNoEmail?: boolean;
  sequenceUnverifiedEmail?: boolean;
}

interface ApolloErrorBody {
  error?: string;
  error_code?: string;
  message?: string;
}

function getApiKey(): string {
  const key = process.env.APOLLO_API_KEY;
  if (!key) throw new Error("APOLLO_API_KEY not configured");
  return key;
}

async function apolloPost<T>(
  path: string,
  body: Record<string, unknown>,
  operation: string,
  costUsd: number,
): Promise<T> {
  const res = await fetchWithTimeout(
    `${APOLLO_BASE}${path}`,
    {
      method: "POST",
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "X-Api-Key": getApiKey(),
      },
      body: JSON.stringify(body),
    },
    DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const errBody: ApolloErrorBody = await res.json().catch(() => ({}));
    throw new Error(
      `Apollo ${operation} failed (${res.status}): ${errBody.error ?? errBody.message ?? res.statusText}`,
    );
  }

  trackUsage({
    service: "apollo",
    operation,
    estimated_cost_usd: costUsd,
  });

  return (await res.json()) as T;
}

/**
 * Search for people in Apollo's database. Replaces Exa for verified-contact
 * discovery. Returns enriched profiles when matches exist.
 */
export async function searchPeople(
  params: ApolloSearchParams,
): Promise<{ people: ApolloPerson[]; total: number }> {
  const body: Record<string, unknown> = {
    page: params.page ?? 1,
    per_page: params.per_page ?? 25,
  };
  if (params.q_keywords) body.q_keywords = params.q_keywords;
  if (params.person_titles?.length) body.person_titles = params.person_titles;
  if (params.person_seniorities?.length)
    body.person_seniorities = params.person_seniorities;
  if (params.organization_domains?.length)
    body.organization_domains = params.organization_domains;
  if (params.organization_locations?.length)
    body.organization_locations = params.organization_locations;

  const data = await apolloPost<{
    people?: ApolloPerson[];
    pagination?: { total_entries?: number };
  }>("/mixed_people/api_search", body, "search_people", PRICING.apollo_search);

  return {
    people: data.people ?? [],
    total: data.pagination?.total_entries ?? 0,
  };
}

/**
 * Enrich a single person. Apollo charges 1 credit per successful match.
 * Pass any combination of identifiers; LinkedIn URL gives the highest hit rate.
 */
export async function enrichPerson(input: {
  linkedinUrl?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  organizationDomain?: string;
  revealPersonalEmails?: boolean;
  revealPhoneNumber?: boolean;
}): Promise<ApolloPerson | null> {
  const body: Record<string, unknown> = {};
  if (input.linkedinUrl) body.linkedin_url = input.linkedinUrl;
  if (input.email) body.email = input.email;
  if (input.firstName) body.first_name = input.firstName;
  if (input.lastName) body.last_name = input.lastName;
  if (input.organizationDomain) body.domain = input.organizationDomain;
  if (input.revealPersonalEmails) body.reveal_personal_emails = true;
  if (input.revealPhoneNumber) body.reveal_phone_number = true;

  const data = await apolloPost<{ person?: ApolloPerson }>(
    "/people/match",
    body,
    "enrich_person",
    PRICING.apollo_enrichment,
  );
  return data.person ?? null;
}

/**
 * Convert an Apollo Person (database record) into an Apollo Contact
 * (your team's CRM record). Required before sequence enrollment.
 */
export async function createContact(input: {
  firstName?: string;
  lastName?: string;
  organizationName?: string;
  title?: string;
  email?: string;
  linkedinUrl?: string;
  websiteUrl?: string;
}): Promise<ApolloContact> {
  const body: Record<string, unknown> = {};
  if (input.firstName) body.first_name = input.firstName;
  if (input.lastName) body.last_name = input.lastName;
  if (input.organizationName) body.organization_name = input.organizationName;
  if (input.title) body.title = input.title;
  if (input.email) body.email = input.email;
  if (input.linkedinUrl) body.linkedin_url = input.linkedinUrl;
  if (input.websiteUrl) body.website_url = input.websiteUrl;

  const data = await apolloPost<{ contact: ApolloContact }>(
    "/contacts",
    body,
    "create_contact",
    0,
  );
  return data.contact;
}

/**
 * Look up an existing Apollo contact by email. Returns null if no match.
 */
export async function findContactByEmail(
  email: string,
): Promise<ApolloContact | null> {
  const data = await apolloPost<{ contacts?: ApolloContact[] }>(
    "/contacts/search",
    { q_keywords: email, per_page: 1 },
    "find_contact",
    0,
  );
  return data.contacts?.[0] ?? null;
}

/**
 * List the team's sequences (Apollo calls these "emailer_campaigns").
 */
export async function listSequences(
  opts: { onlyActive?: boolean; perPage?: number } = {},
): Promise<ApolloSequence[]> {
  const data = await apolloPost<{ emailer_campaigns?: ApolloSequence[] }>(
    "/emailer_campaigns/search",
    { per_page: opts.perPage ?? 50 },
    "list_sequences",
    0,
  );
  const seqs = data.emailer_campaigns ?? [];
  return opts.onlyActive
    ? seqs.filter((s) => s.active && !s.archived)
    : seqs.filter((s) => !s.archived);
}

/**
 * Add contacts to an existing sequence. Returns the IDs that were enrolled.
 *
 * Requires the user's connected email account ID — fetch with
 * `getEmailAccounts()`. The first one is usually the default sending mailbox.
 */
export async function addContactsToSequence(
  sequenceId: string,
  contactIds: string[],
  opts: AddToSequenceOptions,
): Promise<{ added: string[]; failed: { id: string; reason: string }[] }> {
  if (contactIds.length === 0) return { added: [], failed: [] };

  const body: Record<string, unknown> = {
    emailer_campaign_id: sequenceId,
    contact_ids: contactIds,
    send_email_from_email_account_id: opts.emailAccountId,
    status: opts.status ?? "active",
  };
  if (opts.sendEmailFromUserId)
    body.send_email_from_user_id = opts.sendEmailFromUserId;
  if (opts.sequenceNoEmail) body.sequence_no_email = true;
  if (opts.sequenceUnverifiedEmail) body.sequence_unverified_email = true;

  const data = await apolloPost<{
    contacts?: { id: string }[];
    num_contacts_added?: number;
    errors?: Record<string, string>;
  }>(
    `/emailer_campaigns/${sequenceId}/add_contact_ids`,
    body,
    "add_to_sequence",
    PRICING.apollo_sequence_enroll,
  );

  const added = (data.contacts ?? []).map((c) => c.id);
  const failed = Object.entries(data.errors ?? {}).map(([id, reason]) => ({
    id,
    reason,
  }));
  return { added, failed };
}

/**
 * List the email accounts (mailboxes) the team has connected. Required to
 * pick which mailbox sends a sequence on behalf of the user.
 */
export async function getEmailAccounts(): Promise<ApolloEmailAccount[]> {
  const data = await apolloPost<{ email_accounts?: ApolloEmailAccount[] }>(
    "/email_accounts/search",
    {},
    "list_email_accounts",
    0,
  );
  return data.email_accounts ?? [];
}
