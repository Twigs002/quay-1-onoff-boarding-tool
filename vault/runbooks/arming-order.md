# Runbook - Arming order (going live)

Standing reference for the four gates. For an actual go-live, make a dated note from
`templates/arming-runbook` and work its checklist - this page is the "why", that note is the
"what happened".

The repo ships inert. Four flags gate live behaviour; flip them IN THIS ORDER, never skip:

1. **`DRY_RUN=1` -> confirm clean end to end.** Worker logs intended actions only. Full onboard
   dry-run must reach `done` for inline systems and `{"dry_run": true}` for worker systems.
2. **`PROPDATA_LIVE=1`** once `api_key` + vendor id are provisioned. Before that, propdata is
   dry only.
3. **worker `DRY_RUN=0`** - and only per-provisioner, after each of property24 / cma / dialfire
   is verified live individually. cma is OTP-gated (may stay off); dialfire portal path was
   unconfirmed (verify first).
4. **`OFFBOARD_ARMED=1`** LAST, and only on explicit instruction. After this, offboarding
   suspends real Google accounts 30 min after a request, **no cancel window**.

Optional, sideways: **`HUBSPOT_SEAT_ENABLED=1`** - paid seat auto create/release, default off
because it costs money.

Rollback: reverse the flags. Already-fired offboards do not un-suspend.

See also: [[systems/propdata]], [[systems/property24]], [[systems/cma]], [[systems/dialfire]],
[[systems/hubspot]].
