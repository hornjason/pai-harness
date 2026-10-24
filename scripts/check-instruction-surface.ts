#!/usr/bin/env bun
/**
 * Refuse when the instruction surface an agent loads exceeds its declared
 * budget (#1009, #544).
 *
 * Every agent spawned against this repository loads `CLAUDE.md`, `AGENTS.md`
 * and every un-scoped `.claude/rules/*.md` in full before it reads a line of
 * the issue it was spawned for. On 2026-10-21 that came to 176,020 bytes —
 * roughly 44,000 tokens — and one file, `checks-must-be-able-to-fail.md`, was
 * 119,308 of it. #1009 moved the records out; this script is the part that
 * keeps them out. A number nobody enforces drifts back inside a week.
 *
 * Usage:
 *   bun scripts/check-instruction-surface.ts [--root <dir>] [--json]
 *
 * Exit 0 under budget, REFUSE_EXIT over it or on an unreadable population.
 *
 * ## The launch surface is the FLOOR of the reading, not the reading (#544)
 *
 * #1009 measured what an agent loads before it touches anything, and excluded
 * every path-scoped rule at `bytes: 0` because a scoped rule loads on demand.
 * That is the right exclusion for the question #1009 asked and the wrong
 * answer to the question the budget exists for. An agent that never touches a
 * file does no work. The moment it opens one, every rule whose globs match
 * that file loads on top of the launch surface, and NOTHING measured the sum.
 *
 * So `paths:` was a budget escape hatch, and it had already been used. On this
 * tree, before this change: launch surface 56,640 bytes, and
 * `.claude/rules/harness-managed.md` — scoped, therefore uncounted — carried a
 * further 9,484. Editing any file under `.claude/rules/**` cost 66,124 bytes
 * against a 64,000-byte budget that reported the repository clean. The rule
 * had grown to nine kilobytes of worked records for the same reason
 * `checks-must-be-able-to-fail.md` grew to 119,308: nothing was looking.
 *
 * `specs/RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md` (SC-1933) specifies the
 * reading that closes it:
 *
 *   > For every file in the repository, count the rules whose globs match it.
 *   > Take the maximum.
 *
 * in bytes rather than in rules, because bytes are what the budget is in and a
 * count of rules cannot tell a one-line rule from a nine-kilobyte one.
 *
 * ## ONE budget, because the launch surface is a special case of the peak
 *
 * There is no second constant and there must not be: the peak is the launch
 * surface plus a non-negative addition, so `peak <= budget` implies
 * `launch <= budget` and the #1009 check is subsumed rather than duplicated.
 * Two numbers governing one question are behaviourally one number, and a
 * mutation of either would leave the other holding the case up — which is how
 * `SURFACE_BUDGET_BYTES` came to need SC-2447 in the first place.
 *
 * ## What is measured, and why it is not the file size
 *
 * Two corrections to the naive reading, both verified against
 * `specs/RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md` and reproduced in this
 * repository:
 *
 *   1. A rule carrying `paths:` in its frontmatter loads ON DEMAND, when a
 *      Read/Write/Edit touches a matching file — not at launch. It is not part
 *      of the launch surface. `harness-managed.md` and `specs-routing.md` are
 *      path-scoped today and counting them overstates the surface by 13,728
 *      bytes.
 *   2. The frontmatter block is stripped before a rule enters context, so the
 *      bookkeeping keys cost nothing. The measurement is of the BODY.
 *
 * ## Three properties this file must keep, all asserted by
 * ## test/instruction-surface-budget.test.ts
 *
 *   1. Every refusal exits through `REFUSE_EXIT`, declared exactly once. The
 *      test builds a mutant copy with that constant set to 0 and runs every
 *      negative case twice — real refuses, mutant does not. See
 *      `.claude/rules/checks-must-be-able-to-fail.md`, "For a script whose job
 *      is to exit non-zero".
 *   2. No relative imports. The mutant runs from a temp directory and a
 *      relative import would make it die on module resolution — a non-zero
 *      exit that reads as the mutation having been rejected on the merits.
 *   3. The population is DERIVED from the tree, never spelled. A hardcoded
 *      list of eleven filenames goes stale the moment somebody adds a twelfth
 *      rule, and the check would then pass over exactly the growth it exists
 *      to catch.
 *
 * ## A reading that could not be taken is UNMEASURED, and UNMEASURED FAILS
 *
 * Zero rule files found is not a surface of zero bytes; it is a scan that did
 * not happen, and it is the single likeliest way this check becomes
 * decorative — the directory moves, the glob finds nothing, the total is 4,538
 * bytes and the budget is met forever. Same for a missing `CLAUDE.md`. Both
 * refuse rather than returning a number.
 *
 * The peak reading adds a third of the same shape: a walk that returns **no
 * repository files** has not found a repository with nothing in it, it has
 * failed to walk. Its peak would equal its floor and every scoped rule in the
 * tree would be free forever — the escape hatch this reading exists to close,
 * reopened by an empty list.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * - **A glob is matched against paths, never against what an agent will
 *   actually open.** A rule scoped to `test/**` is billed at the peak even if
 *   no agent ever touches a test. The reading is therefore an upper bound on
 *   one session, not a prediction of it, and it is deliberately the
 *   pessimistic direction: under-reporting is what let 9,484 bytes hide.
 * - **Nested `CLAUDE.md` files are not read.** Claude Code loads a
 *   directory-level `CLAUDE.md` when it enters that directory, which is a
 *   fourth loading mode. `ALWAYS_LOADED` names the root pair only, so a
 *   repository that splits instructions into per-directory `CLAUDE.md` files
 *   measures light here. No repository in this tree does.
 * - **Two rules whose globs overlap are summed, with no deduplication of
 *   their CONTENT.** Two rules carrying the same paragraph cost twice. That
 *   is what an agent pays, so it is what is reported.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, resolve, sep } from "path";

/** The one exit code every refusal travels through. See note 1 above. */
export const REFUSE_EXIT = 1;

