#!/usr/bin/env bun
/**
 * audit-specs — Scan spec files, classify SCs, optionally fix unmatched ones.
 *
 * Usage:
 *   bun scripts/audit-specs.ts .              # audit mode
 *   bun scripts/audit-specs.ts . --fix        # fix mode (rewrite in-place)
 *
 * Thin CLI consumer — core logic exported for testing.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  parseFrontmatter,
  matchPattern,
  isBehavioralSC,
  type ExtractedSC,
} from "../lib/conformity";
import { parseScDeclarations } from "../lib/sc-ids";
import { collectSpecFiles } from "../lib/spec-files";

// ── Types ─────────────────────────────────────────────────────

/**
 * `total` is EVERY criterion the spec declares. `ticked` is how many of those
 * are already done, and `matched`/`unmatched`/`behavioral` partition the
 * UNTICKED ones only, so:
 *
 *     total === ticked + matched + unmatched + behavioral
 *
 * The split is deliberate rather than incidental. Those three answer "what
 * open work can the conformity engine bind?", which is a question about
 * criteria nobody has satisfied yet. `unmatched` feeds `strictUnmatched`, the
 * exit code and the `--fix` candidate set, so folding 1,443 ticked criteria
 * into it would turn a number that means "open work the engine cannot bind"
 * into one that means nothing. Whether a TICKED criterion is covered is a
 * different question with a different owner — `uncoveredTickedScs` in
 * `lib/sc-cover.ts`.
 */
export interface SpecAuditResult {
  specFile: string;
  total: number;
  /** Declared `- [x]`. Reported, and never a rewrite candidate. */
  ticked: number;
  matched: number;
  unmatched: number;
  behavioral: number;
  compliance: "strict" | "permissive";
  matchedSCs: SCClassification[];
  unmatchedSCs: SCClassification[];
  behavioralSCs: SCClassification[];
}

export interface SCClassification {
  id: string;
  statement: string;
  category: "matched" | "unmatched" | "behavioral";
}

export interface RewriteEntry {
  scId: string;
  specFile: string;
  before: string;
  after: string;
  patternUsed: string;
  ambiguous: boolean;
  /**
   * Set when the line was DELIBERATELY left alone (#426), carrying why.
   * `before === after` alone cannot say this: it is also what a rewrite that
   * happened to be a no-op looks like, and the caller reports the two
   * differently.
   */
  kept?: string;
}

export interface AuditResult {
  specs: SpecAuditResult[];
  totalSCs: number;
  totalTicked: number;
  totalMatched: number;
  totalUnmatched: number;
  totalBehavioral: number;
  strictUnmatched: number;
  rewrites?: RewriteEntry[];
}

// ── Registry loading ──────────────────────────────────────────

interface RegistryEntry {
  name: string;
  syntax: string;
  regex: string;
  example: string;
  notes: string;
}

let _registryCache: RegistryEntry[] | null = null;

function loadRegistry(): RegistryEntry[] {
  if (_registryCache) return _registryCache;
  const configPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "config",
    "matcher-registry.json"
  );
  _registryCache = JSON.parse(readFileSync(configPath, "utf-8"));
  return _registryCache!;
}

// ── SC extraction ─────────────────────────────────────────────

/**
 * Every criterion a spec declares, from the SHARED binding.
 *
 * This was `/^- \[ \] (SC-\w+):\s*(.+)$/gm` — a reporter carrying its own,
 * narrower spelling of a thing `lib/sc-ids.ts` already decides. That is the
 * fourth shape in `.claude/rules/checks-must-be-able-to-fail.md` pointing the
 * wrong way: two deciders, disagreeing, with the reporter the one people read.
 * It was narrow in two directions at once.
 *
 * - **`SC-\w+` cannot see a `CRC-` id.** `TRACKED_ID_PREFIXES` has held two
 *   namespaces since #1313. `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` declares
 *   56 criteria and is marked `compliance: strict`, and this reported
 *   `total 0` for it. That is worse than crashing: silence is visibly broken,
 *   `0` reads as "nothing to do" and stops anyone looking.
 * - **The `- [ ] ` literal cannot see a TICKED criterion**, in any namespace.
 *   So the `SC-` side had been under-reporting for its whole life and nobody
 *   noticed, because the number it printed was plausible. Measured on this
 *   tree: **66 reported against 1,669 declared.** It was showing 4% of the
 *   corpus.
 *
 * `parseScDeclarations` is the one owner, so this reporter, the status
 * flipper, the drift gate and the collision detectors now agree about what a
 * criterion is by construction rather than by four regexes happening to match.
 */
