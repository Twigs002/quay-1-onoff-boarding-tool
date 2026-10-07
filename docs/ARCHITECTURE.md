# Architecture - Quay 1 Boarding Tool

> Finalized module boundaries and repo layout. Build agents fill in the stub files named
> here without colliding. Read `docs/SPEC.md` (the master spec) and `docs/CONTRACTS.md` (the
> frozen queue schemas) first. Where this doc and SPEC disagree, SPEC wins for behaviour and
> CONTRACTS wins for the wire format.

## 1. Three halves, one shared bus

```
web/ (static, GitHub Pages)  ──POST text/plain + Supabase JWT──▶  apps-script/ (web app)
                                                                        │
                                                            reads/writes │ Google Sheet
                                                                        ▼
                                              Provisioning Queue + Offboarding Queue tabs
                                                                        ▲
                                              worker/ (Python + Playwright, Mac host) ──┘
```

- **apps-script/** is the core: HTTP router, auth, both contract flows, FICA, induction,
  Google + PropData provisioning (inline), the queue writer, and offboarding with its
  30-minute one-shot trigger.
- **worker/** is a polling executor for the three browser-only portals (Property24, CMA,
  Dialfire). It never talks to the frontend; it only reads/writes the Provisioning Queue tab.
- **web/** is one static page with three sections behind a JWT gate.

The Sheet is the only shared state. Neither half calls the other directly.

## 2. Repo layout

```
quay-1-onoff-boarding-tool/
├── README.md                 arm/deploy steps (user-gated), DRY_RUN note
├── .gitignore                node_modules, web/config.js, worker/.env, __pycache__, .clasp.json
├── docs/
│   ├── SPEC.md               master spec (single source of truth for behaviour)
│   ├── CONTRACTS.md          frozen queue schemas + CAS + offboarding state machine
│   ├── ARCHITECTURE.md       this file
│   └── RESEARCH.md           researcher output (live backend shapes) - may refine SPEC
├── apps-script/              ONE clasp project (the consolidated web app)
│   ├── appsscript.json       manifest (V8, timezone, AdminDirectory advanced service)
│   ├── Config.js             constants, Script Properties accessors, feature flags
│   ├── Util.js               shared helpers: JSON responses, ids, ISO dates, sheet access
│   ├── Auth.js               Supabase JWT verify + staff-row role lookup
│   ├── Router.js             doGet/doPost, parse text/plain body, dispatch by {kind}
│   ├── Queue.js              read/write/CAS helpers for both queue tabs (imports CONTRACTS)
│   ├── Onboarding_Quay1.js   Quay 1 contract gen (Sale/Rental 2026 v2.1G), folder + row write
│   ├── Onboarding_Aqua.js    Aqua MOA gen (monthly | fixed | permanent selector)
│   ├── Fica.js               FICA intake form + upload handler → tracker ticks (R..V)
│   ├── Induction.js          induction booking + progress report + Tuesday digest (Quay1)
│   ├── Provisioning.js       Google (AdminDirectory) + PropData REST inline; enqueue browser
│   └── Offboarding.js        request handler + fireOffboarding_() 30-min trigger lifecycle
├── worker/
│   ├── requirements.txt      playwright, google-api-python-client, google-auth, python-dotenv
│   ├── .env.example          SHEET_ID, SA_CREDS_PATH, DRY_RUN=1, portal logins (copy to .env)
│   ├── config.py             env loading, DRY_RUN default ON, sheet id, credentials path
│   ├── log_setup.py          shared logging config for the poller + provisioners
│   ├── sheets.py             Sheets API client: read queue, CAS-claim, write result
│   ├── poll.py               main loop: claim WORKER_SYSTEMS rows, dispatch, write back
│   └── provisioners/
│       ├── base.py           Provisioner ABC: create(row), deactivate(row), Skip exception
│       ├── browser.py        shared Playwright launch/context helper (headless, DRY_RUN aware)
│       ├── property24.py     browser create/deactivate agent
│       ├── cma.py            stub: OTP-gated, returns Skip with TODO (see cma-lookup)
│       └── dialfire.py       scaffold create/deactivate seat, marked NEEDS-PORTAL-MAP
├── web/
│   ├── index.html            single page, three sections (onboard/status/offboard)
│   ├── styles.css            Quay 1 + Aqua themes, no dark mode, WCAG AA
│   ├── auth.js               JWT gate, form build, POST to Apps Script, status polling
│   ├── assets/               logo + favicon
│   └── config.example.js     LIFECYCLE_ENDPOINT, SUPABASE_URL, SUPABASE_ANON_KEY (copy to config.js)
├── scripts/                  clasp pull/deploy helpers (tester/devops fill; user runs them)
├── tests/                    node --check, py_compile, offline dry-run harnesses (tester)
└── .github/                  CI: syntax checks only, no deploy
```

## 3. apps-script/ module boundaries

Each file < 500 lines. Apps Script has a flat global namespace: every top-level function is
callable from any file, so boundaries are by convention. Rule: a module only calls DOWN the
list (Router → flow modules → Queue/Provisioning → Util/Config), never sideways into another
flow module's internals.

| Module | Owns | Key public functions |
|--------|------|----------------------|
| `Config.js`  | all constants + secrets access | `CFG` object; `prop_(key)`, `sheet_()`, `flag_(name)`, `DRY_RUN_()` |
| `Util.js`    | pure helpers | `jsonOut_(obj)`, `uid_(prefix)`, `nowIso_()`, `firstName_(full)`, `logAudit_(...)` |
| `Auth.js`    | identity (verbatim Aqua `_verifyCaller_`) | `verifyCaller_(accessToken) -> {email,isSuper,isAdmin}\|null` (JWT in body as `accessToken`, staff keyed on `auth_user_id`, null if inactive), `authContext_(body)`, `requireAdmin_(ctx)` |
| `Router.js`  | HTTP surface | `doGet(e)`, `doPost(e)`, `parseBody_(e)`, `dispatch_(kind, body, ctx)` |
| `Queue.js`   | the shared bus | `enqueueProvision_(row)`, `enqueueDeactivate_(email,system,payload)`, `readQueue_(tab)`, `writeQueueStatus_(...)`, header constants mirroring CONTRACTS |
| `Onboarding_Quay1.js` | Quay1 contract + folder | `onboardQuay1_(body, ctx)`, `genQuay1Contract_(data)` |
| `Onboarding_Aqua.js`  | Aqua MOA | `onboardAqua_(body, ctx)`, `genAquaMoa_(data, agreementType)` |
| `Fica.js`    | FICA intake | `ficaForm_(e)` (doGet render), `ficaUpload_(body, ctx)`, `tickFica_(folderId, doc)` |
| `Induction.js` | Quay1 induction | `bookInduction_(body,ctx)`, `progressReport_(folderId)`, `tuesdayDigest_()` (trigger) |
| `Provisioning.js` | inline provisioners + enqueue | `provisionAll_(folderId, systems)`, `googleCreate_(p)`, `googleSuspend_(email)`, `propdataCreate_(p)` (dry-run until creds), `enqueueBrowserSystems_(...)` |
| `Offboarding.js` | offboard lifecycle | `offboardRequest_(body,ctx)`, `fireOffboarding_()` (trigger target), `hubspotReleaseSeat_(email)` (flag-gated) |

Dispatch table (Router `dispatch_`): `kind` values →
`onboard_quay1`, `onboard_aqua`, `fica_upload` (alias `candidate_upload`), `book_induction`,
`provision`, `offboard`, `status` (read queues for the UI), `retry` (super flips an error row
back to pending). The JWT travels in the body as `accessToken` (docs/CONTRACTS.md section 7),
not `token`. `fica_upload` and `book_induction` are token-less (folderId-gated). Extended kinds
ported from the source apps but outside the SPEC section 5 UI are reserved, not built for v1:
Quay1 `progress`/`set_programs`/`mark_hired`/`hired`, Aqua `list`/`mark_signed`/`mark_fica`/
`hr_add`/`digest_draft` (see docs/RESEARCH.md 1.1 + 2.2).

## 4. worker/ module boundaries

- `config.py` - loads `.env`; exposes `DRY_RUN` (default True), `SHEET_ID`, `SA_CREDS_PATH`,
  `MAX_ATTEMPTS` (3), `POLL_SECONDS`. Never contains secrets literally.
- `sheets.py` - thin Sheets API v4 wrapper. `read_rows(tab)`, `claim(tab, row_ix, attempts)`
  (the CAS write of `in_progress`), `write_result(tab, row_ix, status, result)`. Imports the
  column map from a small constants block that mirrors `docs/CONTRACTS.md` section 1.
- `poll.py` - the loop. For each Provisioning Queue row with `system in WORKER_SYSTEMS` and
  `status == pending`: claim (CAS), re-read, dispatch to the matching provisioner, write back
  `done`/`error`/`skipped`. Honors `DRY_RUN`.
- `provisioners/base.py` - `class Provisioner(ABC)` with `create(self, row) -> dict` and
  `deactivate(self, row) -> dict`; a `Skip(Exception)` with `.reason` for portal-blocked
  cases; a `run(action, row)` shim. All concrete provisioners subclass this so `poll.py`
  dispatches uniformly.
- `provisioners/property24.py`, `cma.py`, `dialfire.py` - one class each. Under `DRY_RUN`
  they log the intended action and return `{"dry_run": True, "would": ...}` without launching
  a browser. `cma.py` raises `Skip("OTP/2FA gated")`. `dialfire.py` carries a NEEDS-PORTAL-MAP
  banner and a TODO for the confirmed selector path.

## 5. Config, secrets, flags

- Apps Script secrets live in **Script Properties** (Supabase URL/anon+service key, HubSpot
  token, PropData api_key/vendor-id, sheet ids). Accessed only through `Config.js`.
- Worker secrets live in `worker/.env` (gitignored) + a service-account JSON path (gitignored).
- Frontend config lives in `web/config.js` (gitignored); `web/config.example.js` is committed.
- Feature flags (in Script Properties, read via `Config.js`):
  - `DRY_RUN` - default `1`. When set, provisioners log intended actions, no live mutation.
  - `HUBSPOT_SEAT_ENABLED` - default `0`. Gates paid HubSpot seat create/release.
  - `PROPDATA_LIVE` - default `0`. Until api_key/vendor-id provisioned, PropData is dry-run.
  - `OFFBOARD_ARMED` - default `0`. Master safety: while `0`, `fireOffboarding_()` logs and
    writes results but does NOT suspend real Google accounts. User arms this explicitly.

## 6. Non-negotiables baked into the layout

- No live deploy from this repo; every deploy/arm step is user-run and documented in README.
- No secrets in committed source (see `.gitignore`).
- Every file < 500 lines; split a module (e.g. add `Onboarding_*_Templates.js`) before it grows.
- No em/en dashes anywhere. No dark mode in `web/`. Dark text on the yellow brand colour.
- Offboarding is destructive: `OFFBOARD_ARMED=0` + `DRY_RUN=1` are the shipped defaults.

## 7. Architect decisions locked from research (docs/RESEARCH.md)

- **Auth**: JWT in POST body as `accessToken`; lift Aqua `_verifyCaller_` verbatim (staff by
  `auth_user_id`, reject inactive); JWT-only, no shared-secret path. Candidate kinds token-less.
- **Program -> System map** (docs/CONTRACTS.md section 6): Quay1 programs cma/dialfire enqueue
  their systems; whatsapp/training/other are informational; core stack google/propdata/property24
  provisions by default. Programs are NOT the SYSTEMS enum.
- **Aqua theme**: use the Quay navy+gold palette (#3D5BA6/#2E477F/#FDC503), matching the live
  Aqua emails. There is NO separate "Aqua gold" surface theme (SPEC section 5 was aspirational).
  The Aqua toggle may carry a small accent tag, not a full palette swap. (Notified ui.)
- **Google/AdminDirectory = BUILD FRESH (Blocker B0)**: no implementation exists on disk; the
  SPEC's "DONE, verified" was wrong (now corrected). AdminDirectory advanced service, super-admin
  authorizer, DRY_RUN until the user arms. Calls: `Users.insert` / `Members.insert` / `Users.update`.

## 8. Open items deferred to user / follow-up (do not silently resolve)

- **B1**: the live Quay1 `1apqpQ...` script could not be cloned (clasp "Invalid script ID").
  Quay1 wire SHAPE is authoritative (from the frontend) but the server field->column mapping and
  email copy are UNVERIFIED. User action: `clasp login` (pagan@, Apps Script API enabled) so the
  backend can diff the real Code.js. Aqua `Code.js` WAS read in full and is authoritative.
- Single new tracker vs. keeping the two existing trackers - default per SPEC 3 is ONE new
  tracker; the sheet id goes in Script Properties, not source.
- **B2** PropData creds not provisioned -> inline dry-run. **B3** CMA OTP -> `skipped` stub.
  **B4** Dialfire portal path -> `NEEDS-PORTAL-MAP` scaffold. **B5** HubSpot seat -> gated off.
  All stubbed per SPEC 8, never faked.
