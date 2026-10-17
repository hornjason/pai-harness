#!/usr/bin/env bun
/**
 * Sync SC checkbox status: test passes → spec checkbox flips from [ ] to [x].
 *
 * 1. Scans spec files for unchecked SCs: - [ ] SC-NNN: ...
 * 2. Scans test files for matching SC-NNN references
 * 3. Runs only the test files that contain unchecked SCs
 * 4. For SCs without hand-written tests, runs matchPattern() conformity assertions
 * 5. If assertions pass, flips matching checkboxes to [x]
 *
 * Usage:
 *   bun scripts/sync-sc-status.ts           # Run targeted tests and flip checkboxes
 *   bun scripts/sync-sc-status.ts --dry-run # Show what would flip without changing files
 *   bun scripts/sync-sc-status.ts --report  # Output per-spec coverage report
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { commentMask, enclosingComment, stripJsComments } from "../lib/strip-js-comments";
import { commentClaimForm, titleCall, type ClaimForm } from "../lib/sc-claim-forms";
import { join } from "path";
import { execSync } from "child_process";
import { matchPattern, isBehavioralSC, type ParsedSC } from "../lib/conformity";
import { readFreshCache } from "../lib/behavioral-cache";
import { detectDrift } from "./detect-sc-drift";
import {
  ambiguityOf,
  buildScRegistry,
  isQualifiedBy,
  isTemplateSpec,
  oneScMentionPattern,
  parseScDeclarations,
  requiresQualification,
  scDeclarationPattern,
  scMentionPattern as scIdMentionPattern,
  type ScRegistry,
} from "../lib/sc-ids";

export { isTemplateSpec };

const ROOT = join(import.meta.dir, "..");
const SPECS_DIR = join(ROOT, "specs");
const TEST_DIR = join(ROOT, "test");
const dryRun = process.argv.includes("--dry-run");
const reportMode = process.argv.includes("--report");

export interface UncheckedSC {
  id: string;
  statement?: string;
  specFile: string;
}

/**
 * The registry every credit decision is made against (#330).
 *
 * Built from the same spec scan `findUncheckedSCs` walks, so the ids a test
 * can be credited for and the ids a spec declares are the same set by
 * construction rather than by two regexes agreeing.
 */
export function readScRegistry(specsDir?: string): ScRegistry {
  const dir = specsDir || SPECS_DIR;
  if (!existsSync(dir)) return buildScRegistry([]);
  const specs: Array<{ file: string; content: string }> = [];
  for (const file of new Bun.Glob("**/*.md").scanSync({ cwd: dir, absolute: false })) {
    specs.push({ file, content: readFileSync(join(dir, file), "utf-8") });
  }
  return buildScRegistry(specs);
}

export function findUncheckedSCs(specsDir?: string): UncheckedSC[] {
  const dir = specsDir || SPECS_DIR;
  const unchecked: UncheckedSC[] = [];
  if (!existsSync(dir)) return unchecked;

  for (const file of new Bun.Glob("**/*.md").scanSync({ cwd: dir, absolute: false })) {
    if (isTemplateSpec(file)) continue;
    const content = readFileSync(join(dir, file), "utf-8");
    // #330: was `/^- \[ \] (SC-\d+):/`, the fourth copy of this pattern in the
    // tree and the second that could not see an anti-criterion. One owner now.
    for (const match of content.matchAll(scDeclarationPattern())) {
      if (match[1].toLowerCase() === "x") continue;
      unchecked.push({ id: match[2], statement: match[3].trim(), specFile: file });
    }
  }
  return unchecked;
}

/**
 * Does this text name this SC, as opposed to a longer one starting with it?
 *
 * `content.includes("SC-1")` is true of any file mentioning `SC-144`, so
 * eighteen test files were credited as covering `SC-1` and none of them
 * mentioned it (#148). The trailing boundary is "not another digit" rather
 * than `\b`, because `SC-1` is followed by `:`, `,`, `)` or end-of-line in
 * every real reference and `\b` would accept `SC-1` inside `SC-1A` — but a
 * digit is the only character that makes it a different ID.
 *
 * #330 moved the definition to `lib/sc-ids.ts` and widened the boundary to
 * "not a word character and not a hyphen", so `SC-1` also stops matching
 * inside `SC-1-draft`. Re-exported here because callers import it from this
 * module; the body lives in one place.
 */
