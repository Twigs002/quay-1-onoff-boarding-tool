#!/usr/bin/env python3
"""
Quay 1 Boarding Tool - Python worker.

Polls the Provisioning Queue tab of the shared Google Sheet, claims each pending
browser-portal row by CAS (compare-and-set), dispatches it to the right
provisioner (propdata | cma | dialfire) for the requested action
(create | deactivate), and writes status + result_json back to the sheet.

Offboarding teardown reaches the worker as `deactivate` rows that Apps Script
drops on this same Provisioning Queue, so there is one execution path.

SAFETY: DRY_RUN defaults ON (config.DRY_RUN). In dry-run every provisioner logs
what it WOULD do and returns a clearly-labelled simulated result - it NEVER
submits a real create/deactivate. Live provisioning is user-gated (DRY_RUN=0).

Run once (a cron/launchd job invokes it on a schedule, like virtual-agent-lookup):
    python3 worker/poll.py
"""
from __future__ import annotations

import sys
import json

import config
import programs_mirror
from log_setup import get_logger
from sheets import SheetBus, QueueRow, DONE, ERROR, SKIPPED
from provisioners import REGISTRY
from provisioners.base import Person, Skip

log = get_logger("poll")


def _dispatch(qr: QueueRow) -> dict:
    """Run the provisioner for one claimed row. Returns the result dict.

    Raises on an unknown system/action so the caller records an error and the
    row can be retried or inspected - we never silently succeed.
    """
    module = REGISTRY.get(qr.system)
    if module is None:
        raise ValueError(f"no provisioner for system {qr.system!r}")
    person = Person.from_queue_row(qr)
    if qr.action == "create":
        return module.create(person)
    if qr.action == "deactivate":
        return module.deactivate(person)
    raise ValueError(f"unknown action {qr.action!r} (expected create|deactivate)")


def _mirror_account_flag(bus: SheetBus, qr: QueueRow, res: dict) -> None:
    """Best-effort Programs-page roster mirror (see programs_mirror.py), run
    only after a `create` that actually returned ok. Never raises - a mirror
    problem must not turn a real provisioning success into a reported error.
    """
    try:
        person = Person.from_queue_row(qr)
        if qr.system == "propdata":
            programs_mirror.mirror_propdata_created(bus, person, email=res.get("email", ""))
        elif qr.system == "cma":
            programs_mirror.mirror_cma_created(bus, person, email=res.get("email", ""))
    except Exception as e:  # noqa: BLE001
        log.warning("row %d %s: account-flag mirror failed (provisioning still recorded ok): %s",
                    qr.row_index, qr.queue_id, e)


def process_row(bus: SheetBus, qr: QueueRow) -> str:
    """Claim, run, and write back one row. Returns the terminal status string
    for run-summary stats. Never raises - failures are recorded on the row."""
    # Pre-claim guard: a row that has already burned MAX_ATTEMPTS (e.g. a human
    # flipped it back to pending after repeated errors) is capped, not retried.
    if qr.attempts >= config.MAX_ATTEMPTS:
        bus.finish(qr, ERROR, {"ok": False, "system": qr.system,
                               "action": qr.action, "error": "max attempts",
                               "dry_run": config.DRY_RUN})
        log.error("row %d %s: max attempts (%d) reached - marked error, not retried",
                  qr.row_index, qr.queue_id, qr.attempts)
        return "max_attempts"

    attempts = bus.claim(qr)                     # increments M at claim, re-reads K
    if attempts is None:
        log.info("row %d %s: lost the claim (no longer pending) - skipping",
                 qr.row_index, qr.queue_id)
        return "lost_claim"

    log.info("row %d %s: claimed  system=%s action=%s attempt=%d dry_run=%s",
             qr.row_index, qr.queue_id, qr.system, qr.action, attempts, config.DRY_RUN)
    try:
        res = _dispatch(qr)
        status = DONE if res.get("ok") else ERROR
        if status == DONE and qr.action == "create":
            _mirror_account_flag(bus, qr, res)
        bus.finish(qr, status, res)
        log.info("row %d %s: %s  %s", qr.row_index, qr.queue_id, status,
                 json.dumps(res, ensure_ascii=False))
        return status
    except Skip as s:                            # terminal, non-retriable (e.g. CMA OTP)
        res = {"ok": False, "system": qr.system, "action": qr.action,
               "skipped": s.reason, "dry_run": config.DRY_RUN}
        bus.finish(qr, SKIPPED, res)
        log.info("row %d %s: SKIPPED - %s", qr.row_index, qr.queue_id, s.reason)
        return SKIPPED
    except Exception as e:                       # noqa: BLE001 - record every failure
        err = {"ok": False, "system": qr.system, "action": qr.action,
               "error": str(e)[:400], "dry_run": config.DRY_RUN}
        if attempts >= config.MAX_ATTEMPTS:
            bus.finish(qr, ERROR, err)
            log.error("row %d %s: ERROR (final, %d/%d attempts): %s",
                      qr.row_index, qr.queue_id, attempts, config.MAX_ATTEMPTS, e)
            return ERROR
        # under the cap: release back to pending so a later pass retries it
        bus.release_to_pending(qr)
        log.warning("row %d %s: failed (attempt %d/%d), released to pending: %s",
                    qr.row_index, qr.queue_id, attempts, config.MAX_ATTEMPTS, e)
        return "retry"


def main() -> int:
    log.info("worker start  dry_run=%s  headless=%s  sheet=%s",
             config.DRY_RUN, config.HEADLESS, config.SHEET_ID or "<unset>")
    if config.DRY_RUN:
        log.info("DRY_RUN is ON - no real account will be created or deactivated")

    try:
        bus = SheetBus()
    except Exception as e:                      # noqa: BLE001
        log.error("cannot open the sheet bus: %s", e)
        return 1

    rows = bus.pending_provisioning()
    if config.MAX_ROWS_PER_PASS > 0:
        rows = rows[:config.MAX_ROWS_PER_PASS]
    log.info("pending browser-portal rows this pass: %d", len(rows))

    stats: dict[str, int] = {}
    for qr in rows:
        status = process_row(bus, qr)
        stats[status] = stats.get(status, 0) + 1

    log.info("worker done  %s", json.dumps(stats))
    return 0


if __name__ == "__main__":
    sys.exit(main())
