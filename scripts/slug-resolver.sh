#!/usr/bin/env bash
# slug-resolver.sh — Maps repo identifier to short slug. Deterministic — no LLM judgment.
# Usage: bash slug-resolver.sh <repo-identifier>
# Input: "hornjason/pai-config" or "hornjason/asaCommandCenter" or full git URL
# Output: short name (e.g., "pai", "ddb")
# Thin caller — mapping logic lives in scripts/lib/resolve-slug.sh
set -euo pipefail

REPO="${1:?Usage: slug-resolver.sh <repo-identifier>}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-slug.sh"

resolve_slug_from_repo "$REPO"
