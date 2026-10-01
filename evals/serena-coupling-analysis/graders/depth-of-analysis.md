---
type: llm
weight: 4
focus: last_message
---

PASS if the analysis answers all 4 questions with specific references to actual imports, function names, and types found in the code. The recommendation must cite concrete evidence (e.g., "conformity.ts imports X from scanner.ts" or "they share no imports").
FAIL if the analysis is generic architectural advice without referencing specific code, or if it skips any of the 4 questions, or if it makes claims about the code that aren't supported by what's actually in the files.