/**
 * The budget, in bytes of body text, and this is its ONE declaring position.
 *
 * It governs the PEAK — the launch surface plus the worst single file's
 * scoped rules — and therefore the launch surface as well, which is the peak's
 * floor. #544 did not add a second number for concurrent load, on purpose.
 *
 * 64,000 bytes is roughly 16,000 tokens. #1009 landed the surface at 55,764,
 * so the headroom is 8,236 bytes — about two more rules of ordinary size, or
 * one substantial addition to an existing one. That slack is deliberate: a
 * budget set flush against the current reading turns every legitimate rule
 * edit into a red run and gets raised rather than respected.
 *
 * Raising this number is a decision, not a repair. The fix for a red run here
 * is almost always to move a record into `reference/` and route to it from
 * `.claude/rules/docs-routing.md`, which is what #1009 did.
 */
export const SURFACE_BUDGET_BYTES = 64_000;

/**
 * The fraction of the budget above which a PASSING reading still says
 * something. WARNs; never refuses.
 *
 * #1069: this check failed at 100% and was silent at 99.94%. The peak sat 36
 * bytes under budget on `origin/main` for long enough that the next agent to
 * add an ordinary 230-byte table row reddened a CI shard on
 * `.claude/agents/aditi.md` — a file it had never opened and whose connection
 * to its change is two levels of indirection away. Nothing had reported the
 * approach, because a reading one byte under the budget and a reading at half
 * of it produced identical output.
 *
 * So headroom is printed on every run, and a run inside the last 5% names
 * itself. A second REFUSAL at 95% was the alternative and is worse: it is a
 * second budget with the first one's problem and no slack at all, and the
 * repository would be red right now rather than warned.
 */
export const WARN_AT_FRACTION = 0.95;

