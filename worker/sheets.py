#!/usr/bin/env python3
"""
The shared Google Sheet bus.

Apps Script writes queue rows; this worker reads them, claims a row by CAS
(compare-and-set: only act if it's still `pending`), runs the provisioner, then
writes status + result back.

Auth mirrors virtual-agent-lookup exactly:
    gspread.service_account(filename=KEY).open_by_key(SHEET_ID).worksheet(TAB)

Column layout is the single source of truth from docs/SPEC.md sections 3.2 and
3.3. If the architect's docs/CONTRACTS.md finalizes different columns, change the
*_COLS maps below - nothing else in the worker hard-codes a column.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

import config

# ---------------------------------------------------------------- column maps
# 1-based column indices. Keys are the field names used everywhere else in the
# worker. (SPEC 3.2 Provisioning Queue: A..N)
PROV_COLS = {
    "queue_id": 1,      # A
    "folderId": 2,      # B
    "full_name": 3,     # C
    "first_name": 4,    # D
    "id_number": 5,     # E
    "quay_email": 6,    # F
    "cell": 7,          # G
    "system": 8,        # H  google|propdata|cma|dialfire
    "action": 9,        # I  create|deactivate
    "payload_json": 10,  # J
    "status": 11,       # K  pending|in_progress|done|error|skipped
    "result_json": 12,  # L
    "attempts": 13,     # M
    "updated_at": 14,   # N
}

# (SPEC 3.3 Offboarding Queue: A..K) - the worker only reads these to discover
# which browser-portal teardown rows Apps Script has enqueued; teardown itself
# flows through the Provisioning Queue as `deactivate` rows, so the worker's main
# path is the Provisioning Queue. Kept here for status reporting / future use.
OFFB_COLS = {
    "offb_id": 1,               # A
    "full_name": 2,             # B
    "quay_email": 3,            # C
    "requested_by": 4,          # D
    "requested_at": 5,          # E
    "fire_at": 6,               # F
    "systems_json": 7,          # G
    "status": 8,                # H  scheduled|firing|done|error
    "google_result": 9,         # I
    "worker_result_json": 10,   # J
    "trigger_id": 11,           # K
}

# Systems this worker owns (browser-driven). google is done inline (API) by Apps
# Script, so the worker skips google rows even if it sees them. propdata (PDMS) has
# no usable user API and is now driven by the browser worker like the others.
WORKER_SYSTEMS = {"propdata", "cma", "dialfire"}

PENDING = "pending"
IN_PROGRESS = "in_progress"
DONE = "done"
ERROR = "error"
SKIPPED = "skipped"


@dataclass
class QueueRow:
    """One Provisioning Queue row, decoded into named fields."""
    row_index: int                       # 1-based sheet row (incl. header offset)
    values: dict = field(default_factory=dict)

    def get(self, key: str, default: str = "") -> str:
        return (self.values.get(key) or default)

    @property
    def queue_id(self) -> str:
        return self.get("queue_id")

    @property
    def system(self) -> str:
        return self.get("system").strip().lower()

    @property
    def action(self) -> str:
        return self.get("action").strip().lower()

    @property
    def status(self) -> str:
        return self.get("status").strip().lower()

    @property
    def attempts(self) -> int:
        try:
            return int(self.get("attempts") or 0)
        except ValueError:
            return 0


def _now_iso() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


class SheetBus:
    """Thin wrapper over the two queue worksheets."""

    def __init__(self, sheet_id: str | None = None, key_path: str | None = None):
        self.sheet_id = sheet_id or config.SHEET_ID
        self.key_path = key_path or config.GOOGLE_KEY_PATH
        if not self.sheet_id:
            raise RuntimeError("SHEET_ID not set (see worker/.env.example)")
        import gspread   # lazy: only the live sheet path needs it, not decoding
        self._gc = gspread.service_account(filename=self.key_path)
        self._book = self._gc.open_by_key(self.sheet_id)
        self._prov = self._book.worksheet(config.PROVISIONING_TAB)
        self._other: dict = {}   # lazy cache for worksheet(), keyed by tab name

    # -------------------------------------------------- reads
    def pending_provisioning(self) -> list[QueueRow]:
        """Return provisioning rows that are pending AND owned by the worker
        (propdata/cma/dialfire). Row 1 is the header, so data starts at row 2.
        """
        records = self._prov.get_all_values()
        out: list[QueueRow] = []
        inv = {idx: name for name, idx in PROV_COLS.items()}
        for i, raw in enumerate(records[1:], start=2):     # skip header
            vals = {inv[c]: (raw[c - 1] if c - 1 < len(raw) else "")
                    for c in inv}
            qr = QueueRow(row_index=i, values=vals)
            if qr.status != PENDING:
                continue
            if qr.system not in WORKER_SYSTEMS:
                continue
            out.append(qr)
        return out

    # -------------------------------------------------- CAS claim
    def claim(self, qr: QueueRow) -> int | None:
        """Compare-and-set (CONTRACTS.md section 3). Flip status pending ->
        in_progress and increment attempts, but only if the live cell is still
        `pending`. Returns the new attempts count on a won claim, else None.

        gspread has no transaction, so we (1) re-read the status cell right before
        writing, (2) write status+attempts+updated_at, then (3) re-read status to
        confirm our write stuck. This narrows (does not fully eliminate) a race
        with a second worker; for a single-host Mac cron it is belt-and-suspenders.
        """
        col = PROV_COLS["status"]
        live = self._prov.cell(qr.row_index, col).value
        if (live or "").strip().lower() != PENDING:
            return None                                     # someone else took it

        new_attempts = qr.attempts + 1
        self._prov.update_cell(qr.row_index, col, IN_PROGRESS)
        self._prov.update_cell(qr.row_index, PROV_COLS["attempts"], str(new_attempts))
        self._prov.update_cell(qr.row_index, PROV_COLS["updated_at"], _now_iso())

        verify = self._prov.cell(qr.row_index, col).value   # re-read to confirm
        if (verify or "").strip().lower() != IN_PROGRESS:
            return None                                     # lost the race, back off
        return new_attempts

    # -------------------------------------------------- result write-back
    def finish(self, qr: QueueRow, status: str, result: dict) -> None:
        """Write a terminal status (done|error|skipped), result_json, updated_at.
        `attempts` was already written at claim time, so it is not rewritten here.
        """
        import json
        self._prov.update_cell(qr.row_index, PROV_COLS["status"], status)
        self._prov.update_cell(qr.row_index, PROV_COLS["result_json"],
                               json.dumps(result, ensure_ascii=False))
        self._prov.update_cell(qr.row_index, PROV_COLS["updated_at"], _now_iso())

    def release_to_pending(self, qr: QueueRow) -> None:
        """Put a claimed-but-failed row back to pending for a later retry (used
        when attempts are still under the cap). attempts already persisted at claim.
        """
        self._prov.update_cell(qr.row_index, PROV_COLS["status"], PENDING)
        self._prov.update_cell(qr.row_index, PROV_COLS["updated_at"], _now_iso())

    # -------------------------------------------------- other tabs on the book
    def worksheet(self, tab_name: str):
        """Lazily open + cache any other worksheet on the same tracker book (e.g.
        the Programs-page account-flag mirror tabs in programs_mirror.py). Returns
        None if the tab does not exist - tab creation/formatting is owned by Apps
        Script (Setup.js's ensureAccountsTabs_), so a missing tab is "nothing to
        mirror onto yet", not a worker error.
        """
        ws = self._other.get(tab_name)
        if ws is not None:
            return ws
        try:
            ws = self._book.worksheet(tab_name)
        except Exception:
            return None
        self._other[tab_name] = ws
        return ws
