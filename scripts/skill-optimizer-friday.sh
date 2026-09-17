#!/bin/bash
# PAI Skill Optimizer — Friday run
# Auto-discovers all promoted skills (excluding _PROPOSED, _RATE, _DEBRIEF),
# builds benchmarks if missing, then optimizes each skill (5 rounds).
# Crontab: 15 21 * * 5 (Fridays 9:15pm)

set -euo pipefail

# Cron runs with a minimal PATH — add user bin dirs so claude + bun are findable
export PATH="/Users/jhorn/.local/bin:/Users/jhorn/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

BUN="/Users/jhorn/.bun/bin/bun"
BASE="/Users/jhorn/.claude"
LOG="$BASE/MEMORY/LEARNING/SIGNALS/skill-optimizer.log"

echo "[$(date)] Skill optimizer starting" >> "$LOG"

cd "$BASE"

# Benchmark filename lookup — backward-compat for original skills, slug-based for new ones
benchmark_for_skill() {
  local skill_name="$1"
  case "$skill_name" in
    debugging-and-bug-fixes)   echo "skill-benchmark.json" ;;
    dev-loop)                  echo "skill-benchmark-devloop.json" ;;
    testing-and-qa-validation) echo "skill-benchmark-qa.json" ;;
    Developer)                 echo "skill-benchmark-developer.json" ;;
    *)                         echo "skill-benchmark-${skill_name}.json" ;;
  esac
}

# Discover all promoted skills (directories under skills/ with a SKILL.md,
# excluding _PROPOSED, _RATE, _DEBRIEF, and hidden dirs)
SKILLS_FOUND=()
for skill_dir in "$BASE/skills"/*/; do
  skill_name="$(basename "$skill_dir")"
  # Skip excluded dirs
  case "$skill_name" in
    _PROPOSED|_RATE|_DEBRIEF) continue ;;
    _*) continue ;;
  esac
  # Must have a SKILL.md
  if [ ! -f "$skill_dir/SKILL.md" ]; then
    continue
  fi
  SKILLS_FOUND+=("$skill_name")
done

echo "[$(date)] Discovered ${#SKILLS_FOUND[@]} skills: ${SKILLS_FOUND[*]}" >> "$LOG"

# Build benchmarks for any skill that lacks one
for skill_name in "${SKILLS_FOUND[@]}"; do
  bench_file="$(benchmark_for_skill "$skill_name")"
  bench_path="$BASE/MEMORY/LEARNING/STATE/$bench_file"

  if [ ! -f "$bench_path" ]; then
    echo "[$(date)] Building benchmark: $skill_name -> $bench_file" >> "$LOG"
    "$BUN" "$BASE/PAI/Tools/SkillBenchmark.ts" \
      --skill "$skill_name" \
      --output "$bench_path" >> "$LOG" 2>&1 || \
      echo "[$(date)] WARN: benchmark failed for $skill_name" >> "$LOG"
  fi
done

# Optimize each skill — 5 rounds each
for skill_name in "${SKILLS_FOUND[@]}"; do
  skill_path="skills/$skill_name/SKILL.md"
  bench_file="$(benchmark_for_skill "$skill_name")"
  benchmark_path="MEMORY/LEARNING/STATE/$bench_file"

  if [ -f "$BASE/$skill_path" ] && [ -f "$BASE/$benchmark_path" ]; then
    echo "[$(date)] Optimizing $skill_name..." >> "$LOG"
    "$BUN" "$BASE/PAI/Tools/SkillOptimizer.ts" \
      --skill "$skill_path" \
      --benchmark "$benchmark_path" \
      --rounds 5 >> "$LOG" 2>&1 || echo "[$(date)] WARN: $skill_name optimization failed" >> "$LOG"
  else
    echo "[$(date)] SKIP: $skill_name — missing skill or benchmark" >> "$LOG"
    [ ! -f "$BASE/$skill_path" ] && echo "[$(date)]   Missing: $BASE/$skill_path" >> "$LOG"
    [ ! -f "$BASE/$benchmark_path" ] && echo "[$(date)]   Missing: $BASE/$benchmark_path" >> "$LOG"
  fi
done

# Run impact analyzer for before/after comparison
echo "[$(date)] Running ImpactAnalyzer..." >> "$LOG"
"$BUN" "$BASE/PAI/Tools/ImpactAnalyzer.ts" >> "$LOG" 2>&1 || true

echo "[$(date)] Skill optimizer complete" >> "$LOG"