/**
 * One ordinary rule table row, in bytes, and this is its ONE declaring
 * position. The figure is the one `headroomWarning` has always quoted.
 *
 * #1520: the warning above is not enough, and that is measured rather than
 * argued. #1069 added it precisely so the approach would be visible, and the
 * tree still walked to **37 bytes** of headroom with the warning firing on
 * every run — a control that was in place and did not work. What finally
 * reported the problem was a red CI shard on `.claude/agents/aditi.md`,
 * raised against an agent who had never opened that file, for a row somebody
 * else had added weeks earlier.
 *
 * So the budget now has to accommodate the tree PLUS one more ordinary row.
 * The red then lands on the change that consumes the last row, naming the
 * budget, instead of on the next unrelated change.
 */
export const ORDINARY_ROW_BYTES = 230;

/**
 * The largest peak that still leaves room for one ordinary row.
 *
 * Declared as a function over the budget rather than as a second constant,
 * and it REPLACES the bare `peak > budget` comparison instead of joining it.
 * A floor beside a ceiling is the "two deciders that agree" shape from
 * `.claude/rules/checks-must-be-able-to-fail.md`: the floor is strictly
 * stronger, so the ceiling could never fail again and a mutation of it would
 * leave the floor holding every case up. There is one comparison, here.
 */
export function ceiling(budgetBytes: number): number {
  return budgetBytes - ORDINARY_ROW_BYTES;
}

/** Loaded at launch regardless of what is touched. */
const ALWAYS_LOADED = ["CLAUDE.md", "AGENTS.md"] as const;

/** Where the rules live. Walked recursively — Claude Code discovers nested. */
const RULES_DIR = join(".claude", "rules");

/**
 * Claude Code's own per-rule glob limits, from
 * `specs/RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md` (SC-1937). Over either and
 * the rule's loading behaviour is the platform's business rather than this
 * repository's, which makes every byte this script attributes to it a guess.
 */
export const MAX_EXPANDED_PATTERNS = 1_000;
export const MAX_RULE_BYTES = 4 * 1024 * 1024;

/**
 * Not walked when deriving the file population.
 *
 * Two entries, both because their contents are not files an agent edits under
 * this repository's rules: `.git` is the object store, `node_modules` is a
 * dependency tree. Nothing else is skipped — a skip list is a way to make a
 * population smaller than the tree, and the population being derived from the
 * tree is the property SC-2443 exists for.
 */
const SKIP_DIRS = new Set([".git", "node_modules"]);

export class SurfaceUnmeasured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfaceUnmeasured";
  }
}

export interface SurfaceEntry {
  file: string;
  bytes: number;
  /** Non-null when the file exists but does not load at launch. */
  excluded: string | null;
}

export interface SurfaceReading {
  entries: SurfaceEntry[];
  totalBytes: number;
  budgetBytes: number;
}

/**
 * The frontmatter block, stripped exactly as Claude Code strips it.
 *
 * The blank line that separated the block from the body goes with it — a file
 * with 2 KB of frontmatter and one whose frontmatter is absent must measure
 * the same, and leaving the separator behind makes them differ by one byte.
 */
export function ruleBody(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 3);
  if (end < 0) return text;
  const body = text.slice(end + 5);
  return body.startsWith("\n") ? body.slice(1) : body;
}

/** The raw frontmatter block, or "" when there is none. */
function frontmatter(text: string): string {
  if (!text.startsWith("---\n")) return "";
  const end = text.indexOf("\n---\n", 3);
  return end < 0 ? "" : text.slice(4, end + 1);
}

/**
 * True when the rule is path-scoped, so it loads on demand rather than at
 * launch. `paths` is the only frontmatter key Claude Code reads.
 */
export function isPathScoped(text: string): boolean {
  return /^paths:/m.test(frontmatter(text));
}

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
}

/**
 * Measure the surface an agent loads at launch.
 *
 * REFUSES rather than returning a small number when its own premise fails:
 * a tree with no rule files, or without `CLAUDE.md`, has not been measured.
 */
