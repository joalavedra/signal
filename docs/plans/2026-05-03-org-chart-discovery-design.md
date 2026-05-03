# Org chart discovery & data linkage

## Context

The `/companies/[id]` org chart shipped yesterday (`feat/company-org-chart`), but two real problems surfaced:

1. **Discoverability** — the only entry point was a hover-only `Network` icon on each row in `companies-list.tsx`. Users couldn't find it.
2. **Empty chart** — opening `/companies/[browserbase-id]` shows "0 people" even though the user's campaign has 19 Browserbase contacts. Root cause: `searchPeople` (`src/lib/tools/enrichment-tools.ts:60-72`) only sets `people.organization_id` when the agent passes a `companyId` (a `campaign_organizations` link). Ad-hoc chat searches like "find people at Browserbase" land rows with `organization_id = null`. The campaign view still shows them (joined via `campaign_people`), but the company page strictly filters on `organization_id` and finds nothing.

These collapse into one fix: stop relying on the org-chart page as the primary entry, and stop letting people enter the system with no org link.

## Design

### 1. Embed the chart inside the campaign view

`src/components/campaign/companies-list.tsx` — when a user expands a company row, render `<OrgChart>` inside the expanded body in place of the current `ContactsTable`. Chart sources data from the already-loaded `contactsByOrgId.get(company.organization_id)` map, mapped into `OrgChartPerson[]`. Uses `outreach_status` already on each `CampaignContact`. Fixed height ~480px so multi-company browsing still feels light.

A small "Open full page →" link on the chart toolbar navigates to `/companies/[organization_id]` for the focused full-screen experience.

The hover-only `Network` icon I added yesterday gets removed — the embedded chart makes it redundant.

### 2. Fix `searchPeople` to always assign `organization_id`

`src/lib/tools/enrichment-tools.ts` — extend `searchPeople`:

- Add a `companyName` input param. When provided (and `companyId` isn't), call `findOrCreateOrganization({ name: companyName })` and use the resulting org's id as `organization_id` for every person stored.
- Update the system prompt (`src/lib/system-prompt.ts`) to remind the agent: when searching for people at a known company, always pass `companyName`.
- When neither `companyId` nor `companyName` is given (genuinely cross-company query), people still land with `organization_id = null` — that's fine.

### 3. One-off backfill route for orphan people

`src/app/api/companies/backfill-orgs/route.ts` (POST, admin-gated):

- Find all `people` rows with `organization_id = null` and a non-empty `enrichment_data`.
- For each, look at `enrichment_data.linkedin.profileInfo.headline` or `searchQuery` for a company-name signal. Use the existing `findOrCreateOrganization` helper to look up by name (case-insensitive). If matched, set `organization_id`.
- Return `{ scanned, linked }`. Log unmatched rows for manual review.

This is a one-off cleanup — the user's 19 Browserbase rows get reattached, and the chart immediately populates.

### 4. Standalone `/companies/[id]` — no changes needed

After #2 + #3, the standalone page just works. Its query (`people.organization_id = X`) finds the rows that are now correctly linked.

### YAGNI'd

- Inline chat link (`tool-call-card.tsx`). The embedded chart in the campaign view is where users naturally land after agent searches — the chat link adds little new value. Add later if missed.
- "Show as table" toggle inside the campaign expanded row. Chart is the view.
- Any new agent tool. The agent doesn't need to "open" the chart; the user navigates.

## Files touched

```
src/components/campaign/companies-list.tsx     (modify — chart replaces table)
src/lib/tools/enrichment-tools.ts              (modify — add companyName, link)
src/lib/system-prompt.ts                       (modify — agent guidance)
src/app/api/companies/backfill-orgs/route.ts   (new — one-off cleanup)
src/components/company/org-chart.tsx           (no change — already campaign-agnostic)
```

## Verification

1. Pull latest, `pnpm dev`.
2. POST `/api/companies/backfill-orgs` once. Confirm response shows 19+ rows linked.
3. Open `/campaigns/<browserbase-campaign-id>`, expand Browserbase row → chart renders inline with 19 cards in department clusters. Status pills show outreach state.
4. Click "Open full page →" → `/companies/[orgId]` shows the same 19 cards in the focused view.
5. Run a fresh chat search ("find more people at Browserbase") — new people land with `organization_id` set. Refresh campaign — chart updates.
6. `pnpm typecheck && pnpm lint` — clean.
