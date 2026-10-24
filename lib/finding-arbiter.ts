/**
 * Whether a finding is worth filing as an issue — stage 1, mechanical (#1187).
 *
 * ## What this answers, and what it deliberately does not
 *
 * Measured at 15:24 on 2026-10-22: **14 issues filed per hour against 6
 * closed**, 27 open. Nothing between an agent producing a finding and the
 * finding becoming an issue asks whether it is worth filing. #1187 names four
 * filing failures from one session and records that a correctness vote —
 * "several agents hunt, a separate group votes" — catches **none** of them.
 * Every one of the four was a real observation about the tree its reader was
 * looking at. The questions that would have stopped them are *is this new*,
 * *is this here* and *is this current*, and all three are decidable by one
 * process with no model in it.
 *
 * So the checks run in cost order, each on what survived the one before:
 *
 * | stage | question | instrument | on failure |
 * |---|---|---|---|
 * | 1 | is this new? | string sets over the finding bodies | `DUPLICATE` |
 * | 2 | do enough verifiers call it real? | `lib/finding-jury.ts` counts votes the caller cast | `NO_QUORUM` |
 * | 3 | is it the kind we post at all? | the category, verifier-supplied or keyed | `DROPPED_CATEGORY` |
 * | 4 | which tree is it about? | `git grep` against `origin/main` | sets `scope`, never refuses |
 * | 5 | is this current? | the file's line count | `STALE_CITATION` |
 *
 * Stage 1 first and the vote second is the one ordering choice worth
 * defending: a vote is the most expensive instrument the harness has, and
 * spending three agent contexts to confirm a finding that a string-set
 * comparison already knows is a duplicate is the failure #1187 measured.
 *
 * ## THE DEFAULT IS A COMMENT, NOT AN ISSUE
 *
 * #1187 asked which findings are worth **filing**, and that framing is wrong.
 * The design it was drawn from files nothing: a surviving finding becomes an
 * inline comment that **blocks the merge until it is answered** — fixed, or
 * the thread closed with a reason. There is no backlog because findings never
 * become backlog. We added the filing step, and it is why the tracker
 * regenerates: measured 2026-10-22, 23 of 27 open issues were created the
 * same day and 10 named one subsystem.
 *
 * So `Disposition` defaults to `COMMENT`, `ISSUE` requires an explicit
 * declared reason from the caller (`Finding.outOfScope`), and what used to be
 * the `OFF_MAIN` **refusal** is now the `scope` **reading** — a finding about
 * an unmerged branch was never a bad finding, it was a comment on that branch
 * all along. See `FindingScope`.
 *
 * ## Why the key is the measured symptom and not the title
 *
 * The two duplicate pairs this was built against both merged today:
 *
 * - **#1175 / #1177** — two agents, the same 5,060-command corpus sweep, the
 *   same 144-of-234 reading, filed five minutes apart under **completely
 *   different titles**. A title-keyed deduper misses this, and
 *   `test/finding-arbiter.test.ts` runs a title-similarity deduper over the
 *   pair to show that it does.
 * - **#1195 / #1196** — an agent and a human filed the same two regressions
 *   from the same merge, one minute apart. Different titles again; the same
 *   `commandWord` / `isDirDestination` / `statSync` symptom underneath.
 *
 * What survives a rewrite of the prose is what the finding **measured**: the
 * symbols it names, the files it names, and the integers it reports. So a
 * finding emits a set of keys of those three kinds and two findings are
 * duplicates when they share at least `DUPLICATE_MIN_SHARED_KEYS` of them.
 *
 * A set-overlap test and not a hash of the set, because the sets are never
 * equal — #1177 carries a measurement table #1175 renders as prose. An exact
 * key over the symptom catches neither pair, which is the same failure as the
 * title key one level in.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * - **Two findings about one symbol that are genuinely different defects.**
 *   A hot file collects findings, and shared symbols are what a hot file
 *   produces. The threshold is tuned on a 40-issue corpus in
 *   `test/finding-arbiter.test.ts` and the false positives it produces there
 *   are listed in that file by number rather than tuned away. **The direction
 *   of the error matters:** a false DUPLICATE withholds a real finding, so
 *   `arbitrate` returns the colliding issue numbers and the shared keys —
 *   the refusal is reviewable, never silent.
 * - **A finding whose symbol exists on `origin/main` under a different
 *   name.** A rename between the reviewed branch and `main` reads here as
 *   `OFF_MAIN`.
 * - **Prose-only findings.** A finding that names no symbol and no file is
 *   `UNMEASURED`, which FAILS — it does not skip. That is #1187's own
 *   doctrine and the one line in here that must not be softened: a finding
 *   nobody can evaluate is not a finding that passes.
 */

import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { resolve, sep } from "path";

import { contentHash } from "./content-hash";
import {
  promoteCandidates,
  type PromotableCandidate,
  type PromotionReading,
  type WithheldReason,
} from "./rule-promotion";
import {
  classifyCategory,
  DROPPED_CATEGORIES,
  juryCategory,
  juryReading,
  severityOf,
  SEVERITY_RANK,
  type Disposition,
  type FindingCategory,
  type JuryConfig,
  type JuryReading,
  type Severity,
  type VerifierVote,
} from "./finding-jury";

/** A finding, as little of one as the checks need. */
export interface Finding {
  /** How the caller names it — an issue number, or `new` for an unfiled one. */
  id: string;
  title: string;
  body: string;
  /**
   * The ONE route to `ISSUE`, and it must be declared, never inferred.
   *
   * Filing is the exception: the work genuinely cannot ride along on this PR
   * — a different subsystem, or a design decision somebody else owns. An
   * *inferred* exception is exactly how a filing default comes back, so there
   * is no heuristic here and there is no default: a caller that wants an
   * issue says so and says why, in a sentence that ends up in the issue body.
   */
  outOfScope?: { reason: string };
}

/**
 * The id an unfiled finding carries, and the one id that does not identify.
 *
 * Exported so the CLI and the dedupe share one binding. Two findings both
 * labelled `"new"` are two different findings, not one — and treating the
 * label as an identity is what made the in-batch dedupe a no-op in exactly
 * the configuration it was written for.
 */
export const UNFILED_ID = "new";

export type SymptomKeyKind = "sym" | "file" | "qty";

/**
 * A quantity key, `qty:<n>:<what was counted>`.
 *
 * Its own type because it is **not** a symptom key since #1536: it answers
 * "did these two take the same reading?", which is a different question from
 * "are these two the same finding?", and only the second belongs in an
 * identity. See `quantityKeys`.
 */
export type QuantityKeyKind = "qty";

/** How many cited symbols the branch-scope reading will pay a `git grep` for. */
const MAX_SYMBOLS_PROBED = 8;

/**
 * How many `path:line` citations the currency reading will pay a file read for.
 *
 * The asymmetry this fixes ran the wrong way: `MAX_SYMBOLS_PROBED` bounded the
 * *cheap* probe while the expensive one — a `readFileSync`, or a
 * `git show origin/main:<path>` per citation — was unbounded. An AI reviewer's
 * output is the one input on this path nobody audits, so a body naming four
 * hundred `file.ts:N` pairs was a free way to wedge the arbiter.
 */
const MAX_LINES_PROBED = 8;

/**
 * Identifiers that are code-shaped and carry no information about which
 * defect is being described. Excluded from the key rather than down-weighted,
 * because a weight is a second threshold to justify.
 */
const UNINFORMATIVE_SYMBOLS = new Set([
  "true", "false", "null", "undefined", "string", "number", "boolean",
  "console", "process", "export", "import", "return", "const", "function",
  "origin/main", "main", "HEAD",
]);

// ── Symptom keys ─────────────────────────────────────────────────────────