function extractSCs(content: string, specFile: string): ExtractedSC[] {
  return parseScDeclarations(content, specFile).map((d) => ({
    id: d.id,
    statement: d.statement,
    specFile,
    checked: d.checked,
  }));
}

/**
 * The population `--fix` may rewrite — and it is NOT the population this
 * reporter reads.
 *
 * Reporting a criterion costs a row in a table. Rewriting one edits a spec,
 * and #1286 is open about `--fix` damaging a file it should not have touched.
 * Different decisions, different risk, so the reporter widened and the writer
 * did not. Each clause subtracts a population this change would otherwise
 * have handed the rewriter as a side effect:
 *
 * | clause | what it holds back, measured on this tree |
 * |---|---|
 * | `!checked` | 1,443 ticked criteria — finished work |
 * | `SC-` prefix | 55 unmatched `CRC-` criteria, in a spec being bound concurrently |
 * | top-level | 91 unmatched criteria in a split spec under `specs/` |
 *
 * All three live here rather than being enforced upstream, because a clause
 * split across two sites is two deciders for one question: mutate either and
 * the other holds the case up.
 *
 * This is a SCOPE, not a second opinion about what a criterion is —
 * `extractSCs` remains the only thing that decides that. Deleting a clause is
 * a deliberate one-line widening whenever somebody wants it, and
 * `test/audit-specs-blindness.test.ts` AB-4 measures that the set it selects
 * is the pre-change population exactly.
 */
export function isRewriteCandidate(sc: ExtractedSC): boolean {
  return !sc.checked && sc.id.startsWith("SC-") && !sc.specFile.includes("/");
}

// ── Closest pattern matching for rewrites ─────────────────────

export interface ClosestPattern {
  patternName: string;
  rewrite: string;
  ambiguous: boolean;
  /**
   * Set ONLY by the last-resort file-token match (#589).
   *
   * `patternName` cannot carry this: the last resort renders `file-exists`,
   * which is also the name of a real heuristic, so a caller reading the name
   * alone cannot tell a pattern the statement matched from one inferred off a
   * filename that happened to be in the sentence.
   */
  fallback?: boolean;
}

/**
 * Score how well an SC statement matches a registry pattern by
 * looking for keyword overlaps. Returns the best pattern name and
 * a generated rewrite, or null if nothing is close enough.
 */
