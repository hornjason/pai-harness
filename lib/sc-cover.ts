/**
 * What counts as COVER for a ticked success criterion (#327).
 *
 * A tick is a claim that something was proven. #149 made it visible that the
 * claim and the proof had come apart: it replaced "a test file mentions the
 * id" with "a test file DECLARES the id", and eight criteria lost their only
 * coverage claim without losing their tick. Three spot-checked then were
 * certified by, in order, a line of unrelated fixture text, a key-formatting
 * test, and a duplicate-detection record. None asserted anything about the
 * criterion it certified.
 *
 * The eight were the visible edge. Measured over the whole tree at the time
 * of this issue: **748 ticked criteria, 161 of them with no cover of any
 * kind** — no declaring test claim, no passing conformity assertion, no
 * behavioural exemption, no supersession. That is the number this module
 * exists to stop growing.
 *
 * ## Four ways a tick can be honest, and they are not interchangeable
 *
 *   claim        a test file declares the id in a comment or a title
 *                (`.claude/rules/claiming-sc-coverage.md` owns the forms)
 *   conformity   the statement matches a registry pattern AND the assertion
 *                passes right now — not merely that it matched
 *   behavioural  marked `(behavioral)`, bounded elsewhere by #328's ratchet
 *   superseded   the statement opens `SUPERSEDED`, so the tick is a pointer
 *                to the criteria that replaced it rather than a proof
 *
 * Supersession is in the list because GITHUB-API-MIGRATION-SPEC.md uses it
 * three times in a row (SC-499, SC-500, SC-501) and the convention is
 * deliberate: the line records what the criterion USED to say and why it was
 * wrong. Demanding a test for a criterion that explicitly no longer applies
 * would push the spec to delete its own history.
 *
 * ## One binding
 *
 * `uncoveredTickedScs` is the only place that decides, so
 * `test/ticked-sc-cover.test.ts` can short-circuit it and watch the ratchet
 * stop refusing. Two functions answering this would leave a mutation of
 * either one looking like the guard working — which is the defect in
 * `.claude/rules/checks-must-be-able-to-fail.md`, and the defect this whole
 * issue is an instance of.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import { collectTestableSpecs, isBehavioralSC, matchPattern, planSCTests } from "./conformity";
import { buildScRegistry, isTemplateSpec, parseScDeclarations, type ScDeclaration } from "./sc-ids";

export interface UncoveredSc {
  id: string;
  specFile: string;
  statement: string;
}

/** A tick that is a pointer rather than a proof. */
export function isSuperseded(statement: string): boolean {
  return /^SUPERSEDED\b/.test(statement.trim());
}

export function readSpecs(specsDir: string): Array<{ file: string; content: string }> {
  return readdirSync(specsDir, { recursive: true, encoding: "utf-8" })
    .filter(f => typeof f === "string" && f.endsWith(".md"))
    .map(f => ({ file: f, content: readFileSync(join(specsDir, f), "utf-8") }));
}

/**
 * Every ticked criterion with no cover of any kind.
 *
 * `claimed` is passed in rather than computed here, because the credit rule
 * lives in `scripts/sync-sc-status.ts` and having two implementations of it
 * is how this class of bug arrives. Keys are `scopedKey(specFile, id)`.
 */
export function uncoveredTickedScs(opts: {
  specsDir: string;
  projectRoot: string;
  claimed: Set<string>;
  scopedKey: (specFile: string, id: string) => string;
}): UncoveredSc[] {
  const { specsDir, projectRoot, claimed, scopedKey } = opts;
  const out: UncoveredSc[] = [];

  for (const { file, content } of readSpecs(specsDir)) {
    if (isTemplateSpec(file)) continue;
    for (const d of parseScDeclarations(content, file) as ScDeclaration[]) {
      if (!d.checked) continue;
      if (claimed.has(scopedKey(d.specFile, d.id))) continue;
      if (isSuperseded(d.statement)) continue;
      if (isBehavioralSC(d as never)) continue;

      // A matcher that MATCHES is not cover; a matcher that PASSES is. The
      // distinction is the whole point — `sync-sc-status` reports matched,
      // failing and unmatchable as three separate states precisely because
      // conflating the first two certifies a broken assertion.
      const assertion = matchPattern(d as never);
      if (assertion) {
        try {
          assertion(projectRoot);
          continue;
        } catch {
          // Matched and failed. Not cover.
        }
      }
      out.push({ id: d.id, specFile: d.specFile, statement: d.statement });
    }
  }
  return out;
}

/** The same list, grouped by the spec that declares it. */
export function uncoveredBySpec(uncovered: UncoveredSc[]): Map<string, string[]> {
  const bySpec = new Map<string, string[]>();
  for (const u of uncovered) {
    bySpec.set(u.specFile, [...(bySpec.get(u.specFile) ?? []), u.id]);
  }
  return bySpec;
}

/**
 * Which specs exceed what they are allowed, given a banked per-spec ratchet.
 *
 * Ratchets BOTH ways, like every other allowlist in this repo: a spec over
 * its number fails, and so does a spec under it, because an entry that has
 * stopped being a violation is an entry nobody will ever remove.
 */
