# Plugin Eval Setup

## Prerequisites

1. Claude Code v2.1.269+
2. GCP credentials (for Vertex AI users)

## First-time setup (Vertex AI)

The eval sandbox strips GCP application default credentials. Fix:

```bash
# 1. Copy ADC file to project (gitignored)
cp ~/.config/gcloud/application_default_credentials.json evals/.gcp-adc.json

# 2. Add to ~/.claude/settings.json env block:
#    "GOOGLE_APPLICATION_CREDENTIALS": "/Users/jhorn/Projects/rungate/evals/.gcp-adc.json"
#    "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB": "0"

# 3. Remove SSH symlink if present (sandbox can't handle symlinks in ~/.ssh)
rm ~/.ssh/ssh_auth_sock 2>/dev/null
echo "was symlink to ~/.ssh/agent/..." > ~/.ssh/ssh_auth_sock.removed
```

## Running evals

```bash
# All cases, 1 run, no baseline comparison
claude plugin eval . --runs 1 --ablation none --trust-plugin \
  --allow-tools "Write" "Edit" --no-publish

# All cases, 3 runs, with baseline delta
claude plugin eval . --trust-plugin --allow-tools "Write" "Edit" --no-publish

# Single case
claude plugin eval . --case marcus-no-cat --runs 1 --ablation none \
  --trust-plugin --allow-tools "Write" "Edit" --no-publish

# With Bash (requires no SSH symlinks in ~/.ssh)
claude plugin eval . --trust-plugin --allow-tools "Write" "Edit" "Bash" --no-publish

# CI mode
claude plugin eval . --trust-plugin --threshold 0.7 --json results.json \
  --allow-tools "Write" "Edit" --no-publish --max-cost-usd 5
```

## Eval cases

| Case | COMP | What it tests | Graders |
|------|------|--------------|---------|
| marcus-no-cat | COMP-7 | Uses Read tool, not cat/head/tail | tool_used + llm |
| marcus-reads-before-edit | COMP-12 | Reads file before editing | tool_order + tool_used |
| serena-analysis-only | — | No code writes, provides analysis | tool_used (min:0/max:0) + llm |

## Adding new cases

```
evals/
├── my-new-case/
│   ├── prompt.md          # frontmatter: max_turns, allowed_tools, tags
│   ├── case.yaml          # scaffold_script, context
│   └── graders/
│       ├── my-check.md    # type: tool_used|tool_order|regex|file_exists|llm
│       └── quality.md     # type: llm with PASS/FAIL rubric
└── scaffold-workspace.sh  # shared scaffold for all cases
```

Grader schema reference: see EVAL-FORMAT.md (restore from git: `git show 2300cef0:evals/EVAL-FORMAT.md`)

## Troubleshooting

- **"Could not load Google Cloud credentials"** — Run first-time setup above
- **"SSH credential store holds a symbolic link"** — Remove `~/.ssh/ssh_auth_sock` symlink
- **"CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set"** — Set to "0" in `~/.claude/settings.json`
- **Only EVAL_* env vars in case.yaml** — Auth vars must be in operator's shell or settings.json
- **PostToolUse hook corrupts eval files** — Write eval files via `cat >` in Bash, not Write tool
