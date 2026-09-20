---
doc-type: reference
status: active
owner: jason
updated: 2026-09-20
---

# Security Rules

- Never store secrets in source control
- All user input must be validated with Zod schemas at API boundary
- SQL queries must use parameterized statements, never string concatenation
- Authentication tokens expire after 24 hours
- Rate limiting on all public endpoints: 100 req/min default
- CORS whitelist: only known frontend origins
- Audit log all admin actions with actor, action, timestamp
- File uploads: validate MIME type, max 10MB, scan for malware
- Dependencies: run npm audit weekly, zero critical vulnerabilities
- HTTPS only in production — redirect HTTP to HTTPS
