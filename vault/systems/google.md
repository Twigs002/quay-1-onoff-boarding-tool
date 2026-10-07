---
system: google
executes: inline        # Apps Script runs this, not the worker
api: yes
---

# google (Google Workspace)

The **linchpin** - created first; everything else keys off the Quay1 address. Property24
auto-links when the broker later logs in with the Quay1 gmail.

- create: `AdminDirectory.Users.insert` `name@quay1.co.za` (fallback `name.surname@`),
  temp pw `G{First}@002`, changePasswordAtNextLogin=true; then `Members.insert` per group.
- deactivate: `Users.update {suspended:true}`, remove group memberships, transfer/revoke Drive.
- runs INLINE in Apps Script and is written to the queue as `done`/`error` for audit.

Backlinks below show every hire/leaver/incident that touched Google.
