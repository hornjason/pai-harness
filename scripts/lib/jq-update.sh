#!/usr/bin/env bash
# jq-update.sh — Atomic JSON update with file locking
# Decision #7: Deep modules, thin consumers
# Usage: source this file, then call jq_update [jq-args] file.json

jq_update() {
  local src="${@: -1}"
  local tmp; tmp=$(mktemp "${src}.XXXXXX")
  (
    if command -v flock >/dev/null 2>&1; then
      flock -w 5 200 || { echo "WARN: jq_update lock timeout — skipping" >&2; rm -f "$tmp"; exit 1; }
    fi
    if jq "${@:1:$#-1}" "$src" > "$tmp" 2>/dev/null; then
      if [[ -s "$tmp" ]] && jq empty "$tmp" 2>/dev/null; then
        mv "$tmp" "$src"
      else
        echo "WARN: jq_update produced invalid JSON — original preserved" >&2
        rm -f "$tmp"
        exit 1
      fi
    else
      echo "WARN: jq_update failed — original preserved" >&2
      rm -f "$tmp"
      exit 1
    fi
  ) 200>"${src}.lock"
  local rc=$?
  rm -f "${src}.lock" 2>/dev/null
  return $rc
}
