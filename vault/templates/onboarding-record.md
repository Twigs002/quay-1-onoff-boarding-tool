---
type: onboarding
entity:            # quay1 | aqua   (ENTITIES)
name:
id_number:
personal_email:
contact:
start_date:        # YYYY-MM-DD
# assignment
division:
team:
designation:       # agent | senior_agent | candidate | admin
senior_name:
senior_email:
# quay1 only
deal_type:         # sale | rental (contract template)
commission:
programs: []       # cma, dialfire, whatsapp, training, other
# aqua only
agreement_type:    # monthly | fixed | permanent
end_date:          # required when agreement_type = fixed (span <= 6 months)
remuneration:
work_hours:
# join keys (fill from the Sheet / onboard response)
folderId:          # hidden key -> Onboarding row + Provisioning Queue col B
quay_email:        # provisioned Google address (col F) - the linchpin
# lifecycle
requested_by:      # forced from JWT server-side
status: requested  # requested | provisioning | complete | blocked
---

# {{title}}

> One hire. This note is the human audit trail for the Sheet row keyed on `folderId`.
> Created {{date}}.

## Contract
- [ ] Contract generated ([[systems/google|contract flow]] output) - link the PDF / folder
- folder: <folderUrl>
- pdf: <pdfUrl>

## FICA (self-service intake -> tracker ticks R..V)
- [ ] ID document
- [ ] Proof of address
- [ ] Bank confirmation
- [ ] Tax number
- [ ] SARS / other
- notes:

## Provisioning (per system - status from QUEUE_STATUS)
> Default Quay1 stack = google, propdata, property24. Add cma/dialfire when the program is
> ticked. Aqua defaults to google only. google/propdata run INLINE; the rest are worker rows.

| system | action | status | result (account id / error / dry_run) |
|--------|--------|--------|----------------------------------------|
| [[systems/google\|google]]         | create | pending | |
| [[systems/propdata\|propdata]]     | create | pending | |
| [[systems/property24\|property24]] | create | pending | |
| [[systems/cma\|cma]]               | create |         | (only if program ticked; OTP-gated) |
| [[systems/dialfire\|dialfire]]     | create |         | (only if program ticked) |

## Induction (Quay 1 only)
- [ ] Wednesday session booked - induction_wed:
- [ ] Thursday session booked - induction_thu:
- temp password delivered in induction email packet (email only, never WhatsApp)

## Timeline / notes
- {{date}} - created

## Links
- Related offboarding: [[ ]]
- Incidents: [[ ]]
