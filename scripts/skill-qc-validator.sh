#!/usr/bin/env bash
# skill-qc-validator.sh — Data-driven QC validator
# Reads check definitions from skill-qc-checks.json, runs them generically.
# The script never hardcodes skill names — all skill-specific logic lives in the JSON config.
#
# Usage: skill-qc-validator.sh --skill SKILL --issue NUM --slug SLUG [--repo REPO] [--project-root PATH]
set -u

# ─── Arg parsing ───────────────────────────────────────────────
SKILL="" ISSUE="" SLUG="" REPO="hornjason/pai-config" PROJECT_ROOT="$HOME/.claude"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skill)        SKILL="$2"; shift 2 ;;
    --issue)        ISSUE="$2"; shift 2 ;;
    --slug)         SLUG="$2"; shift 2 ;;
    --repo)         REPO="$2"; shift 2 ;;
    --project-root) PROJECT_ROOT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SKILL" || -z "$ISSUE" || -z "$SLUG" ]]; then
  echo "Usage: skill-qc-validator.sh --skill SKILL --issue NUM --slug SLUG [--repo REPO] [--project-root PATH]" >&2
  exit 1
fi

WORK_DIR="${RUNGATE_WORK_DIR:-$HOME/.rungate}/$SLUG"

# Auto-detect repo from workflow-state.json if not explicitly provided
if [[ "$REPO" == "hornjason/pai-config" && -f "$WORK_DIR/workflow-state.json" ]]; then
  DETECTED_REPO=$(jq -r '.issueRepo // .repo // empty' "$WORK_DIR/workflow-state.json" 2>/dev/null)
  if [[ -n "$DETECTED_REPO" ]]; then
    REPO="$DETECTED_REPO"
  fi
fi

CONFIG="$(cd "$(dirname "$0")/.." && pwd)/schemas/skill-qc-checks.json"

# Fallback: try home dir
if [[ ! -f "$CONFIG" ]]; then
  CONFIG="$HOME/.claude/schemas/skill-qc-checks.json"
fi

[[ -f "$CONFIG" ]] || { echo "ERROR: Config not found: $CONFIG" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required" >&2; exit 1; }

# ─── Temp dir for jq filter files ──────────────────────────────
QC_TMPDIR=$(mktemp -d)
trap 'rm -rf "$QC_TMPDIR"' EXIT

# ─── Counters ──────────────────────────────────────────────────
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
WARN_COUNT=0

# ─── Variable substitution in command strings ──────────────────
subst_vars() {
  local s="$1"
  s="${s//\$ISSUE/$ISSUE}"
  s="${s//\$SLUG/$SLUG}"
  s="${s//\$REPO/$REPO}"
  s="${s//\$WORK_DIR/$WORK_DIR}"
  s="${s//\$PROJECT_ROOT/$PROJECT_ROOT}"
  printf '%s' "$s"
}

# ─── Run jq filter from string (avoids shell quoting issues) ──
run_jq_filter() {
  local filter="$1" file="$2"
  printf '%s\n' "$filter" > "$QC_TMPDIR/jqf"
  jq -rf "$QC_TMPDIR/jqf" "$file" 2>/dev/null
}

# ─── Result recording ─────────────────────────────────────────
do_result() {
  local status="$1" id="$2" desc="$3" sev="$4" detail="$5"

  # WARN severity always prints WARN regardless of pass/fail
  if [[ "$sev" == "WARN" ]]; then
    if [[ -n "$detail" ]]; then
      printf "%-4s WARN  %s -- %s\n" "$id" "$desc" "$detail"
    else
      printf "%-4s WARN  %s\n" "$id" "$desc"
    fi
    WARN_COUNT=$((WARN_COUNT + 1))
    return
  fi

  if [[ "$status" == "PASS" ]]; then
    printf "%-4s PASS  %s\n" "$id" "$desc"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    if [[ -n "$detail" ]]; then
      printf "%-4s FAIL  %s -- %s\n" "$id" "$desc" "$detail"
    else
      printf "%-4s FAIL  %s\n" "$id" "$desc"
    fi
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

do_skip() {
  local id="$1" desc="$2"
  printf "%-4s SKIP  %s\n" "$id" "$desc"
  SKIP_COUNT=$((SKIP_COUNT + 1))
}

# ─── Expect evaluation for command-type checks ────────────────
eval_expect() {
  local op="$1" value="$2" raw_output="$3" exit_code="$4"
  local trimmed
  trimmed=$(printf '%s' "$raw_output" | tail -1 | tr -d '[:space:]')

  case "$op" in
    exit-0)
      [[ "$exit_code" -eq 0 ]]
      ;;
    non-empty)
      [[ -n "$trimmed" ]]
      ;;
    contains)
      printf '%s' "$raw_output" | grep -qF "$value"
      ;;
    ">=")
      local num="${trimmed:-0}"
      # Ensure numeric
      [[ "$num" =~ ^-?[0-9]+$ ]] || num=0
      [[ "$num" -ge "${value:-0}" ]] 2>/dev/null
      ;;
    "==")
      [[ "$trimmed" == "$value" ]]
      ;;
    "!=")
      [[ "$trimmed" != "$value" ]]
      ;;
    *)
      return 1
      ;;
  esac
}

