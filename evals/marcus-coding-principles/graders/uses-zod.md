---
type: llm
weight: 2
---
Check if lib/config-loader.ts uses Zod for input validation. The code should import from "zod" and use z.object(), z.string(), z.number(), or z.boolean() to define a schema.

Grade PASS if Zod is used for validation.
Grade FAIL if the code validates without Zod (manual checks, no schema).
