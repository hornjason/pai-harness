#!/bin/bash
# One-time overnight skill synthesis + optimization run
# Crontab: 15 21 24 4 * (fires once tonight — April 24 at 9:15pm)

set -euo pipefail

BUN="/Users/jhorn/.bun/bin/bun"
BASE="/Users/jhorn/.claude"
REPORTS_DIR="$BASE/MEMORY/LEARNING/REPORTS"
LOG="$REPORTS_DIR/skill-synthesis-$(date +%Y%m%d).md"

mkdir -p "$REPORTS_DIR"

echo "## Skill Synthesis Run — $(date)" >> "$LOG"
echo "" >> "$LOG"

# Step 1: Synthesize + auto-promote
echo "### Step 1: Synthesize + Auto-Promote" >> "$LOG"
echo "Skills: infrastructure-and-devops, product-feature-development" >> "$LOG"
echo "" >> "$LOG"

"$BUN" "$BASE/PAI/Tools/SkillSynthesizer.ts" \
  --skills "infrastructure-and-devops,product-feature-development" 2>&1 | tee -a "$LOG"

echo "" >> "$LOG"

# Step 2: Build benchmarks for newly promoted skills
echo "### Step 2: Build Benchmarks" >> "$LOG"

for skill_name in infrastructure-and-devops product-feature-development; do
  bench="$BASE/MEMORY/LEARNING/STATE/skill-benchmark-${skill_name}.json"
  if [ ! -f "$bench" ]; then
    echo "Building benchmark: $skill_name" >> "$LOG"
    cd "$BASE"
    "$BUN" "$BASE/PAI/Tools/SkillBenchmark.ts" \
      --skill "$skill_name" --output "$bench" 2>&1 | tee -a "$LOG" || \
      echo "WARN: benchmark failed for $skill_name" >> "$LOG"
  else
    echo "Benchmark already exists: $bench — skipping" >> "$LOG"
  fi
done

echo "" >> "$LOG"

# Step 3: Optimize (5 rounds each)
echo "### Step 3: Optimize Skills" >> "$LOG"

for skill_name in infrastructure-and-devops product-feature-development; do
  skill_path="skills/$skill_name/SKILL.md"
  bench="$BASE/MEMORY/LEARNING/STATE/skill-benchmark-${skill_name}.json"

  if [ -f "$BASE/$skill_path" ] && [ -f "$bench" ]; then
    echo "Optimizing: $skill_name" >> "$LOG"
    cd "$BASE"
    "$BUN" "$BASE/PAI/Tools/SkillOptimizer.ts" \
      --skill "$skill_path" --benchmark "$bench" --rounds 5 2>&1 | tee -a "$LOG" || \
      echo "WARN: optimizer failed for $skill_name" >> "$LOG"
  else
    echo "SKIP: $skill_name — skill or benchmark missing" >> "$LOG"
    [ ! -f "$BASE/$skill_path" ] && echo "  Missing: $BASE/$skill_path" >> "$LOG"
    [ ! -f "$bench" ] && echo "  Missing: $bench" >> "$LOG"
  fi
done

echo "" >> "$LOG"
echo "## Complete: $(date)" >> "$LOG"
