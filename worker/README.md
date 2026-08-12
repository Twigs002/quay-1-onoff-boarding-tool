# Worker (Python + Playwright)

Executes the browser-only provisioning/offboarding steps that Apps Script cannot
do (PropData, CMA, Dialfire have no usable user-management API). It reads jobs
off the shared Google Sheet, runs them, and writes the result back.

```
Apps Script  ──writes rows──►  Provisioning Queue tab  ◄──polls/updates──  poll.py
                                                                             │
                                        dispatch by (system, action)         ▼
                                     provisioners/{propdata,cma,dialfire}.py
```

## Safety (read this first)

- **`DRY_RUN` defaults to `1` (on).** In dry-run every provisioner logs exactly
  what it *would* do and returns a clearly-labelled simulated result. It **never**
  submits a real create or deactivate on any portal.
- Live provisioning (`DRY_RUN=0`) is **user-gated** and additionally blocked in
  code: the Dialfire live flow still contains `TODO(portal-map)`
  selectors and raise `NotImplementedError` until a human maps the real portal
  DOM. CMA is OTP/2FA-gated, so it raises `Skip` and its rows land as the terminal
  `skipped` status (never a fake `done`, never a retriable `error`) until the OTP
  step is solved. So even with `DRY_RUN=0` nothing is submitted until those are
  deliberately completed.
- No secrets in source. Passwords come from the macOS Keychain; the Google key
  path and sheet id come from `.env` (gitignored).

## Layout

| File | Role |
|------|------|
| `poll.py` | Entry point. Poll queue, CAS-claim, dispatch, write back, cap retries. |
| `config.py` | Env + `.env` loading, `DRY_RUN`, Keychain password access. |
| `sheets.py` | gspread service-account auth + queue read/claim/write (column maps here). |
| `log_setup.py` | Per-day file + stdout logging. |
| `provisioners/base.py` | `Person` model, `Provisioner` base, dry-run gate + result shape. |
| `provisioners/browser.py` | Shared persistent-context Playwright launcher. |
| `provisioners/propdata.py` | Add PDMS agent profile (browser-driven). Deactivate not mapped yet. |
| `provisioners/cma.py` | Add / disable CMA user. Login ported from cma-lookup; OTP unsolved. |
| `provisioners/dialfire.py` | Add / remove Dialfire seat. NEEDS-PORTAL-MAP. |

The queue column layout lives in one place: the `PROV_COLS` / `OFFB_COLS` maps in
`sheets.py` (from `docs/SPEC.md` sections 3.2 and 3.3). If the contract changes,
edit those maps only.

## Setup

```bash
cd worker
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium

cp .env.example .env
# edit .env: set SHEET_ID and GOOGLE_KEY_PATH (point at the gitignored key file)
# share the sheet with the service-account email as an editor
```

Portal passwords (only needed to arm live, never for dry-run):

```bash
security add-generic-password -s cma-info        -a "<admin-user>" -w
security add-generic-password -s dialfire-admin  -a "<admin-user>" -w
```

## Run

```bash
# dry-run (default) - safe, submits nothing
python3 poll.py

# one visible-browser debugging pass (still dry-run)
HEADLESS=0 python3 poll.py
```

Schedule it the same way as `virtual-agent-lookup` (a launchd `.plist` or cron
invoking `poll.py` on an interval). Each pass claims up to `MAX_ROWS_PER_PASS`
pending rows and exits, so it is safe to run frequently.

## Verify (no network / no browser needed)

```bash
python3 -m py_compile poll.py config.py sheets.py log_setup.py provisioners/*.py
```
