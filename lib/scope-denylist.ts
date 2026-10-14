/**
 * Files a goal put out of bounds, and the plans that claimed them anyway (#306).
 *
 * ## What happened
 *
 * #274 attempt 4 (`wf_b3714a40-bb7`). The goal said, under a heading in
 * capitals, "ALSO DO NOT FIX, ALREADY FILED: #295 … leave it there". The
 * `to-issues` decomposer then emitted a sub-issue whose `filesToModify` was
 * `gates/schema.ts`, `lib/evidence-prevalidator.ts`,
 * `gates/SCHEMA-GUIDE.md` — the three files you would touch to fix #295, and
 * nothing to do with #274. The agent did what its file list permitted, and
 * the run refused on its own contradiction: one sub-issue both documented the
 * defect and removed it.
 *
 * The attribution is the decomposer's, not the agent's. The collection guard
 * (#178, SC-413) refuses any file no sub-issue claimed, and it did not refuse
 * these — so they were in the plan. An agent handed `gates/schema.ts` and a
 * defect description has been told, by the strongest signal in the system,
 * that the file is in scope.
 *
 * ## One thing #306 got wrong, corrected here
 *
 * The issue proposes "the goal already names them; the decomposer could be
 * given an explicit deny-list". **The goal did not name them.** Re-read the
 * quoted prohibition: it names an ISSUE (`#295`) and three code symbols
 * (`prevalidationViolations`, `reading.broken`, `acs[].status`). Not one file
 * path. The paths came from `discovery.filesToModify`, which
 * `workflows/ship.js:1952` hands to the decomposer verbatim as "Files to
 * modify".
 *
 * That changes the fix in a way worth stating, because a deny-list built on
 * the issue's premise would have returned `[]` for the very run that
 * motivated it and passed — the decorative check
 * `.claude/rules/checks-must-be-able-to-fail.md` is about, shipped as its own
 * remedy. So this module has two outputs, not one:
 *
 * - `deniedFiles` — paths the prohibition actually named, which can be
 *   enforced.
 * - `unresolvedProhibitions` — prohibitions that named an issue and no file,
 *   which CANNOT be enforced and are reported rather than counted as clean.
 *   #274's own goal is this case. An empty deny-list and an unenforceable one
 *   look identical from the outside, and conflating them is the whole bug.
 */

/** A marked region of goal text and what could be extracted from it. */
export interface Prohibition {
  /** The text of the marked paragraph. */
  text: string;
  /** Repo-relative paths named inside it. */
  files: string[];
  /** Issue numbers named inside it, as `#295`. */
  issues: string[];
}

/**
 * Line markers that put the rest of a paragraph out of bounds.
 *
 * Deliberately short and literal. A wider list reads ordinary prose as a
 * prohibition and starts denying files the run needs, which fails a correct
 * plan — and a guard that fires on correct work is removed within a week.
 */
const MARKERS = [
  /\bdo\s+not\s+fix\b/i,
  /\bdo\s+not\s+touch\b/i,
  /\bdo\s+not\s+modify\b/i,
  /\bout\s+of\s+scope\b/i,
  /\bnot\s+in\s+scope\b/i,
  /\balready\s+filed\b/i,
];

/**
 * A source path: an optional directory prefix and a KNOWN EXTENSION.
 *
 * The extension is what does the discriminating, and that is worth stating
 * because the first draft of this file claimed the `/` did. It does not.
 * `reading.broken` and `acs[].status` — both in #274's prohibition, both code
 * expressions — are excluded because `.broken` and `.status` are not
 * extensions, not because they lack a separator. Mutating the `/` from
 * required to optional scored **zero red** against the cases written to
 * defend it, which is how the claim was caught.
 *
 * The separator is optional on purpose, once it stopped being load-bearing:
 * requiring it silently misses every root-level file a goal might name —
 * `package.json`, `AGENTS.md`, `CODE-MAP.md` — which is a false negative in
 * exactly the common case. How a bare name matches a plan entry is
 * `matchesDenied` below, and it is not the same rule as for a full path.
 */
const PATH = /\b([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:ts|tsx|js|jsx|md|json|ya?ml|sh))\b/g;

const ISSUE_REF = /#(\d+)\b/g;

/** Paths named in a span of text, deduplicated, in first-seen order. */
export function pathsNamedIn(text: string): string[] {
  return [...new Set([...text.matchAll(PATH)].map(m => m[1]))];
}

/**
 * Split goal text into the paragraphs a marker puts out of bounds.
 *
 * A paragraph, not a line: #274's prohibition is one bolded lead-in followed
 * by two sentences, and a line-scoped reader would see the marker and stop
 * before the content. A paragraph, not the rest of the document: a marker
 * near the top would otherwise deny the entire goal.
 */
export function prohibitions(goalText: string): Prohibition[] {
  const out: Prohibition[] = [];
  for (const para of String(goalText ?? "").split(/\n\s*\n/)) {
    if (!MARKERS.some(m => m.test(para))) continue;
    out.push({
      text: para.trim(),
      files: pathsNamedIn(para),
      issues: [...new Set([...para.matchAll(ISSUE_REF)].map(m => `#${m[1]}`))],
    });
  }
  return out;
}

/**
 * Every file the goal put out of bounds.
 *
 * `scopeOut` entries count in full — that field exists to say what is out of
 * scope, so it needs no marker. Until now nothing read it at all: it was
 * required by the discovery schema, appended to in one place, and consulted
 * by nothing, which is its own small version of this bug.
 */
