---
doc-type: guide
status: active
owner: jason
updated: 2026-09-01
---

# Project Rules

- Never deploy on Fridays; this is a hard rule.
- The auth module must always be imported before the db module.
- All API responses must include a requestId header.
- Do not modify the migration files after they have been applied; intentional constraint.
