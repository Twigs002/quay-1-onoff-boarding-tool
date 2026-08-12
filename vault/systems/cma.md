---
system: cma
executes: worker
api: no
status: stub          # OTP/2FA gated - provisioner returns `skipped`, not fake success
---

# cma (cmainfo.co.za)

- home: worker. create/disable user via browser, but **OTP/2FA gated** - headless can't solve
  it, so the provisioner returns `skipped` with a TODO (distinct from `error`).
- only provisioned when the Quay1 `cma` program is ticked.
- see the parked `cma-lookup` work for the OTP path.