export function measureSurface(root: string): SurfaceReading {
  const abs = resolve(root);

  const ruleFiles: string[] = [];
  walk(join(abs, RULES_DIR), ruleFiles);
  if (ruleFiles.length === 0) {
    throw new SurfaceUnmeasured(
      `no .md files under ${join(abs, RULES_DIR)} — a surface of zero is a scan that did not ` +
        `happen, not a repository with no rules (#1009)`,
    );
  }

  const entries: SurfaceEntry[] = [];
  let total = 0;

  for (const name of ALWAYS_LOADED) {
    const p = join(abs, name);
    let text: string;
    try {
      statSync(p);
      text = readFileSync(p, "utf-8");
    } catch {
      throw new SurfaceUnmeasured(
        `${name} is missing from ${abs} — it is loaded at launch unconditionally, so a tree ` +
          `without it is UNMEASURED rather than lighter (#1009)`,
      );
    }
    const bytes = Buffer.byteLength(ruleBody(text), "utf-8");
    total += bytes;
    entries.push({ file: name, bytes, excluded: null });
  }

  for (const p of ruleFiles) {
    const text = readFileSync(p, "utf-8");
    const file = relative(abs, p).split(sep).join("/");
    if (isPathScoped(text)) {
      entries.push({ file, bytes: 0, excluded: "path-scoped: loads on demand, not at launch" });
      continue;
    }
    const bytes = Buffer.byteLength(ruleBody(text), "utf-8");
    total += bytes;
    entries.push({ file, bytes, excluded: null });
  }

  return { entries, totalBytes: total, budgetBytes: SURFACE_BUDGET_BYTES };
}

// ── The peak: launch surface plus what one file pulls in (#544) ──────────

/**
 * The `paths:` globs a rule declares, in declaration order.
 *
 * Both YAML spellings, because both are legal and a parser that reads one
 * silently measures the other as un-scoped — which would move a rule from the
 * on-demand tier into the launch surface and change its bytes, not just its
 * bookkeeping. Quotes are stripped; a `#` comment is not, because a glob may
 * legitimately contain one and guessing which is which needs a YAML parser
 * this script cannot import (see note 2 in the header).
 */
export function rulePaths(text: string): string[] {
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");
  const lines = frontmatter(text).split("\n");
  const at = lines.findIndex(l => /^paths:/.test(l));
  if (at < 0) return [];

  const inline = /^paths:\s*\[(.*)\]\s*$/.exec(lines[at]!);
  if (inline) return inline[1]!.split(",").map(unquote).filter(s => s.length > 0);

  // Block form: indented `- item` lines, until the next top-level key. Parsed
  // line by line rather than with one regex over the block, because the
  // regex version shipped in review with `\Z` in it — which JavaScript reads
  // as a literal `Z`, so it matched nothing, every rule parsed to zero globs,
  // and the peak equalled the launch surface on every tree. Caught by the
  // fixtures below; it is the exact failure the `isPathScoped` agreement case
  // at the end of the battery exists to catch in the field.
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\S/.test(line)) break;
    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (item) out.push(unquote(item[1]!));
  }
  return out;
}

/**
 * Brace groups, expanded the way Claude Code counts them against its 1,000
 * pattern budget: `{a,b}/{c,d}/*.{ts,tsx}` is eight patterns, not one.
 *
 * Bounded at `MAX_EXPANDED_PATTERNS * 2`, and the bound is the point rather
 * than a guard against it: the only reason to expand is to find out whether
 * the count is over, so expanding a pathological pattern to completion in
 * order to report that it is too large would be the defect it reports.
 */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === "{") depth++;
    else if (pattern[i] === "}" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return [pattern];

  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const alts: string[] = [];
  let cur = "";
  let d = 0;
  for (const ch of pattern.slice(open + 1, close)) {
    if (ch === "{") d++;
    if (ch === "}") d--;
    if (ch === "," && d === 0) {
      alts.push(cur);
      cur = "";
    } else cur += ch;
  }
  alts.push(cur);

  const out: string[] = [];
  for (const alt of alts) {
    for (const rest of expandBraces(head + alt + tail)) {
      out.push(rest);
      if (out.length > MAX_EXPANDED_PATTERNS * 2) return out;
    }
  }
  return out;
}

