# resolve-slug.sh — Shared slug resolution functions.
# Source this file; do not execute directly.
# No shebang, no set -euo — inherited from caller.

# resolve_slug_from_path(abs_path) — converts work dir path to relative slug.
# Example: /Users/jhorn/.pai-work/pai/361 -> pai/361
resolve_slug_from_path() {
  local abs_path="$1"
  local work_dir="${PAI_WORK_DIR:-${HOME}/.pai-work}"
  echo "${abs_path#${work_dir}/}"
}

# resolve_slug_from_repo(repo_identifier) — maps repo to short prefix.
# Input: "hornjason/pai-config" or full git URL.
# Output: short name (e.g., "pai", "ddb").
# Returns 1 on unknown repo.
resolve_slug_from_repo() {
  local repo="$1"
  # Strip URL prefix if present
  repo=$(echo "$repo" | sed 's|.*github.com[:/]||' | sed 's|\.git$||')
  case "$repo" in
    hornjason/pai-config)            echo "pai" ;;
    hornjason/asaCommandCenter)      echo "ddb" ;;
    hornjason/daily-brief-dashboard) echo "ddb" ;;
    *)
      echo "FAIL: unknown repo '$repo' — add mapping to scripts/lib/resolve-slug.sh" >&2
      return 1
      ;;
  esac
}