function findClosestPattern(statement: string): ClosestPattern | null {
  const registry = loadRegistry();
  const lower = statement.toLowerCase();

  // Heuristic keyword rules per pattern — ordered by specificity
  const heuristics: Array<{
    pattern: string;
    keywords: string[];
    extractor: (stmt: string) => string | null;
    /** All keywords must be present, not any one of them (#586). */
    requireAll?: boolean;
    /** The extractor ignores its argument, so it cannot be unambiguous (#586). */
    constant?: boolean;
  }> = [
    {
      pattern: "pointer-exists",
      keywords: ["pointer", "reference to", "contains reference"],
      extractor: (s) => {
        const m = s.match(/(?:file\s+)?(\S+\.?\w+)\s+(?:contains?|has|with)\s+(?:pointer|reference)\s+to\s+(\S+)/i);
        return m ? `${m[1]} exists with pointer to ${m[2]}` : null;
      },
    },
    {
      pattern: "content-contains",
      keywords: ["contains [", "includes ["],
      extractor: (s) => {
        const m = s.match(/(\S+)\s+(?:contains?|includes?)\s+\[([^\]]+)\]/i);
        return m ? `${m[1]} contains [${m[2]}]` : null;
      },
    },
    {
      pattern: "content-not-contains",
      keywords: ["not contain", "must not have", "has no ["],
      extractor: (s) => {
        const m = s.match(/(\S+)\s+(?:must\s+not\s+contain|has\s+no)\s+\[([^\]]+)\]/i);
        return m ? `${m[1]} must NOT contain [${m[2]}]` : null;
      },
    },
    {
      pattern: "dir-exists",
      keywords: ["directory"],
      extractor: (s) => {
        const m = s.match(/(?:the\s+)?(?:directory\s+)?(\S+?)\/?\s+(?:directory\s+)?(?:should\s+)?(?:be\s+present|exists?|is\s+present|must\s+exist)/i);
        if (m) return `${m[1].replace(/\/$/, "")}/ directory exists`;
        const m2 = s.match(/(?:directory|dir|folder)\s+(\S+?)\/?\s/i);
        if (m2) return `${m2[1].replace(/\/$/, "")}/ directory exists`;
        return null;
      },
    },
    {
      pattern: "file-exists",
      keywords: ["exist", "file", "present", "must be"],
      extractor: (s) => {
        // Match "file X exists" or "X should exist" or "X must exist" patterns
        const m = s.match(
          /(?:the\s+)?(?:file\s+)?(\S+\.\w+)\s+(?:should\s+|must\s+)?(?:exist|be\s+present)/i
        );
        if (m) return `${m[1]} exists`;
        // Match "exists" at end
        const m2 = s.match(/(\S+\.\w+)\s+exists/i);
        if (m2) return `${m2[1]} exists`;
        return null;
      },
    },
    {
      pattern: "section-exists",
      keywords: ["section", "heading"],
      extractor: (s) => {
        const m = s.match(/(\S+)\s+has\s+(?:a\s+)?section\s+(?:called\s+|named\s+)?\[([^\]]+)\]/i);
        return m ? `${m[1]} has section [${m[2]}]` : null;
      },
    },
    {
      pattern: "count-threshold",
      keywords: ["under", "at most", "lines", "words"],
      extractor: (s) => {
        const m = s.match(/(\S+)\s+(?:is\s+under|at\s+most)\s+\[?(\d+)\]?\s+(lines?|words?)/i);
        return m ? `${m[1]} is under [${m[2]}] ${m[3]}` : null;
      },
    },
    {
      pattern: "json-field-equals",
      keywords: ["field equals"],
      extractor: (s) => {
        const m = s.match(/(\S+)\s+(\S+)\s+field\s+equals\s+\[([^\]]+)\]/i);
        return m ? `${m[1]} ${m[2]} field equals [${m[3]}]` : null;
      },
    },
    {
      pattern: "json-has-field",
      keywords: ["has field"],
      extractor: (s) => {
        const m = s.match(/(\S+)\s+has\s+field\s+(\S+)/i);
        return m ? `${m[1]} has field ${m[2]}` : null;
      },
    },
    {
      pattern: "frontmatter-field",
      keywords: ["frontmatter"],
      extractor: (s) => {
        const m = s.match(/(\S+)\s+frontmatter\s+has\s+(\S+)(?:\s*=\s*(.+))?/i);
        return m
          ? m[3]
            ? `${m[1]} frontmatter has ${m[2]} = ${m[3]}`
            : `${m[1]} frontmatter has ${m[2]}`
          : null;
      },
    },
    {
      pattern: "root-clean",
      keywords: ["root is clean", "clean root"],
      extractor: () => "root is clean",
    },
    {
      pattern: "paths-resolve",
      keywords: ["paths resolve", "links resolve"],
      extractor: (s) => {
        const m = s.match(/paths?\s+(?:referenced\s+)?in\s+(\S+)\s+resolve/i);
        return m ? `all paths referenced in ${m[1]} resolve` : null;
      },
    },
    {
      pattern: "all-specs-frontmatter",
      // #586: `requireAll`, because the keyword test below is `some` and the
      // bare word `frontmatter` was firing a rule about ALL SPECS. It turned
      // `Baseline rules carry no paths: key in frontmatter` into
      // `all specs have frontmatter` — a different, weaker property.
      // "all specs" is the phrase that scopes this rule; "frontmatter" is
      // the phrase it shares with every other frontmatter criterion.
      requireAll: true,
      keywords: ["all specs", "frontmatter"],
      extractor: () => "all specs have frontmatter",
      /**
       * The extractor never reads its argument, so it cannot know what the
       * criterion said. #586: that is precisely when the original must be
       * kept in the file, and this rule claimed `ambiguous: false` — the
       * one flag that suppresses the `<!-- REVIEW: original — … -->` marker.
       */
      constant: true,
    },
    {
      pattern: "canary",
      keywords: ["canary"],
      extractor: () => "canary test exists",
      constant: true,
    },
  ];

  // Try each heuristic — first one whose extractor succeeds wins
  for (const h of heuristics) {
    const hasKeyword = h.requireAll
      ? h.keywords.every((k) => lower.includes(k))
      : h.keywords.some((k) => lower.includes(k));
    if (!hasKeyword) continue;

    const rewrite = h.extractor(statement);
    if (rewrite) {
      // A constant extractor is ambiguous BY CONSTRUCTION. Marking it
      // otherwise discards the original from the file in the only case where
      // nothing can reconstruct it.
      return { patternName: h.pattern, rewrite, ambiguous: h.constant === true };
    }
  }

  // If no heuristic matched, try a loose file-exists match.
  // Look for any filename-like token (word.ext) in the statement.
  //
  // #586 looked hard at narrowing this to statements whose verb is
  // existence, and did not. The fallback does turn behaviour into presence —
  // measured over the real tree, two criteria go through it:
  //
  //   "Rejecting a promoted rule writes its hash to
  //    `reference/rejected-constraints.md` and it is never re-promoted"
  //      -> "reference/rejected-constraints.md exists"
  //
  //   "Makefile targets, `package.json` scripts and CI workflow files are
  //    scanned for constraints alongside markdown"
  //      -> "package.json exists"
  //
  // — but it reports `ambiguous: true`, and an ambiguous rewrite writes
  // `<!-- REVIEW: original — … -->` beside the line. #426 kept this path for
  // exactly that reason (see SC-1587: "a lossy render by nature … kept as the
  // one remaining rewrite path precisely because it writes the statement it
  // replaced into the next line"). Nothing is discarded, so this is a
  // DOWNGRADE, not a LOSS, and #586 is about loss.
  //
  // Narrowing it here turns SC-1587 and SC-1594 red for a reason those
  // criteria are right about, which is how the distinction got found. The
  // downgrade is #589, and it is now scoped by `coordinatedClaims` below
  // rather than by narrowing the token match: WHICH statements this may
  // speak for is a question about the criterion, not about the filename.
  const fileToken = statement.match(/\b(\S+\.\w{1,5})\b/);
  if (fileToken) {
    return {
      patternName: "file-exists",
      rewrite: `${fileToken[1]} exists`,
      ambiguous: true,
      fallback: true,
    };
  }

  // Truly unresolvable
  return null;
}