export interface ScopedRule {
  file: string;
  bytes: number;
  globs: string[];
  /** Expanded pattern count, against `MAX_EXPANDED_PATTERNS`. */
  expandedPatterns: number;
}

export interface ConcurrentLoadReading {
  /** Every file pays this, whatever it touches. The peak's floor. */
  launch: SurfaceReading;
  /** The worst single file: launch surface plus every scoped rule matching it. */
  peakBytes: number;
  /**
   * The file producing the peak, or `null` when no scoped rule matches any
   * file — in which case the peak IS the launch surface and naming an
   * arbitrary file as its cause would be a fact the reading does not have.
   */
  peakFile: string | null;
  /** The scoped rules loading on `peakFile`, largest first. */
  peakRules: ScopedRule[];
  /** Repository files walked. Zero is UNMEASURED, not a peak of zero. */
  filesScanned: number;
  /** Scoped rules whose globs match every file walked — SC-1936. */
  unscoped: ScopedRule[];
  /** Rules over Claude Code's own per-rule glob or size limits — SC-1937. */
  globOverruns: ScopedRule[];
  oversized: ScopedRule[];
  budgetBytes: number;
}

function walkFiles(dir: string, root: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkFiles(join(dir, e.name), root, out);
    } else if (e.isFile()) {
      out.push(relative(root, join(dir, e.name)).split(sep).join("/"));
    }
  }
}

/**
 * Measure the peak: for every file in the repository, the launch surface plus
 * every scoped rule whose globs match it. Take the maximum.
 *
 * The total rule count is NOT consulted anywhere in here (SC-1935). Forty
 * rules that never co-match cost one rule's worth; two that always co-match
 * cost two. A cap on the count would refuse the first and pass the second,
 * which is the wrong way round.
 */