export function deniedFiles(goalText: string, scopeOut: readonly string[] = []): string[] {
  const fromGoal = prohibitions(goalText).flatMap(p => p.files);
  const fromScopeOut = scopeOut.flatMap(s => pathsNamedIn(String(s ?? "")));
  return [...new Set([...fromGoal, ...fromScopeOut])];
}

/**
 * Prohibitions that name an issue and no file (#306).
 *
 * These are the ones the deny-list cannot act on, and reporting them is the
 * point. "Nothing was denied because the goal named nothing" and "nothing was
 * denied because the goal named no files" are the same empty list, and only
 * the first is a clean run.
 */
export function unresolvedProhibitions(goalText: string): Prohibition[] {
  return prohibitions(goalText).filter(p => p.files.length === 0 && p.issues.length > 0);
}

/** A plan item that claims files. Shaped to match a sub-issue or discovery. */
export interface FileClaimant {
  title?: string;
  filesToModify?: readonly string[];
}

/**
 * One spelling per path, so a guard cannot be stepped around by rewriting it.
 *
 * A string comparison is only as good as its normalisation, and `./a/b.ts`,
 * `a//b.ts`, `a/./b.ts` and `a/c/../b.ts` are four spellings of one file that
 * an `===` reads as four different ones. The whole value of this module is a
 * comparison, so an un-normalised one is a guard with a documented bypass —
 * "a detector narrower than what it detects", third shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * A leading `..` is kept rather than resolved away: it escapes the repo root
 * and there is nothing above it to collapse into, so dropping it would make
 * `../secrets.ts` normalise to `secrets.ts` and match a deny entry that never
 * meant it. Raised by the commit security review on this change.
 */
export function normalisePath(p: string): string {
  const raw = String(p ?? "").trim().replace(/\\/g, "/");
  const out: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length > 0 && out.at(-1) !== "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/**
 * Does a plan's file entry fall under a denied entry?
 *
 * Two rules, because a goal names files two ways:
 *
 * - **A denied entry WITH a separator matches exactly**, after normalisation.
 *   A suffix match would read `test/gates/schema.ts` as `gates/schema.ts` and
 *   deny a file the prohibition never mentioned.
 * - **A denied entry with NO separator matches by basename.** "Do not touch
 *   package.json" has to reach `package.json`, and "do not touch
 *   HARNESS-STANDARD.md" has to reach `specs/HARNESS-STANDARD.md` — a goal
 *   author naming a bare file means the file, wherever it lives. Requiring
 *   the path instead would make the common phrasing silently do nothing,
 *   which is this issue's own defect one level down.
 *
 * The basename arm compares the last segment rather than testing `endsWith`,
 * because `endsWith("/package.json")` is satisfied by nothing a normalised
 * path can spell differently but the segment comparison says what it means.
 */
export function matchesDenied(planFile: string, deniedEntry: string): boolean {
  const plan = normalisePath(planFile);
  const denied = normalisePath(deniedEntry);
  if (denied === "" || plan === "") return false;
  if (denied.includes("/")) return plan === denied;
  return plan === denied || plan.split("/").at(-1) === denied;
}

/** Violations, one line each. Empty allows. */
export function denylistViolations(
  claimants: readonly FileClaimant[],
  denied: readonly string[],
): string[] {
  const out: string[] = [];
  for (const [i, c] of claimants.entries()) {
    for (const f of c.filesToModify ?? []) {
      if (!denied.some(d => matchesDenied(f, d))) continue;
      out.push(
        `${c.title ? `"${c.title}"` : `plan item ${i + 1}`} claims ${f}, which the goal ` +
          `put out of scope. An agent handed a file is an agent told the file is in ` +
          `scope (#306).`,
      );
    }
  }
  return out;
}

/**
 * Did the deny-list eat the entire plan? (commit security review, #306)
 *
 * Two findings on this change were about the same hazard from opposite
 * sides. The goal text is attacker-influenceable — issue bodies are — and
 * nothing here validates it. What limits the damage is direction: a
 * deny-list only ever NARROWS what an agent may write, so a hostile goal can
 * deny progress but cannot grant access. That is the safe direction, and it
 * is why this is a report rather than a refusal.
 *
 * The one outcome that is NOT safe is silence. If every file the run was
 * going to touch is denied, stripping leaves an empty plan, and an empty
 * plan is indistinguishable from a run with nothing to do — work refused,
 * reported as work completed. That is the fail-open, and it is the shape the
 * rest of this issue is about, so it gets a message rather than an empty
 * array.
 */
export function scopeContradiction(
  files: readonly string[],
  denied: readonly string[],
): string | null {
  if (files.length === 0 || denied.length === 0) return null;
  if (withoutDenied(files, denied).length > 0) return null;
  return (
    `every file the run planned to touch is out of scope (${files.join(", ")} vs ` +
    `denied ${denied.join(", ")}). An empty plan looks exactly like a run with ` +
    `nothing to do, so this is reported rather than stripped in silence (#306).`
  );
}

/** The denied files stripped out, order preserved. Same rule as above. */
export function withoutDenied(
  files: readonly string[],
  denied: readonly string[],
): string[] {
  return files.filter(f => !denied.some(d => matchesDenied(f, d)));
}