// ── Whether to rewrite at all, and into what (#426) ───────────

/**
 * A file-ish leading token: `workflows/ship.js`, `AGENTS.md`, `specs/X.md`.
 *
 * Anchored, because the question is whether the statement OPENS by naming
 * its target. A filename mentioned halfway through a sentence of prose is
 * not a structured criterion, and treating it as one is how
 * `findClosestPattern`'s last resort turns a whole criterion into
 * `foo.ts exists`.
 */
function leadingFileToken(statement: string): string | null {
  const m = /^(\S*[./]\S*)\s/.exec(statement);
  return m ? m[1]! : null;
}

/** The prose after the em dash — the part that says why the criterion exists. */
function rationaleOf(statement: string): string | null {
  const m = /\s+—\s+(.+)$/.exec(statement);
  return m ? m[1]!.trim() : null;
}

/**
 * Is this already written in the structured grammar?
 *
 * A target named up front and a bracketed payload. That is the authored
 * shape of every matcher in `config/matcher-registry.json` that takes one —
 * `contains [...]`, `not contains [...]`, `is under [N] lines`,
 * `has field [x]` — and it is deliberately asked of the SHAPE rather than
 * by running the registry.
 *
 * The distinction matters: SC-1469 is structured and the registry did not
 * recognise it, because `content-not-contains` accepted `must NOT contain`
 * and `has no` but not the `not contains` form the compound matcher's own
 * example uses. Asking the registry would therefore have answered "rewrite
 * it", which is the bug. A matcher gap is a matcher gap; it is not a licence
 * to delete what the author wrote.
 */
export function alreadyStructured(statement: string): boolean {
  return leadingFileToken(statement) !== null && /\[[^\]]+\]/.test(statement);
}

export type RewriteDecision =
  | { kind: "keep"; reason: string }
  | { kind: "rewrite"; statement: string };

/**
 * What `--fix` may do to one SC line (#426).
 *
 * `scaffold . --fix` is the documented way to take a harness update, and it
 * was rewriting SC-1469 on every run into
 * `not contains [s.environments.prod.rebuild = 'PASS']` — dropping both the
 * file the criterion is about and the whole rationale clause, silently, under
 * a summary line naming `ci.yml`.
 *
 * Three rules, and the third is the one that makes this a fix rather than a
 * patch over one line:
 *
 *   1. A statement already in the structured grammar is never rewritten.
 *   2. A rewrite that would drop the file the criterion names is refused
 *      outright. `findClosestPattern`'s last resort collapses anything with a
 *      filename in it to `<file> exists`, which is an assertion that holds
 *      vacuously against a file that obviously exists.
 *   3. A rewrite that survives both carries the em-dash rationale across.
 *
 * One exported binding, so there is exactly one thing to mutate.
 */