export function measureConcurrentLoad(
  root: string,
  budgetBytes: number = SURFACE_BUDGET_BYTES,
): ConcurrentLoadReading {
  const abs = resolve(root);
  const launch = measureSurface(abs);

  const ruleFiles: string[] = [];
  walk(join(abs, RULES_DIR), ruleFiles);

  const scoped: ScopedRule[] = [];
  for (const p of ruleFiles) {
    const text = readFileSync(p, "utf-8");
    if (!isPathScoped(text)) continue;
    const globs = rulePaths(text);
    let expandedPatterns = 0;
    for (const g of globs) expandedPatterns += expandBraces(g).length;
    scoped.push({
      file: relative(abs, p).split(sep).join("/"),
      bytes: Buffer.byteLength(ruleBody(text), "utf-8"),
      globs,
      expandedPatterns,
    });
  }

  const files: string[] = [];
  walkFiles(abs, abs, files);

  // The two walks must agree about the tree they are both reading.
  //
  // `measureSurface` has already proved that `CLAUDE.md`, `AGENTS.md` and
  // `ruleFiles.length` rule files exist. A file walk that comes back with
  // fewer than those has not found a smaller repository, it has failed —
  // and its failure is silent in the worst possible direction, because a
  // peak computed over no files equals the launch surface and every
  // path-scoped rule in the tree is free forever. That is the escape hatch
  // this whole reading exists to close, reopened by a short list.
  //
  // Stated as a floor rather than as `length === 0` on purpose: zero is
  // unreachable here (the files `measureSurface` read are in this tree, so a
  // working walk always returns at least three), and a guard whose condition
  // cannot occur is the shape `.claude/rules/checks-must-be-able-to-fail.md`
  // is about. The floor is reachable — breaking the recursion in `walkFiles`
  // trips it, which is the mutation `test/instruction-surface-budget.test.ts`
  // runs.
  const floor = ALWAYS_LOADED.length + ruleFiles.length;
  if (files.length < floor) {
    throw new SurfaceUnmeasured(
      `the file walk under ${abs} returned ${files.length} files, fewer than the ${floor} ` +
        `the launch reading already read from the same tree — a walk that did not happen, ` +
        `not a repository that small. Its peak would equal its launch surface and every ` +
        `path-scoped rule would be free (#544)`,
    );
  }

  const matchers = scoped.map(r => ({
    rule: r,
    globs: r.globs.map(g => new Bun.Glob(g)),
    matchCount: 0,
  }));

  let peakBytes = launch.totalBytes;
  let peakFile: string | null = null;
  let peakRules: ScopedRule[] = [];

  for (const file of files) {
    let bytes = launch.totalBytes;
    const hits: ScopedRule[] = [];
    for (const m of matchers) {
      if (!m.globs.some(g => g.match(file))) continue;
      m.matchCount++;
      bytes += m.rule.bytes;
      hits.push(m.rule);
    }
    // Strictly greater, so the first file in sorted order wins a tie and two
    // runs over one tree name the same file. `files` is sorted by the walk.
    if (hits.length > 0 && bytes > peakBytes) {
      peakBytes = bytes;
      peakFile = file;
      peakRules = [...hits].sort((a, b) => b.bytes - a.bytes);
    }
  }

  return {
    launch,
    peakBytes,
    peakFile,
    peakRules,
    filesScanned: files.length,
    unscoped: matchers.filter(m => m.matchCount === files.length).map(m => m.rule),
    globOverruns: scoped.filter(r => r.expandedPatterns > MAX_EXPANDED_PATTERNS),
    oversized: scoped.filter(r => r.bytes > MAX_RULE_BYTES),
    budgetBytes,
  };
}

/**
 * The peak refusal. Names the overlapping rules and puts glob-narrowing
 * FIRST, because the spec does: an over-budget repository is fixed by making
 * a rule load less often before it is fixed by deleting a good rule.
 *
 * It carries the launch breakdown as well as the scoped additions. A reader
 * handed only "peak 66,124 on some rule file" cannot tell a repository
 * whose floor is too high from one whose floor is fine and whose glob is too
 * wide, and those have different first moves.
 */
export function overPeakReport(reading: ConcurrentLoadReading): string {
  const loaded = reading.launch.entries
    .filter(e => !e.excluded)
    .sort((a, b) => b.bytes - a.bytes);
  const limit = ceiling(reading.budgetBytes);
  const over = reading.peakBytes - limit;
  const lines = [
    `The peak instruction surface is ${reading.peakBytes.toLocaleString()} bytes ` +
      `(~${Math.round(reading.peakBytes / 4).toLocaleString()} tokens), ` +
      `${over.toLocaleString()} over the ${limit.toLocaleString()}-byte ceiling: the ` +
      `${reading.budgetBytes.toLocaleString()}-byte SURFACE_BUDGET_BYTES declared in ` +
      `scripts/check-instruction-surface.ts, less the ${ORDINARY_ROW_BYTES} bytes kept free ` +
      `for one ordinary rule table row so the next agent to add one does not go red on a ` +
      `file they never opened (#1520).`,
    "",
    `Worst file: ${reading.peakFile ?? "(launch surface alone — no scoped rule matches any file)"}`,
    "",
    `  ${String(reading.launch.totalBytes).padStart(8)}  LAUNCH, paid by every agent before it reads its issue:`,
  ];
  for (const e of loaded.slice(0, 8)) {
    const share = Math.round((e.bytes / reading.peakBytes) * 100);
    lines.push(`  ${String(e.bytes).padStart(8)}  ${String(share).padStart(3)}%    ${e.file}`);
  }
  if (reading.peakRules.length > 0) {
    lines.push("", "  path-scoped rules that also load on that file:");
    for (const r of reading.peakRules) {
      const share = Math.round((r.bytes / reading.peakBytes) * 100);
      lines.push(
        `  ${String(r.bytes).padStart(8)}  ${String(share).padStart(3)}%    ${r.file}  [${r.globs.join(" ")}]`,
      );
    }
  }
  lines.push(
    "",
    "Fix it in this order:",
    "",
    "  1. NARROW A GLOB. A rule loading on a file it has nothing to say about",
    "     is the cheapest byte in the reading. Split the rule before you cut it.",
    "  2. Move the worked examples and measurement tables into reference/ and",
    "     route to them from .claude/rules/docs-routing.md — #1009 took the",
    "     launch surface from 176,020 to 55,764 that way, deleting nothing.",
    "  3. Evict the rule. Last, and only once 1 and 2 are exhausted.",
    "",
    "Raising SURFACE_BUDGET_BYTES is a decision, not a repair, and SC-2447",
    "refuses a budget more than 35% above what it measures.",
  );
  return lines.join("\n");
}

