# Quay 1 Boarding Tool - Master Spec (single source of truth)

> Every build agent reads this file first and builds to these contracts. Do NOT invent
> field names, sheet columns, or endpoint shapes that aren't here - if something is
> missing, add it to this file (don't diverge silently).

## 0. What this repo is

A single repo that unifies **staff onboarding**, **account provisioning**, and
**offboarding** for two entities:

- **Quay 1** broker onboarding (was: `quay-hubspot` frontend + Apps Script `1apqpQ…`)
- **Aqua Promotions** contractor onboarding (was: `quay-dashboard-v2` Staff>Contracts + Apps Script `16tzth…`)

Decision (user, 2026-07-28): **FULL CONSOLIDATION** - both contract pipelines are rebuilt
inside this repo as one codebase. Stack: **Apps Script + static frontend** core, plus a
**Python + Playwright worker** for browser-only portals. Offboarding fires **automatically
after a 30-minute delay, no cancel window**.

## 1. Architecture

```
web/  (static frontend, GitHub Pages)
  └── one UI: Onboard request · Provisioning status · Offboard request
        │  POST (text/plain, no-preflight)  + Supabase JWT auth
        ▼
apps-script/  (ONE consolidated Apps Script web app - the core)
  ├── Router (doGet/doPost)                → dispatch by {kind}
  ├── Onboarding
  │     ├── Quay 1 contract gen  (2026 v2.1G Sale/Rental templates)
  │     └── Aqua MOA gen         (monthly/fixed/permanent selector)
  ├── FICA intake  (self-service form + upload → tracker ticks)
  ├── Induction booking + progress report + Tue digest   (Quay 1 only)
  ├── Provisioning
  │     ├── Google Workspace  (AdminDirectory advanced service - TO BUILD; no prior impl exists)
  │     ├── PropData REST API  (feeds-api.propdata.net - needs api_key+vendor id)
  │     └── QUEUE writer  → drops rows on "Provisioning Queue" tab for the worker
  └── Offboarding
        ├── request handler  → writes "Offboarding Queue" row, schedules +30min trigger
        └── fireOffboarding_()  → Google suspend + groups + HubSpot seat + Drive revoke,
                                   and drops browser-portal teardown rows on the queue
        │  reads/writes queue tabs (Google Sheet)
        ▼
worker/  (Python + Playwright, runs on the Mac like virtual-agent-lookup)
  ├── poll.py            → reads Provisioning/Offboarding Queue tabs (Sheets API)
  └── provisioners/
        ├── property24.py → create/deactivate agent (no API; browser)
        ├── cma.py        → create/deactivate (cmainfo.co.za; OTP-gated - see cma-lookup)
        └── dialfire.py   → create/deactivate agent seat (browser)
```

**Why the split:** Apps Script cannot drive a browser. Google + PropData are API-based →
they live in Apps Script. Property24 / CMA / Dialfire have no usable API → Apps Script
enqueues a job, the Python worker executes it and writes status back. One Google Sheet is
the shared bus between the two halves.

## 2. Auth (unchanged from existing apps)

- Writes are **Supabase JWT only** (the browser holds the logged-in user's JWT).
  Backend verifies against Supabase `/auth/v1/user` then reads the `staff` row for role.
- Roles: `is_super`, `is_admin`, `is_broker`. Onboarding actions allow
  `is_super || is_admin || is_broker` (a broker submits only for their own hire;
  `requester_email` is force-set from the JWT server-side, matching quay-hubspot).
  Offboarding and provisioning require `is_super || is_admin`; retry requires `is_super`.
  Brokers see only their own requested candidates (requester_email) and have no Offboard tab.
- POSTs use `Content-Type: text/plain` to dodge CORS preflight (existing pattern).
- Supabase project: `dqszbqiimbfvmmnpgpsb` ("quay-clock", PRODUCTION). `staff` table has a
  `staff_admin_write_guard_tg` trigger - never auto-toggle is_super/is_admin.

## 3. Data model - Google Sheet tabs (the shared bus)

One tracker Sheet holds all tabs. (Consolidation may keep the two existing trackers or
create one new - architect decides; default: NEW single tracker, migrate later.)

### 3.1 `Onboarding` tab (merged Quay1 + Aqua)
Keyed on folderId (hidden). Columns (superset of both existing trackers):
`entity`(quay1|aqua), name, id_number, email, contact, start_date, senior_name,
senior_email, requester_name, requester_email, designation, team, division,
agreement_type(monthly|fixed|permanent - aqua), work_hours, remuneration(aqua),
commission(quay1), programs(JSON), FICA ticks (R - V per-doc), induction_wed, induction_thu,
status, folderId(hidden key).

### 3.2 `Provisioning Queue` tab  (Apps Script → worker)
One row per (person × system). The worker polls this.
| col | field | notes |
|-----|-------|-------|
| A | queue_id | unique, apps-script generated |
| B | folderId | links back to Onboarding row |
| C | full_name | |
| D | first_name | |
| E | id_number | |
| F | quay_email | provisioned Google address |
| G | cell | |
| H | system | `google`\|`propdata`\|`property24`\|`cma`\|`dialfire` |
| I | action | `create`\|`deactivate` |
| J | payload_json | system-specific extra fields |
| K | status | `pending`\|`in_progress`\|`done`\|`error`\|`skipped` |
| L | result_json | worker writes: account id/username, or error text |
| M | attempts | int, worker increments |
| N | updated_at | ISO |

- Apps Script writes rows with status=`pending` for google/propdata (it does those itself
  and flips them done inline) OR for the browser systems (worker does them).
  **Decision:** google + propdata are executed INLINE by Apps Script and written as
  `done`/`error` for audit; property24/cma/dialfire are written `pending` for the worker.
- Worker claims a row by CAS: only act if status still `pending`, set `in_progress` first.

### 3.3 `Offboarding Queue` tab  (Apps Script → worker + self)
| col | field | notes |
|-----|-------|-------|
| A | offb_id | unique |
| B | full_name | |
| C | quay_email | |
| D | requested_by | requester email |
| E | requested_at | ISO |
| F | fire_at | requested_at + 30min |
| G | systems_json | list to tear down (default: all) |
| H | status | `scheduled`\|`firing`\|`done`\|`error` |
| I | google_result | |
| J | worker_result_json | browser-portal teardown results |
| K | trigger_id | Apps Script time-trigger handle |

**Offboarding lifecycle:** request → write row status=`scheduled`, fire_at=+30min, create a
one-shot `ScriptApp.newTrigger('fireOffboarding_').timeBased().after(30*60*1000)`. When it
fires: set `firing`, suspend Google + remove group memberships + revoke Drive shares +
release HubSpot seat (all in Apps Script), then enqueue property24/cma/dialfire
`deactivate` rows on the Provisioning Queue for the worker. No cancel window (user choice).
Idempotent: re-firing a `done` row is a no-op.

## 4. External systems - provisioning contracts

| System | API? | Home | Create | Deactivate |
|--------|------|------|--------|------------|
| Google Workspace | yes (AdminDirectory advanced service - NOT yet implemented anywhere; build fresh) | Apps Script | `AdminDirectory.Users.insert` name@quay1.co.za (fallback name.surname@), pass `G{First}@002`, changePasswordAtNextLogin=true; then `AdminDirectory.Members.insert` per group | `AdminDirectory.Users.update {suspended:true}`, remove group memberships, transfer/revoke Drive |
| PropData | yes (REST) | Apps Script | POST agent (feeds-api.propdata.net) - needs `api_key`+`vendor id` headers (BLOCKED on creds) | deactivate/remove agent |
| Property24 | no | Worker | browser: admin → add agent (auto-links via Google login too) | browser: deactivate agent |
| CMA (cmainfo.co.za) | no | Worker | browser: create user - OTP/2FA gated (see cma-lookup, parked) | browser: disable user |
| Dialfire | no (for user mgmt) | Worker | browser: add agent seat | browser: remove seat |

- Google account is the **linchpin**: created first; P24 auto-links when the broker later
  logs into Property24 with the Quay1 gmail (still also create explicitly for the profile).
- PropData `api_key`/vendor-id: provisioned by emailing api-support@propdata.net. Until then
  the propdata provisioner runs in **dry-run** (logs the payload it WOULD send).
- Passwords: temp password in the induction email packet only (email, never WhatsApp).

## 5. Frontend (web/) - built with the `ui-ux-pro-max` skill

Single page, three sections behind the JWT gate, Quay 1 brand
(#3D5BA6 navy / #FDC503 yellow / #98C5ED / #D20A03; Montserrat). Aqua surfaces use the
Aqua gold theme (#F4B400 / #3A2D00 / #8A6D0B). No dark mode (user pref). No em/en dashes.

1. **Onboard** - entity toggle (Quay 1 / Aqua) → contract request form (fields per §3.1),
   provisioning checkboxes (which systems to create), submit → generates contract + enqueues
   provisioning.
2. **Provisioning status** - live table from the queue tabs (per-system pill:
   pending/in progress/done/error), retry button (super only).
3. **Offboard** - pick person, confirm, submit → shows "will fire at HH:MM (in 30 min)".

Accessibility: WCAG AA contrast, keyboard nav, dark text on yellow (never white-on-yellow).

## 6. Non-negotiables (from user memory)

- **Never auto-send general emails** - the recruitment/onboarding pipeline is the ONLY
  scoped exception (contract/induction/digest auto-send OK). Offboarding notifications:
  DRAFT unless explicitly told to send.
- **No em/en dashes** anywhere.
- **No dark mode.**
- Destructive ops (offboarding suspends real accounts) - build + dry-run only in this repo;
  live arming is user-gated. Every provisioner supports `DRY_RUN=1`.
- Secrets (tokens, api keys) live in Script Properties / gitignored config / keychain -   NEVER in committed source.
- Files under 500 lines; split modules.

## 7. Build order / ownership

1. researcher → pull live Quay `1apqpQ…` source via clasp, confirm Aqua `16tzth…` shape,
   confirm sheet schemas. Fills any gaps in this SPEC.
2. architect → finalize repo layout + module boundaries + the two queue-tab contracts.
3. backend (apps-script) → consolidated Code.js (router, both contract flows, FICA,
   induction, Google+PropData provisioning, queue writer, offboarding + 30min trigger).
4. worker (python) → poll.py + property24/cma/dialfire provisioners (create+deactivate),
   all with DRY_RUN default on.
5. ui (ui-ux-pro-max skill) → web/ single page per §5.
6. tester → node --check on Code.js, python -m py_compile, offline dry-run harnesses.
7. reviewer → /code-review pass; report findings.

## 8. Known blockers to surface, not silently skip

- clasp login may be stale → pulling the live Quay backend needs `clasp login` (pagan@).
- PropData creds not yet provisioned → propdata provisioner dry-run only.
- CMA OTP/2FA → cma provisioner is a stub with a TODO + clean interface, not a fake success.
- Dialfire user-management portal path unconfirmed → dialfire provisioner scaffolded, marked
  NEEDS-PORTAL-MAP.
- HubSpot seat auto-create/release has licensing cost → gate behind a config flag, default off.

## 9. Aqua admin check + per-document FICA decline (added 2026-09-08)

Extends the shared onboarding path so Aqua Promotions contractors run the SAME flow as Quay 1,
with only two deliberate differences (the FICA field set, and the acceptance notification). Built
non-destructively: the existing Quay 1 path is unchanged; both entities share one implementation
parameterised by entity. Ships inert - the only NEW email (the Aqua acceptance notice) drafts in
DRY_RUN and sends only once armed.

### 9.1 New Onboarding columns (appended after the folderId key, no existing column shifts)
- `fica_declines_json` (57): structured decline record set by `declineFica_`. Shape:
  `{ docs: { id?|poa?|bank?: { reason, by, at } }, contract_incorrect?: { reason, by, at } }`.
  The reason lives against each document, not just the candidate. `general` may appear under
  `docs` for a legacy single-reason decline (back-compat).
- `declined_at` (58), `declined_by` (59): durable last-decline audit markers (parity with
  approved_at/approved_by).
- `aqua_accept_notified_at` (60): idempotency marker for the Aqua acceptance notice. In DRY_RUN it
  is deliberately NOT stamped (draft-only), so the real send fires once armed.

All four clear on the candidate's next FICA re-upload (`ficaUpload_`), so a re-submission returns
the row to a clean awaiting-acceptance state.

### 9.2 `decline_fica` wire (Router `_declineDispatch_` -> `declineFica_`)
Admin-only. New request body (legacy `{ reason }` still accepted as one general decline):
```
{ kind:"decline_fica", folderId, declines:{ id?:reason, poa?:reason, bank?:reason },
  contract_incorrect: reason|"" }
```
At least one declined document OR a contract_incorrect reason is required, else
`{ ok:false, error:"select at least one document to decline or tick Contract incorrect" }`.
Declinable FICA documents are `id`, `poa`, `bank` only (labels in `CFG.FICA_DECLINE_LABELS`). The
signed contract is NOT a declinable FICA document - it is handled solely by the `contract_incorrect`
control, so a document is only ever flagged in one place. Status is set to `FICA declined`; FICA
ticks are left intact (a fresh upload re-ticks and clears the decline record).

### 9.3 Decline email (candidate-facing, auto-sends as today)
`ficaDeclineHtml_(company, first, record, ficaUrl)` renders, in order and only when present: a
"FICA documents to re-submit" section listing each declined document with its own reason, then a
"Your contract" section (only if contract_incorrect) telling them to re-submit the contract with the
reason. Nothing that passed review is mentioned. Send semantics unchanged from the old decline
(candidate-facing auto-send; only internal CC is gated by CC_ENABLED).

### 9.4 Aqua acceptance notice (NEW, previewable-until-armed)
On admin "Accept & set up" of an `entity === 'aqua'` row, `_maybeNotifyAquaAccepted_` emails
`CFG.AQUA_ACCEPT_NOTIFY` (alan@quay1.co.za, kat@quay1.co.za) that the contractor is accepted and can
join Aqua, with name + start details (`aquaAcceptedHtml_`). This email is the GO-AHEAD gate: it states
"You may now begin onboarding this contractor" and that no contractor may be onboarded until this
acceptance email is received for them. Same draft/send gating as the manual account-requests:
DRAFT in DRY_RUN (no stamp, previewable), send + stamp `aqua_accept_notified_at` once armed. No-op
for quay1. Fires from BOTH accept transition points (interactive `approveAndProvision_` and the
scheduled `provisionReadyBatch_`).

### 9.5 Aqua FICA form (`ficaForm_` / `ficaUpload_`)
The Aqua form is the Quay 1 form minus question 7 "Professional status" (the FFC status radio, FFC
number, and the headshot photo that shares that card); "Next of kin" renumbers from 8 to 7 with no
gap. Server-side, `ficaUpload_` skips FFC validation for `entity === 'aqua'` so an Aqua candidate can
submit with no FFC status. Quay 1 form + validation are byte-identical to before.

### 9.6 Admin Check tab (web/app.admincheck.js)
Two top buttons, "Quay 1 Admin Checks" / "Aqua Admin Checks", filter the one queue by entity
(default Quay 1); the screen is functionally identical for both. Decline is an inline panel with a
per-document decline control (ID / Proof of address / Bank), each revealing its own reason box, plus
a separate "Contract incorrect" checkbox with its own reason box. A declined row shows
"Declined - awaiting re-submission" and an inline "What was declined" block listing, per declined
document and the contract, the reason recorded and who declined it and when (from the `declined` /
`declines` fields now carried on the `status` snapshot). The answer to a question about a candidate
is on the screen without opening anything else.

### 9.7 Aqua contract stage captures HR data
`onboardAqua_` captures and now VALIDATES the five HR fields at the contract stage: full name, ID
number, cell (`contact`), personal email, start date (cell + start date are the newly enforced
required checks). It already calls `hrTrackingUpsert_` (Hr.js) at that stage, which writes those into
the HR "New Starters (Tracking)" tab. HR writes are gated by `HR_SYNC_ENABLED` (a Script Property,
independent of `DRY_RUN`, default OFF); when off, the write is a PREVIEW - `hrTrackingUpsert_` returns
`{ dryRun:true, tab, would, fields:{name,id_number,contact,email,start_date}, row }` and logs the same,
so the exact HR write is reviewable before HR sync is armed.

### 9.8 Aqua provisioning scope (Google + Dialfire only)
`CFG.CORE_SYSTEMS.aqua = ['google','dialfire']` and a new hard per-entity cap
`CFG.ENTITY_SYSTEMS_ALLOW = { aqua:['google','dialfire'] }`, enforced in `resolveSystems_` AFTER
core/program/team/explicit resolution - so no explicit tick, team mapping, or program can ever put
PropData/PDMS or CMA on an Aqua hire (dropped systems are logged as `entity_scope_filtered`). quay1 is
uncapped and unchanged. Dialfire is request-only for Aqua: `provisionAll_` does NOT enqueue a Dialfire
worker job for an aqua person (it would only error), and `_maybeRequestDialfire_` emails
`DIALFIRE_APPROVERS` (alan@quay1.co.za) with the contractor's name/team on accept (DRY_RUN drafts,
sends once armed). So an accepted Aqua contractor triggers two Alan emails, both previewable-until-armed:
the acceptance notice (SPEC 9.4) and the Dialfire request.

### 9.9 Aqua Google-only welcome pack
Aqua has no induction step, so at the moment of real (non-dry-run) provisioning an Aqua contractor
gets `_sendAquaWelcome_` instead of the "pick your induction week" invite. It reads the Google
credential (`_credentialFor_`) and sends `aquaWelcomeHtml_` - the same welcome-pack format as Quay 1
but containing ONLY the Google Workspace email + temporary password + how to switch on 2FA. Nothing
about PropData or CMA appears. quay1 still gets the induction invite. Both provisioning paths
(interactive `approveAndProvision_` and scheduled `provisionReadyBatch_`) branch on entity.