export const scMentionPattern = oneScMentionPattern;


/**
 * The success criteria a source file CLAIMS to cover (#149).
 *
 * The old rule was "the file mentions the id". Tests of the spec tooling embed
 * spec lines and SC records as INPUT — they assert how an SC is parsed,
 * flipped or scanned, and nothing about the criterion the id names — so a
 * mention was never evidence of coverage. #148 removed the two worst shapes by
 * name with a pair of regexes; this replaces the convention, which is what
 * that fix deferred here.
 *
 * ## The rule
 *
 * One question, not a list of shapes: **is the id the whole of what was
 * written, or is it embedded in something else?**
 *
 *   claim   a mention in a comment, or in a describe/test/it title
 *   data    everything else — any id inside a string literal
 *
 * A list of forbidden shapes is a second place to forget, and forgetting there
 * reads as the mention being a claim, which is the failure direction that
 * flatters us. An allowlist of two declaring positions cannot fail that way:
 * a shape nobody thought of is not credited.
 *
 * ## Why not "a complete string literal also counts"
 *
 * Because it cannot be made safe, and the attempt is worth recording. A
 * criterion registry is real coverage:
 *
 *     const EXPECTED_REREVIEW_SCS = ["SC-621", "SC-622", …];   // coverage
 *
 * but so is this, and it is a test PARAMETER naming the criterion a bug was
 * about:
 *
 *     const SHORTEST_ID = "SC-1";                               // not coverage
 *     const scs = [{ id: "SC-1", done: true }];                 // not coverage
 *     findTestFilesForSCs(new Set(["SC-9", "SC-92"]), dir);     // not coverage
 *
 * All four are bare ids in quotes. Nothing syntactic separates them — not
 * `id:`, not array-vs-scalar, not the variable's name. A rule that credited
 * them would certify criteria nobody tested, and that is the direction this
 * project's own `.claude/rules/checks-must-be-able-to-fail.md` says never to
 * fail in.
 *
 * So a registry declares itself with a comment. That costs one line, it is
 * already the convention most files follow, and unlike an inference it cannot
 * be wrong in the flattering direction.
 *
 * ## Why a bare literal counts
 *
 * #149's body proposed titles and comments only. Measured against the tree,
 * that demotes `const EXPECTED_REREVIEW_SCS = ["SC-621", …]` in
 * test/harness-standard-security.test.ts — a criterion registry driving a
 * per-criterion loop, which .claude/rules/checks-must-be-able-to-fail.md holds
 * up as the worked example for that spec. It is a BETTER coverage mechanism
 * than a hand-written title because the ids cannot drift from the assertions,
 * and a rule that dropped it would push authors toward the weaker pattern.
 *
 * ## Why it is built on stripJsComments rather than on lines
 *
 * The three categories have to be told apart at the right level, and a
 * line-oriented detector cannot do it. `fixtureTestDir("x", "// covers SC-92")`
 * contains a comment that is STRING DATA: a rule asking "does this line start
 * with //" is fooled by its own test fixture. stripJsComments is an
 * offset-preserving scanner over exactly these contexts, so two views of the
 * same source — comments blanked, and comments plus literal CONTENTS blanked —
 * classify every character by subtraction, with no second lexer to drift.
 */
export function coverageClaimIds(source: string): Set<string> {
  return new Set(coverageClaimSites(source).map(c => c.id));
}

/**
 * The same scan, keeping WHERE each claim was written (#330).
 *
 * An ambiguous id — an anti-criterion, a collision, or a number an issue's
 * own criteria also use — is creditable only when the surrounding text names
 * the spec, and "surrounding" needs the offset.
 */
export interface ClaimSite {
  id: string;
  at: number;
  /**
   * Where it was written. A comment is a claim for an unambiguous id and is
   * NOT enough for an ambiguous one — see `findTestFilesForSCs`.
   */
  kind: "comment" | "title" | "unrun-title" | "bare";
  /**
   * For a comment, WHICH structural declaring form it occupies, or `null` for
   * a bare mention inside running prose (#360). Always `null` for the other
   * two kinds, which are declaring positions by construction.
   *
   * Reported rather than filtered: the credit rule reads this, and
   * `unqualifiedClaims` reports what the credit rule refused.
   */
  form: ClaimForm | null;
}