/** Spans between backticks, where a body puts the things it measured. */
function codeSpans(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/`{1,3}([^`]+)`{1,3}/g)) out.push(m[1]);
  return out;
}

/**
 * Identifiers worth keying on: `camelCase`, `UPPER_SNAKE`, `snake_case`.
 *
 * Two exclusions, both measured on the 40-issue corpus rather than guessed:
 *
 * - **A bare lowercase word is not a symbol.** That costs `dequote` and
 *   `mkdtemp` on the two pairs above and buys exclusion of every English word
 *   that ever appears inside backticks. Both pairs clear the threshold
 *   without them.
 * - **An all-caps token must contain `_`.** Without this, the hyphenated
 *   filename `specs/HOOK-ARCHITECTURE-SPEC.md` yields the three "symbols"
 *   `HOOK`, `ARCHITECTURE` and `SPEC`, and `CODE-MAP.md` yields two more —
 *   so two findings citing one document agree on five keys while sharing no
 *   symptom. It also drops the status vocabulary (`CLEAN`, `BLOCK`, `PASS`,
 *   `FAIL`, `EOF`, `JSON`), which every finding in a review pipeline uses.
 *   The path itself is still keyed, once, as a `file:` key.
 *
 *   The cost is real and is the direction to watch: a genuine unsnaked
 *   constant such as `OPERATORS` is no longer a key. It is paid because the
 *   measured error was 44 false pairs out of 49.
 */
function identifiersIn(span: string): string[] {
  const out: string[] = [];
  for (const m of span.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/g)) {
    const t = m[0];
    if (UNINFORMATIVE_SYMBOLS.has(t)) continue;
    const shaped = /[a-z][A-Z]/.test(t) || /_/.test(t);
    if (shaped) out.push(t);
  }
  return out;
}

/** Repository-shaped paths, anywhere in the body. */
function pathsIn(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/(?:[\w.@-]+\/)+[\w.-]+\.(?:ts|tsx|js|mjs|cjs|md|json|ya?ml|sh)\b/g)) {
    out.push(m[0].toLowerCase());
  }
  return out;
}

/**
 * Readings a finding reports, each as `<n>:<what it counted>`.
 *
 * ## A BARE INTEGER IS NOT A SYMPTOM (#1536)
 *
 * This emitted the integer alone, and the integer alone cannot say whether
 * `19` is a line number, a count of check names or a byte figure. Two
 * measured false `DUPLICATE`s on 2026-10-24, both overridden after a human
 * read the issue the refusal named:
 *
 * | refused | called a duplicate of | on |
 * |---|---|---|
 * | #1520 instruction-surface headroom | #1506 reservation protocol | `qty:20`, `qty:99` + one path |
 * | #1534 clean arm's banked reading | #1162 findings discarded four ways | `qty:19`, `qty:22`, `qty:28` + one symbol |
 *
 * In #1534 the three integers are LINE NUMBERS — *"the clean arm changes
 * 7–11, 22, 25, 28"* — and in #1162 they are counts: *"19 distinct check
 * names"*, *"22 times"*, *"28 carrying refusals"*. Nothing the old key
 * carried could tell those apart, so any issue quoting a measurement
 * collided with any other issue quoting a measurement.
 *
 * So the key carries **the word the number qualifies**: the token
 * immediately after it, joined by one space or one hyphen. `19 violations`
 * is a reading; `19` followed by a comma, a full stop or a line end is a
 * position in a list and emits nothing. No stopword list and no second
 * threshold — a number with nothing naming what it counted is simply not a
 * key, which is the one direction this function is allowed to be wrong in.
 *
 * Measured over a 103-issue live corpus (43 open + the 60 most recent
 * closed) on 2026-10-24, 5,253 pairs, before and after — together with
 * moving these keys out of the identity set, which is the other half of the
 * change and cannot be measured apart from it:
 *
 * | | pairs flagged | byte-identical re-filings refused |
 * |---|---|---|
 * | before | 6 — **4 of them false** | 96/103 |
 * | after | **3** — all four false pairs gone | 93/103 |
 *
 * Both true duplicates on that corpus survive (#1456/#1454 at 0.900,
 * #1409/#1406 at 1.000) and one new pair appears: **#1394/#1353**, two
 * ai-review ledger defects in one file at containment exactly 0.800. It is
 * named here rather than tuned away, the way this file names the rest of
 * its false positives — the refusal is reviewable and `arbiter-override`
 * waives it.
 *
 * The price, stated: ten findings carrying one to three location keys
 * (#1492, #1395, #1341, #1167, #1160, #1157, #1437, #1426, #1413, #1412)
 * reached the floor only through bare integers and can now be re-filed
 * byte-identically. A duplicate that gets filed is a tracker row somebody
 * closes; a false `DUPLICATE` silences a finding. The asymmetry this file
 * argues everywhere else is what chooses the direction.
 *
 * The other exclusions are unchanged and are what make this a measurement
 * and not a number: an issue reference (`#1188`), an SC or AC id, a date
 * component, and anything under ten. Without the first of those, every
 * finding that cites the same prior issue collides with every other — which
 * is a reading of the cross-reference graph, not of the defect.
 */
