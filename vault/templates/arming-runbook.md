---
type: arming-runbook
date:              # YYYY-MM-DD of this arming event
operator:          # who ran it
reason:            # why we are going live now
# flag state AFTER this event (the four gates)
DRY_RUN:           # 1 = inert, 0 = live portals
PROPDATA_LIVE:     # 0 until api_key + vendor id provisioned
HUBSPOT_SEAT_ENABLED:  # 0 = no paid seat create/release
OFFBOARD_ARMED:    # 0 = offboarding runs but does NOT suspend real accounts
outcome:           # in-progress | armed | rolled-back
---

# Arming event - {{date}}

> This repo ships INERT. Nothing mutates a live account until a human works down this list.
> Arming is a production change (SPEC s6, README "Arming order"). Do the steps IN ORDER;
> do not skip ahead. Record the real values you set. Created {{date}}.

## Gate 0 - dry-run is clean end to end
- [ ] Worker runs clean with `DRY_RUN=1` through a full onboard: google + propdata inline
      rows go `done`, worker rows (property24/cma/dialfire) log `{"dry_run": true, "would": ...}`
- [ ] Offboarding fires in dry mode and the state machine reaches `done` without suspending
- Evidence / log link:

## Gate 1 - PropData credentials
- [ ] `PROPDATA_API_KEY` + `PROPDATA_VENDOR_ID` provisioned (email api-support@propdata.net)
- [ ] Set them in Apps Script Script Properties (never commit)
- [ ] Flip `PROPDATA_LIVE=1`
- [ ] One real propdata create verified against the portal
- set at:

## Gate 2 - worker portals live (per provisioner, one at a time)
Flip worker `DRY_RUN=0` only AFTER each provisioner is verified live individually.
- [ ] [[systems/property24|property24]] create + deactivate verified
- [ ] [[systems/cma|cma]] - OTP/2FA path resolved (currently a stub, returns skipped) or left OFF
- [ ] [[systems/dialfire|dialfire]] - portal path confirmed (was NEEDS-PORTAL-MAP) or left OFF
- [ ] Worker `DRY_RUN=0` set
- set at:

## Gate 3 - HubSpot seat (optional, has licensing cost)
- [ ] Confirm we WANT auto seat create/release (costs money)
- [ ] `HUBSPOT_SEAT_ENABLED=1` (else leave 0 and manage seats by hand)
- decision:

## Gate 4 - offboarding LIVE (last, explicit instruction only)
> After this, `fireOffboarding_()` suspends real Google accounts 30 min after a request,
> with no cancel window. Only set on explicit go.
- [ ] Explicit sign-off recorded from:
- [ ] `OFFBOARD_ARMED=1` set at:
- [ ] First live offboard watched end to end

## Rollback
- To make inert again: `OFFBOARD_ARMED=0`, worker `DRY_RUN=1`, `PROPDATA_LIVE=0`,
  `HUBSPOT_SEAT_ENABLED=0`. Note that already-fired offboards do NOT un-suspend.
- rolled back at (if any):

## Sign-off
- Armed by:
- Verified by:
- Related incidents from this arming: [[ ]]