# ─── Verify checks exist for this skill ───────────────────────
check_count=$(jq "[.checks[] | select(.skill == \"$SKILL\")] | length" "$CONFIG")
if [[ "$check_count" -eq 0 ]]; then
  echo "No checks found for skill: $SKILL" >&2
  exit 1
fi

echo "=== Skill QC: $SKILL ($check_count checks) ==="

# ─── Main loop: process each check ────────────────────────────
while IFS= read -r check || [[ -n "$check" ]]; do
  id=$(jq -r '.id' <<< "$check")
  desc=$(jq -r '.description' <<< "$check")
  chk_type=$(jq -r '.type' <<< "$check")
  severity=$(jq -r '.severity // "FAIL"' <<< "$check")

  # ── Skip gate-runner checks when called from within a gate (prevents recursion) ──
  chk_cmd=$(jq -r '.command // empty' <<< "$check")
  if [[ -n "${GATE_RUNNER_ACTIVE:-}" && "$chk_cmd" == *"gate-runner.sh"* ]]; then
    do_skip "$id" "$desc (gate-runner recursion guard)"
    continue
  fi

  # ── Evaluate skipWhen ──
  skip_kind=$(jq -r '.skipWhen | type' <<< "$check")
  if [[ "$skip_kind" == "object" ]]; then
    skip_cmd=$(jq -r '.skipWhen.command // empty' <<< "$check")
    if [[ -n "$skip_cmd" ]]; then
      skip_cmd=$(subst_vars "$skip_cmd")
      if eval "$skip_cmd" 2>/dev/null; then
        do_skip "$id" "$desc"
        continue
      fi
    fi
  fi

  # ── Run check by type ──
  case "$chk_type" in

    command)
      cmd=$(jq -r '.command' <<< "$check")
      cmd=$(subst_vars "$cmd")
      op=$(jq -r '.expect.op' <<< "$check")
      value=$(jq -r '.expect.value // empty' <<< "$check")

      raw_output=$(eval "$cmd" 2>/dev/null)
      cmd_exit=$?

      if eval_expect "$op" "$value" "$raw_output" "$cmd_exit"; then
        do_result "PASS" "$id" "$desc" "$severity" ""
      else
        # Build detail from output
        detail_line=$(printf '%s' "$raw_output" | tail -1 | tr -d '[:space:]')
        case "$op" in
          ">="| "=="|"!=") do_result "FAIL" "$id" "$desc" "$severity" "got $detail_line" ;;
          contains)        do_result "FAIL" "$id" "$desc" "$severity" "output missing expected string" ;;
          non-empty)       do_result "FAIL" "$id" "$desc" "$severity" "empty output" ;;
          exit-0)          do_result "FAIL" "$id" "$desc" "$severity" "exit code $cmd_exit" ;;
          *)               do_result "FAIL" "$id" "$desc" "$severity" "" ;;
        esac
      fi
      ;;

    jq)
      source_name=$(jq -r '.source' <<< "$check")
      query=$(jq -r '.query' <<< "$check")
      op=$(jq -r '.expect.op' <<< "$check")
      value=$(jq -r '.expect.value // empty' <<< "$check")
      source_file="$WORK_DIR/$source_name"

      if [[ ! -f "$source_file" ]]; then
        do_result "FAIL" "$id" "$desc" "$severity" "source file not found: $source_name"
        continue
      fi

      result=$(run_jq_filter "$query" "$source_file")

      case "$op" in
        not-null)
          if [[ "$result" != "null" && -n "$result" ]]; then
            do_result "PASS" "$id" "$desc" "$severity" ""
          else
            do_result "FAIL" "$id" "$desc" "$severity" "got null"
          fi
          ;;
        length-gte)
          result_clean=$(printf '%s' "$result" | tr -d '[:space:]')
          if [[ ${#result_clean} -ge ${value:-0} ]]; then
            do_result "PASS" "$id" "$desc" "$severity" ""
          else
            do_result "FAIL" "$id" "$desc" "$severity" "length ${#result_clean} < $value"
          fi
          ;;
        *)
          do_result "FAIL" "$id" "$desc" "$severity" "unknown jq op: $op"
          ;;
      esac
      ;;

    jq-count)
      source_name=$(jq -r '.source' <<< "$check")
      query=$(jq -r '.query' <<< "$check")
      op=$(jq -r '.expect.op' <<< "$check")
      value=$(jq -r '.expect.value // empty' <<< "$check")
      source_file="$WORK_DIR/$source_name"

      if [[ ! -f "$source_file" ]]; then
        do_result "FAIL" "$id" "$desc" "$severity" "source file not found: $source_name"
        continue
      fi

      count=$(run_jq_filter "$query | length" "$source_file")
      count="${count:-0}"
      [[ "$count" =~ ^[0-9]+$ ]] || count=0

      if eval_expect "$op" "$value" "$count" "0"; then
        do_result "PASS" "$id" "$desc" "$severity" ""
      else
        do_result "FAIL" "$id" "$desc" "$severity" "count=$count"
      fi
      ;;

    jq-each)
      source_name=$(jq -r '.source' <<< "$check")
      query=$(jq -r '.query' <<< "$check")
      test_kind=$(jq -r '.test' <<< "$check")
      source_file="$WORK_DIR/$source_name"

      if [[ ! -f "$source_file" ]]; then
        do_result "FAIL" "$id" "$desc" "$severity" "source file not found: $source_name"
        continue
      fi

      elements=$(run_jq_filter "$query" "$source_file")

      if [[ -z "$elements" ]]; then
        do_result "FAIL" "$id" "$desc" "$severity" "no elements returned by query"
        continue
      fi

      all_pass=true
      fail_detail=""

      while IFS= read -r elem; do
        [[ -z "$elem" ]] && continue

        if [[ "$elem" == "null" ]]; then
          all_pass=false
          fail_detail="null or missing field"
          break
        fi

        case "$test_kind" in
          file-exists)
            # Resolve relative paths against WORK_DIR
            check_path="$elem"
            if [[ "$check_path" != /* ]]; then
              check_path="$WORK_DIR/$check_path"
            fi
            if [[ ! -f "$check_path" ]]; then
              all_pass=false
              fail_detail="file not found: $elem"
              break
            fi
            ;;
          in-enum)
            found=false
            while IFS= read -r enum_val; do
              if [[ "$elem" == "$enum_val" ]]; then
                found=true
                break
              fi
            done < <(jq -r '.enum[]' <<< "$check")
            if ! $found; then
              all_pass=false
              fail_detail="'$elem' not in allowed enum"
              break
            fi
            ;;
          *)
            all_pass=false
            fail_detail="unknown test type: $test_kind"
            break
            ;;
        esac
      done <<< "$elements"

      if $all_pass; then
        do_result "PASS" "$id" "$desc" "$severity" ""
      else
        do_result "FAIL" "$id" "$desc" "$severity" "$fail_detail"
      fi
      ;;

    computed)
      source_name=$(jq -r '.source' <<< "$check")
      jq_test=$(jq -r '.jq_test' <<< "$check")
      source_file="$WORK_DIR/$source_name"

      if [[ ! -f "$source_file" ]]; then
        do_result "FAIL" "$id" "$desc" "$severity" "source file not found: $source_name"
        continue
      fi

      result=$(run_jq_filter "$jq_test" "$source_file")

      if [[ -z "$result" ]]; then
        do_result "FAIL" "$id" "$desc" "$severity" "jq evaluation failed"
      elif [[ "$result" == "PASS" ]]; then
        do_result "PASS" "$id" "$desc" "$severity" ""
      else
        do_result "FAIL" "$id" "$desc" "$severity" "computed: $result"
      fi
      ;;

    grep)
      source_name=$(jq -r '.source' <<< "$check")
      pattern=$(jq -r '.pattern' <<< "$check")
      op=$(jq -r '.expect.op' <<< "$check")
      value=$(jq -r '.expect.value // empty' <<< "$check")
      source_file="$WORK_DIR/$source_name"

      if [[ ! -f "$source_file" ]]; then
        do_result "FAIL" "$id" "$desc" "$severity" "source file not found: $source_name"
        continue
      fi

      pattern=$(subst_vars "$pattern")
      count=$(grep -c "$pattern" "$source_file" 2>/dev/null || echo "0")

      if eval_expect "$op" "$value" "$count" "0"; then
        do_result "PASS" "$id" "$desc" "$severity" ""
      else
        do_result "FAIL" "$id" "$desc" "$severity" "matches=$count"
      fi
      ;;

    file-exists)
      path=$(jq -r '.path' <<< "$check")
      path=$(subst_vars "$path")

      if [[ -f "$path" ]]; then
        do_result "PASS" "$id" "$desc" "$severity" ""
      else
        do_result "FAIL" "$id" "$desc" "$severity" "not found: $path"
      fi
      ;;

    *)
      do_result "FAIL" "$id" "$desc" "$severity" "unknown check type: $chk_type"
      ;;
  esac

done < <(jq -c ".checks[] | select(.skill == \"$SKILL\")" "$CONFIG")

# ─── Summary ──────────────────────────────────────────────────
echo ""
echo "$SKILL QC: $PASS_COUNT pass, $FAIL_COUNT fail, $SKIP_COUNT skip, $WARN_COUNT warn"
[[ $FAIL_COUNT -eq 0 ]]