export interface HeadroomReading {
  /** Budget minus peak. Negative when over — this is a reading, not a verdict. */
  bytes: number;
  /** Peak as a fraction of the budget. */
  used: number;
  /** True at or above `WARN_AT_FRACTION`, including when already over. */
  warn: boolean;
}

/**
 * How much room is left, as one function rather than as arithmetic at each
 * call site.
 *
 * There is exactly one of these on purpose. A second place computing
 * `budget - peak` would be the "two deciders that agree" shape from
 * `.claude/rules/checks-must-be-able-to-fail.md`: both correct, neither
 * falsifiable by a mutation of the other.
 */
export function headroom(reading: ConcurrentLoadReading): HeadroomReading {
  const bytes = reading.budgetBytes - reading.peakBytes;
  const used = reading.peakBytes / reading.budgetBytes;
  return { bytes, used, warn: used >= WARN_AT_FRACTION };
}

/**
 * The warning text. Says what an ordinary addition costs, because "402 bytes
 * left" does not tell a reader whether their table row fits and a table row
 * is the thing that keeps not fitting.
 */
export function headroomWarning(reading: ConcurrentLoadReading): string {
  const h = headroom(reading);
  return (
    `HEADROOM: the peak instruction surface is ${reading.peakBytes.toLocaleString()} bytes, ` +
    `${Math.round(h.used * 100)}% of the ${reading.budgetBytes.toLocaleString()}-byte budget — ` +
    `${h.bytes.toLocaleString()} left, and an ordinary rule table row is about ` +
    `${ORDINARY_ROW_BYTES}. The next ` +
    `agent to add one will go red on ${reading.peakFile ?? "the launch surface"}, which has ` +
    `nothing to do with their change. Move a worked record into reference/ and route to it ` +
    `from .claude/rules/docs-routing.md now, rather than making them discover this (#1069).`
  );
}

// `overBudgetReport` — #1009's launch-only renderer — is gone, folded into
// `overPeakReport` above. Two renderers for one refusal would be two places
// to keep the remedy correct, and the launch surface is no longer a thing
// this script refuses separately.

