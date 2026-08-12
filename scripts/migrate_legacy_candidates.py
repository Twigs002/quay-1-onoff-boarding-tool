#!/usr/bin/env python3
"""
migrate_legacy_candidates.py - one-time migration of real candidates from the OLD
quay-hubspot recruitment pipeline ("Recruitment Tracking" sheet) into THIS tool's
"Quay 1 Boarding Tool Tracker" Onboarding tab (Task #8).

Source data: scripts/legacy_candidates_source.json, a point-in-time export (the
worker's service account has no read access to the old sheet - see that file's
_readme). Destination: the new tracker's "Onboarding" + "Google Credentials" tabs,
via the worker's existing service account (worker/service-account.json), the same
auth pattern as worker/sheets.py.

SAFETY (read this before ever passing --live):
  - Every imported row is written with `status` = "Migrated (legacy)" and NO
    `approved_at` / `approved_by`. Per apps-script/Provisioning.js `_provisionReady_`,
    approved_at is "the ONE guard between an onboarded candidate and real account
    creation" - the Wednesday `provisionReadyBatch_` trigger only acts on rows that
    are BOTH doc-complete AND approved_at-stamped. Leaving approved_at empty means
    the scheduled batch will only ever count these rows under `not_ready`; it takes
    no action on them. No email is sent as a side effect of this script either way -
    Apps Script send paths (contract email, induction invite, CMA/Dialfire requests)
    all live inside the onboard/approve/batch functions in apps-script/, none of
    which this script calls; it only appends raw sheet rows via the Sheets API.
  - Idempotent: skips any candidate whose folderId is already a row in Onboarding,
    or whose quay_email is already a row in Google Credentials.
  - Defaults to --dry-run (prints the exact proposed rows, writes nothing). Pass
    --live to actually write. There is no other way to arm it (no env var).

Usage:
    python3 scripts/migrate_legacy_candidates.py              # dry run (default)
    python3 scripts/migrate_legacy_candidates.py --dry-run     # same, explicit
    python3 scripts/migrate_legacy_candidates.py --live        # writes for real
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKER = ROOT / "worker"
SOURCE_FILE = Path(__file__).resolve().parent / "legacy_candidates_source.json"

TRACKER_SHEET_ID = "1LfUEieWxPEfLiWreSmQTvYUke5LIO6Rrm9xzQwuBiDI"
SERVICE_ACCOUNT_KEY = WORKER / "service-account.json"

ONBOARDING_TAB = "Onboarding"
CREDENTIALS_TAB = "Google Credentials"

# Mirrors apps-script/Tracker.js ONB_COL exactly (1-based columns). Keep in sync by
# hand if that file's column map ever changes - this script does not read it live.
ONB_COL = {
    "entity": 1, "name": 2, "id_number": 3, "email": 4, "contact": 5, "start_date": 6,
    "senior_name": 7, "senior_email": 8, "requester_name": 9, "requester_email": 10,
    "designation": 11, "team": 12, "division": 13, "agreement_type": 14, "work_hours": 15,
    "remuneration": 16, "commission": 17,
    "fica_nda": 18, "fica_bank": 19, "fica_poa": 20, "fica_id": 21, "fica_contract": 22,
    "programs": 23, "induction_wed": 24, "induction_thu": 25, "status": 26, "folderId": 27,
    "ffc_status": 28, "ffc_number": 29, "propdata_profile_type": 30, "specialist_ref": 31,
    "systems_json": 32, "provisioned_at": 33,
    "approved_at": 34, "approved_by": 35, "reminded_at": 36, "cma_requested_at": 37,
    "nationality": 38, "birthday": 39, "bank_name": 40, "account_number": 41, "account_type": 42,
    "tax_number": 43, "residential_address": 44, "work_permit_expiry": 45, "work_permit_received": 46,
    "nok_name": 47, "nok_contact": 48, "nok_relationship": 49, "nok_email": 50,
    "hr_tracking_at": 51, "hr_promoted_at": 52, "photo_file_id": 53, "dialfire_requested_at": 54,
}
ONB_WIDTH = 54

CRED_HEADERS = ["created_at", "full_name", "quay_email", "temp_password", "team", "folderId"]

MIGRATED_STATUS = "Migrated (legacy)"
FICA_TICK_VALUE = "Received (migrated from legacy tracker)"


# ---------------------------------------------------------------- SA ID helpers
# Mirrors apps-script/Hr.js isSaId_ / saIdBirthday_ exactly, so a migrated row gets
# the same birthday a live HR sync would derive.
def is_sa_id(id_number: str) -> bool:
    return bool(re.fullmatch(r"\d{13}", (id_number or "").strip()))


def sa_id_birthday(id_number: str, current_year: int) -> str:
    if not is_sa_id(id_number):
        return ""
    yy = int(id_number[0:2])
    mm = int(id_number[2:4])
    dd = int(id_number[4:6])
    if not (1 <= mm <= 12) or not (1 <= dd <= 31):
        return ""
    pivot = current_year % 100
    year = 2000 + yy if yy <= pivot else 1900 + yy
    import datetime
    try:
        d = datetime.date(year, mm, dd)
    except ValueError:
        return ""
    return f"{d.year:04d}-{d.month:02d}-{d.day:02d}"


# ---------------------------------------------------------------- field mapping
def map_candidate(c: dict, current_year: int) -> tuple[dict, list[str]]:
    """Return (onb_row_fields, data_flags) for one legacy candidate record."""
    flags = []

    id_number = c["id_number"].strip()
    if not is_sa_id(id_number):
        flags.append(f"id_number '{id_number}' is not a well-formed 13-digit SA ID "
                      f"({len(id_number)} digits) - verify with the candidate before a live import")

    if not c.get("contact", "").strip():
        flags.append("no contact/cell number on file")

    if not re.search(r"\d{6,}", c.get("account_number", "")):
        flags.append(f"account_number '{c.get('account_number')}' looks malformed")
    if not re.search(r"\d{4,}", c.get("tax_number", "")) or not c["tax_number"].strip().replace(" ", "").isdigit():
        flags.append(f"tax_number '{c.get('tax_number')}' is not a plain number - looks like placeholder text")

    name = re.sub(r"\s+", " ", c["name"]).strip().rstrip(".")

    designation = c["designation"]
    agreement_type = "Rental" if "rental" in designation.lower() else "Sale"

    ffc_number = c.get("ffc_number", "").strip()
    ffc_status = "full" if ffc_number else ""
    if not ffc_status and "broker" in designation.lower():
        flags.append("Broker designation but no FFC certificate number on file in the old sheet - "
                      "ffc_status left blank; candidate should (re)declare on the FICA page")

    birthday = sa_id_birthday(id_number, current_year)
    nationality = "South African" if is_sa_id(id_number) else ""

    row = {
        "entity": "quay1",
        "name": name,
        "id_number": id_number,
        "email": c["email"].strip(),
        "contact": c.get("contact", "").strip(),
        "start_date": c["start_date"],
        "senior_name": c.get("senior_name", ""),
        "senior_email": c.get("senior_email", ""),
        "requester_name": c.get("requester_name", ""),
        "requester_email": c.get("requester_email", ""),
        "designation": designation,
        "team": c.get("team", ""),
        "agreement_type": agreement_type,
        "fica_nda": FICA_TICK_VALUE if c.get("fica_nda") else "",
        "fica_bank": FICA_TICK_VALUE if c.get("fica_bank") else "",
        "fica_poa": FICA_TICK_VALUE if c.get("fica_poa") else "",
        "fica_id": FICA_TICK_VALUE if c.get("fica_id") else "",
        "fica_contract": FICA_TICK_VALUE if c.get("fica_contract") else "",
        "programs": json.dumps(c.get("programs", [])),
        "induction_wed": c.get("induction_wed", ""),
        "induction_thu": c.get("induction_thu", ""),
        "status": MIGRATED_STATUS,
        "folderId": c["folderId"],
        "ffc_status": ffc_status,
        "ffc_number": ffc_number,
        "nationality": nationality,
        "birthday": birthday,
        "bank_name": c.get("bank", ""),
        "account_number": c.get("account_number", ""),
        "account_type": c.get("account_type", ""),
        "tax_number": c.get("tax_number", ""),
        "residential_address": c.get("residential_address", ""),
        "nok_name": c.get("nok_name", ""),
        "nok_contact": c.get("nok_contact", ""),
        "nok_relationship": c.get("nok_relationship", ""),
        "nok_email": c.get("nok_email", ""),
        # Left deliberately blank: approved_at, approved_by, provisioned_at, systems_json,
        # reminded_at, cma_requested_at, dialfire_requested_at, hr_tracking_at, hr_promoted_at,
        # photo_file_id, work_permit_expiry, work_permit_received, division, work_hours,
        # remuneration, commission, propdata_profile_type, specialist_ref.
    }
    return row, flags


def row_to_values(fields: dict) -> list[str]:
    values = [""] * ONB_WIDTH
    for key, val in fields.items():
        col = ONB_COL[key]
        values[col - 1] = "" if val is None else str(val)
    return values


# ---------------------------------------------------------------- sheet access
def open_tracker():
    import gspread
    gc = gspread.service_account(filename=str(SERVICE_ACCOUNT_KEY))
    return gc.open_by_key(TRACKER_SHEET_ID)


def existing_onboarding_keys(sh) -> tuple[set[str], set[str]]:
    ws = sh.worksheet(ONBOARDING_TAB)
    vals = ws.get_all_values()[1:]
    folder_ids = {r[ONB_COL["folderId"] - 1].strip() for r in vals if len(r) >= ONB_COL["folderId"]}
    id_numbers = {r[ONB_COL["id_number"] - 1].strip() for r in vals if len(r) >= ONB_COL["id_number"]}
    return folder_ids, id_numbers


def existing_credential_emails(sh) -> set[str]:
    ws = sh.worksheet(CREDENTIALS_TAB)
    vals = ws.get_all_values()[1:]
    return {r[2].strip().lower() for r in vals if len(r) > 2 and r[2].strip()}


def roster_hits(sh, email: str) -> list[str]:
    """Which non-Onboarding roster tabs already list this email (informational only -
    the Onboarding tab's folderId/id_number is the authoritative dedupe key)."""
    hits = []
    for tab, email_col in (("CMA Accounts", 3), ("PropData Accounts", 3)):
        ws = sh.worksheet(tab)
        vals = ws.get_all_values()[1:]
        for r in vals:
            if len(r) >= email_col and r[email_col - 1].strip().lower() == email.lower():
                hits.append(f"{tab}: {r}")
                break
    return hits


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--live", action="store_true", help="actually write rows (default is dry-run)")
    ap.add_argument("--dry-run", action="store_true", help="explicit dry-run (default behaviour)")
    args = ap.parse_args()
    live = args.live and not args.dry_run

    source = json.loads(SOURCE_FILE.read_text())
    candidates = source["candidates"]

    import datetime
    current_year = datetime.date.today().year

    sh = open_tracker()
    existing_folder_ids, existing_id_numbers = existing_onboarding_keys(sh)
    existing_cred_emails = existing_credential_emails(sh)

    print(f"{'LIVE' if live else 'DRY-RUN'}: {len(candidates)} legacy candidates loaded from "
          f"{SOURCE_FILE.name}\n")

    onb_ws = sh.worksheet(ONBOARDING_TAB) if live else None
    cred_ws = sh.worksheet(CREDENTIALS_TAB) if live else None

    to_import, to_skip = [], []
    for c in candidates:
        fields, flags = map_candidate(c, current_year)
        already_onboarding = fields["folderId"] in existing_folder_ids or fields["id_number"] in existing_id_numbers
        already_cred = c["quay_email"].strip().lower() in existing_cred_emails
        hits = roster_hits(sh, c["quay_email"])

        print(f"--- {fields['name']} ({fields['id_number']}) folderId={fields['folderId']}")
        print(f"    team={fields['team']!r}  designation={fields['designation']!r}  "
              f"agreement_type={fields['agreement_type']!r}")
        print(f"    programs={fields['programs']}")
        print(f"    status -> {fields['status']!r}   approved_at -> '' (unset, provisioning-safe)")
        if flags:
            for f in flags:
                print(f"    DATA FLAG: {f}")
        if hits:
            for h in hits:
                print(f"    ROSTER HIT (informational, does not block import): already in {h}")

        if already_onboarding:
            print("    SKIP: already present in Onboarding tab (folderId or id_number match)")
            to_skip.append(fields["name"])
            print()
            continue

        to_import.append((c, fields))

        if live:
            # table_range="A1" anchors the append to column A. Without it, gspread mis-detects the
            # "table" on this very wide (375-col), sparsely-populated Onboarding tab and writes each
            # row progressively further right (the misalignment that corrupted the first import).
            onb_ws.append_row(row_to_values(fields), value_input_option="RAW", table_range="A1")
            print("    WROTE Onboarding row.")
        else:
            print("    Would append 1 Onboarding row.")

        if already_cred:
            print(f"    Credentials: SKIP, {c['quay_email']} already has a Google Credentials row.")
        else:
            cred_row = ["", fields["name"], c["quay_email"], c["temp_password"], fields["team"], fields["folderId"]]
            if live:
                cred_ws.append_row(cred_row, value_input_option="RAW", table_range="A1")
                print(f"    WROTE Google Credentials row for {c['quay_email']}.")
            else:
                print(f"    Would append 1 Google Credentials row for {c['quay_email']} "
                      f"(temp_password from the old sheet - see report caveat if this person already "
                      f"appears in a roster tab above, their real password may since have changed).")
        print()

    print(f"\nSummary: {len(to_import)} to import, {len(to_skip)} already present and skipped "
          f"(of {len(candidates)} real candidates considered).")
    if not live:
        print("This was a DRY RUN. Nothing was written. Re-run with --live to write for real.")


if __name__ == "__main__":
    sys.exit(main())