export function ratchetViolations(
  bySpec: Map<string, string[]>,
  banked: Record<string, number>,
): string[] {
  const out: string[] = [];
  for (const [spec, ids] of bySpec) {
    const allowed = banked[spec] ?? 0;
    if (ids.length > allowed) {
      out.push(
        `${spec}: ${ids.length} ticked criteria have no cover of any kind, ${allowed} allowed. ` +
          `New: ${ids.slice(allowed).join(", ")}. Write the test, or untick it.`,
      );
    }
  }
  for (const [spec, allowed] of Object.entries(banked)) {
    const found = bySpec.get(spec)?.length ?? 0;
    if (found < allowed) {
      out.push(
        `${spec}: banked at ${allowed} but only ${found} remain. Lower the number — ` +
          `a ratchet nobody lowers is a number nobody reads.`,
      );
    }
  }
  return out.sort();
}

/**
 * The two halves of "checked, and the engine can build no assertion" (#441).
 *
 * `UNMATCHED_CHECKED_RATCHET` was one number counting both, and its docblock
 * read it as debt: SCs marked done that carry no assertion and are therefore
 * wishes. That reading was right at 54. It stopped being right once the repo
 * started writing criteria about REFUSALS, because the registry's whole
 * vocabulary — file-exists, content-contains, count-threshold — is claims
 * about the state of the tree, and there is no state of a tree that expresses
 * "X refuses, and says which of two things happened".
 *
 * So the number rose on #397, #398 and #399 for criteria that are all covered
 * by executed tests, and the only way to lower it would have been to rewrite
 * them as weaker claims about file contents. A ratchet that rises whenever an
 * issue writes a good behavioural criterion is measuring the matcher's
 * vocabulary, not the project's honesty.
 *
 * - `unclaimed` — no test file declares it. The wish the old docblock meant.
 * - `claimed` — a test file declares it per
 *   `.claude/rules/claiming-sc-coverage.md`, and the engine still cannot
 *   build the assertion. A measure of the vocabulary.
 *
 * `SUPERSEDED` ticks are excluded from BOTH, matching `uncoveredTickedScs`.
 * A tick that points at its replacement is not a criterion anybody owes a
 * test for, and leaving it in would have put one criterion in `unclaimed`
 * that the census next door deliberately drops — a disagreement between two
 * numbers about the same tree, arrived at by accident.
 */
export interface UnmatchedSplit {
  unclaimed: UncoveredSc[];
  claimed: UncoveredSc[];
}

export function splitUnmatchedChecked(opts: {
  projectRoot: string;
  claimed: Set<string>;
  scopedKey: (specFile: string, id: string) => string;
}): UnmatchedSplit {
  const { projectRoot, claimed, scopedKey } = opts;
  const out: UnmatchedSplit = { unclaimed: [], claimed: [] };

  for (const [specFile, meta] of collectTestableSpecs(projectRoot)) {
    for (const entry of planSCTests(meta.scs)) {
      if (entry.kind !== "unmatched") continue;
      if (isSuperseded(entry.sc.statement)) continue;
      const row = { id: entry.sc.id, specFile, statement: entry.sc.statement };
      if (claimed.has(scopedKey(specFile, entry.sc.id))) out.claimed.push(row);
      else out.unclaimed.push(row);
    }
  }
  return out;
}

/**
 * Where the unclaimed half disagrees with the uncovered census next door.
 *
 * Measured before this existed: of 155 unclaimed criteria, **154** were
 * already in `uncoveredTickedScs`'s census, which
 * `test/ticked-sc-cover.test.ts` ratchets per spec, both directions, naming
 * the ids. Banking the unclaimed count as a SECOND global number would have
 * been two deciders answering one question — the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` — and a mutation of either
 * would have left the other holding every case up.
 *
 * So this returns the DIFFERENCE rather than a count, and the test asserts
 * the difference is exactly what is explained below. The per-spec ratchet
 * stays the one place a new untested criterion is refused; this is the
 * relationship between the two populations, checked rather than assumed.
 *
 * The two known residues, both of them the other function behaving correctly
 * and this one being narrower:
 *
 * - `collectTestableSpecs` skips a spec whose frontmatter says
 *   `testable: no`, and `readSpecs` does not. `DA-COMPLIANCE-SPEC.md` is one.
 * - `uncoveredTickedScs` also counts a criterion whose matcher MATCHES and
 *   then FAILS, which is not `unmatched` and so is invisible here.
 */
export function unclaimedCensusResidue(opts: {
  unclaimed: UncoveredSc[];
  census: UncoveredSc[];
  scopedKey: (specFile: string, id: string) => string;
}): { onlyUnclaimed: string[]; onlyCensus: string[] } {
  const { scopedKey } = opts;
  const a = new Set(opts.unclaimed.map(u => scopedKey(u.specFile, u.id)));
  const b = new Set(opts.census.map(u => scopedKey(u.specFile, u.id)));
  return {
    onlyUnclaimed: [...a].filter(k => !b.has(k)).sort(),
    onlyCensus: [...b].filter(k => !a.has(k)).sort(),
  };
}
