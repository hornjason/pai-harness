/**
 * The names a cross-project document actually calls a project by (#442).
 *
 * `scanExternalSources` matched on `basename(projectRoot)` and nothing else,
 * in both of its match modes. Measured by the reporting session against a
 * real document in a sibling project:
 *
 *     grep -ic "dailybriefdashboard"  ->  0
 *     grep -ic "ddb"                  ->  2
 *
 * That generalises. A document written in one project that refers to another
 * calls it by nickname, abbreviation, product name or repo slug — almost
 * never by the literal name of the directory it happens to be checked out
 * into. An exact substring match on the folder name is the wrong matcher for
 * the only situation the feature exists to serve, and the feature has never
 * fired for any project.
 */

import { existsSync, readFileSync } from "fs";
import { basename, join } from "path";

/**
 * Below this length an alias matches so much that it is noise.
 *
 * Two characters inside word boundaries is already thin; one is a letter,
 * and a one-letter alias proposes adopting most of a directory. The same
 * shape bit #437, where a one-character prefix made `isScratchEntry`
 * accept `.claude`.
 */
export const MIN_ALIAS_LENGTH = 2;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `owner/name` from a git remote URL, in either of the two forms git writes. */
export function remoteSlug(remoteUrl: string): string | null {
  const m = /(?:github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(remoteUrl.trim());
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

/**
 * Every name this project answers to, lowercased and de-duplicated.
 *
 * The repo name and the GitHub slug are DERIVED rather than typed, which is
 * the point of SC-1: a project should not have to write down facts the tree
 * already states. `configured` is for the ones only a human knows — the
 * abbreviation, the product name, the thing the team says out loud.
 */
export function projectAliases(projectRoot: string, configured: string[] = []): string[] {
  const out: string[] = [basename(projectRoot)];

  // `.git/config` rather than spawning git: this runs inside scaffold, and a
  // subprocess per scaffolded project is a cost with no payoff when the file
  // is right there. An unreadable or absent one simply contributes nothing —
  // not a fail-open, because the directory name is always present and the
  // caller is told which aliases were used.
  const gitConfig = join(projectRoot, ".git", "config");
  if (existsSync(gitConfig)) {
    let text = "";
    try {
      text = readFileSync(gitConfig, "utf-8");
    } catch {
      text = "";
    }
    for (const m of text.matchAll(/^\s*url\s*=\s*(.+)$/gm)) {
      const slug = remoteSlug(m[1]!);
      if (!slug) continue;
      out.push(slug);
      out.push(slug.split("/")[1]!);
    }
  }

  out.push(...configured);

  const seen = new Set<string>();
  return out
    .map(a => a.trim().toLowerCase())
    .filter(a => a.length >= MIN_ALIAS_LENGTH && !seen.has(a) && (seen.add(a), true));
}

/**
 * Whether any alias appears in `text` as a WORD.
 *
 * ONE decider, used by both match modes. They were two separate expressions
 * — `entry.toLowerCase().includes(projectName)` and
 * `content.toLowerCase().includes(projectName)` — which meant two places to
 * fix and two places for them to drift apart.
 *
 * Word boundaries rather than substring, because the aliases that make this
 * feature work are short: `ddb` as a substring matches `oddball`, and a
 * three-letter abbreviation proposing adoption of every document that
 * happens to contain those letters is worse than the matcher that never
 * fired. A slug like `owner/name` is bounded by `/`, which `\b` handles.
 */
export function matchesAnyAlias(text: string, aliases: string[]): boolean {
  const haystack = text.toLowerCase();
  return aliases.some(a => new RegExp(`\\b${escapeRegex(a)}\\b`).test(haystack));
}
