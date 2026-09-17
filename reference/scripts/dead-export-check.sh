#!/bin/bash
set -euo pipefail

PROJECT_ROOT="${1:-.}"
SRC_DIR="$PROJECT_ROOT/src"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "No src/ directory found at $PROJECT_ROOT"
  exit 0
fi

dead_count=0
dead_list=()

ts_files=$(find "$SRC_DIR" \( -name '*.ts' -o -name '*.tsx' \) \
  ! -name '*.d.ts' ! -name '*.test.*' ! -name '*.spec.*' | sort)

while IFS= read -r file; do
  [[ -z "$file" ]] && continue

  basename_file=$(basename "$file")
  # Skip barrel files — they re-export, not consume
  [[ "$basename_file" == "index.ts" || "$basename_file" == "index.tsx" ]] && continue

  rel_file="${file#$PROJECT_ROOT/}"

  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    # Skip short names (single char) — too many false positives from grep
    [[ ${#name} -lt 2 ]] && continue

    import_count=$(grep -rl --include='*.ts' --include='*.tsx' \
      -e "import.*[{ ,]${name}[} ,]" \
      -e "import ${name} " \
      -e "import ${name}," \
      "$SRC_DIR" 2>/dev/null \
      | grep -v "$file" \
      | grep -v '\.d\.ts' \
      | wc -l | tr -d ' ')

    if [[ "$import_count" -eq 0 ]]; then
      dead_count=$((dead_count + 1))
      dead_list+=("$rel_file: $name")
    fi
  done < <(
    grep -oE 'export (function|const|class|interface|type|enum) ([A-Za-z_][A-Za-z0-9_]*)' "$file" 2>/dev/null \
      | sed 's/export [a-z]* //'
    grep -oE 'export \{ *([A-Za-z_][A-Za-z0-9_]*)' "$file" 2>/dev/null \
      | sed 's/export { *//'
  )

done <<< "$ts_files"

if [[ $dead_count -gt 0 ]]; then
  echo "DEAD EXPORTS: $dead_count found"
  printf '%s\n' "${dead_list[@]}"
  exit 1
else
  echo "No dead exports found"
  exit 0
fi