export function decideRewrite(
  statement: string,
  closest: ClosestPattern | null,
): RewriteDecision {
  if (alreadyStructured(statement)) {
    return { kind: "keep", reason: "already a structured criterion — a matcher gap is not a licence to rewrite it" };
  }
  if (!closest) {
    return { kind: "keep", reason: "no registry pattern was close enough" };
  }

  const file = leadingFileToken(statement);
  if (file !== null && !closest.rewrite.includes(file)) {
    return {
      kind: "keep",
      reason: `rewriting as ${closest.patternName} would drop the file ${file} the criterion names`,
    };
  }

  // #589: the last resort may only speak for a criterion that makes ONE
  // claim. It takes a filename-like token from anywhere in a sentence and
  // renders the whole criterion as `<that file> exists`, which can be about
  // at most one thing — so a criterion that coordinates a second claim is
  // guaranteed to come back as a statement about something else.
  //
  // Measured over the corpus `--fix` edits: two criteria went through it,
  // SC-1940 (a hash is written AND the rule never resurfaces) and SC-1943 (a
  // three-item subject of which the filename is one). Both are kept now.
  //
  // Scoped to the fallback deliberately. A heuristic that MATCHED the
  // statement was chosen by what the statement says; the last resort was
  // chosen by a filename being present, and that is the difference this
  // guard is about.
  if (closest.fallback) {
    const claims = coordinatedClaims(statement);
    if (claims.length > 0) {
      return {
        kind: "keep",
        reason:
          `rewriting as ${closest.patternName} would assert only that ${closest.rewrite}, ` +
          `while the criterion coordinates a further claim (${claims[0]}) — ` +
          `the file is mentioned, not what the criterion is about`,
      };
    }
  }

  const rationale = rationaleOf(statement);
  const rewritten = rationale ? `${closest.rewrite} — ${rationale}` : closest.rewrite;

  // #586: the fourth guard, and the general one. The three above protect
  // specific things — a structured line, a missing pattern, a named file.
  // This one asks the question they are each a special case of: **does the
  // rewrite still say what the criterion was about?**
  //
  // It exists because the three above all passed on
  // `Baseline rules carry no paths: key in frontmatter`, which was rewritten
  // to `all specs have frontmatter`. Nothing of the original survived and no
  // guard was looking at that.
  //
  // It asks the question of `rewritten`, not of `closest.rewrite`, and the
  // difference is #426's SC-1591: the rationale clause is carried across, so
  // a statement whose meaning lives in its `— because …` half survives a
  // constant rewrite with that half intact. Asking it of the bare pattern
  // text refuses those, which turns the enricher off for every criterion
  // that explains itself. SC-1930 has no rationale clause, so nothing of it
  // survives either way and it is still refused.
  const terms = distinguishingTerms(statement);
  const lowered = rewritten.toLowerCase();
  if (terms.length > 0 && !terms.some(t => lowered.includes(t))) {
    return {
      kind: "keep",
      reason:
        `rewriting as ${closest.patternName} would drop every distinguishing term the ` +
        `criterion uses (${terms.join(", ")}) — the rewrite would be about something else`,
    };
  }

  if (rewritten === statement) {
    return { kind: "keep", reason: "the rewrite is what is already written" };
  }
  return { kind: "rewrite", statement: rewritten };
}

/**
 * The words that say what THIS criterion is about (#586).
 *
 * Deliberately not "every word": a rewrite legitimately drops grammar, and
 * the term that caused the heuristic to fire is shared with every other
 * criterion the heuristic matches. Counting the MATCHED keyword as retained
 * content is how a constant rewrite reads as a faithful one — the proxy
 * standing in for the property, which `.claude/rules/checks-must-be-able-to-fail.md`
 * names as the trap in wording a refusal.
 *
 * So: lowercase alphanumeric tokens of four characters or more, minus
 * stopwords, minus the vocabulary every registry pattern already uses.
 */
