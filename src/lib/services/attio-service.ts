import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { PRICING, trackUsage } from "@/lib/services/cost-tracker";

const ATTIO_BASE = "https://api.attio.com/v2";
const DEFAULT_TIMEOUT_MS = 20_000;

export interface AttioRecordId {
  workspace_id: string;
  object_id: string;
  record_id: string;
}

export interface AttioListEntryId {
  workspace_id: string;
  list_id: string;
  entry_id: string;
}

export interface AttioPerson {
  id: AttioRecordId;
  values: Record<string, unknown>;
}

export interface AttioCompany {
  id: AttioRecordId;
  values: Record<string, unknown>;
}

export interface AttioListEntry {
  id: AttioListEntryId;
  parent_record_id: string;
  parent_object: string;
  entry_values: Record<string, unknown>;
  created_at: string;
}

export type OutreachStage =
  | "discovered"
  | "approved"
  | "in_sequence"
  | "sent"
  | "opened"
  | "replied"
  | "bounced"
  | "completed";

interface AttioErrorBody {
  status_code?: number;
  type?: string;
  code?: string;
  message?: string;
}

function getToken(): string {
  const token = process.env.ATTIO_API_TOKEN;
  if (!token) throw new Error("ATTIO_API_TOKEN not configured");
  return token;
}

async function attioRequest<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
  operation: string,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetchWithTimeout(
    `${ATTIO_BASE}${path}`,
    init,
    DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const errBody: AttioErrorBody = await res.json().catch(() => ({}));
    throw new Error(
      `Attio ${operation} failed (${res.status}): ${errBody.message ?? res.statusText}`,
    );
  }

  trackUsage({
    service: "attio",
    operation,
    estimated_cost_usd: PRICING.attio_request,
  });

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Upsert a Person record in Attio by email address. If a person with this
 * primary email already exists, their values are updated; otherwise created.
 */
export async function upsertPerson(input: {
  name?: string;
  email: string;
  linkedinUrl?: string;
  jobTitle?: string;
  companyDomain?: string;
}): Promise<AttioPerson> {
  const values: Record<string, unknown> = {
    email_addresses: [input.email],
  };
  if (input.name) {
    const [first, ...rest] = input.name.trim().split(/\s+/);
    values.name = [
      {
        first_name: first ?? input.name,
        last_name: rest.join(" "),
        full_name: input.name,
      },
    ];
  }
  if (input.linkedinUrl) values.linkedin = input.linkedinUrl;
  if (input.jobTitle) values.job_title = input.jobTitle;

  const data = await attioRequest<{ data: AttioPerson }>(
    "PUT",
    `/objects/people/records?matching_attribute=email_addresses`,
    { data: { values } },
    "upsert_person",
  );
  return data.data;
}

/**
 * Upsert a Company by domain. If a company with this primary domain exists,
 * update it; otherwise create it.
 */
export async function upsertCompany(input: {
  name: string;
  domain: string;
  description?: string;
}): Promise<AttioCompany> {
  const values: Record<string, unknown> = {
    domains: [input.domain],
    name: input.name,
  };
  if (input.description) values.description = input.description;

  const data = await attioRequest<{ data: AttioCompany }>(
    "PUT",
    `/objects/companies/records?matching_attribute=domains`,
    { data: { values } },
    "upsert_company",
  );
  return data.data;
}

/**
 * Look up a Company by domain. Returns null if no match.
 * Used for prospect dedup: warn before adding a company to a Signal campaign
 * if they're already a Customer in Attio.
 */
export async function findCompanyByDomain(
  domain: string,
): Promise<AttioCompany | null> {
  const data = await attioRequest<{ data: AttioCompany[] }>(
    "POST",
    `/objects/companies/records/query`,
    {
      filter: { domains: { domain } },
      limit: 1,
    },
    "find_company",
  );
  return data.data[0] ?? null;
}

/**
 * Resolve a list's UUID from its api_slug. Cached per-process.
 */
const listIdCache = new Map<string, string>();

export async function getListIdBySlug(apiSlug: string): Promise<string | null> {
  const cached = listIdCache.get(apiSlug);
  if (cached) return cached;

  const data = await attioRequest<{
    data: { id: { list_id: string }; api_slug: string }[];
  }>("GET", `/lists`, undefined, "list_lists");

  const match = data.data.find((l) => l.api_slug === apiSlug);
  if (!match) return null;
  listIdCache.set(apiSlug, match.id.list_id);
  return match.id.list_id;
}

/**
 * Idempotent upsert of a list entry, matched by parent_record_id.
 * Same parent + same list = same entry. Subsequent calls patch entry_values.
 *
 * Attio's `PUT /lists/{id}/entries?matching_attribute=parent_record_id` is
 * the assert endpoint — no separate find/create/update dance needed.
 */
export async function upsertListEntry(input: {
  listId: string;
  recordId: string;
  parentObject: "people" | "companies";
  stageAttr: string;
  stageValue: string;
  extraValues?: Record<string, unknown>;
}): Promise<AttioListEntry> {
  const data = await attioRequest<{ data: AttioListEntry }>(
    "PUT",
    `/lists/${input.listId}/entries?matching_attribute=parent_record_id`,
    {
      data: {
        parent_record_id: input.recordId,
        parent_object: input.parentObject,
        entry_values: {
          [input.stageAttr]: input.stageValue,
          ...(input.extraValues ?? {}),
        },
      },
    },
    "upsert_list_entry",
  );
  return data.data;
}
