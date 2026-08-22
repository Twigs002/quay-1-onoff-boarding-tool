---
system: propdata
executes: inline
api: yes
---

# propdata (PropData REST)

- home: Apps Script, REST to feeds-api.propdata.net; needs `api_key` + `vendor id` headers.
- BLOCKED on creds until provisioned (email api-support@propdata.net). Runs dry-run until
  `PROPDATA_LIVE=1` - logs the payload it WOULD send.
- create: POST agent. deactivate: remove/deactivate agent.