const REWRITE_STOPWORDS = new Set([
  "that", "this", "with", "from", "have", "has", "does", "must", "will", "when",
  "then", "than", "each", "every", "into", "over", "under", "about", "there",
  "their", "which", "where", "while", "been", "being", "they", "them", "than",
  // The registry's own vocabulary. A rewrite keeping only these has kept
  // nothing specific to the criterion it replaced.
  "frontmatter", "specs", "spec", "exists", "contains", "canary", "test",
  "tests", "file", "files", "all", "none",
]);

export function distinguishingTerms(statement: string): string[] {
  const words = statement.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  return [...new Set(words)].filter(w => !REWRITE_STOPWORDS.has(w));
}

/**
 * The further claims this criterion coordinates, if any (#589).
 *
 * Returns the clause after each `and`/`or`, so the refusal can name what the
 * rewrite would have dropped rather than merely reporting that something was
 * dropped. Empty for a criterion that makes one claim.
 *
 * One exported binding, so there is exactly one thing to mutate — and it is
 * the only thing that decides which statements the last resort may speak
 * for.
 */
export function coordinatedClaims(statement: string): string[] {
  const claims: string[] = [];
  const coordinator = /\s+(?:and|or)\s+/gi;
  let m: RegExpExecArray | null;
  while ((m = coordinator.exec(statement)) !== null) {
    const rest = statement.slice(m.index + m[0].length).trim();
    // A trailing coordinator joins nothing. An empty string here would read
    // as a second claim whose text is gone, and refuse a rewrite on it.
    if (rest.length > 0) claims.push(rest);
  }
  return claims;
}

/**
 * `findClosestPattern`, exported so a test can drive the real decision.
 *
 * One binding (#586). A test that reimplemented the heuristic walk would
 * agree with it right up until somebody changed one of them.
 */
export function closestPatternFor(statement: string): ClosestPattern | null {
  return findClosestPattern(statement);
}

// ── Editing one SC line ───────────────────────────────────────

/**
 * Put `replacement` where `match` was, as LITERAL TEXT (#586).
 *
 * `String.prototype.replace(re, string)` treats the second argument as a
 * replacement TEMPLATE: `$'` is "everything after the match", `$&` is the
 * match, `$1` is the first capture group. Every one of those is a sequence a
 * success criterion can legitimately contain — `--fix` is a tool for editing
 * documents written by people about shell and regex syntax — and the text
 * being substituted in here is the criterion itself.
 *
 * Measured before this existed, on a four-criterion fixture whose first
 * statement read ``Baseline rules carry no $' key in frontmatter``:
 *
 *     - [ ] SC-9301: Baseline rules carry no        <- its text, truncated
 *     - [ ] SC-9302: …                              <- the remainder of the
 *     - [ ] SC-9303: …                                 document, pasted in
 *     - [ ] SC-9304: …
 *      key in frontmatter
 *
 * Three ids now appeared twice in one spec and one criterion had lost its
 * statement — on a run whose own ledger reported `kept` and `before ===
 * after` for all four. The report and the file disagreed and only the report
 * was ever read.
 *
 * It splices by INDEX rather than re-running the regex, which also removes
 * the second search: the caller has already found the line, and a function
 * that searched for it again would be a second answer to a question that was
 * already answered.
 */
function replaceLine(content: string, match: RegExpMatchArray, replacement: string): string {
  const at = match.index!;
  return content.slice(0, at) + replacement + content.slice(at + match[0].length);
}

/**
 * Does `marker` already sit on the line directly below the matched line?
 *
 * The question the suppression guard has to ask (#586). It used to ask
 * `modified.includes(marker)` — of the WHOLE FILE — so the second criterion
 * declined for a given reason was silently left unmarked, and the commonest
 * reason by far is the generic "no registry pattern was close enough".
 */
function followsWith(content: string, match: RegExpMatchArray, marker: string): boolean {
  return content.slice(match.index! + match[0].length).startsWith(`\n${marker}`);
}

// ── Core audit function ───────────────────────────────────────

