/**
 * The file extensions under a directory (#1200).
 *
 * A LEAF module, in the shape `lib/local-calendar-day.ts` and
 * `lib/readdir-sorted.ts` established: one exported binding, no relative
 * imports, so there is exactly one thing to mutate and every call site names
 * the same rule.
 *
 * ## Why this exists
 *
 * This was four lines, copied into all three of the scanners that build
 * CODE-MAP.md's `## Directory Structure` table —
 * `scripts/generate-code-map.ts`, `lib/scanner.ts` and
 * `generateCodeMapInline` in `lib/scaffold/steps.ts`:
 *
 *     const files = readdirSync(full, { recursive: true }).map(String);
 *     const exts = new Set(files.map(f => f.split(".").pop()).filter(Boolean));
 *     dirs.push({ name: entry, types: [...exts].slice(0, 5) });
 *
 * Every clause of that is wrong, and the shipped `CODE-MAP.md` said so:
 *
 *     | test/   | ts, unit, types, json, fixtures |
 *     | evals/  | marcus-tdd-order, marcus-tdd-vs-speed, marcus-surgical, … |
 *     | scripts/| ts, sh, git-hooks, lib, git-hooks/pre-push |
 *
 * - `readdirSync(…, { recursive: true })` returns **directories as well as
 *   files**, and `"unit".split(".").pop()` is `"unit"`. So every
 *   extensionless entry — every directory, every `LICENSE`, every
 *   `Makefile` — contributed its own name as a "type", and not one entry in
 *   the `evals/` row was a file type.
 * - Without `withFileTypes` the strings are **relative paths**, so the split
 *   ran on `git-hooks/pre-push` rather than on a basename.
 * - A leading dot does not open an extension. `.gitignore` yielded
 *   `gitignore`.
 * - `.slice(0, 5)` over a `Set` fed by a raw `readdirSync` is
 *   **filesystem-ordered**: five of N chosen by APFS or ext4, which is the
 *   defect `lib/readdir-sorted.ts` exists for, one indirection further in.
 *   Sorting here rather than at the three call sites is the same argument
 *   that file makes — one binding is one thing to forget.
 *
 * Measured on this repository, 10 of the 14 rows changed; `evals/` went from
 * five directory names to `json, md, sh, ts, yaml`.
 *
 * ## Why the cap stays
 *
 * `MAX_TYPES` bounds a table cell, and #1200 asked only that the five be
 * chosen deterministically rather than that they be all of them. Ascending
 * order is also the drift-resistant key: a file added to a directory cannot
 * move it, and only a brand-new extension can — unlike a frequency ranking,
 * which is the per-directory census #1163 removed wearing an indirection.
 *
 * Errors are NOT caught here. An unreadable tree is the caller's to decide
 * about, and all three callers already wrap this in the `try` that used to
 * hold the four lines; swallowing it would turn "could not read" into "has
 * no files", which is `.claude/rules/checks-must-be-able-to-fail.md`'s
 * fail-open shape.
 */
import { readdirSync } from "fs";

/** How many extensions a `Types` cell carries, at most. */
export const MAX_TYPES = 5;

export function fileExtensions(dir: string, limit: number = MAX_TYPES): string[] {
  const exts = new Set<string>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    // `entry.name` is a basename even under `recursive` — the directory part
    // is on `parentPath` — so this cannot pick up a path separator.
    const dot = entry.name.lastIndexOf(".");
    // `<= 0` covers both "no dot at all" and a dotfile like `.gitignore`,
    // whose leading dot does not open an extension.
    if (dot <= 0) continue;
    const ext = entry.name.slice(dot + 1);
    if (ext) exts.add(ext);
  }
  // Plain `.sort()`: lexicographic over UTF-16 code units is
  // locale-independent, unlike `localeCompare`. A generated file whose
  // contents depend on the runner's locale is the same defect in a different
  // coat (`lib/readdir-sorted.ts`).
  return [...exts].sort().slice(0, limit);
}
