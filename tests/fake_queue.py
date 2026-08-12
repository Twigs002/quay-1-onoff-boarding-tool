"""Offline test doubles for the python worker harness.

Provides:
  - FakeQueue: an in-memory stand-in for the Provisioning/Offboarding Queue
    "sheet". Mimics the read/claim/write surface the worker's poll.py uses so a
    provisioner run can transition rows pending -> in_progress -> done without a
    real Sheets API call.
  - block_network(): monkeypatches socket so ANY attempt to open a real
    connection raises. This is the hard guarantee that DRY_RUN provisioners make
    no network/portal calls; if a Playwright/requests call slips through, the
    test fails loudly instead of silently hitting a live portal.

Nothing here imports the worker; the harness wires them together so this file
stays usable even before worker/ lands.
"""
import socket

from contracts import PROVISIONING_QUEUE_COLUMNS


class NetworkAccessError(RuntimeError):
    """Raised when offline test code tries to touch the real network."""


def block_network():
    """Disable real outbound sockets for the rest of the process.

    Returns the original socket.socket so a caller could restore it, though
    tests generally run in a subprocess and don't bother.
    """
    original = socket.socket

    def _blocked(*args, **kwargs):
        raise NetworkAccessError(
            "Offline test attempted a real network connection - a DRY_RUN "
            "provisioner is not honoring dry-run mode."
        )

    socket.socket = _blocked  # type: ignore[assignment]
    # Also block the convenience creators.
    socket.create_connection = lambda *a, **k: _blocked()  # type: ignore[assignment]
    return original


class FakeQueue:
    """In-memory Provisioning Queue keyed by queue_id (column A)."""

    COLUMNS = PROVISIONING_QUEUE_COLUMNS

    def __init__(self, rows=None):
        # rows: list of dicts keyed by column name
        self._rows = list(rows or [])
        self.write_log = []  # every mutation, for assertions

    # --- reads -------------------------------------------------------------
    def header(self):
        return list(self.COLUMNS)

    def as_grid(self):
        """Return header + rows as a list-of-lists, like sheet.getValues()."""
        grid = [list(self.COLUMNS)]
        for r in self._rows:
            grid.append([r.get(c, "") for c in self.COLUMNS])
        return grid

    def pending(self, systems=None):
        out = []
        for r in self._rows:
            if r.get("status") != "pending":
                continue
            if systems and r.get("system") not in systems:
                continue
            out.append(r)
        return out

    def get(self, queue_id):
        for r in self._rows:
            if r.get("queue_id") == queue_id:
                return r
        return None

    # --- writes ------------------------------------------------------------
    def claim(self, queue_id):
        """CAS claim: only succeed if still pending. Mirrors SPEC 3.2."""
        r = self.get(queue_id)
        if r is None or r.get("status") != "pending":
            return False
        r["status"] = "in_progress"
        r["attempts"] = int(r.get("attempts") or 0) + 1
        self.write_log.append((queue_id, "in_progress"))
        return True

    def set_status(self, queue_id, status, result_json=None):
        r = self.get(queue_id)
        if r is None:
            raise KeyError(queue_id)
        r["status"] = status
        if result_json is not None:
            r["result_json"] = result_json
        self.write_log.append((queue_id, status))
        return r

    def add(self, **row):
        self._rows.append(dict(row))
        return row


def sample_worker_rows():
    """A minimal pending set covering all three browser systems + both actions."""
    base = {
        "folderId": "F1",
        "full_name": "Jane Doe",
        "first_name": "Jane",
        "id_number": "9001010000000",
        "quay_email": "jane@quay1.co.za",
        "cell": "0820000000",
        "payload_json": "{}",
        "status": "pending",
        "result_json": "",
        "attempts": 0,
        "updated_at": "",
    }
    rows = []
    for i, system in enumerate(["propdata", "cma", "dialfire"]):
        r = dict(base)
        r["queue_id"] = f"Q{i+1}"
        r["system"] = system
        r["action"] = "create"
        rows.append(r)
    return rows