export function auditSpecs(
  root: string,
  opts?: { fix?: boolean }
): AuditResult {
  const specsDir = join(root, "specs");
  const specs: SpecAuditResult[] = [];
  const rewrites: RewriteEntry[] = [];

  if (!existsSync(specsDir)) {
    return {
      specs,
      totalSCs: 0,
      totalTicked: 0,
      totalMatched: 0,
      totalUnmatched: 0,
      totalBehavioral: 0,
      strictUnmatched: 0,
      rewrites,
    };
  }

  // The SHARED enumeration (#225), not a second walk. This was
  // `readdirSync(specsDir).filter(f => f.endsWith(".md"))`, which reports
  // `bootstrap-data-flow` as a directory entry and then drops it for not
  // ending in `.md` — so its six specs and 260 criteria were not merely
  // unread, they were unreachable. `scripts/detect-sc-drift.ts` already
  // carries a docblock about having fixed exactly this for itself, so the
  // reporter and the drift gate disagreed about what a spec is, and the gate
  // was the one that was right.
  //
  // Entries come back relative to `specsDir`, so a nested spec names itself
  // `bootstrap-data-flow/success-criteria.md` in the table and in a finding.
  const specFiles = collectSpecFiles(specsDir);

  for (const specFile of specFiles) {
    const filePath = join(specsDir, specFile);
    const content = readFileSync(filePath, "utf-8");
    const fm = parseFrontmatter(content);

    // Skip non-testable specs
    if (!fm || fm.testable !== "true") continue;

    const compliance: "strict" | "permissive" =
      fm.compliance === "permissive" ? "permissive" : "strict";

    const scs = extractSCs(content, specFile);
    const matchedSCs: SCClassification[] = [];
    const unmatchedSCs: SCClassification[] = [];
    const behavioralSCs: SCClassification[] = [];
    /** The unmatched criteria as declared, so the writer can scope itself. */
    const unmatchedDecls: ExtractedSC[] = [];

    // Over the UNTICKED criteria only — see `SpecAuditResult`. Widening
    // `total` to the whole corpus must not widen `unmatched`.
    const open = scs.filter((sc) => !sc.checked);
    for (const sc of open) {
      if (isBehavioralSC(sc)) {
        behavioralSCs.push({ id: sc.id, statement: sc.statement, category: "behavioral" });
      } else if (matchPattern(sc) !== null) {
        matchedSCs.push({ id: sc.id, statement: sc.statement, category: "matched" });
      } else {
        unmatchedSCs.push({ id: sc.id, statement: sc.statement, category: "unmatched" });
        unmatchedDecls.push(sc);
      }
    }

    specs.push({
      specFile,
      total: scs.length,
      ticked: scs.length - open.length,
      matched: matchedSCs.length,
      unmatched: unmatchedSCs.length,
      behavioral: behavioralSCs.length,
      compliance,
      matchedSCs,
      unmatchedSCs,
      behavioralSCs,
    });

    // ── Fix mode: rewrite unmatched SCs in-place ──────────────
    const rewritable = unmatchedDecls.filter(isRewriteCandidate);
    if (opts?.fix && rewritable.length > 0) {
      let modified = content;
      let hasChanges = false;

      for (const usc of rewritable) {
        const closest = findClosestPattern(usc.statement);
        const decision = decideRewrite(usc.statement, closest);

        const scLinePattern = new RegExp(`^(- \\[ \\] ${usc.id}:\\s*)(.+)$`, "m");
        const scMatch = modified.match(scLinePattern);
        if (!scMatch) continue;

        // #426: a line we decline to rewrite keeps its text exactly. The
        // REVIEW marker records that the matcher could not bind it — which
        // is a coverage gap worth seeing — without the line itself losing
        // the file it names or the prose that says why it exists.
        if (decision.kind === "keep") {
          const marker = `<!-- REVIEW: unmatched (${decision.reason}) -->`;
          // #586: asked of THIS criterion's own next line, not of the whole
          // file. A file-wide `includes` meant that two criteria declined
          // for the same reason — and "no registry pattern was close enough"
          // is the commonest reason there is — shared one marker: measured
          // at four unmatched criteria and one marker. The three unmarked
          // ones read as reviewed because of a comment about a different
          // criterion.
          if (!followsWith(modified, scMatch, marker)) {
            modified = replaceLine(modified, scMatch, `${scMatch[0]}\n${marker}`);
            hasChanges = true;
          }
          rewrites.push({
            scId: usc.id,
            specFile,
            before: usc.statement,
            after: usc.statement, // unchanged, and that is the point
            patternUsed: closest?.patternName ?? "none",
            ambiguous: true,
            kept: decision.reason,
          });
          continue;
        }

        let replacement = `${scMatch[1]}${decision.statement}`;
        if (closest!.ambiguous) {
          replacement += `\n<!-- REVIEW: original — ${usc.statement} -->`;
        }
        modified = replaceLine(modified, scMatch, replacement);
        hasChanges = true;
        rewrites.push({
          scId: usc.id,
          specFile,
          before: usc.statement,
          after: decision.statement,
          patternUsed: closest!.patternName,
          ambiguous: closest!.ambiguous,
        });
      }

      if (hasChanges) {
        writeFileSync(filePath, modified);
      }
    }
  }

  const totalSCs = specs.reduce((sum, s) => sum + s.total, 0);
  const totalTicked = specs.reduce((sum, s) => sum + s.ticked, 0);
  const totalMatched = specs.reduce((sum, s) => sum + s.matched, 0);
  const totalUnmatched = specs.reduce((sum, s) => sum + s.unmatched, 0);
  const totalBehavioral = specs.reduce((sum, s) => sum + s.behavioral, 0);
  const strictUnmatched = specs
    .filter((s) => s.compliance === "strict")
    .reduce((sum, s) => sum + s.unmatched, 0);

  return {
    specs,
    totalSCs,
    totalTicked,
    totalMatched,
    totalUnmatched,
    totalBehavioral,
    strictUnmatched,
    rewrites,
  };
}

