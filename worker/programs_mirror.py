#!/usr/bin/env python3
"""
Programs-page account-flag mirror.

apps-script/Programs.js renders each team's CMA / PropData status from two
roster tabs on the shared tracker sheet - "CMA Accounts" and "PropData
Accounts" (CFG.TAB.CMA_ACCOUNTS / PROPDATA_ACCOUNTS) - that are otherwise only
refreshed by pasting a periodic portal export. Without this mirror a freshly
provisioned agent shows "none" on the Programs page until someone pastes a
fresh export.

poll.py calls into here right after a provisioner reports a successful
`create`, to upsert one row on the matching roster tab so Programs.js reflects
the new account immediately. Column layout is mirrored 1:1 from
apps-script/Programs.js's CMA_HEADERS / PROPDATA_HEADERS - like Programs.js's
own readers (_cmaSet_ / _propdataMaps_), columns are located BY HEADER NAME,
never a fixed index, because these tabs get overwritten by raw-export pastes
whose column order is not guaranteed.

Safety:
  - Honors config.DRY_RUN: in dry-run this only logs what it WOULD write and
    never opens the tracker's other worksheets.
  - Additive only: an existing non-blank cell (name, email, or an already-true
    Active flag) is never overwritten or blanked - the mirror can only fill a
    gap or add a new row, never erase a manually-confirmed one.
  - Never raises - any failure is logged and swallowed so a mirror problem can
    never turn a real provisioning success into a reported error (poll.py also
    wraps its call site, belt-and-suspenders).
  - Never creates or formats a tab. Setup.js's ensureAccountsTabs_ owns tab
    creation (header row + frozen row); a missing tab just logs and no-ops.
"""
from __future__ import annotations

import config
from log_setup import get_logger

log = get_logger("programs_mirror")

# Header layout, mirrored 1:1 from apps-script/Programs.js's CMA_HEADERS /
# PROPDATA_HEADERS. Keep in sync if that file's headers ever change.
PROPDATA_HEADERS = ("first name", "last name", "email", "active")
CMA_HEADERS = ("first", "last", "email")


def _norm_email(email: str) -> str:
    """Dot-insensitive, lower-cased local part - matches Programs.js's
    _normEmail_ exactly, so a mirror row lines up with the divisions-tree join."""
    s = (email or "").strip().lower()
    at = s.find("@")
    if at <= 0:
        return ""
    local, domain = s[:at], s[at:]
    return local.replace(".", "") + domain


def _last_name(person) -> str:
    """Mirrors propdata.py's _last_name(): payload override, else everything
    after the first token of the full name. Kept here too (small, no shared
    utility yet) so this module has no import-time dependency on propdata.py."""
    pd = person.payload or {}
    if pd.get("last_name"):
        return str(pd["last_name"])
    parts = (person.full_name or "").split()
    return " ".join(parts[1:]) if len(parts) > 1 else ""


def _truthy(v: str) -> bool:
    s = str(v or "").strip().lower()
    return s in ("yes", "true", "y", "active", "1")


def mirror_propdata_created(bus, person, email: str = "", active: bool = True) -> str:
    """Upsert one row on the PropData Accounts tab for a just-created agent.

    `email` lets the caller pass the exact address the provisioner submitted
    (res["email"]); falls back to person.quay_email when not given. Returns a
    short status for logging/tests: "written" | "updated" | "unchanged" |
    "dry_run" | "no_email" | "no_tab" | "no_header" | "error". Never raises.
    """
    email = email or person.quay_email or ""
    ne = _norm_email(email)
    if not ne:
        log.warning("propdata mirror: no email for %r - skipping", person.full_name or "?")
        return "no_email"

    first = person.first_name or ""
    last = _last_name(person)
    active_str = "Yes" if active else "No"

    if config.DRY_RUN:
        log.info("[DRY_RUN] propdata mirror WOULD upsert %r: first=%r last=%r email=%r active=%s",
                 config.PROPDATA_ACCOUNTS_TAB, first, last, email, active_str)
        return "dry_run"

    try:
        return _upsert(bus, config.PROPDATA_ACCOUNTS_TAB,
                       {"first name": first, "last name": last, "email": email,
                        "active": active_str},
                       key=ne, active_col="active")
    except Exception as e:  # noqa: BLE001 - a mirror failure must never break provisioning
        log.warning("propdata mirror failed for %r: %s", email, e)
        return "error"


def mirror_cma_created(bus, person, email: str = "") -> str:
    """Upsert one row on the CMA Accounts tab. CMA has no live create path yet
    (cma.py's create() always Skips at the unsolved OTP gate), so nothing calls
    this today - it is wired ahead of time so arming CMA later needs no new
    mirror plumbing. Same contract as mirror_propdata_created."""
    email = email or person.quay_email or ""
    ne = _norm_email(email)
    if not ne:
        return "no_email"

    first = person.first_name or ""
    last = _last_name(person)

    if config.DRY_RUN:
        log.info("[DRY_RUN] cma mirror WOULD upsert %r: first=%r last=%r email=%r",
                 config.CMA_ACCOUNTS_TAB, first, last, email)
        return "dry_run"

    try:
        return _upsert(bus, config.CMA_ACCOUNTS_TAB,
                       {"first": first, "last": last, "email": email},
                       key=ne, active_col=None)
    except Exception as e:  # noqa: BLE001
        log.warning("cma mirror failed for %r: %s", email, e)
        return "error"


def _upsert(bus, tab_name: str, fields: dict, key: str, active_col: str | None) -> str:
    """Find the row on `tab_name` whose normalised email matches `key`, fill in
    any blank cells named in `fields` (by header name), or append a new row
    when no match exists. See module docstring for the additive-only contract.
    """
    ws = bus.worksheet(tab_name)
    if ws is None:
        log.warning("mirror: tab %r not found on the tracker - Setup.ensureAccountsTabs_ "
                    "must run once in Apps Script before the mirror can write to it", tab_name)
        return "no_tab"

    rows = ws.get_all_values()
    if not rows:
        log.warning("mirror: tab %r has no header row - skipping", tab_name)
        return "no_header"
    header = {str(h or "").strip().lower(): i for i, h in enumerate(rows[0])}
    if "email" not in header:
        log.warning("mirror: tab %r has no Email header - skipping", tab_name)
        return "no_header"

    ecol = header["email"]
    match_row = match_vals = None
    for i, row in enumerate(rows[1:], start=2):          # 1-based sheet row, skip header
        cell = row[ecol] if ecol < len(row) else ""
        if _norm_email(cell) == key:
            match_row, match_vals = i, row
            break

    if match_row is None:
        new_row = [""] * len(rows[0])
        for name, val in fields.items():
            if name in header:
                new_row[header[name]] = val
        ws.append_row(new_row)
        log.info("mirror: appended %r row for %s", tab_name, key)
        return "written"

    changed = False
    for name, val in fields.items():
        if name not in header or not val:
            continue
        idx = header[name]
        existing = match_vals[idx] if idx < len(match_vals) else ""
        if name == active_col:
            if _truthy(existing):
                continue                  # already active - never touch, never downgrade
            if existing and not _truthy(val):
                continue                  # never blank/negate an existing explicit flag
        elif existing:
            continue                      # additive only - never clobber an existing value
        ws.update_cell(match_row, idx + 1, val)
        changed = True
    log.info("mirror: %s %r row for %s", "updated" if changed else "left unchanged", tab_name, key)
    return "updated" if changed else "unchanged"