export function coverageClaimSites(source: string): ClaimSite[] {
  const noComments = stripJsComments(source);
  const codeOnly = stripJsComments(source, { blankLiterals: true });
  const mask = commentMask(source);
  const claims: ClaimSite[] = [];
  const add = (id: string, at: number, kind: ClaimSite["kind"], form: ClaimForm | null = null) =>
    claims.push({ id, at, kind, form });

  for (const m of source.matchAll(scIdMentionPattern())) {
    const id = m[0];
    const at = m.index!;

    // Blanked by the first pass => the id sits in a comment. Offsets are
    // preserved, so this is an exact answer rather than a heuristic.
    if (noComments[at] !== source[at]) {
      // #360 records the FORM here and credits on it downstream, rather than
      // dropping the site. `unqualifiedClaims` exists so an ambiguous mention
      // that failed to earn a credit is reported instead of vanishing (#358);
      // filtering here would have re-created that silent drop one layer down,
      // and did — it turned "an uncredited ambiguous mention is reported" red.
      const { text, offset } = enclosingComment(source, mask, at);
      add(id, at, "comment", commentClaimForm(text, offset, id));
      continue;
    }

    // Survives the first pass but not the second => inside a literal. Code
    // context is neither (and `SC-7` is not a legal identifier anyway), so it
    // can only be something like a stray token; count it rather than guess.
    if (codeOnly[at] === source[at]) {
      add(id, at, "bare");
      continue;
    }

    // Inside a literal. The only literal that declares coverage is a test
    // title — the project's oldest convention, and prose by definition, so no
    // rule about the literal's contents can apply to it. Walk out to the
    // opening delimiter, which survives `blankLiterals`; that is the property
    // that makes the boundary findable without a second parser.
    let open = at;
    while (open > 0 && !/['"`]/.test(codeOnly[open])) open--;
    if (!/['"`]/.test(codeOnly[open] ?? "")) continue;

    // A title is a declaring position; a title that never runs is a
    // declaration of INTENT (#574). `test.todo("SC-N: …")` is the honest way
    // to write down work you have not done, and crediting it ticked 37
    // criteria whose only test was the word todo. Kept as a site rather than
    // dropped, so the sync can report it as UNMEASURED — dropping it would
    // make "nobody wrote this test" look like "nobody mentioned this id".
    const call = titleCall(codeOnly.slice(Math.max(0, open - 120), open));
    if (call === "runs") add(id, at, "title");
    else if (call === "never-runs") add(id, at, "unrun-title");
  }

  return claims;
}

/** A credit, scoped to the criterion it actually names. */
export interface ScCredit {
  id: string;
  specFile: string;
}

/**
 * Which test file covers which criterion — spec-scoped (#330, #352, #358).
 *
 * This used to return bare ids, and the flipper then ticked that id in EVERY
 * spec declaring it (`unchecked.filter(u => u.id === scId)`). With one id per
 * spec that was harmless. With `SC-A1` declared by three specs it is not: one
 * passing test about doc hygiene would tick an unrelated anti-criterion in
 * the GitHub API migration spec. The narrow `SC-\d+` pattern was the only
 * thing hiding it, which is why #330 said widening the regex without fixing
 * scoping makes the measurement worse.
 *
 * An id whose bare mention does not identify a criterion is credited only
 * when the text around it names the spec. That is the whole of the fix for
 * three issues:
 *
 * - `SC-A1` in `ceremony-overrides.test.ts` names no spec, and no spec
 *   declares those criteria — they are an issue's own. Not credited.
 * - `SC-6` in `context-preload-parity.test.ts` is #71's sixth criterion, not
 *   `bootstrap-data-flow`'s. Not credited.
 * - `SC-640` in `harness-standard-security.test.ts` is unique in the
 *   registry, so it needs no qualifier and keeps its credit.
 *
 * ## Why a qualified COMMENT is still not enough
 *
 * The first version of this accepted any mention with the spec's name
 * nearby, and gained two credits it should not have. `behavioral-sc-ratchet
 * .test.ts` opens with prose about a past bug:
 *
 *     used `SC-[0-9]+` and SC ids are not always numeric — `SC-A1` and `SC-A2`
 *     in GITHUB-API-MIGRATION-SPEC.md were missed.
 *
 * Every ingredient of a qualified claim, and it is a citation. A window says
 * WHICH criterion a mention means; it cannot say WHETHER the mention is a
 * claim, and #149 already decided that a bare comment counts as one — which
 * is fine for an id only this file would write and wrong for an id prose
 * cites constantly.
 *
 * So an ambiguous id must be claimed from a `describe`/`test`/`it` title AND
 * name its spec. That is the strongest position the convention has, it is
 * where a real anti-criterion test would put it anyway, and prose cannot
 * reach it by accident. The cost is that six anti-criteria stay uncredited
 * until someone writes such a title — under-crediting, which is the
 * direction this is allowed to fail in.
 */
export function findTestFilesForSCs(
  scs: Array<{ id: string; specFile: string }>,
  reg: ScRegistry,
  testDir?: string,
): Map<string, ScCredit[]> {
  const dir = testDir || TEST_DIR;
  const out = new Map<string, ScCredit[]>();
  if (!existsSync(dir)) return out;

  const wanted = new Map<string, string[]>();
  for (const sc of scs) {
    const specs = wanted.get(sc.id) ?? [];
    if (!specs.includes(sc.specFile)) specs.push(sc.specFile);
    wanted.set(sc.id, specs);
  }

  for (const file of readdirSync(dir).filter(f => f.endsWith(".test.ts"))) {
    const source = readFileSync(join(dir, file), "utf-8");
    const credits: ScCredit[] = [];
    for (const { id, at, kind, form } of coverageClaimSites(source)) {
      // #360. A comment earns a credit only in a structural declaring form.
      // The position was never the question — a comment is equally where this
      // project declares coverage and where it explains itself, and a bare id
      // inside a running sentence is a citation.
      if (kind === "comment" && !form) continue;
      // #574. The direction this is allowed to be wrong in is toward NOT
      // crediting, and a todo is the clearest case there is: nothing can go
      // red, so nothing can be measured.
      if (kind === "unrun-title") continue;
      for (const specFile of wanted.get(id) ?? []) {
        if (requiresQualification(id, reg) && !(kind === "title" && isQualifiedBy(source, at, specFile))) continue;
        if (!credits.some(c => c.id === id && c.specFile === specFile)) {
          credits.push({ id, specFile });
        }
      }
    }
    if (credits.length > 0) out.set(file, credits);
  }
  return out;
}

/**
 * Ids whose only declaring position in the test tree is a title that never
 * runs (#574), with the files that name them.
 *
 * An id that ALSO has a running title or a declaring comment anywhere is
 * not here: the question is whether anything can measure it, not whether a
 * todo exists. That distinction is the whole report — otherwise every
 * criterion with a todo beside a real test would be listed as unmeasured
 * and the list would be ignored within a week.
 */
export function intendedOnly(testDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!existsSync(testDir)) return out;
  const measured = new Set<string>();
  const intended = new Map<string, string[]>();
  for (const file of readdirSync(testDir).filter(f => f.endsWith(".test.ts"))) {
    for (const site of coverageClaimSites(readFileSync(join(testDir, file), "utf-8"))) {
      if (site.kind === "unrun-title") {
        const files = intended.get(site.id) ?? [];
        if (!files.includes(file)) files.push(file);
        intended.set(site.id, files);
      } else if (site.kind === "title" || (site.kind === "comment" && site.form)) {
        measured.add(site.id);
      }
    }
  }
  for (const [id, files] of intended) if (!measured.has(id)) out.set(id, files);
  return out;
}

/**
 * Mentions that look like claims and are not credited, with why (#330).
 *
 * Reported rather than silently dropped. Under-crediting is the safe
 * direction and it is still a measurement error, so the number has to be
 * visible or nobody will ever qualify a mention.
 */
export function unqualifiedClaims(
  source: string,
  reg: ScRegistry,
): Array<{ id: string; reason: string }> {
  const out: Array<{ id: string; reason: string }> = [];
  const sites = coverageClaimSites(source);

  // Which ids this file DOES claim properly, settled before anything is
  // reported (#392). `findTestFilesForSCs` has always credited a file that
  // cites an id in one place and declares it in another — "one file doing
  // both is credited once, by the claim" — and this reporter did not: the
  // first non-title mention won, so a correctly qualified `describe` title
  // was reported as unqualified because a comment two lines above it named
  // the same id. Site order decided the answer, which means a comment ABOVE
  // the title reported and the same comment BELOW it did not.
  const qualified = new Set(
    sites
      .filter(s => s.kind === "title")
      .filter(s => (reg.declaredById.get(s.id) ?? []).some(f => isQualifiedBy(source, s.at, f)))
      .map(s => s.id),
  );

  for (const { id, at, kind } of sites) {
    if (!requiresQualification(id, reg)) continue;
    if (qualified.has(id)) continue;
    // Every declarer, so the reason names the spec whose HEADING made the id
    // ambiguous (#392). Listing only the checkbox holders would report
    // "declared by SCAFFOLD-DECOMPOSITION-SPEC.md" as the reason a mention
    // needs qualifying against it, which reads as nonsense.
    const specs = reg.declaredById.get(id) ?? [];
    if (kind === "title" && specs.some(s => isQualifiedBy(source, at, s))) continue;
    if (out.some(o => o.id === id)) continue;
    out.push({
      id,
      reason:
        `${ambiguityOf(id, reg)} — declared by ${specs.join(", ")}. To claim it, name the ` +
        `spec in a describe/test/it title beside the id. If this is an issue's own ` +
        `criterion, write it as "criterion N of #NNN" — SC- is the spec registry's.`,
    });
  }
  return out;
}

function runTestFile(file: string): boolean {
  try {
    execSync(`bun test test/${file}`, {
      cwd: ROOT, timeout: 120000, stdio: ["ignore", "pipe", "pipe"]
    });
    return true;
  } catch (e: any) {
    const out = (e.stdout || "") + (e.stderr || "");
    const failMatch = out.match(/(\d+) fail/);
    return failMatch ? parseInt(failMatch[1]) === 0 : false;
  }
}

export interface ConformityResult {
  passing: Set<string>;
  failing: Set<string>;
  unmatchable: Set<string>;
}

/**
 * Composite key scoped to spec file — prevents cross-spec ID collisions.
 */
export function scopedKey(specFile: string, id: string): string {
  return `${specFile}::${id}`;
}

/**
 * Every `specFile::id` a test file declares, per
 * `.claude/rules/claiming-sc-coverage.md` (#441).
 *
 * ONE owner. This was written out longhand in `test/ticked-sc-cover.test.ts`
 * and #441 needed the same set in a second place; copying it would have put
 * two implementations of the credit rule in the tree, which is the way this
 * class of bug arrives and the reason `uncoveredTickedScs` takes `claimed`
 * as a parameter rather than computing it.
 *
 * It lives here rather than in `lib/` because the credit rule lives here —
 * `findTestFilesForSCs` and `commentClaimForm` are what decide, and a `lib/`
 * module reaching back into `scripts/` would invert the dependency.
 */
export function claimedScKeys(specsDir: string, testDir?: string): Set<string> {
  const specs = readdirSync(specsDir, { recursive: true, encoding: "utf-8" })
    .filter((f): f is string => typeof f === "string" && f.endsWith(".md"))
    .map(f => ({ file: f, content: readFileSync(join(specsDir, f), "utf-8") }));
  const declarations = specs
    .filter(s => !isTemplateSpec(s.file))
    .flatMap(s => parseScDeclarations(s.content, s.file));
  const credits = findTestFilesForSCs(declarations, buildScRegistry(specs), testDir);
  return new Set([...credits.values()].flat().map(c => scopedKey(c.specFile, c.id)));
}

/**
 * Detect duplicate SC IDs across specs.
 */
export function findDuplicateSCIds(scs: UncheckedSC[]): Map<string, string[]> {
  const idToSpecs = new Map<string, string[]>();
  for (const sc of scs) {
    if (isTemplateSpec(sc.specFile)) continue;
    const specs = idToSpecs.get(sc.id) || [];
    if (!specs.includes(sc.specFile)) specs.push(sc.specFile);
    idToSpecs.set(sc.id, specs);
  }
  const duplicates = new Map<string, string[]>();
  for (const [id, specs] of idToSpecs) {
    if (specs.length > 1) duplicates.set(id, specs);
  }
  return duplicates;
}

/**
 * AC-2: For each unchecked SC without a hand-written test, runs matchPattern()
 * and executes the returned assertion against the project root.
 * Results are scoped by spec file to prevent cross-spec ID collisions.
 *
 * Behavioral SCs are checked against the behavioral-results cache first.
 * If a fresh cached result exists, it's used instead of matchPattern.
 */
export function checkConformitySCs(uncheckedSCs: UncheckedSC[], root: string): ConformityResult {
  const passing = new Set<string>();
  const failing = new Set<string>();
  const unmatchable = new Set<string>();

  // Read behavioral cache for behavioral SCs
  const cachePath = join(root, ".rungate", "behavioral-results.json");
  const behavioralCache = readFreshCache(cachePath);

  for (const sc of uncheckedSCs) {
    const statement = sc.statement || "";
    const key = scopedKey(sc.specFile, sc.id);
    const parsed: ParsedSC = { id: sc.id, statement, specFile: sc.specFile };

    // Check behavioral cache first for behavioral SCs
    if (isBehavioralSC(parsed) && behavioralCache[sc.id]) {
      if (behavioralCache[sc.id].passed) {
        passing.add(key);
      } else {
        failing.add(key);
      }
      continue;
    }

    const assertion = matchPattern(parsed);

    if (!assertion) {
      unmatchable.add(key);
      continue;
    }

    try {
      assertion(root);
      passing.add(key);
    } catch {
      failing.add(key);
    }
  }

  return { passing, failing, unmatchable };
}

export function flipCheckboxes(specFile: string, scIds: string[], specsDir?: string, isDryRun?: boolean): number {
  const dir = specsDir || SPECS_DIR;
  const filePath = join(dir, specFile);
  let content = readFileSync(filePath, "utf-8");
  let flipped = 0;

  for (const id of scIds) {
    const pattern = `- [ ] ${id}:`;
    if (content.includes(pattern)) {
      content = content.replace(pattern, `- [x] ${id}:`);
      flipped++;
    }
  }

  // Write unless dry-run: use explicit isDryRun param if provided, else module-level flag
  const shouldSkipWrite = isDryRun !== undefined ? isDryRun : dryRun;
  if (flipped > 0 && !shouldSkipWrite) {
    writeFileSync(filePath, content);
  }
  return flipped;
}

export interface SpecCoverage {
  testedPassing: string[];
  testedFailing: string[];
  conformityPassing: string[];
  conformityFailing: string[];
  unmatchable: string[];
}

/**
 * AC-4: --report flag outputs per-spec coverage showing
 * tested-passing, tested-failing, and unmatchable SCs.
 */
export function generateReport(specCoverage: Map<string, SpecCoverage>): string {
  const lines: string[] = [];
  lines.push("=== SC Coverage Report ===\n");

  for (const [specFile, coverage] of specCoverage) {
    lines.push(`${specFile}:`);
    if (coverage.testedPassing.length > 0)
      lines.push(`  tested-passing (${coverage.testedPassing.length}): ${coverage.testedPassing.join(", ")}`);
    if (coverage.testedFailing.length > 0)
      lines.push(`  tested-failing (${coverage.testedFailing.length}): ${coverage.testedFailing.join(", ")}`);
    if (coverage.conformityPassing.length > 0)
      lines.push(`  conformity-passing (${coverage.conformityPassing.length}): ${coverage.conformityPassing.join(", ")}`);
    if (coverage.conformityFailing.length > 0)
      lines.push(`  conformity-failing (${coverage.conformityFailing.length}): ${coverage.conformityFailing.join(", ")}`);
    if (coverage.unmatchable.length > 0)
      lines.push(`  unmatchable (${coverage.unmatchable.length}): ${coverage.unmatchable.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

// --- Main (only runs when executed directly) ---
const isDirectExecution = import.meta.main;

if (isDirectExecution) {
  const unchecked = findUncheckedSCs();
  if (unchecked.length === 0) {
    console.log("All SCs are already checked off");
    process.exit(0);
  }

  console.log(`Found ${unchecked.length} unchecked SCs across specs`);

  // Step 0: Check for drift and staleness
  const driftResult = detectDrift(SPECS_DIR, ROOT);
  const driftedSCs = new Set<string>();
  const staleSCs = new Set<string>();

  if (driftResult.drifted.size > 0 || driftResult.stale.size > 0) {
    console.log(`\n⚠️  SC drift/staleness detected:`);

    for (const [specFile, details] of driftResult.drifted) {
      for (const detail of details) {
        console.log(`  DRIFT: ${detail.scId} in ${specFile} references ${detail.path} but file does not exist`);
        driftedSCs.add(scopedKey(specFile, detail.scId));
      }
    }

    for (const [specFile, details] of driftResult.stale) {
      for (const detail of details) {
        console.log(`  STALE: ${detail.scId} in ${specFile} expects [${detail.keyword}] in ${detail.path} but it's missing`);
        staleSCs.add(scopedKey(specFile, detail.scId));
      }
    }

    console.log(`  Fix: update SC descriptions to match current file structure.\n`);
  }

  // Step 1: Detect duplicate SC IDs across specs
  const duplicates = findDuplicateSCIds(unchecked);
  if (duplicates.size > 0) {
    console.log(`\n⚠️  Duplicate SC IDs found across specs:`);
    for (const [id, specs] of duplicates) {
      console.log(`  ${id}: ${specs.join(", ")}`);
    }
    console.log(`  Fix: renumber duplicates so each SC ID is unique across all specs.\n`);
  }

  // Step 2: Find SCs covered by hand-written test files.
  // Scoped to (spec, id) since #330 — see findTestFilesForSCs. The old bare-id
  // credit ticked the id in every spec declaring it.
  const registry = readScRegistry();
  const testFileMap = findTestFilesForSCs(unchecked, registry);
  const testedKeys = new Set(
    [...testFileMap.values()].flat().map(c => scopedKey(c.specFile, c.id)),
  );
  const untestedSCs = unchecked.filter(s => !testedKeys.has(scopedKey(s.specFile, s.id)));

  // Mentions that look like claims and are not credited. Visible on purpose:
  // under-crediting is the safe direction and still a measurement error.
  const unqualified = new Map<string, string>();
  for (const file of readdirSync(TEST_DIR).filter(f => f.endsWith(".test.ts"))) {
    for (const u of unqualifiedClaims(readFileSync(join(TEST_DIR, file), "utf-8"), registry)) {
      unqualified.set(`${file} ${u.id}`, `  ${file}: ${u.id} — ${u.reason}`);
    }
  }
  if (unqualified.size > 0) {
    console.log(`\n⚠️  ${unqualified.size} ambiguous SC mention(s) credited to nothing:`);
    for (const line of [...unqualified.values()].sort()) console.log(line);
  }

  // #574. A criterion whose only test is a `.todo` is UNMEASURED, and
  // UNMEASURED has to be loud: `0`, `{}`, `null` and silence are all
  // indistinguishable from success. Reported by name, with the file, so the
  // list is a backlog rather than a number.
  const intended = intendedOnly(TEST_DIR);
  if (intended.size > 0) {
    console.log(`\n⚠️  UNMEASURED: ${intended.size} SC(s) named only by a test that never runs:`);
    for (const [id, files] of [...intended].sort()) {
      console.log(`  ${id}: ${files.join(", ")} — a .todo or .skip title is a declaration of intent, not coverage`);
    }
  }

  // Step 3: Run hand-written tests — scope by spec file
  const passingSCs = new Set<string>();
  const failingSCs = new Set<string>();

  for (const [testFile, credits] of testFileMap) {
    process.stdout.write(`  Running ${testFile}...`);
    const passed = runTestFile(testFile);
    const target = passed ? passingSCs : failingSCs;
    console.log(
      passed
        ? ` (${credits.length} SCs)`
        : ` (${credits.map(c => `${c.id} in ${c.specFile}`).join(", ")})`,
    );
    for (const c of credits) target.add(scopedKey(c.specFile, c.id));
  }

  // Remove any SCs that failed from passing set
  for (const key of failingSCs) passingSCs.delete(key);

  // Step 4: AC-2 — Run conformity assertions on untested SCs
  if (untestedSCs.length > 0) {
    console.log(`\nChecking ${untestedSCs.length} untested SCs via conformity engine...`);
    const conformityResult = checkConformitySCs(untestedSCs, ROOT);

    for (const key of conformityResult.passing) {
      passingSCs.add(key);
      const scId = key.split("::")[1];
      console.log(`  ${scId}: conformity PASS`);
    }
    for (const key of conformityResult.failing) {
      failingSCs.add(key);
      const scId = key.split("::")[1];
      console.log(`  ${scId}: conformity FAIL`);
    }
    if (conformityResult.unmatchable.size > 0) {
      const ids = [...conformityResult.unmatchable].map(k => k.split("::")[1]);
      console.log(`  ${conformityResult.unmatchable.size} SCs unmatchable: ${ids.join(", ")}`);
    }

    // AC-4: --report flag
    if (reportMode) {
      const specCoverage = new Map<string, SpecCoverage>();

      for (const sc of unchecked) {
        if (!specCoverage.has(sc.specFile)) {
          specCoverage.set(sc.specFile, {
            testedPassing: [],
            testedFailing: [],
            conformityPassing: [],
            conformityFailing: [],
            unmatchable: [],
          });
        }
        const coverage = specCoverage.get(sc.specFile)!;
        const key = scopedKey(sc.specFile, sc.id);

        // Scoped since #330: a bare id matched a criterion in every spec
        // declaring it, so one spec's report borrowed another's test result.
        if (testedKeys.has(key)) {
          if (passingSCs.has(key)) coverage.testedPassing.push(sc.id);
          else if (failingSCs.has(key)) coverage.testedFailing.push(sc.id);
        } else if (conformityResult.passing.has(key)) {
          coverage.conformityPassing.push(sc.id);
        } else if (conformityResult.failing.has(key)) {
          coverage.conformityFailing.push(sc.id);
        } else if (conformityResult.unmatchable.has(key)) {
          coverage.unmatchable.push(sc.id);
        }
      }

      console.log("\n" + generateReport(specCoverage));
    }
  }

  // Step 4: Filter out drifted/stale SCs before flipping
  for (const key of driftedSCs) {
    if (passingSCs.has(key)) {
      passingSCs.delete(key);
      const scId = key.split("::")[1];
      console.log(`\n⚠️  Not flipping ${scId}: drifted (references nonexistent file)`);
    }
  }
  for (const key of staleSCs) {
    if (passingSCs.has(key)) {
      passingSCs.delete(key);
      const scId = key.split("::")[1];
      console.log(`\n⚠️  Not flipping ${scId}: stale (keyword missing from file)`);
    }
  }

  // Step 5: Flip passing SCs
  if (passingSCs.size === 0) {
    console.log("No SCs to flip");
    process.exit(0);
  }

  // Group passing SCs by spec file and flip — scoped keys prevent cross-spec bleeding
  const bySpec = new Map<string, string[]>();
  for (const sc of unchecked) {
    const key = scopedKey(sc.specFile, sc.id);
    if (passingSCs.has(key)) {
      const list = bySpec.get(sc.specFile) || [];
      list.push(sc.id);
      bySpec.set(sc.specFile, list);
    }
  }

  let totalFlipped = 0;
  for (const [specFile, scs] of bySpec) {
    const flipped = flipCheckboxes(specFile, scs);
    if (flipped > 0) {
      console.log(`${dryRun ? "Would flip" : "Flipped"} ${flipped} SCs in ${specFile}: ${scs.join(", ")}`);
      totalFlipped += flipped;
    }
  }

  console.log(`\n${dryRun ? "Would flip" : "Flipped"} ${totalFlipped} SC checkboxes`);
}
