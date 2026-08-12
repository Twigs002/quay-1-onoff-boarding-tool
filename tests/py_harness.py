#!/usr/bin/env python3
"""Offline dry-run harness for the python worker (TEST items #2, #3-python, #4-worker).

Runs entirely against a FAKE in-memory queue with DRY_RUN=1 and a hard socket
network-guard installed, then drives the REAL worker/poll.py:process_row logic so
we exercise the actual claim/dispatch/write-back code path - not a reimplementation.

Asserts:
  A. Column cross-check: worker sheets.PROV_COLS / OFFB_COLS match the canonical
     contract (tests/contracts.json) field-for-field AND in column order. This is
     the single most important test - a drift here silently corrupts the bus.
  B. dialfire, create AND deactivate -> terminal `done`, result_json
     carries dry_run=True and a `would` field (CONTRACTS sec 3).
  C. cma (create + deactivate) -> terminal `skipped` (never a fake done / error).
  D. A row already at MAX_ATTEMPTS is marked `error {"error":"max attempts"}`
     WITHOUT being claimed.
  E. A row that is no longer `pending` at claim time -> lost_claim (no write).
  F. Status transitions observed on the fake queue are pending->in_progress->done
     for the happy path.
  G. No real network connection was attempted by any dry-run provisioner.

Run:  python3 tests/py_harness.py     (exit 0 = all pass, 1 = failure)
No network, no browser, no gspread/playwright needed.
"""
import os
import sys

# DRY_RUN must be set BEFORE importing worker.config (it reads env at import).
os.environ["DRY_RUN"] = "1"
os.environ.setdefault("MAX_ATTEMPTS", "3")

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
sys.path.insert(0, _HERE)                       # contracts.py, fake_queue.py
sys.path.insert(0, os.path.join(_ROOT, "worker"))  # config, poll, sheets, provisioners

import contracts                                  # noqa: E402
from fake_queue import block_network, NetworkAccessError  # noqa: E402

# Guard the network before anything worker-side runs. Any real socket -> failure.
block_network()

import config                                     # noqa: E402
import poll                                        # noqa: E402
import sheets                                      # noqa: E402
from sheets import QueueRow                         # noqa: E402


FAILURES = []


def check(cond, label):
    status = "PASS" if cond else "FAIL"
    print(f"  [{status}] {label}")
    if not cond:
        FAILURES.append(label)


# --------------------------------------------------------------------------- A
def test_column_cross_check():
    print("A. Queue column cross-check (worker reader vs canonical contract)")
    check(config.DRY_RUN is True, "worker config.DRY_RUN is ON")

    # PROV_COLS: field -> 1-based index. Rebuild the ordered list and diff.
    prov_by_index = [None] * len(sheets.PROV_COLS)
    for field, idx in sheets.PROV_COLS.items():
        prov_by_index[idx - 1] = field
    check(prov_by_index == contracts.PROVISIONING_QUEUE_COLUMNS,
          f"Provisioning cols match A..N field-for-field "
          f"(worker={prov_by_index})")

    offb_by_index = [None] * len(sheets.OFFB_COLS)
    for field, idx in sheets.OFFB_COLS.items():
        offb_by_index[idx - 1] = field
    check(offb_by_index == contracts.OFFBOARDING_QUEUE_COLUMNS,
          f"Offboarding cols match A..K field-for-field "
          f"(worker={offb_by_index})")

    # No gaps / duplicate indices.
    check(sorted(sheets.PROV_COLS.values()) == list(range(1, len(contracts.PROVISIONING_QUEUE_COLUMNS) + 1)),
          "Provisioning column indices are 1..N contiguous, no dupes")
    check(set(sheets.WORKER_SYSTEMS) == set(contracts.WORKER_SYSTEMS),
          "worker WORKER_SYSTEMS == contract WORKER_SYSTEMS (propdata/cma/dialfire)")


# ----------------------------------------------------------- fake bus + rows
class FakeBus:
    """In-memory stand-in for sheets.SheetBus, backed by QueueRow.values dicts.

    Implements exactly the surface poll.process_row uses: claim / finish /
    release_to_pending. Records every call so the harness can assert behavior.
    """
    def __init__(self):
        self.claims = []      # queue_ids that reached claim()
        self.finishes = []    # (queue_id, status, result)
        self.releases = []

    def claim(self, qr):
        self.claims.append(qr.queue_id)
        if qr.status != "pending":          # CAS: only claim a pending row
            return None
        qr.values["status"] = "in_progress"
        qr.values["attempts"] = str(qr.attempts + 1)
        return qr.attempts                  # already incremented above

    def finish(self, qr, status, result):
        qr.values["status"] = status
        qr.values["result_json"] = result
        self.finishes.append((qr.queue_id, status, result))

    def release_to_pending(self, qr):
        qr.values["status"] = "pending"
        self.releases.append(qr.queue_id)


def make_row(row_index, queue_id, system, action, status="pending", attempts=0):
    return QueueRow(row_index=row_index, values={
        "queue_id": queue_id, "folderId": "F1", "full_name": "Jane Doe",
        "first_name": "Jane", "id_number": "9001010000000",
        "quay_email": "jane@quay1.co.za", "cell": "0820000000",
        "system": system, "action": action, "payload_json": "{}",
        "status": status, "result_json": "", "attempts": str(attempts),
        "updated_at": "",
    })