function main(argv: string[]): number {
  const rootArg = argv.indexOf("--root");
  const root = rootArg >= 0 ? argv[rootArg + 1]! : process.cwd();
  const asJson = argv.includes("--json");

  let peak: ConcurrentLoadReading;
  try {
    peak = measureConcurrentLoad(root);
  } catch (err) {
    if (!(err instanceof SurfaceUnmeasured)) throw err;
    console.error(`UNMEASURED: ${err.message}`);
    return REFUSE_EXIT;
  }
  const reading = peak.launch;

  if (asJson) {
    // The launch reading stays at the top level: it is what #1009's callers
    // read, and burying it under a new key would be a silent contract change
    // dressed as an addition.
    console.log(JSON.stringify({ ...reading, concurrent: peak, headroom: headroom(peak) }, null, 2));
  } else {
    for (const e of [...reading.entries].sort((a, b) => b.bytes - a.bytes)) {
      console.log(`${String(e.bytes).padStart(8)}  ${e.file}${e.excluded ? `  [${e.excluded}]` : ""}`);
    }
    console.log(
      `${String(reading.totalBytes).padStart(8)}  LAUNCH (every agent pays this, ` +
        `~${Math.round(reading.totalBytes / 4)} tokens)`,
    );
    console.log(
      `${String(peak.peakBytes).padStart(8)}  PEAK on ${peak.peakFile ?? "(no scoped rule matches any file)"} ` +
        `(budget ${peak.budgetBytes}, ~${Math.round(peak.peakBytes / 4)} tokens, ` +
        `${peak.filesScanned} files scanned)`,
    );
    for (const r of peak.peakRules) {
      console.log(`${String(r.bytes).padStart(8)}    + ${r.file}  [${r.globs.join(" ")}]`);
    }
    const h = headroom(peak);
    console.log(
      `${String(h.bytes).padStart(8)}  HEADROOM (${Math.round(h.used * 100)}% of budget used)`,
    );
  }

  // #1069. Printed before the refusals below and independent of them: a tree
  // that is over budget is also, trivially, inside the warning band, and a
  // reader who sees only the refusal learns nothing about how close the tree
  // was before their change. This is the whole of the warning — it does not
  // touch the return value anywhere.
  if (headroom(peak).warn) console.error(headroomWarning(peak));

  // SC-1936. A `paths:` matching every file in the tree declares the mined
  // tier and behaves as the baseline one, which is strictly worse than
  // declaring no `paths:` at all: the rule is in the launch surface in
  // practice and excluded from it in the reading. A WARN is how 1,010
  // candidates accumulated, so this refuses.
  if (peak.unscoped.length > 0) {
    console.error("");
    for (const r of peak.unscoped) {
      console.error(
        `UNSCOPED: ${r.file} declares paths [${r.globs.join(" ")}] which match all ` +
          `${peak.filesScanned} files in the tree. A glob that excludes nothing is not a scope — ` +
          `narrow it, or drop \`paths:\` and let the ${r.bytes}-byte body be billed at launch ` +
          `where it is actually paid (#544, SC-1936).`,
      );
    }
    return REFUSE_EXIT;
  }

  // SC-1937. Over either of Claude Code's own per-rule limits the platform
  // decides what loads, so every byte attributed above is a guess.
  for (const r of peak.globOverruns) {
    console.error(
      `GLOB BUDGET: ${r.file} expands to ${r.expandedPatterns} patterns, over Claude Code's ` +
        `limit of ${MAX_EXPANDED_PATTERNS}. Brace groups multiply (#544, SC-1937).`,
    );
  }
  for (const r of peak.oversized) {
    console.error(
      `RULE SIZE: ${r.file} is ${r.bytes} bytes, over Claude Code's per-rule limit of ` +
        `${MAX_RULE_BYTES} (#544, SC-1937).`,
    );
  }
  if (peak.globOverruns.length > 0 || peak.oversized.length > 0) return REFUSE_EXIT;

  // One comparison, against the peak. The launch surface is the peak's floor,
  // so `peak <= budget` implies `launch <= budget` and a second comparison
  // would be a second decider that can only ever agree.
  //
  // #1520 moved the threshold from the budget to `ceiling(budget)` rather
  // than adding a second test below it, for the same reason: a floor and a
  // ceiling over one measurement are two deciders, and the stronger one would
  // mask every mutation of the weaker.
  if (peak.peakBytes > ceiling(peak.budgetBytes)) {
    console.error("");
    console.error(overPeakReport(peak));
    return REFUSE_EXIT;
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