// ── Report formatting ─────────────────────────────────────────

export function formatReport(result: AuditResult): string {
  const lines: string[] = [];
  lines.push("audit-specs report");
  lines.push("=".repeat(60));
  lines.push("");

  // The name column is sized to the longest name present. A nested spec is
  // named by its path, so a fixed 45 would silently push every other column
  // out of alignment on exactly the rows this change made visible.
  const nameWidth = Math.max(
    "Spec".length,
    ...result.specs.map((s) => s.specFile.length),
  );
  const row = (
    name: string,
    total: string | number,
    ticked: string | number,
    matched: string | number,
    unmatched: string | number,
    behavioral: string | number,
  ) =>
    `${name.padEnd(nameWidth)} ${String(total).padEnd(6)} ${String(ticked).padEnd(7)} ` +
    `${String(matched).padEnd(8)} ${String(unmatched).padEnd(10)} ${String(behavioral).padEnd(10)}`;

  lines.push(row("Spec", "total", "ticked", "matched", "unmatched", "behavioral"));
  lines.push("-".repeat(nameWidth + 46));

  for (const spec of result.specs) {
    lines.push(
      row(spec.specFile, spec.total, spec.ticked, spec.matched, spec.unmatched, spec.behavioral),
    );
  }

  lines.push("-".repeat(nameWidth + 46));
  lines.push(
    row(
      "TOTAL",
      result.totalSCs,
      result.totalTicked,
      result.totalMatched,
      result.totalUnmatched,
      result.totalBehavioral,
    ),
  );
  lines.push("");
  // `matched`/`unmatched`/`behavioral` are the UNTICKED split, and a reader
  // who adds the columns and gets `total` only by accident will read them as
  // a partition of the whole. Say which population they describe.
  lines.push(
    `total = ticked + matched + unmatched + behavioral. ` +
      `matched/unmatched/behavioral classify the ${result.totalSCs - result.totalTicked} UNTICKED criteria only.`,
  );
  lines.push("");

  return lines.join("\n");
}

// ── Diff summary formatting ───────────────────────────────────

export function formatDiffSummary(result: AuditResult): string {
  const lines: string[] = [];

  if (!result.rewrites || result.rewrites.length === 0) {
    lines.push("No rewrites applied.");
    return lines.join("\n");
  }

  lines.push("Rewrite diff summary");
  lines.push("=".repeat(60));
  lines.push("");

  for (const r of result.rewrites) {
    lines.push(`${r.scId} (${r.specFile}):`);
    lines.push(`  before: ${r.before}`);
    lines.push(`  after:  ${r.after}`);
    lines.push(`  pattern: ${r.patternUsed}${r.ambiguous ? " (AMBIGUOUS — needs review)" : ""}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── CLI entry point ───────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith("-")) || ".";
  const fix = args.includes("--fix");

  if (!existsSync(root)) {
    console.error(`ERROR: Path does not exist: ${root}`);
    process.exit(1);
  }

  const result = auditSpecs(root, { fix });
  console.log(formatReport(result));

  if (fix && result.rewrites && result.rewrites.length > 0) {
    console.log(formatDiffSummary(result));
  }

  // Exit with non-zero if there are unmatched SCs in strict specs
  if (result.strictUnmatched > 0 && !fix) {
    process.exit(1);
  }
}
