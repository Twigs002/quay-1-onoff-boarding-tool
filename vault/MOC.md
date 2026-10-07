# Quay 1 Boarding - Home (Map of Content)

The human layer over the automation. Runtime source of truth is the tracker Sheet + Supabase;
this vault is the readable audit + procedures. Specs: [[../docs/SPEC|SPEC]] /
[[../docs/CONTRACTS|CONTRACTS]] (open the repo root as the vault instead of `vault/` if you
want those links live).

## Do a thing
- New hire -> new note from `templates/onboarding-record` into `records/onboarding/`
- Someone leaving -> `templates/offboarding-record` into `records/offboarding/`
- Going live / changing a flag -> `templates/arming-runbook` into `runbooks/`
- Something broke -> `templates/incident`

## Boards (need the Dataview plugin; plain markdown without it)

In-flight hires:
```dataview
TABLE entity, status, quay_email, start_date
FROM "records/onboarding"
WHERE status != "complete"
SORT start_date asc
```

Offboards not yet done:
```dataview
TABLE status, fire_at, armed
FROM "records/offboarding"
WHERE status != "done"
SORT fire_at asc
```

Open incidents:
```dataview
TABLE system, severity, date
FROM "records/incident" OR "records"
WHERE type = "incident" AND status = "open"
```

## Systems
[[systems/google|google]] · [[systems/propdata|propdata]] · [[systems/property24|property24]] ·
[[systems/cma|cma]] · [[systems/dialfire|dialfire]] · [[systems/hubspot|hubspot]]

## Runbooks
- [[runbooks/arming-order]] - the four gates to go live
- [[runbooks/portal-maps]] - where each browser portal's screens live
