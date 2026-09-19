# Security Rules

## Input Validation

- Validate all external inputs before processing
- Use schema validation (Zod) for request bodies
- Sanitize strings to prevent injection attacks
- Reject requests with unexpected Content-Type headers

## Authentication

- Use bearer tokens for API authentication
- Validate token signatures on every request
- Expire tokens after 24 hours maximum
- Never store plaintext passwords

## Secrets Management

- All secrets must come from environment variables
- Never commit secrets to version control
- Use .env.example for documenting required variables
- Rotate secrets quarterly at minimum

## Logging

- Never log authentication tokens or passwords
- Redact PII from log output
- Include request IDs in all log entries
