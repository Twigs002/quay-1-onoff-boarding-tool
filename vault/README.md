# Quay 1 Boarding - Obsidian Vault

A human-readable knowledge + runbook layer over the automation in this repo. It does **not**
run or replace anything - the operational source of truth stays Supabase + the tracker Sheet
(see `docs/SPEC.md`, `docs/CONTRACTS.md`). This vault is where a human records what happened,
follows high-stakes procedures step by step, and keeps the specs linked.

## Open it

Obsidian - "Open folder as vault" - point at this `vault/` folder. That's it. The `.obsidian/`
settings folder Obsidian creates is committed so everyone shares the same templates + hotkeys.

## Layout

```
vault/
  MOC.md                     home / map of content - start here
  templates/                 new-note templates (Templates core plugin)
    onboarding-record.md     one per hire
    offboarding-record.md    one per leaver
    arming-runbook.md        one per live-arming event (the no-cancel path)
    incident.md              one per provisioner/portal misfire
  records/
    onboarding/              per-hire notes (from the template)
    offboarding/             per-leaver notes
  runbooks/                  standing procedures (arming order, portal maps)
  systems/                   one note per external system - link targets for backlinks
```

## Conventions (match the repo)

- No em/en dashes. Use hyphens.
- Field names + status values below are the FROZEN ones from `docs/CONTRACTS.md` section 5.
  Do not invent new ones here - if a value isn't in the enum, it's wrong.
- `folderId` / `offb_id` / `quay_email` are the join keys back to the Sheet. Put the real
  value in frontmatter so a record maps 1:1 to its queue row.
- Records are a WRITTEN AUDIT of what the automation did, not a second system of record.
  If this drifts from the Sheet, the Sheet wins.

## Frozen enums (copy, don't reinvent - CONTRACTS.md s5)

```
SYSTEMS        = google, propdata, property24, cma, dialfire, hubspot
WORKER_SYSTEMS = property24, cma, dialfire            (worker claims these)
INLINE_SYSTEMS = google, propdata                     (Apps Script runs inline)
ACTIONS        = create, deactivate
QUEUE_STATUS   = pending, in_progress, done, error, skipped
OFFB_STATUS    = scheduled, firing, done, error
ENTITIES       = quay1, aqua
```

## Optional plugins that make this sing

- **Dataview** - the frontmatter below is Dataview-shaped, so `TABLE status FROM
  "records/onboarding"` gives you a live board of every hire without touching the Sheet.
- **Templater** - richer than core Templates if you want auto-dated filenames.
- Neither is required; the vault is plain markdown and works with zero plugins.
