/**
 * Cite a line of source by what it SAYS, not by where it sits (#514).
 *
 * A spec that writes `workflows/ship.js:5775` is making a claim that stops
 * being true the next time anything is inserted above line 5775, and nothing
 * about the spec changes when it does. `test/gate-env-expressibility.test.ts`
 * SC-1719 is the one guard anybody wrote for one such citation, and keeping
 * it green cost three hand edits of five numbers in two PRs.
 *
 * Measured on `specs/GATE-CONTRACTS-SPEC.md` while fixing this: of its seven
 * line citations, the three under that guard were correct and **three of the
 * four unguarded ones were already wrong** — `gate-executor.ts:1725` pointed
 * at a `parseFloat`, `evidence-prevalidator.ts:208` at a comment, and
 * `scaffold-rungate-config.ts:66` at an unrelated `existsSync`. Each pointed
 * at a plausible-looking line. Nobody had noticed.
 *
 * So the citation carries the text and the resolver reports the position:
 *
 *     `workflows/ship.js@"const containerConfig = projectConfig.container"`
 *
 * **Resolution is total.** Not found and found-twice are both refusals, and
 * the second one matters more than it looks: an ambiguous anchor is how a
 * citation lands somewhere plausible, which is precisely the failure the line
 * numbers had. `0`, `null` and "the first match" are indistinguishable from a
 * correct answer; a refusal naming the count is not.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

/** `path@"anchor"` inside a single markdown code span. */
export const ANCHOR_CITATION = /`([A-Za-z0-9_./-]+)@"([^"`]*)"`/g;

/** The old form, kept so a document can be checked for having left it behind. */
export const LINE_CITATION = /`?\b([A-Za-z0-9_./-]+\.(?:ts|js|json)):(\d+)\b/g;

export interface Citation {
  path: string;
  anchor: string;
}

export type Resolution =
  | { ok: true; path: string; anchor: string; line: number; text: string }
  | { ok: false; path: string; anchor: string; reason: string };

/** Every anchor citation in a document, in order, deduplicated by nothing. */
export function anchorCitations(doc: string): Citation[] {
  const out: Citation[] = [];
  for (const m of doc.matchAll(ANCHOR_CITATION)) out.push({ path: m[1], anchor: m[2] });
  return out;
}

/**
 * Where a citation points, or why it does not point anywhere.
 *
 * `root` is the repository root; a citation's path is repo-relative, because
 * a bare filename is how `steps.ts:43` came to be ambiguous between three
 * files in this repo's own ADRs.
 */
export function resolveCitation(root: string, cite: Citation): Resolution {
  const { path, anchor } = cite;
  const fail = (reason: string): Resolution => ({ ok: false, path, anchor, reason });

  if (anchor.length === 0) return fail("the anchor is empty, so it matches nothing and everything");
  // Short anchors are the ones that become ambiguous later, after an
  // unrelated edit somewhere else in the file. Refusing them now is cheaper
  // than refusing them on the day they break something.
  if (anchor.trim().length < 12) {
    return fail(`the anchor "${anchor}" is ${anchor.trim().length} characters — too short to stay unique`);
  }

  const full = join(root, path);
  if (!existsSync(full)) return fail("no such file in the repository");

  const source = readFileSync(full, "utf-8");
  const count = source.split(anchor).length - 1;
  if (count === 0) return fail("the file no longer contains this text");
  if (count > 1) {
    return fail(
      `the text appears ${count} times, so the citation does not name a site — ` +
        `an ambiguous anchor is how a citation lands somewhere plausible`,
    );
  }

  const lines = source.split("\n");
  const index = lines.findIndex(l => l.includes(anchor));
  // A multi-line anchor has no single line, and silently reporting its first
  // is the kind of "near enough" that put three wrong numbers in a spec.
  if (index < 0) return fail("the text spans more than one line, so it does not name a line");
  return { ok: true, path, anchor, line: index + 1, text: lines[index] };
}

/** Every citation in a document that does not resolve, as sentences. */
export function citationFailures(root: string, doc: string): string[] {
  const out: string[] = [];
  for (const cite of anchorCitations(doc)) {
    const r = resolveCitation(root, cite);
    if (!r.ok) out.push(`${cite.path}@"${cite.anchor}" — ${r.reason}`);
  }
  return out;
}
