# Claude Plugin Eval Format Reference (from official docs)

## Grader Types — Exact Schema

### tool_used (free)
```yaml
---
type: tool_used
tool: Bash           # tool name
input_match: "regex" # optional regex on JSON-encoded input
min: 1               # default 1 (min calls)
max: 999             # default unlimited
---
```
For "never called": `min: 0, max: 0`

### tool_order (free)
```yaml
---
type: tool_order
before: Read                    # simple: tool name
after: Write                    # simple: tool name
---
```
Or with input matching:
```yaml
---
type: tool_order
before:
  tool: Write
  input_match: "test/"
after:
  tool: Write
  input_match: "lib/"
---
```

### regex (free)
```yaml
---
type: regex
pattern: "z\\.object"
flags: i                        # optional
match: contains                 # contains | not_contains | "count:N"
target: last_message            # last_message | trace | files | { source: file, path: "lib/foo.ts" }
---
```

### file_exists (free)
```yaml
---
type: file_exists
path: "lib/slug.ts"
exists: true
---
```

### llm (paid, 3-vote majority)
```yaml
---
type: llm
weight: 2                       # optional
focus: trace                    # last_message | trace | files | { source: file, path: "..." }
---

PASS if <concrete condition>.
FAIL if <concrete condition>.
```

### baseline (paid)
```yaml
---
type: baseline
baseline_file: reference.jsonl
---

criteria: Agent produces equivalent output to the baseline.
```

## prompt.md Frontmatter
```yaml
---
max_turns: 15                   # up to 200
timeout_seconds: 300            # up to 3600
allowed_tools: [Read, Bash, Write, Edit]
model: claude-sonnet-5          # optional
tags: [marcus, tdd]             # for --tag filtering
runs: 3                         # default 3
env:                            # only EVAL_* keys allowed
  EVAL_FOO: bar
---
```

## Running
```bash
# Single case, 1 run, no baseline
claude plugin eval . --case marcus-tdd --runs 1 --ablation none --no-publish --allow-tools "Read,Bash,Write,Edit" --trust-plugin

# Full suite
claude plugin eval . --no-publish --allow-tools "Read,Bash,Write,Edit" --trust-plugin --threshold 0.8

# CI
claude plugin eval . --trust-plugin --json results.json --threshold 0.8 --model claude-sonnet-5 --no-publish --max-cost-usd 20
```

## Vertex AI Sandbox Fix
The eval sandbox strips env vars. For Vertex AI users:
```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/creds.json claude plugin eval ...
```
And temporarily set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0 in settings.json.
