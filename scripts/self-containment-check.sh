#!/bin/bash
# Self-containment check for rungate repo
# Run from repo root: bash scripts/self-containment-check.sh
# Exit 0 = clean, Exit 1 = leaks found

set -euo pipefail
FAIL=0

echo "=== Rungate Self-Containment Check ==="
echo ""

# 1. No external path references in production code
echo "1. External path references (production code only):"
EXTERNAL=$(grep -rn '/Users/jhorn\|~/.claude\|~/.pai' --include="*.ts" --include="*.js" . 2>/dev/null \
  | grep -v node_modules | grep -v ".git/" | grep -v "test/" | grep -v "reference/" \
  | grep -v " \* \|^.*://\|// " || true)
if [ -n "$EXTERNAL" ]; then
  echo "   FAIL — found external paths:"
  echo "$EXTERNAL" | sed 's/^/   /'
  FAIL=1
else
  echo "   PASS — zero external paths in production code"
fi
echo ""

# 2. No old name references
echo "2. Old name references (pai-work, PAI_WORK_DIR, project-harness, pai-harness):"
OLD_NAMES=$(grep -rn 'pai-work\|PAI_WORK_DIR\|project-harness\|pai-harness' \
  --include="*.ts" --include="*.js" --include="*.json" --include="*.sh" . 2>/dev/null \
  | grep -v node_modules | grep -v ".git/" | grep -v "reference/migration" \
  | grep -v "RUNGATE_WORK_DIR.*PAI_WORK_DIR" \
  | grep -v "fallback\|legacy\|deprecated" \
  | grep -v "self-containment-check" || true)
if [ -n "$OLD_NAMES" ]; then
  echo "   FAIL — found old names:"
  echo "$OLD_NAMES" | sed 's/^/   /'
  FAIL=1
else
  echo "   PASS — zero old name references"
fi
echo ""

# 3. Old names in specs/docs
echo "3. Old name references in specs/docs:"
OLD_DOCS=$(grep -rn 'pai-work\|PAI_WORK_DIR\|project-harness\|pai-harness' \
  --include="*.md" . 2>/dev/null \
  | grep -v node_modules | grep -v ".git/" | grep -v "reference/migration" || true)
if [ -n "$OLD_DOCS" ]; then
  echo "   FAIL — found old names in docs:"
  echo "$OLD_DOCS" | wc -l | xargs -I{} echo "   {} references remaining"
  FAIL=1
else
  echo "   PASS — zero old name references in docs"
fi
echo ""

# 4. Agent briefs exist
echo "4. Agent briefs in .claude/agents/:"
for agent in marcus quinn rook serena aditi; do
  if [ -f ".claude/agents/${agent}.md" ]; then
    echo "   PASS — ${agent}.md exists"
  else
    echo "   FAIL — ${agent}.md missing"
    FAIL=1
  fi
done
echo ""

# 5. Prompt templates exist
echo "5. Prompt templates in prompts/:"
if [ -d "prompts" ] && [ "$(ls prompts/*.md 2>/dev/null | wc -l)" -gt 0 ]; then
  echo "   PASS — $(ls prompts/*.md | wc -l) templates found"
else
  echo "   WARN — no prompts/ directory or no templates"
fi
echo ""

# 6. Package.json name
echo "6. Package name:"
PKG_NAME=$(python3 -c "import json; print(json.load(open('package.json'))['name'])" 2>/dev/null)
if [ "$PKG_NAME" = "rungate" ]; then
  echo "   PASS — package.json name is 'rungate'"
else
  echo "   FAIL — package.json name is '${PKG_NAME}', expected 'rungate'"
  FAIL=1
fi
echo ""

# 7. Config file name
echo "7. Config file:"
if [ -f ".claude/rungate.json" ]; then
  echo "   PASS — .claude/rungate.json exists"
elif [ -f ".claude/project-harness.json" ]; then
  echo "   FAIL — still using project-harness.json (not renamed)"
  FAIL=1
else
  echo "   WARN — no config file found"
fi
echo ""

# Summary
echo "=== Summary ==="
if [ $FAIL -eq 0 ]; then
  echo "PASS — repo is self-contained"
  exit 0
else
  echo "FAIL — leaks found (see above)"
  exit 1
fi
