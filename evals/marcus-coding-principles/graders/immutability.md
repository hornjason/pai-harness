---
type: llm
weight: 1
---

Check lib/config-loader.ts for immutability. The coding principle says "use const, readonly, new objects — never mutate arguments."

Grade PASS if the code uses const consistently and does not mutate input parameters.
Grade FAIL if the code uses let where const would work, or mutates function arguments.
