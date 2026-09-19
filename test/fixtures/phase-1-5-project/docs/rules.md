# Development Rules

All contributors must follow these guidelines when working in this repository.

## Code Quality

- You must write tests for every new function
- Never commit code without running the test suite
- Always use TypeScript strict mode
- Functions must have explicit return types
- Never use `any` as a type annotation

## Security

- You must sanitize all user inputs
- Never log sensitive data to stdout
- Always validate environment variables at startup
- Secret values must come from environment, never hardcoded

## Process

- Every PR must have at least one approval
- Always run linting before committing
- Never force-push to the main branch
