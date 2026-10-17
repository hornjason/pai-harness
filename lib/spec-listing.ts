/**
 * Where a spec may be listed, and what counts as a spec (#382, #552).
 *
 * `refreshAgentsMd` warns when a file in `specs/` is not named in
 * `AGENTS.md`. D-15 capped AGENTS.md at 100 lines and moved the specs table
 * and the doc-routing table into `.claude/rules/`, and neither check
 * followed. So both have warned on every `--fix` run since: 23 spec
 * filenames on this repo, plus `CODE-MAP.md exists but not referenced`,
 * every single time.
 *
 * **Both are unfixable from the document's side**, which is what makes them
 * worse than noise. Satisfying `UNLISTED specs` means pasting 23 filenames
 * back into AGENTS.md, which breaks the line cap D-15 moved them out to
 * respect — the detector asking for the thing the architecture forbids. A
 * consumer who adds the table by hand gets it deleted by the next
 * `REGENERATED: AGENTS.md`, so the warning cannot be cleared at all.
 *
 * A standing false positive trains readers past the whole class. #380
 * measured the neighbouring check at a true-positive rate of **zero** for
 * the same underlying reason, and nobody had noticed in months because the
 * output was always noisy.
 *
 * ## Is `SPEC-TEMPLATE.md` a spec?
 *
 * **No, and this module is where that is decided.** It is the file
 * `create-spec` copies to start a new spec; it governs nothing and a reader
 * sent to it by a routing table learns nothing about the project. The
 * scanner has always excluded it from `specs-routing.md`, and the audit has
 * always included it — which is how it ended up in the warning list as the
 * one entry that was never going to be listed anywhere.
 *
 * It is a decision rather than a lookup, so it lives in one named constant
 * that both sides import, rather than being absorbed by whichever file a
 * check happens to read.
 *
 * ## Why the surfaces are a directory and not a filename
 *
 * `listingSurfaces` searches AGENTS.md and every `.claude/rules/*.md`, not
 * `.claude/rules/specs-routing.md` by name. The generator chooses that
 * filename and a check that hard-codes it is a second decider for the same
 * question — the shape that put this defect here. A rule file renamed by the
 * generator stays covered; a spec listed in no agent-facing document at all
 * is still reported, which is the half that has to keep working.
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Files that live in `specs/` and are not specs. See the module docstring —
 * this is a judgement, and it is deliberately a list of exact names rather
 * than a pattern, so adding to it is a visible decision.
 */
export const NON_SPEC_FILES: readonly string[] = ["SPEC-TEMPLATE.md"];

export function isSpecFile(name: string): boolean {
  return name.endsWith(".md") && !NON_SPEC_FILES.includes(name);
}

/** Top-level spec files in `root/specs`, or `[]` when there is no `specs/`. */
export function specFilesIn(root: string): string[] {
  const dir = join(root, "specs");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter(isSpecFile);
  } catch {
    return [];
  }
}

export interface Surface {
  /** Project-relative, so a report can name it. */
  path: string;
  content: string;
}

/**
 * Every agent-facing document in which a spec or a doc may be listed.
 *
 * AGENTS.md first because a consumer may still list specs there; then
 * `.claude/rules/*.md`, which is where this project's generator puts the
 * tables and where D-15 moved them.
 */
export function listingSurfaces(root: string): Surface[] {
  const out: Surface[] = [];
  const agents = join(root, "AGENTS.md");
  if (existsSync(agents)) {
    try { out.push({ path: "AGENTS.md", content: readFileSync(agents, "utf-8") }); } catch { /* unreadable */ }
  }
  const rulesDir = join(root, ".claude", "rules");
  if (!existsSync(rulesDir)) return out;
  let names: string[];
  try { names = readdirSync(rulesDir).filter(f => f.endsWith(".md")).sort(); } catch { return out; }
  for (const n of names) {
    try {
      out.push({ path: `.claude/rules/${n}`, content: readFileSync(join(rulesDir, n), "utf-8") });
    } catch { /* unreadable */ }
  }
  return out;
}

/** Spec files named by no surface. Empty when every spec is listed somewhere. */
export function unlistedSpecs(root: string): string[] {
  const specs = specFilesIn(root);
  if (specs.length === 0) return [];
  const surfaces = listingSurfaces(root);
  return specs.filter(f => !surfaces.some(s => s.content.includes(f)));
}

/**
 * `CODE-MAP.md` exists but no surface points at it.
 *
 * Matched on `CODE-MAP` rather than on the filename, because the routing
 * table writes it in backticks and the key-files table writes it bare, and
 * the question is whether a reader is sent there at all.
 */
export function codeMapUnreferenced(root: string): boolean {
  if (!existsSync(join(root, "CODE-MAP.md"))) return false;
  return !listingSurfaces(root).some(s => s.content.includes("CODE-MAP"));
}
