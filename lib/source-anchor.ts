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
import { existsSync, readFileSync, realpathSync } from "fs";
import { join, resolve, sep } from "path";

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

  // The path comes out of a markdown document, and this function reads
  // whatever it names. Flagged by the commit security review: `ANCHOR_CITATION`
  // admits `.` and `/`, so `../../../../etc/passwd` is a well-formed citation
  // and `join` resolves it happily out of the tree.
  //
  // No live document does that — every citation here is written by someone
  // with commit access — but "the input happens to be trusted today" is not a
  // property of a library, and a spec is exactly the sort of file a consumer
  // generates. Refused rather than normalised: a citation that climbs out of
  // the repository is not a citation with a fixable path, it is a citation to
  // something this function has no business reading.
  //
  // Three checks, and each has an input only it reaches. The first draft had
  // four, and the battery measured the fourth — a `..`-segment spelling rule
  // — at **0 red**, because `resolve` normalises `..` and the containment
  // check below already refuses it. Two deciders answering one question, the
  // fourth shape in `.claude/rules/checks-must-be-able-to-fail.md`. Dropped.
  //
  //   `/etc/passwd`        only this rule. `join` CONCATENATES a leading
  //                        slash rather than absorbing it, so the path stays
  //                        inside the tree and containment has nothing to say
  //   `../../etc/passwd`   only containment, below
  //   a symlink inside     only `realpathSync`, below — `resolve` is purely
  //                        lexical and cannot see a link at all
  //
  // The first of those is not an escape: `join(root, "/etc/passwd")` reads
  // `<root>/etc/passwd`. It is refused because a citation written absolute
  // means something other than what its author thinks it means, and a
  // confident citation to the wrong file is this whole issue.
  if (path.startsWith("/")) return fail("the path is absolute — citations are repository-relative");

  const full = join(root, path);
  const contained = resolve(root) + sep;
  if (!resolve(full).startsWith(contained)) {
    return fail("the path resolves outside the repository, so it is not a citation to this tree");
  }
  if (!existsSync(full)) return fail("no such file in the repository");

  // The symlink question, which the lexical check genuinely cannot answer:
  // a link INSIDE the tree whose target is outside it resolves to a
  // contained path and reads an uncontained file. `realpathSync` is the only
  // thing that follows it, and it needs the file to exist, which is why it
  // sits here rather than beside its lexical sibling.
  if (!realpathSync(full).startsWith(realpathSync(resolve(root)) + sep)) {
    return fail("the path is a symlink whose target is outside the repository");
  }

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