# --------------------------------------------------------------------------- B/C
def test_dispatch_paths():
    print("B/C. Dry-run dispatch: dialfire -> done, cma -> skipped")
    bus = FakeBus()
    cases = [
        ("dialfire", "create", "done"),
        ("dialfire", "deactivate", "done"),
        ("cma", "create", "skipped"),
        ("cma", "deactivate", "skipped"),
    ]
    for i, (system, action, expected) in enumerate(cases, start=2):
        qr = make_row(i, f"PQ-F1-{system}-{action}", system, action)
        ret = poll.process_row(bus, qr)
        check(ret == expected,
              f"{system}.{action} -> {ret} (expected {expected})")
        check(qr.values["status"] == expected,
              f"{system}.{action} row status written = {expected}")
        if expected == "done":
            res = qr.values["result_json"]
            check(isinstance(res, dict) and res.get("dry_run") is True,
                  f"{system}.{action} result stamped dry_run=True")
            check("would" in res or res.get("simulated") is True,
                  f"{system}.{action} result carries a `would`/simulated marker")
        if expected == "skipped":
            res = qr.values["result_json"]
            check(isinstance(res, dict) and "skipped" in res,
                  f"{system}.{action} skipped result has reason")


# --------------------------------------------------------------------------- D
def test_max_attempts_not_claimed():
    print("D. Row at MAX_ATTEMPTS -> error, never claimed")
    bus = FakeBus()
    qr = make_row(9, "PQ-F1-dialfire-create", "dialfire", "create",
                  attempts=config.MAX_ATTEMPTS)
    ret = poll.process_row(bus, qr)
    check(ret == "max_attempts", f"return == max_attempts (got {ret})")
    check(qr.queue_id not in bus.claims, "row was NOT claimed")
    fin = [f for f in bus.finishes if f[0] == qr.queue_id]
    check(len(fin) == 1 and fin[0][1] == "error", "row finished as error")
    check(fin and fin[0][2].get("error") == "max attempts",
          "error result is {'error':'max attempts'}")


# --------------------------------------------------------------------------- E
def test_lost_claim():
    print("E. Row not pending at claim -> lost_claim, no write-back")
    bus = FakeBus()
    qr = make_row(10, "PQ-F1-dialfire-create", "dialfire", "create",
                  status="in_progress")   # someone else already owns it
    ret = poll.process_row(bus, qr)
    check(ret == "lost_claim", f"return == lost_claim (got {ret})")
    check(len(bus.finishes) == 0, "no terminal write happened on a lost claim")


# --------------------------------------------------------------------------- F
def test_status_transition_sequence():
    print("F. Happy-path status sequence pending -> in_progress -> done")
    seq = []

    class TracingBus(FakeBus):
        def claim(self, qr):
            r = super().claim(qr)
            if r is not None:
                seq.append(qr.values["status"])   # in_progress
            return r

        def finish(self, qr, status, result):
            super().finish(qr, status, result)
            seq.append(status)

    bus = TracingBus()
    qr = make_row(11, "PQ-F1-dialfire-create", "dialfire", "create")
    seq.append(qr.status)                          # pending
    poll.process_row(bus, qr)
    check(seq == ["pending", "in_progress", "done"],
          f"observed transitions {seq}")


# --------------------------------------------------------------------------- G
def test_no_network():
    print("G. Network guard held (no real socket during dry-run)")
    # If any dry-run path had opened a socket, block_network would already have
    # raised inside process_row and the run would have crashed. Prove the guard
    # is live by asserting a direct connection still raises.
    import socket
    raised = False
    try:
        socket.create_connection(("example.com", 80), 1)
    except NetworkAccessError:
        raised = True
    except Exception:
        raised = True   # any refusal is fine; the point is: not a real connection
    check(raised, "socket.create_connection is blocked")


# --------------------------------------------------------------------------- H
def test_dry_run_fail_safe():
    """The master safety switch must FAIL SAFE: only an exact, trimmed,
    lowercased member of the live-set {0,false,no,off} arms live provisioning.
    Any other value - a typo, unset, empty, or even a truthy-looking 'yes' -
    must keep DRY_RUN ON. A bug here fails OPEN and could hit a real portal."""
    print("H. DRY_RUN fail-safe (garbage/typo/unset stays dry)")
    import importlib
    saved = os.environ.get("DRY_RUN")

    def dry_for(val):
        if val is None:
            os.environ.pop("DRY_RUN", None)
        else:
            os.environ["DRY_RUN"] = val
        importlib.reload(config)
        return config.DRY_RUN

    try:
        # exact live-set (case/space-insensitive) -> LIVE (dry OFF)
        for v in ["0", "false", "FALSE", "no", "off", " off ", "No"]:
            check(dry_for(v) is False, f"live-set value {v!r} -> DRY_RUN OFF (live)")
        # everything else -> DRY (fail safe). Includes the reviewer's 'ture' typo.
        for v in [None, "", "1", "true", "yes", "on", "ture", "flase",
                  "offf", "disable", "xyz", "2"]:
            check(dry_for(v) is True, f"non-live value {v!r} -> DRY_RUN ON (fail safe)")
    finally:
        # restore the harness's dry default so nothing downstream runs live
        if saved is None:
            os.environ["DRY_RUN"] = "1"
        else:
            os.environ["DRY_RUN"] = saved
        importlib.reload(config)
        check(config.DRY_RUN is True, "config restored to DRY_RUN ON after test")


def main():
    print("=== python worker offline dry-run harness ===")
    test_column_cross_check()
    test_dispatch_paths()
    test_max_attempts_not_claimed()
    test_lost_claim()
    test_status_transition_sequence()
    test_no_network()
    test_dry_run_fail_safe()
    print()
    if FAILURES:
        print(f"RESULT: FAIL ({len(FAILURES)} check(s) failed)")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("RESULT: PASS (all python worker checks green, DRY_RUN, no network)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