function quantitiesIn(body: string): string[] {
  const out: string[] = [];
  // Blank out the shapes whose digits are identifiers rather than readings,
  // keeping the length so no two tokens are glued together by the removal.
  const masked = body
    // Emphasis first, and to a SPACE so lengths still hold. `**144** rows`
    // and `144 rows` are the same reading written twice, and a qualifier the
    // author happened to bold away would be the second shape in
    // `.claude/rules/checks-must-be-able-to-fail.md` — a detector narrower
    // than what it detects, defeated by a reformat.
    .replace(/\*/g, " ")
    .replace(/#\d+/g, m => " ".repeat(m.length))
    .replace(/\b(?:SC|AC|PR|H|R)-?\d+/gi, m => " ".repeat(m.length))
    .replace(/\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g, m => " ".repeat(m.length))
    // Before the `:\d+` rule, not after (#1333). That rule takes the minutes
    // and leaves the hour, so by the time a later rule ran there would be no
    // clock time left to see — `15:24` scored `qty:15`, the same key a
    // genuine reading of 15 produces. Colon-joined numbers are a time or a
    // ratio far more often than two independent readings, and masking both
    // is the direction this function is allowed to be wrong in: a key it
    // declines to emit cannot make two unrelated findings agree.
    // ## The boundaries are lookarounds, NOT `\b` (#1385)
    //
    // This shipped as `/\b\d{1,2}:\d{2}(?::\d{2})?\b/` and the trailing `\b`
    // is the bug: it needs a NON-word character after the match, and a UTC
    // `Z` is a word character. So `19:05Z` did not match, the `:\d+` rule
    // below then ate `:05`, and the hour survived as `qty:19` — the exact
    // defect #1333 was filed about, surviving #1333's fix.
    //
    // It had a live instance. `#1226` says "registry served 0.8.1 at roughly
    // 19:05Z" and `#1162` says "19 distinct check names"; that collision was
    // one of only two cross-issue duplicate pairs the arbiter produced on the
    // open corpus, and closing it drops the pair below the quantity floor.
    //
    // `(?<![\d:])` refuses to start mid-number, so the `48` of `15:48:30`
    // cannot begin a second match. `(?!\d)` refuses to stop mid-number but
    // allows a letter, which is the whole fix.
    .replace(/(?<![\d:])\d{1,2}:\d{2}(?::\d{2})?(?!\d)/g, m => " ".repeat(m.length))
    .replace(/:\d+/g, m => " ".repeat(m.length))
    .replace(/\bv?\d+\.\d+(?:\.\d+)?/g, m => " ".repeat(m.length));
  // The qualifier is whatever word the number runs into, with no vocabulary
  // of accepted units: a list of units is a list somebody has to maintain,
  // and one that is missing a word silently drops a real reading. Two
  // findings agreeing on `144:of` agree on more than two findings agreeing
  // on `144`, which is the entire claim.
  // `[ -]+` and not `[ -]`: the emphasis mask above turns `**144** rows`
  // into two spaces, and a reading that depended on how many spaces the
  // author's markdown left behind would be the second shape in
  // `.claude/rules/checks-must-be-able-to-fail.md` all over again.
  for (const m of masked.matchAll(/\b(\d[\d,]*)[ -]+([A-Za-z]+)/g)) {
    const n = Number.parseInt(m[1].replace(/,/g, ""), 10);
    if (Number.isFinite(n) && n >= 10) out.push(`${n}:${m[2].toLowerCase()}`);
  }
  return out;
}

/**
 * The keys a finding is deduplicated on.
 *
 * ## What the key set is FOR, and why quantities are no longer in it (#1536)
 *
 * It answers one question and no other: **would these two findings be
 * closed by the same change?** Every admission rule below follows from that
 * and from nothing else. A `sym:` or `file:` key names something a fix would
 * edit — which is why a bare lowercase word is not a symbol and an unsnaked
 * all-caps token is not either: `CLEAN` and `dequote` name nothing anybody
 * would change.
 *
 * **A measurement is not part of that identity.** A reading is evidence
 * *about* a defect, and the same defect measured twice gives two numbers
 * while two unrelated defects give one. That is not a claim from first
 * principles; it is the shape of both false `DUPLICATE`s of 2026-10-24,
 * which `quantitiesIn` records. So quantities moved out of this set and into
 * `quantityKeys`, read by the one arm that asks about readings.
 *
 * That split is also what stopped the fix costing the pair this module was
 * built on. Qualifying the quantity and leaving it here was tried first and
 * **lost #1175/#1177**, whose containment fell from 1.000 to 0.417: the key
 * sets grew, because prose repeats a number beside a different word each
 * time, and a ratio whose denominator grows with prose is measuring prose.
 * A reading could never have belonged in that denominator.
 *
 * This set is deliberately NOT a relevance score, not a topic model, and not
 * an index: a key that merely says two findings are *about* the same area
 * produces the `lib/bash-write-guard.ts` cluster, six distinct defects in
 * one file that this rule exists to keep apart.
 *
 * What was measured and NOT adopted, so the next reader does not re-derive
 * it: #1536 also asks whether a path or symbol appearing only as *cited
 * evidence* — inside a blockquote, or in a table of candidates — should
 * weigh as a subject. Both variants were run over the same 103-issue corpus.
 * Excluding blockquote lines moved **nothing**: zero pairs, zero re-filings.
 * Excluding table rows as well cost a TRUE duplicate — #1456/#1454 fell from
 * 0.900 to 0.750 — because in this repository a table is where a finding
 * states its own fixture paths. Neither narrowing removed a false positive
 * the qualified quantity had not already removed, so neither shipped: an
 * admission rule with no measured case is an unproven rule, and this file
 * already has more constants than corpus to justify them.
 *
 * Sorted and de-duplicated, so two runs over one finding agree byte for byte
 * and a caller can print the intersection without re-deriving it.
 */
export function symptomKeys(finding: Finding): string[] {
  const keys = new Set<string>();
  for (const span of [...codeSpans(finding.body), finding.title]) {
    for (const id of identifiersIn(span)) keys.add(`sym:${id}`);
  }
  for (const p of [...pathsIn(finding.body), ...pathsIn(finding.title)]) keys.add(`file:${p}`);
  return [...keys].sort();
}

/**
 * The readings a finding reports — a different question from its identity.
 *
 * Read ONLY by `duplicateOverlap`'s same-reading arm. Deliberately not part
 * of `symptomKeys`, `symptomHash` or `containmentOf`: see `symptomKeys` for
 * what the identity set is for, and `quantitiesIn` for the two false
 * `DUPLICATE`s that moved these out of it.
 *
 * The body only, never the title. A title states a headline number the body
 * also states, and counting it twice would let two findings agree on one
 * reading reported in two places.
 */
export function quantityKeys(finding: Finding): string[] {
  return [...new Set(quantitiesIn(finding.body).map(q => `qty:${q}`))].sort();
}

/**
 * A stable identity for the symptom as a whole — the one hashing binding.
 *
 * Location keys only since #1536, so **re-measuring does not change the
 * hash**. Hashes written to `~/.rungate/finding-ledger.jsonl` before that
 * date were taken over a different key set and will not match one taken now;
 * the field was never a row identity and `FilingLedgerRow.key` says so.
 */
export function symptomHash(finding: Finding): string {
  return contentHash(symptomKeys(finding).join("\n"));
}

/**
 * Keys two findings have in common, sorted — both kinds, because this is
 * what a refusal prints and a reader asked to review a refusal needs to see
 * every key it was decided on, not only the ones in the identity set.
 */
export function sharedKeys(a: Finding, b: Finding): string[] {
  const left = new Set([...symptomKeys(a), ...quantityKeys(a)]);
  return [...symptomKeys(b), ...quantityKeys(b)].filter(k => left.has(k)).sort();
}

/**
 * Do two findings describe the same measured symptom?
 *
 * **The two key kinds answer different questions and the rule needs both.**
 * A shared `sym:` or `file:` key says the findings are about the same area
 * of code. A shared `qty:` key says they report the same *reading*. Only the
 * second is a measurement, and #1187 asks for a key derived from the
 * measured symptom.
 *
 * The corpus says why that distinction is the whole rule. Over the 40 most
 * recent issues, a plain "share at least three keys of any kind" test flags
 * **19 pairs, of which 2 are real**. Six of the seventeen are one cluster —
 * #1175, #1176, #1177, #1184, #1195, #1196 all landed on
 * `lib/bash-write-guard.ts` in a single afternoon and name the same
 * functions while describing genuinely different defects. Every one of those
 * six shares **zero or one** quantity. Requiring two drops the cluster
 * whole, and both real pairs clear it: #1175/#1177 agree on 144, 234 and
 * 5,060, and #1195/#1196 on two more.
 *
 * ## The honest caveat
 *
 * The two target pairs were fixed as the requirement before any of this was
 * written. **The kind-split was not** — it was chosen after reading the
 * corpus it is measured on, so the 5-pair reading below is a fit, not a
 * forecast. What makes it worth shipping anyway is that the surviving false
 * positives are one explainable class rather than a residue: all three
 * involve #1187, which quotes other findings' numbers verbatim because it is
 * *about* them. A finding that re-reports another's readings is the shape
 * this rule cannot tell from a duplicate, and nothing here claims otherwise.
 */
export const DUPLICATE_MIN_SHARED_QUANTITIES = 2;
export const DUPLICATE_MIN_SHARED_LOCATIONS = 1;

/**
 * The second arm: how much of one finding's key set must sit inside the
 * other's before it is the same finding rather than a similar one (#1301).
 *
 * **A re-filing and a paraphrase are different questions and only the second
 * was being asked.** The rule above asks "do these two share enough to be the
 * same symptom?", which is right for #1175/#1177 and wrong for a finding
 * being filed twice: measured over the live tracker on 2026-10-23, 26 of 38
 * open findings re-filed BYTE-IDENTICALLY were refused and **12 were
 * allowed**, every one of them because it carries fewer than two quantity
 * keys. They are not key-poor — median 7.5 location keys, one with nineteen
 * — they name symbols and files and report no measured numbers.
 *
 * Lowering `DUPLICATE_MIN_SHARED_QUANTITIES` is the cheap fix and the wrong
 * one. At 1 the self-refile rate goes to 82% and the `lib/bash-write-guard.ts`
 * cluster comes back, in the direction this file already calls worse.
 *
 * So this is an ADDITIONAL arm, OR-ed with the one above and never replacing
 * it. Measured over all 44 findings — the 38 open plus the six closed cluster
 * issues, which a sweep of open issues alone cannot see — across 946 pairs:
 *
 * | rule | cross-issue pairs |
 * |---|---|
 * | `qty>=2 AND loc>=1` | 4 — 1175/1177, 1195/1196, 1269/1286, 1162/1226 |
 * | containment >= 0.6 | 3 — 1175/1177, 1195/1196, 1195/1239 |
 * | containment >= 0.8 | **1** — 1175/1177 |
 *
 * The two pairs the quantity threshold was tuned to CATCH are the top two by
 * containment, at 1.00 and 0.78. The four inside the cluster it was tuned to
 * KEEP APART top out at 0.44. At 0.8 this arm adds **zero** cross-issue pairs
 * over the whole corpus while taking the self-refile rate to 38 of 38.
 *
 * ## The caveat, in the same terms as the tuning above
 *
 * 0.8 is fitted on 44 findings, and on that corpus the only thing separating
 * it from 0.6 is a single pair. It is chosen for the error direction rather
 * than for a margin the data supports, and a false DUPLICATE here stays
 * reviewable: the refusal names the colliding issue and the shared keys, and
 * `arbiter-override` waives it.
 *
 * ## THAT SEPARATING PAIR WAS A TIMESTAMP, AND THE JUSTIFICATION IS VOID (#1333)
 *
 * The single pair was #1195/#1196 at 0.778, and 0.778 was inflated by a leak:
 * both findings say "merged 15:48" and `quantitiesIn` emitted the hour as
 * `qty:15`. With the leak masked the pair reads **0.750** — and so does
 * #1195/#1239, which is a DIFFERENT write-guard defect. They are exactly
 * tied, so **no value of this constant admits the first and excludes the
 * second.** The margin that chose 0.8 over 0.6 was the two findings
 * mentioning the same time of day.
 *
 * Measured on the 11 issues this file's tables name, 49 pairs after the
 * cross-reference escape, with two known duplicates (#1175/#1177,
 * #1195/#1196):
 *
 * | arm | can it isolate #1195/#1196? |
 * |---|---|
 * | containment | **no** — tied at 0.750 with a distinct pair |
 * | quantities | **no** — needs `>= 1`, which fires on 11 distinct pairs |
 * | locations | **no** — the highest shared-location pair (7) is distinct, above the true pair (5) |
 *
 * **We are not losing a capability here; we are finding out we never had
 * one, because the only reason that pair was ever caught was two findings
 * mentioning the same time of day.**
 *
 * **The tie survives the floor of 4 below**, re-measured against the merged
 * constant rather than predicted: both pairs still read 0.750, because #1239
 * carries exactly 4 keys and sits on the floor rather than under it. A floor
 * of 5 would separate them — by refusing the distinct pair a reading at all,
 * which is a different mechanism from a ratio and is not an argument for
 * moving the ratio.
 *
 * So both constants are left where they are. Every setting that recovers the
 * pair costs false positives, and a false DUPLICATE is a real finding
 * silently withheld — the direction this file already calls worse. Missing a
 * duplicate means a duplicate gets filed, which a human can see.
 *
 * ### THE TIE IS BROKEN, AND NOT BY EITHER CONSTANT (#1536)
 *
 * Everything above is still the correct reading *of a ratio taken over a key
 * set that mixed readings with locations*. It stopped being the reading when
 * quantities left `symptomKeys` — re-measured against the four live bodies
 * on 2026-10-24:
 *
 * | pair | before | after |
 * |---|---|---|
 * | #1195/#1196, the true duplicate | 0.750 | **0.833 — caught** |
 * | #1195/#1239, the distinct pair | 0.750 | **0.000 — below the floor** |
 *
 * Both constants are untouched. What moved is the denominator: #1239's three
 * remaining keys put it under `DUPLICATE_CONTAINMENT_MIN_KEYS`, and #1196's
 * five shared symbols are five of its six. So the sentence above — *no value
 * of this constant admits the first and excludes the second* — was true of
 * the ratio and false of the problem, and the capability it declared lost
 * was never a property of the cut. That is worth saying plainly rather than
 * deleting: a measurement that names a mechanism it never varied will read
 * as settled for as long as nobody varies it.
 *
 * **The 946-pair table above is not reproducible.** It was measured live
 * against a tracker that has moved and no corpus was stored, so neither
 * constant can be re-derived by anyone — including anyone who disagrees with
 * leaving them. **Tracked as #1365**; until a fixture exists, treat every
 * number in this docblock as a reading someone took once.
 *
 * The floor exists because containment is meaningless on a tiny key set — a
 * one-key finding is wholly contained in anything mentioning that key, which
 * would manufacture a duplicate out of one word.
 *
 * ## The floor is 4, and it was 2 for about an hour (#1318)
 *
 * It shipped at 2 on the argument that "a floor of 4 costs three of the 38
 * and flags not one pair fewer" — which was true, and was the wrong thing to
 * weigh. Counting the pairs it does not flag says nothing about the findings
 * it eats, and no case in the suite asked the second question. Re-measured on
 * the live tracker, at ratio 0.8 over the 35 findings the corpus filters to:
 *
 * | floor | self-refile | cross-issue pairs |
 * |---|---|---|
 * | 2 | 35/35 | 0 |
 * | 3 | 34/35 | 0 |
 * | 4 | **32/35** | 0 |
 * | 5 | 30/35 | 0 |
 *
 * No floor in that range costs a single cross-issue pair, so three of
 * thirty-five self-refiles is the entire price. What it buys: #1162 carries
 * 40 keys, and at floor 2 a TWO-key finding whose keys both appear in it is
 * refused as a duplicate of it. That is a real finding withheld by an
 * unrelated issue, reachable on the tracker as it stands.
 *
 * The two directions are not symmetric and that is what decides this. A
 * missed duplicate is a tracker row somebody closes. A false DUPLICATE
 * silences a finding, and an arbiter that quietly eats novel findings turns a
 * visible backlog into an invisible one — worse than the backlog it exists to
 * shrink. `AR-20` is the ALLOW-direction control that was missing.
 *
 * **Not closed by this:** a FOUR-key finding wholly inside that same issue is
 * still refused, at either floor. The floor shortens the swallow's reach; it
 * does not remove it. An absolute shared-key minimum beside the ratio would
 * not reach that case either, since four keys are genuinely shared.
 */
export const DUPLICATE_CONTAINMENT_RATIO = 0.8;
export const DUPLICATE_CONTAINMENT_MIN_KEYS = 4;

/** Does `text` reference `id` as an issue number? */
function references(text: string, id: string): boolean {
  if (!/^\d+$/.test(id)) return false;
  return new RegExp(`#${id}\\b`).test(text);
}

/**
 * Two findings that cite each other are not duplicates.
 *
 * An author who writes `#1177` knows #1177 exists; what they are filing is a
 * comment on it, a follow-on from it, or — in the case that made this rule
 * necessary — an issue *about* a set of other findings, quoting their
 * readings in order to argue from them. #1187 is that shape: it reproduces
 * #1175's 234 and 5,060 and #1176's 60 verbatim, and under measurement alone
 * it is indistinguishable from a duplicate of each.
 *
 * Measured: removes 2 false positives of 7 and neither target pair, which is
 * the asymmetry worth having — it can only ever *allow* a filing, so the
 * worst case is a duplicate that gets through, never a real finding
 * withheld.
 */
export function duplicateOverlap(a: Finding, b: Finding): { duplicate: boolean; keys: string[] } {
  const keys = sharedKeys(a, b);
  if (references(a.body, b.id) || references(b.body, a.id)) return { duplicate: false, keys };
  // Counted from their own producers rather than by prefix over `keys`
  // (#1536). The two kinds are now two sets and the prefix test was the
  // place that still treated them as one — a quantity that slipped into the
  // identity set would be counted by both arms and nothing would say so.
  const quantities = keys.filter(k => k.startsWith("qty:")).length;
  const locations = keys.length - quantities;
  const sameSymptom =
    quantities >= DUPLICATE_MIN_SHARED_QUANTITIES &&
    locations >= DUPLICATE_MIN_SHARED_LOCATIONS;

  // The second arm, OR-ed and never replacing the first: is one of these
  // findings' key sets essentially INSIDE the other's? That is the question a
  // re-filing answers yes to and a paraphrase does not, and the first arm
  // cannot ask it — see DUPLICATE_CONTAINMENT_RATIO for the 946-pair reading
  // that sets the cut and for what the floor is protecting against.
  const contained = containmentOf(a, b) >= DUPLICATE_CONTAINMENT_RATIO;

  return { duplicate: sameSymptom || contained, keys };
}

/**
 * How much of the smaller key set sits inside the larger, as a ratio.
 *
 * **`0` when either side is under `DUPLICATE_CONTAINMENT_MIN_KEYS`** — a
 * refusal, not a reading, and the two are deliberately the same number here
 * because both mean "this arm does not fire". A caller that needs to tell
 * them apart must check the sizes itself, and `AR-9`'s tie case does.
 *
 * Exported so the arm has **one binding**. A test that recomputed this
 * expression would be a second decider over the same question and a
 * mutation of either would leave the other holding the case up
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 */
export function containmentOf(a: Finding, b: Finding): number {
  const left = new Set(symptomKeys(a));
  const sizeA = left.size;
  const sizeB = symptomKeys(b).length;
  if (Math.min(sizeA, sizeB) < DUPLICATE_CONTAINMENT_MIN_KEYS) return 0;
  // Identity keys ONLY, on both sides of the ratio (#1536). A reading in the
  // denominator makes the ratio move when a finding re-states a number, and
  // that is what cost #1175/#1177 when the qualifier was tried inside
  // `symptomKeys` — see that function's header.
  const shared = symptomKeys(b).filter(k => left.has(k)).length;
  return Math.max(shared / sizeA, shared / sizeB);
}

/**
 * Issues in `existing` whose symptom collides with this one, strongest first.
 *
 * Extracted from `arbitrate`'s stage 1 so that stage has **one binding**.
 * `arbitrate` runs it with a verifier group behind it;
 * `lib/issue-filing-gate.ts` runs it at the `gh issue create` chokepoint,
 * where no group has been convened and the dedupe is the only stage that is
 * decidable at all. Two spellings of this loop would be two deciders over one
 * question, and a mutation of either would leave the other holding the case
 * up (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape) — which
 * is the same reasoning that deleted the redundant `isAbsolute` check in
 * `containedCitationPath` above.
 *
 * Identity is REFERENCE identity, and the id clause is secondary.
 *
 * Keying self-skip on the id string alone made the in-batch dedupe a no-op in
 * the one configuration it was written for: the CLI labels every unfiled
 * finding `UNFILED_ID`, so two findings in one batch both carried `"new"`,
 * each skipped the other as itself, and both survived. Measured on the merged
 * code with the real #1195/#1196 bodies — 2 survivors under `"new"`/`"new"`,
 * 1 under their real ids. The acceptance case was green for a true reason
 * about an input the CLI never produces.
 *
 * The sort is here rather than at the call site for the same reason: a caller
 * that forgot it would name a weaker match than the one it had, and "the
 * reader lands on the best match" is a property of the collision list, not of
 * whoever asked for it.
 */
export function duplicateCollisions(
  finding: Finding,
  existing: readonly Finding[],
): Array<{ id: string; keys: string[] }> {
  const collisions: Array<{ id: string; keys: string[] }> = [];
  for (const other of existing) {
    if (other === finding) continue;
    if (other.id === finding.id && finding.id !== UNFILED_ID) continue;
    const overlap = duplicateOverlap(finding, other);
    if (overlap.duplicate) collisions.push({ id: other.id, keys: overlap.keys });
  }
  // Strongest overlap first, so the reader lands on the best match.
  collisions.sort((a, b) => b.keys.length - a.keys.length || a.id.localeCompare(b.id));
  return collisions;
}

// ── Stage 1b: branch scope ───────────────────────────────────────────────

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", timeout: 20_000 });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

/** Symbols cited by a finding, in body order, capped. */
export function citedSymbols(finding: Finding): string[] {
  return symptomKeys(finding)
    .filter(k => k.startsWith("sym:"))
    .map(k => k.slice(4))
    .slice(0, MAX_SYMBOLS_PROBED);
}

/** `path:line` citations a finding makes, capped at `MAX_LINES_PROBED`. */
export function citedLines(finding: Finding): Array<{ path: string; line: number }> {
  const out: Array<{ path: string; line: number }> = [];
  const seen = new Set<string>();
  for (const m of finding.body.matchAll(
    /((?:[\w.@-]+\/)*[\w.-]+\.(?:ts|tsx|js|mjs|cjs|md|json|ya?ml|sh)):(\d+)/g,
  )) {
    const key = `${m[1].toLowerCase()}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: m[1], line: Number.parseInt(m[2], 10) });
    if (out.length >= MAX_LINES_PROBED) break;
  }
  return out;
}

/**
 * The absolute path a citation resolves to, or `null` if it escapes the root.
 *
 * The citation text comes from an AI reviewer's output and reaches
 * `readFileSync`. The regex above cannot emit a leading `/`, so an absolute
 * path never arrives — but `../` does, and `../../../../Users/…/settings.json`
 * carries an allowlisted extension and matches cleanly. The payoff is only a
 * line count and an existence oracle rather than content, which is why this is
 * two lines and not a subsystem; it is here because an unaudited input should
 * not be choosing which file the arbiter opens.
 *
 * **There is deliberately no separate `isAbsolute` rejection**, and this was
 * measured rather than reasoned: one was written, and removing it changed
 * **0 of 63** cases. `resolve(root, "/etc/hosts.json")` is `/etc/hosts.json`,
 * which fails containment on its own — so the two guards answered one
 * question, no behavioural test could tell them apart, and a mutation of
 * either left the other holding the case up. That is the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`, and the remedy for it is
 * deletion, not a second assertion.
 */
export function containedCitationPath(projectRoot: string, cited: string): string | null {
  const root = resolve(projectRoot);
  const abs = resolve(root, cited);
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

// ── The verdict ──────────────────────────────────────────────────────────

export type ArbiterRefusal =
  /** The symptom is already filed. `duplicateOf` names where. */
  | "DUPLICATE"
  /** The verifier group did not reach quorum on "is this real?". */
  | "NO_QUORUM"
  /** Style, diagnostics or cleanup. Dropped outright, never posted. */
  | "DROPPED_CATEGORY"
  /** A cited line is past the end of the file it cites. */
  | "STALE_CITATION"
  /**
   * The filing names no `SUCCESS.md` claim, so nothing says what it moves.
   * A chokepoint refusal only — a review round's findings are adjudicated
   * against a diff rather than filed by hand, and have no title to carry one.
   */
  | "NO_CLAIM"
  /**
   * Nobody declared a reason this finding cannot be a comment (#1595).
   *
   * The refusal this file's own header has asked for since it was written —
   * *"`Disposition` defaults to `COMMENT`, `ISSUE` requires an explicit
   * declared reason from the caller (`Finding.outOfScope`)"*. `arbitrate`
   * enforces it at stage 6 and the `gh issue create` chokepoint did not,
   * because its header lists the three stages that genuinely cannot run at a
   * PreToolUse hook and `outOfScope` was quietly carried along with them. It
   * is not one of them: a declaration is readable from the command line the
   * hook already has.
   *
   * A chokepoint refusal only, for the same reason `NO_CLAIM` is: on the
   * `arbitrate` path the same question is the `COMMENT` disposition, which
   * is an outcome rather than a refusal.
   */
  | "COMMENT_INSTEAD"
  /**
   * An earlier clause of the SAME command already files this finding's class
   * (#1595, CRC-N3's hook-side half).
   *
   * *"Flag the class of bug, so the author fixes every instance, not one
   * line"* — so two findings that share a class are one item saying *every
   * instance*, never two issues. Distinct from `DUPLICATE`, which is about
   * the TRACKER: a duplicate names an issue a reader can go and read, and
   * this names a clause in a command that has not run yet.
   */
  | "SAME_CLASS_IN_RUN"
  /** Something could not be evaluated. Fails; never skips. */
  | "UNMEASURED";

/**
 * Which tree the finding describes.
 *
 * `OFF_MAIN` used to be a **refusal**, and the inversion of that is the
 * central correction in this change. A finding whose symbols exist only on an
 * unmerged branch is not a bad finding — it is a finding about the branch,
 * which is precisely what an inline PR comment is for. Refusing it was the
 * old shape, where the only two outcomes were "file an issue" and "nothing".
 *
 * It survives as a reading because it still decides one thing: a finding
 * about code that exists only on this branch **cannot** be out-of-scope work
 * for this PR, so it can never be routed to `ISSUE` however the caller marks
 * it.
 */
export type FindingScope = "main" | "branch";

export interface Verdict {
  id: string;
  /**
   * What to do with it. **One field, because this is one decision** — a
   * separate `file: boolean` alongside it would be a second decider over the
   * same input, and a mutation of either would leave the other holding the
   * case up (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
   */
  disposition: Disposition;
  refusal: ArbiterRefusal | null;
  /** Why, in words a reader can act on without re-running anything. */
  reason: string;
  /** `null` when the branch-scope reading was not reached. */
  scope: FindingScope | null;
  category: FindingCategory;
  /** `null` when nothing could tag it; a dropped finding has no severity. */
  severity: Severity | null;
  /** The vote count, or `null` when no group was convened. */
  jury: JuryReading | null;
  /** Issue ids whose symptom this one collides with. */
  duplicateOf: string[];
  /** The keys that produced the collision. Empty when there was none. */
  collidingKeys: string[];
  /**
   * How many findings carry this symptom, this one included. #1187's
   * acceptance: a duplicate increments a count rather than opening an issue.
   */
  occurrences: number;
  symptomHash: string;
}

/** No group was convened at all. The single-finding case. */
export const NO_BALLOT =
  "no verifier group was convened, so no quorum was reached — not reaching one and not having one are different states";

/**
 * One ballot was offered for a batch of several findings.
 *
 * A vote is about a finding. Spreading one across a heterogeneous batch does
 * not give the other findings a quorum, it gives them somebody else's — and
 * `VERIFIER_QUORUM` then counts agreement that was never about them. The
 * refusal is the point: a batch cannot be waved through on one vote.
 */
export const SHARED_BALLOT =
  "one ballot was supplied for a batch of several findings, and a vote is about a finding: " +
  "the other findings in this batch have not failed a quorum, they have not had one. " +
  "Supply `ballots`, one group per finding, in input order";

/**
 * The ballot list did not describe the batch.
 *
 * Padding the short end would invent votes nobody cast and truncating the
 * long end would discard ones somebody did — the same argument
 * `INCOMPLETE_GROUP` makes one level down, where an absent vote is neither
 * agreement nor dissent.
 */
export const BALLOT_COUNT_MISMATCH =
  "the ballot list does not have one entry per finding, so which group voted on which finding is not recoverable";

/** Both `votes` and `ballots` arrived. Two instructions, no tie-break. */
export const BALLOT_AMBIGUOUS =
  "both `votes` and `ballots` were supplied and they are two different instructions about the same batch; " +
  "choosing one silently would be a decision nobody recorded";

export interface ArbitrateOptions {
  /** Repository root. `origin/main` is read from here; never checked out. */
  projectRoot: string;
  /** Findings already posted or filed. The dedupe compares against these. */
  existing: readonly Finding[];
  /**
   * The separate verifier group's votes on "is this real?".
   *
   * **Absent is UNMEASURED, not a pass.** A finding nobody voted on has not
   * cleared a quorum; it has not had one. Those are different states and only
   * one of them is reportable. There is deliberately no `skipJury` escape —
   * `skipRepoChecks` below exists because a caller may genuinely have no
   * repository, and no caller genuinely has no verifiers.
   */
  votes?: readonly VerifierVote[];
  /**
   * What to say when `votes` is absent. The refusal is unchanged either way
   * — this is the sentence, not the reading.
   *
   * It exists because `arbitrateBatch` knows something this function cannot:
   * *why* a finding has no ballot. "Nobody convened a group" and "a ballot
   * list arrived that does not describe this finding" are the same verdict
   * and different defects, and a reader debugging the second one should not
   * be told the first.
   */
  noBallotReason?: string;
  /** Group size and quorum. Both default; see `lib/finding-jury.ts`. */
  jury?: JuryConfig;
  /**
   * The PR's changed files. Supplying them is what makes `Pre-existing`
   * decidable: a finding citing none of them is about code the change never
   * touched. Absent, the pre-existing axis is simply not read.
   */
  changedFiles?: readonly string[];
  /**
   * Skip the two `git`-backed checks. For a caller with no repository, and
   * for the corpus measurement, which is about the key and nothing else.
   * The skipped checks report `UNMEASURED`, they do not report a pass.
   */
  skipRepoChecks?: boolean;
}

/**
 * The single place that decides. One exported function, one binding.
 *
 * Checks run in cost order and short-circuit, so a duplicate is never paid a
 * `git grep` for. That ordering is the whole design: #1187's measurement is
 * that the cheap questions catch the failures, and the expensive instrument
 * was being spent first.
 */
export function arbitrate(finding: Finding, options: ArbitrateOptions): Verdict {
  const hash = symptomHash(finding);
  const votes = options.votes;
  const category = votes ? juryCategory(finding, votes) : classifyCategory(finding);
  const base = {
    id: finding.id,
    duplicateOf: [] as string[],
    collidingKeys: [] as string[],
    occurrences: 1,
    symptomHash: hash,
    scope: null as FindingScope | null,
    category,
    severity: null as Severity | null,
    jury: null as JuryReading | null,
  };
  const drop = (refusal: ArbiterRefusal, reason: string, extra: Partial<Verdict> = {}): Verdict => ({
    ...base,
    ...extra,
    disposition: "DROP",
    refusal,
    reason,
  });

  const keys = symptomKeys(finding);
  if (keys.length === 0) {
    return drop("UNMEASURED", "the finding names no symbol, no file and no reading — nothing here can be evaluated");
  }

  // ── 1. is this new? ──
  const collisions = duplicateCollisions(finding, options.existing);
  if (collisions.length > 0) {
    return drop(
      "DUPLICATE",
      `the symptom is already reported as ${collisions.map(c => c.id).join(", ")} — ` +
        `shared ${collisions[0].keys.length} key(s): ${collisions[0].keys.slice(0, 6).join(", ")}`,
      {
        duplicateOf: collisions.map(c => c.id),
        collidingKeys: collisions[0].keys,
        occurrences: collisions.length + 1,
      },
    );
  }

  // ── 2. do enough of the verifiers agree it is real? ──
  if (votes === undefined) {
    return drop("UNMEASURED", options.noBallotReason ?? NO_BALLOT);
  }
  const jury = juryReading(votes, options.jury);
  if (jury.reading === "UNMEASURED") {
    return drop("UNMEASURED", `the vote could not be read: ${jury.unmeasuredReasons.join("; ")}`, { jury });
  }
  if (!jury.passed) {
    return drop(
      "NO_QUORUM",
      `${jury.agree} of ${jury.votes} verifiers called it real, quorum is ${jury.quorum}`,
      { jury },
    );
  }
  const withJury = { ...base, jury };

  // ── 3. is it the kind of finding that gets posted at all? ──
  if (DROPPED_CATEGORIES.has(category)) {
    return drop(
      "DROPPED_CATEGORY",
      `${category} findings are dropped outright: they cost a review round and change no behaviour`,
      { jury },
    );
  }

  if (options.skipRepoChecks === true) {
    return drop("UNMEASURED", "branch scope and citation currency were not read: skipRepoChecks", { jury });
  }

  // ── 4. which tree is it about? ──
  const symbols = citedSymbols(finding);
  if (symbols.length === 0) {
    return drop("UNMEASURED", "the finding cites no symbol, so whether it describes `origin/main` cannot be read", { jury });
  }
  const probe = git(options.projectRoot, ["rev-parse", "--verify", "--quiet", "origin/main"]);
  if (!probe.ok) {
    return drop(
      "UNMEASURED",
      `no origin/main at ${options.projectRoot} — branch scope is unreadable, which fails rather than passes`,
      { jury },
    );
  }
  const present = symbols.filter(
    s => git(options.projectRoot, ["grep", "--quiet", "--fixed-strings", "-e", s, "origin/main"]).ok,
  );
  const scope: FindingScope = present.length > 0 ? "main" : "branch";

  // ── 5. is this current? ──
  const stale: string[] = [];
  for (const c of citedLines(finding)) {
    const abs = containedCitationPath(options.projectRoot, c.path);
    if (abs === null) continue;
    let text: string | null = null;
    if (existsSync(abs)) {
      text = readFileSync(abs, "utf-8");
    } else {
      const shown = git(options.projectRoot, ["show", `origin/main:${c.path}`]);
      if (shown.ok) text = shown.out;
    }
    // A path that resolves nowhere is not a stale citation — the evidence
    // gate is where an unresolvable citation is adjudicated, and guessing
    // here would put a second decider in front of it.
    if (text === null) continue;
    const lines = text.split("\n").length;
    if (c.line > lines) stale.push(`${c.path}:${c.line} (file is ${lines} lines)`);
  }
  if (stale.length > 0) {
    return drop(
      "STALE_CITATION",
      `cited line(s) past the end of the file: ${stale.join("; ")} — re-read before posting`,
      { jury, scope },
    );
  }

  // ── 6. where does it go? COMMENT unless somebody declared otherwise. ──
  const severity = severityOf(finding, votes, options.changedFiles) ?? "Important";
  const outOfScope = finding.outOfScope;
  if (outOfScope !== undefined && outOfScope.reason.trim() !== "" && scope === "main") {
    return {
      ...withJury,
      scope,
      severity,
      disposition: "ISSUE",
      refusal: null,
      reason: `out of scope for this change, declared: ${outOfScope.reason}`,
    };
  }
  return {
    ...withJury,
    scope,
    severity,
    disposition: "COMMENT",
    refusal: null,
    reason:
      scope === "main"
        ? `${jury.agree} of ${jury.votes} verifiers agree; cites ${present.join(", ")} on origin/main`
        : `${jury.agree} of ${jury.votes} verifiers agree; cites only branch symbols (${symbols.join(", ")}), so it is about this change`,
  };
}

/** One line a caller can print without re-deriving any of the above. */
export function verdictSummary(v: Verdict): string {
  const tag = v.severity ? `${v.severity}/${v.category}` : v.category;
  return v.refusal === null
    ? `${v.disposition} ${v.id} [${tag}]: ${v.reason}`
    : `DROP ${v.id} (${v.refusal}): ${v.reason}`;
}

// ── The batch, and the cap that is not written here ──────────────────────

/**
 * How many findings one batch may file.
 *
 * Six, which is the measured hourly CLOSE rate at the time #1187 was filed —
 * 14 filed against 6 closed. A filing budget above the closing rate is not a
 * budget, it is a slower queue growth, and the queue was the constraint.
 *
 * Deliberately NOT `PROMOTION_BUDGET_RULES`. That sixteen is a context-window
 * reading about how many rules an agent can hold at once
 * (`docs/research/context-management.md`); it answers a different question
 * and reusing the literal would make one number the decider for two
 * unrelated decisions. The *mechanism* is shared; the number is not.
 */
export const FILING_BUDGET_FINDINGS = 6;

/**
 * Why a candidate did not reach a reader.
 *
 * `NO_QUORUM` and `DROPPED_CATEGORY` are **separate values and must stay
 * separate**. They are the two filters this module adds, and collapsing them
 * into one "suppressed" reason would make the quorum and the category filter
 * inseparable in exactly the A/B that exists to price them apart.
 *
 * `WithheldReason` is `lib/rule-promotion.ts`'s own vocabulary, reused rather
 * than restated: the promoter decides which candidates it withheld and why,
 * and a parallel enum here would be a second name for one decision.
 *
 * - `BATCH_UNMEASURED` — the candidate was fine and the BATCH was not. A
 *   candidate refused `UNMEASURED` in its own right carries `UNMEASURED`;
 *   the two are deliberately distinguishable, because the first set is what
 *   explains the second.
 * - `COMMAND_BLOCKED` — the same shape one layer out, and the reason it is a
 *   value of its own rather than a reuse of the one above (#1344). At the
 *   `gh issue create` chokepoint the unit is a Bash COMMAND, and a hook's one
 *   lever is all of it: a clause that cleared on its own merits beside a
 *   clause that was refused reached the tracker exactly as little as the
 *   refused one did. It is not `BATCH_UNMEASURED` — nothing here was
 *   unmeasured, the sibling was measured and refused — and it is not the
 *   sibling's own `ArbiterRefusal`, because this clause was never refused and
 *   is the one an agent should re-run.
 * - `UNACCOUNTED` — the promoter returned this candidate in neither
 *   `promoted` nor `withheld`. It partitions its input, so this cannot
 *   happen; it is named instead of defaulted so that if the partition ever
 *   breaks the ledger says so rather than reporting a plausible reason.
 */
export type WithheldBy =
  | ArbiterRefusal
  | WithheldReason
  | "BATCH_UNMEASURED"
  | "COMMAND_BLOCKED"
  | "UNACCOUNTED";

/**
 * One row per finding the batch considered, **including the ones it withheld**.
 *
 * ## Why this exists at all
 *
 * The quorum's cardinality (`VERIFIER_GROUP_SIZE`, `VERIFIER_QUORUM`) is a
 * defended default and not a measurement, and the category filter's only
 * backwards reading is a safety one — 0 dropped of 385 known-real findings.
 * Both gaps have the same cause: **nothing records a finding before it is
 * filed.** The tracker is post-filing by construction, there are no inline
 * review comments to mine, and a candidate the quorum votes down leaves no
 * artefact anywhere. So the population those numbers would be derived from
 * does not exist in history and **cannot be reconstructed from it** — it has
 * to be written down at the moment the candidate is withheld, or never.
 *
 * This is that record. It is deliberately a list of rows and not a tally: a
 * count cannot be joined against an outcome later, and the join is the whole
 * point.
 *
 * ## How it is read
 *
 * `evals/ai-review-control/outcomes.ts`'s `compareReviewOutcomes(before,
 * after)` prices a filter, and it returns UNMEASURED on a population
 * mismatch by design — so both sides are built from **this same ledger**,
 * differing only in which rows carry `suppressed`. Three summaries, two
 * comparisons:
 *
 * | summary | rows marked suppressed |
 * |---|---|
 * | baseline | none |
 * | quorum-only | `withheldBy === "NO_QUORUM"` |
 * | both | `withheldBy` is `NO_QUORUM` or `DROPPED_CATEGORY` |
 *
 * `compare(baseline, quorumOnly)` prices the quorum; `compare(quorumOnly,
 * both)` prices the category filter on top of it. The attribution lives in
 * **which pair you compare**, which is why that function's `suppressed` is a
 * reasonless boolean and why the reason lives here instead.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * - **Findings no hunter produced.** This records what was *considered*, not
 *   what was missable. A bug nobody reported is invisible here, and no
 *   amount of this data will price recall.
 * - **Whether a withheld candidate was right to be withheld.** That needs an
 *   outcome, which arrives later and from somewhere else. This supplies the
 *   left-hand side of that join and nothing more.
 */
export interface CandidateRecord {
  /**
   * A key unique across every ledger produced under the same `batch`, for a
   * consumer that scores a corpus keyed by one field.
   *
   * **`null` when the caller named no batch**, and that is the honest
   * reading rather than a gap. Neither of the other two fields can do this
   * job and both look as though they can:
   *
   * - `id` is `UNFILED_ID` for everything that has not been filed, which is
   *   every candidate the ledger exists to record.
   * - `symptomHash` is not unique either. Measured on an exact re-report
   *   under two different titles: **1 distinct hash across 2 rows**, the
   *   original and the duplicate that collided with it. And it does not even
   *   identify the collision — the real #1195/#1196 pair hashes to
   *   `11f1ca58d515` and `609a1838a74d`, two different values for one
   *   symptom, because the dedupe matches on SHARED keys and not on the
   *   whole set.
   *
   * A duplicate key does not degrade a score, it inverts one: in
   * `evals/ai-review-control/outcomes.ts` two rows sharing a key meant the
   * second overwrote the first, so a finding with a real fixing commit read
   * `NO_ACTION` and landed in `cost` — noise manufactured out of a fix.
   * That module now refuses a repeated key outright, which is why the
   * failure here must be an absent key and never a plausible one.
   *
   * It is position-derived rather than content-derived on purpose: unique by
   * construction, with no collision bookkeeping to be a second decider.
   */
  key: string | null;
  /**
   * The tracker's issue number once the finding has been filed, and
   * `UNFILED_ID` before that.
   *
   * **For a withheld candidate this is `UNFILED_ID`, and it will never be
   * anything else.** Not "not yet" — never. Being withheld IS the state of
   * not acquiring an issue number, so the two can only ever be read
   * together: there is no later moment at which a row recording a finding
   * the quorum voted down, or the category filter dropped, or the budget
   * ranked below the cut, comes back carrying a number. Those rows are the
   * population this ledger exists to record, so the field is absent exactly
   * where the data matters.
   *
   * ## What follows, and it is the reason this comment is here
   *
   * **The outcome join has to be on content.** This ledger supplies the
   * left-hand side of a join against something that arrives later and from
   * somewhere else — a fixing commit, a re-report, a bug that shipped. The
   * right-hand side will be keyed by whatever that source keys by, and the
   * one thing it can never be matched on is this field, because half the
   * rows do not have a value and the half that do were never the question.
   * Match on `symptomHash`, on the title, on the cited symbols — on
   * something the finding SAYS.
   *
   * **So do not add an id field to make the join easier.** It is the
   * obvious repair and there is nothing to put in it: a synthetic id minted
   * here is a key only this file has ever seen, which is `key` and is
   * already present, and it still will not appear on the other side of the
   * join. The thing that looks like a missing column is a fact about the
   * domain.
   */
  id: string;
  symptomHash: string;
  category: FindingCategory;
  severity: Severity | null;
  disposition: Disposition;
  refusal: ArbiterRefusal | null;
  /** Did it reach a reader — a PR comment or a filed issue? */
  emitted: boolean;
  /** Why not. `null` exactly when `emitted` is true. */
  withheldBy: WithheldBy | null;
  /** The vote, when one was taken. `null` when no group was convened. */
  jury: JuryReading | null;
}

export interface BatchReading {
  /** Per-finding verdicts, in input order. */
  verdicts: Verdict[];
  /**
   * EVERY candidate the batch considered, in input order, withheld ones
   * included. Exactly one row per input finding — `compareReviewOutcomes`
   * refuses a population mismatch, and this is the population.
   */
  candidates: CandidateRecord[];
  /**
   * Ids to post as inline comments, **ranked by severity** — Important, then
   * Pre-existing, then Nit. This is the default output and it is deliberately
   * NOT budgeted: a comment blocks the merge until it is answered, so it
   * leaves the system the same day. `FILING_BUDGET_FINDINGS` caps the other
   * list, which is the one that accumulates.
   */
  toComment: string[];
  /** `lib/rule-promotion.ts`'s reading over the declared-out-of-scope ones. */
  promotion: PromotionReading;
  /** Ids cleared to file as issues, after the checks and the budget. */
  toFile: string[];
}

/**
 * The order the batch is walked in.
 *
 * **Order is load-bearing and therefore pinned here**: with an
 * accumulate-as-you-walk dedupe, whichever of a duplicate pair is seen first
 * is the one that survives, so leaving it to array position would let the
 * caller's iteration order silently decide which finding exists. Numeric ids
 * compare numerically so `9` precedes `10`; everything else falls back to
 * lexical, and the original index breaks remaining ties so the sort is total.
 */
function walkOrder(findings: readonly Finding[]): Array<{ finding: Finding; index: number }> {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      const [x, y] = [Number(a.finding.id), Number(b.finding.id)];
      const numeric = Number.isInteger(x) && Number.isInteger(y);
      return (numeric ? x - y : a.finding.id.localeCompare(b.finding.id)) || a.index - b.index;
    });
}

/**
 * Arbitrate a batch, then hand the survivors to the promoter that already
 * exists.
 *
 * **The ranking, the eviction and the UNMEASURED folding are not implemented
 * here.** `promoteCandidates` does all three, has them under test, and
 * already gets the hard part right — an upstream that read UNMEASURED makes
 * the whole promotion UNMEASURED rather than a smaller one. #1187 and #1162
 * both say the same thing about this machinery: wire it, do not rewrite it.
 * What stage 1 adds is the three checks in front and a budget whose number
 * is its own.
 *
 * A finding refused by any check is withheld before it reaches the promoter,
 * so it cannot be ranked above one that passed them.
 *
 * ## The dedupe accumulates as it walks, and that is the whole point
 *
 * The first cut of this compared every finding against `options.existing` and
 * nothing else. `existing` is a **fixed snapshot**, so two identical findings
 * in one batch both read as new — which is exactly the incident that
 * motivated #1187: #1195 and #1196, the same symptom, filed **one minute
 * apart**, close enough that neither was in the tracker when the other was
 * arbitrated. A tracker-only dedupe would not have stopped it, and
 * `test/finding-arbiter.test.ts`'s `AR-9` drives the real pair through this
 * function to prove the fix does.
 *
 * So each survivor joins the comparison set for everything walked after it.
 * See `walkOrder` for why the order is pinned rather than inherited.
 *
 * ## One ballot per finding, and no way to spread one across the batch
 *
 * `ballots` is indexed by INPUT position, not by walk order and not by id —
 * every unfiled finding carries `UNFILED_ID`, so a batch of them is a batch
 * of one id and an id-keyed ballot map resolves all of them to whichever came
 * first.
 *
 * `votes` remains the single-finding path and is refused for a batch of
 * several, because a vote is about a finding: spreading one across a
 * heterogeneous batch does not give the others a quorum, it gives them
 * somebody else's, and `VERIFIER_QUORUM` then counts agreement that was never
 * about them.
 *
 * **There is deliberately no `sharedBallot: true`.** A flag that re-enables
 * the defect is satisfied by typing a word, and every caller who wants to get
 * past a gate learns to type it — the same thing `--label follow-up` had
 * become before #1261. A caller that genuinely has one group's verdict on
 * several findings writes the expansion at its own call site, where a reader
 * can see that it happened.
 */
export function arbitrateBatch(
  findings: readonly Finding[],
  options: ArbitrateOptions & {
    budget?: number;
    now?: string;
    batch?: string;
    /** One verifier group per finding, in INPUT order. */
    ballots?: readonly (readonly VerifierVote[])[];
  },
): BatchReading {
  const date = options.now ?? new Date().toISOString();
  const seen: Finding[] = [...options.existing];
  const verdicts: Verdict[] = new Array(findings.length);
  const { ballots } = options;

  // Resolved once, before the walk, so every finding in a refused batch gets
  // the same sentence and no finding is adjudicated on a ballot the batch as
  // a whole could not account for.
  const refusal: string | null =
    ballots !== undefined && options.votes !== undefined
      ? BALLOT_AMBIGUOUS
      : ballots !== undefined && ballots.length !== findings.length
        ? BALLOT_COUNT_MISMATCH
        : ballots === undefined && options.votes !== undefined && findings.length > 1
          ? SHARED_BALLOT
          : null;

  for (const { finding, index } of walkOrder(findings)) {
    const verdict = arbitrate(finding, {
      ...options,
      existing: seen,
      votes: refusal !== null ? undefined : (ballots?.[index] ?? options.votes),
      noBallotReason: refusal ?? options.noBallotReason,
    });
    verdicts[index] = verdict;
    // Only something that will actually be posted or filed occupies the
    // space. A dropped finding leaves no artefact for a later one to
    // duplicate, so it must not shadow one.
    if (verdict.disposition !== "DROP") seen.push(finding);
  }

  // ── Everything below is keyed by POSITION, never by id ─────────────────
  //
  // `UNFILED_ID` is the id of every finding that has not been filed yet, so
  // ids are not unique within a batch: the #1195/#1196 incident arrives as
  // two rows both reading `"new"`, one of which is dropped as a duplicate of
  // the other. A lookup by id resolves both to whichever came first, which
  // would title one candidate with the other's title and mark a withheld
  // candidate as emitted. The index is the only identity a candidate has
  // before it is filed.
  const withIndex = verdicts.map((verdict, index) => ({ verdict, index }));
  const bySeverity = (a: Verdict, b: Verdict) =>
    SEVERITY_RANK[a.severity ?? "Important"] - SEVERITY_RANK[b.severity ?? "Important"];
  const commented = withIndex
    .filter(({ verdict }) => verdict.disposition === "COMMENT")
    .sort((a, b) => bySeverity(a.verdict, b.verdict));
  const toComment = commented.map(({ verdict }) => verdict.id);

  const declared: PromotableCandidate[] = withIndex
    .filter(({ verdict }) => verdict.disposition === "ISSUE")
    .map(({ verdict, index }) => ({
      rule: findings[index]!.title,
      source: `finding:${index}`,
      hash: verdict.symptomHash,
      evidence: { kind: "finding" as const, date, citation: verdict.reason, issues: [] },
    }));

  // The arbiter's own reading is an upstream, so a batch in which nothing
  // could be evaluated does not report a measured zero.
  const unmeasured = verdicts.filter(v => v.refusal === "UNMEASURED");
  const promotion = promoteCandidates(declared, {
    budget: options.budget ?? FILING_BUDGET_FINDINGS,
    upstream: {
      reading: unmeasured.length > 0 ? "UNMEASURED" : "MEASURED",
      unmeasuredReasons: unmeasured.map(v => `${v.id}: ${v.reason}`),
    },
  });

  // `promoteCandidates` returns a POPULATED `promoted` under an UNMEASURED
  // reading — only its `budget < 1` branch empties it. So the discriminator
  // has to be consulted here or it is computed and then ignored, and this
  // function's own header would be claiming that a batch which could not be
  // evaluated "does not report a measured zero" while it reported a measured
  // LIST. Gated here rather than in `promoteCandidates`, which has other
  // callers whose semantics are not ours to change.
  const position = (c: PromotableCandidate) => Number(c.source.replace(/^finding:/, ""));
  const filed = promotion.reading === "MEASURED" ? promotion.promoted.map(position) : [];
  const emitted = new Set<number>([...commented.map(c => c.index), ...filed]);

  // The promoter's own per-candidate reason, read rather than re-derived. A
  // second opinion here about why something was not promoted would be two
  // deciders over one question, and the one that is not consulted is the one
  // that silently rots (`.claude/rules/checks-must-be-able-to-fail.md`).
  const promoterReason = new Map<number, WithheldReason>(
    promotion.withheld.map(w => [position(w.candidate), w.reason]),
  );

  const candidates: CandidateRecord[] = verdicts.map((verdict, index) => ({
    // The batch name is REQUIRED for a key rather than defaulted, because a
    // default would make every batch's first row collide with every other
    // batch's first row — the corpus a consumer builds is many batches
    // concatenated, and a plausible key is the one failure mode that
    // silently shrinks it.
    key: options.batch === undefined ? null : `${options.batch}/${index}`,
    id: verdict.id,
    symptomHash: verdict.symptomHash,
    category: verdict.category,
    severity: verdict.severity,
    disposition: verdict.disposition,
    refusal: verdict.refusal,
    emitted: emitted.has(index),
    withheldBy: emitted.has(index)
      ? null
      : // A refusal is the candidate's OWN reading and outranks everything
        // after it: this one never reached the promoter. Note that a
        // candidate refused `UNMEASURED` is recorded as `UNMEASURED`, not
        // `BATCH_UNMEASURED` — the first says this finding could not be
        // evaluated, the second says the batch could not be, and conflating
        // them would lose the only row that says WHY the batch folded.
        (verdict.refusal ??
        // Then the batch fold. It outranks the promoter's reason because an
        // UNMEASURED batch ranked an incomplete population, so "over budget"
        // read off that ranking is a number nobody should act on.
        (promotion.reading === "UNMEASURED"
          ? "BATCH_UNMEASURED"
          : (promoterReason.get(index) ?? "UNACCOUNTED"))),
    jury: verdict.jury,
  }));

  return {
    verdicts,
    candidates,
    toComment,
    promotion,
    toFile: filed.map(index => findings[index]!.id),
  };
}
