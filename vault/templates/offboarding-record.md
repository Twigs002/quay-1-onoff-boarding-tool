---
type: offboarding
offb_id:           # OFF-<ts>-<rand>  (Offboarding Queue col A)
full_name:
quay_email:        # the Google account to suspend (linchpin key)
requested_by:      # requester email (from JWT)
requested_at:      # ISO-8601 UTC
fire_at:           # requested_at + 30 min  <-- NO CANCEL WINDOW after this
systems: [google, propdata, property24, cma, dialfire, hubspot]
status: scheduled  # scheduled | firing | done | error   (OFFB_STATUS)
armed:             # was OFFBOARD_ARMED=1 at fire time?  yes | no (dry)
---

# Offboard - {{title}}

> WARNING: once fired and armed this suspends real accounts with **no cancel window**
> (SPEC s3, CONTRACTS s4). Treat firing as a production change. Created {{date}}.

## Pre-fire
- [ ] Confirmed correct person (`quay_email` matches the leaver, not a namesake)
- [ ] `systems` list reviewed (remove any that should be kept)
- [ ] Drive hand-over / transfer target decided
- [ ] Manager / notifications drafted (offboarding emails DRAFT unless told to send)
- fire_at scheduled for:

## Fire (fireOffboarding_ -> col H state machine)
Inline (Apps Script), on fire:
- [ ] [[systems/google|google]] suspend `{suspended:true}` - google_result:
- [ ] group memberships removed
- [ ] Drive shares revoked / transferred
- [ ] [[systems/hubspot|hubspot]] seat released (only if HUBSPOT_SEAT_ENABLED)

Enqueued as `deactivate` rows on the Provisioning Queue (worker executes):
| system | status | result |
|--------|--------|--------|
| [[systems/property24\|property24]] | pending | |
| [[systems/cma\|cma]]               | pending | (OTP-gated -> may return skipped) |
| [[systems/dialfire\|dialfire]]     | pending | |
| [[systems/propdata\|propdata]]     | pending | (inline deactivate) |

## Outcome
- final status:
- re-fire needed? (error rows -> human re-runs; done is idempotent no-op)

## Timeline / notes
- {{date}} - requested

## Links
- Original onboarding: [[ ]]
- Arming event this ran under: [[ ]]
