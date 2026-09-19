# Coding Standards

## TypeScript Conventions

- Use strict mode in all TypeScript files
- Prefer `const` over `let`; never use `var`
- All functions must have explicit return type annotations
- Use descriptive variable names; avoid single-letter names except in loops
- Prefer early returns over nested conditionals

## Error Handling

- Always catch and handle errors explicitly
- Use typed error classes for domain-specific failures
- Log errors with context (function name, input values)
- Never swallow errors silently

## Code Organization

- One export per file for primary modules
- Group related utilities in a single file
- Keep files under 200 lines
