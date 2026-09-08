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


def _parse_iso(s: str) -> "dt.datetime | None":
    """Parse an ISO timestamp to a NAIVE local datetime (comparable to dt.datetime.now()).

    Tolerates both the worker's own naive-local stamps (_now_iso) and Apps Script's UTC 'Z' stamps
    (nowIso_), so staleness math is correct regardless of which side wrote updated_at last. Returns
    None on empty/garbage so callers can treat "no usable timestamp" as its own case.
    """
    s = (s or "").strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        d = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    if d.tzinfo is not None:
        d = d.astimezone().replace(tzinfo=None)   # normalise to naive local
    return d


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

    def reap_stale_in_progress(self, timeout_min: int) -> list[QueueRow]:
        """Recover rows stranded in `in_progress` by a crash/kill/sleep between claim() and finish().

        Nothing else moves a row off in_progress except finish()/release_to_pending() inside
        process_row, so a worker that dies mid-row would otherwise leave the candidate silently never
        provisioned, with no error status to alert anyone. Any worker-owned in_progress row whose
        updated_at is older than `timeout_min` is put back to `pending` so a later pass retries it
        (attempts was already incremented at claim, so MAX_ATTEMPTS still caps it). A row with no
        parseable updated_at is treated as stale (it cannot be shown to be fresh). Returns the rows
        re-pended, for logging.
        """
        records = self._prov.get_all_values()
        inv = {idx: name for name, idx in PROV_COLS.items()}
        now = dt.datetime.now()
        cutoff = dt.timedelta(minutes=timeout_min)
        revived: list[QueueRow] = []
        for i, raw in enumerate(records[1:], start=2):     # skip header
            vals = {inv[c]: (raw[c - 1] if c - 1 < len(raw) else "")
                    for c in inv}
            qr = QueueRow(row_index=i, values=vals)
            if qr.status != IN_PROGRESS:
                continue
            if qr.system not in WORKER_SYSTEMS:
                continue
            updated = _parse_iso(qr.get("updated_at"))
            if updated is not None and (now - updated) < cutoff:
                continue                                   # still fresh - a live worker may hold it
            self.release_to_pending(qr)
            revived.append(qr)
        return revived

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

        # Re-read attempts from the live cell (not the pending_provisioning snapshot) so the increment
        # reflects any writes since the scan and the MAX_ATTEMPTS cap cannot be quietly overrun.
        live_attempts = self._prov.cell(qr.row_index, PROV_COLS["attempts"]).value
        try:
            new_attempts = int((live_attempts or "0").strip() or "0") + 1
        except ValueError:
            new_attempts = qr.attempts + 1
        self._prov.update_cell(qr.row_index, col, IN_PROGRESS)
        self._prov.update_cell(qr.row_index, PROV_COLS["attempts"], str(new_attempts))
        self._prov.update_cell(qr.row_index, PROV_COLS["updated_at"], _now_iso())

        verify = self._prov.cell(qr.row_index, col).value   # re-read to confirm
        if (verify or "").strip().lower() != IN_PROGRESS:
            return None                                     # lost the race, back off
        return new_attempts

    # -------------------------------------------------- result write-back
    def _write_row_cells(self, row_index: int, updates: list[tuple[int, str]]) -> None:
        """Write several cells of one row in a SINGLE batched API call, so a terminal write cannot be
        torn in half by a crash between cells (which previously could leave status=done with a stale or
        empty result_json). `updates` is a list of (1-based column, value)."""
        from gspread.utils import rowcol_to_a1
        self._prov.batch_update(
            [{"range": rowcol_to_a1(row_index, col), "values": [[val]]} for col, val in updates],
            value_input_option="RAW",
        )

    def finish(self, qr: QueueRow, status: str, result: dict) -> None:
        """Write a terminal status (done|error|skipped), result_json, updated_at in one atomic batch.
        `attempts` was already written at claim time, so it is not rewritten here.
        """
        import json
        self._write_row_cells(qr.row_index, [
            (PROV_COLS["status"], status),
            (PROV_COLS["result_json"], json.dumps(result, ensure_ascii=False)),
            (PROV_COLS["updated_at"], _now_iso()),
        ])

    def release_to_pending(self, qr: QueueRow) -> None:
        """Put a claimed-but-failed row back to pending for a later retry (used
        when attempts are still under the cap). attempts already persisted at claim.
        """
        self._write_row_cells(qr.row_index, [
            (PROV_COLS["status"], PENDING),
            (PROV_COLS["updated_at"], _now_iso()),
        ])

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
