---
system: hubspot
executes: inline
api: yes
gated: HUBSPOT_SEAT_ENABLED   # default OFF - paid seat has licensing cost
---

# hubspot

- appears only in offboarding `systems_json`; handled INLINE by Apps Script (seat release).
- never a worker row.
- gated on `HUBSPOT_SEAT_ENABLED` (default 0) because a paid seat create/release costs money.
