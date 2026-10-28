#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { SIGNAL_PHRASE_PATTERNS } from "../lib/signal-phrases";
import { planDocScan, type DocScanPlan } from "../lib/doc-scan-targets";
import { lastCommitDates } from "../lib/git-dates";
import { contentHash } from "../lib/content-hash";
import {
  mineFixCommits,
  type EvidenceCandidate,
  type FailureIntakeReading,
} from "../lib/failure-intake";
import {
  promoteCandidates,
  PROMOTION_BUDGET_RULES,
  type PromotionReading,
} from "../lib/rule-promotion";
import {
  retireUnresolvable,
  survivingSubset,
  type RetirementReading,
} from "../lib/rule-retirement";

// ── Types ────────────────────────────────────────────────────────

export interface Candidate {
  rule: string;
  source: string;
  context: string;
  hash: string;
}

export interface StalenessEntry {
  file: string;
  daysSince: number;
  threshold: number;
  type: string;
}

/**
 * What the scan planned against what it actually read (#508).
 *
 * `scan` below says what the walk could SEE. Nothing said what the extractor
 * then managed to READ, and the two are different questions: a candidate
 * count of zero from a scan that read 91 documents and a candidate count of
 * zero from a scan that read 4 are the same line of output.
 *
 * `.claude/rules/checks-must-be-able-to-fail.md` states the general form
 * after #492 measured it — *a scan that reports a verdict should report its
 * own coverage* — and HYGIENE-6 is the verdict in question: it ended in
 * `expect(true).toBe(true)`, so a timeout was the only red it could produce.
 */
export interface ScanCoverage {
  /** Documents the plan listed. */
  planned: number;
  /** Documents whose bytes reached `extractSignalPhrases`. */
  read: number;
  /**
   * Planned documents the read could not take, with the error that stopped
   * it — `ENOENT` for a file that moved between the walk and the read,
   * `EISDIR`, `EACCES`.
   *
   * Recorded rather than thrown, and recorded rather than dropped. A throw
   * takes an advisory backlog report down over one transient file; a drop
   * makes a partial scan indistinguishable from a complete one, which is
   * the failure this whole interface exists to stop.
   */
  unread: Array<{ file: string; reason: string }>;
}

export interface ExtractResult {
  candidates: Candidate[];
  deduped: {
    existingConstraints: number;
    rejectedPrior: number;
    candidatesRemoved: number;
  };
  staleness: StalenessEntry[];
  /** What was planned against what was read. Never inferred from `candidates`. */
  coverage: ScanCoverage;
  /**
   * Set when `## Hard Constraints` holds lines that parsed to no constraints
   * at all, so `deduped.existingConstraints` of 0 means "could not read them"
   * rather than "there are none" (#1644). `null` when the section is absent,
   * empty, or read successfully — those are all honest zeroes.
   */
  unreadConstraints: string | null;
  /**
   * Observed failures mined from `fix:` and `Revert` commits (#545).
   *
   * Carried BESIDE `candidates` rather than merged into it, deliberately. The
   * two populations answer different questions — "is this sentence
   * rule-shaped" against "did something go wrong and cost us something" — and
   * folding them together would move HYGIENE-6's advisory backlog count for a
   * reason that has nothing to do with the backlog.
   */
  evidence: FailureIntakeReading;
  /**
   * Who survives, and why everything else did not (#544). Computed over BOTH
   * populations, which is the point: the doc candidates are what the
   * evidence-required criterion is being applied to.
   */
  promotion: PromotionReading;
  /**
   * What the generator stopped emitting, and why (#544, SC-1941).
   *
   * Separate from `promotion` for the same reason `evidence` is: a candidate
   * dropped because the commit it cites was rebased away and one dropped
   * because it ranked below the cut are different events with different
   * repairs, and one `withheld` list carrying both would need a reader to
   * tell them apart by reason string.
   */
  retirement: RetirementReading<EvidenceCandidate | Candidate>;
  /**
   * What was scanned and what could not be (#440).
   *
   * Carried on the result rather than printed, because the thing that went
   * wrong for four months was a scan silently covering four flat directories
   * while the project declared eight. A candidate count tells you nothing
   * about what was never read.
   */
  scan: DocScanPlan;
}

// ── Helpers ──────────────────────────────────────────────────────

// `contentHash` lives in `lib/content-hash.ts` now and is re-exported here
// under the name its callers already know — one binding, two names, the
// arrangement `lastCommitDates` has with `lib/conformity.ts` (#508). It moved
// because `lib/failure-intake.ts` is a second producer of candidates and the
// SC-137 veto table matches on this hash: two implementations of it would be
// behaviourally one until the day they disagreed, and the veto would silently
// stop applying to whichever producer used the other copy.
export { contentHash };

function surroundingContext(lines: string[], lineIdx: number): string {
  const start = Math.max(0, lineIdx - 1);
  const end = Math.min(lines.length, lineIdx + 2);
  return lines.slice(start, end).join("\n");
}

// `collectScanTargets` was four flat `readdirSync` loops and no recursion.
// `lib/doc-scan-targets.ts` owns this now, and derives the directories from
// the project's own routing table instead of hardcoding them. See #440.

function extractSignalPhrases(content: string, filePath: string, projectPath: string): Candidate[] {
  const lines = content.split("\n");
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const rel = relative(projectPath, filePath);

  for (const pattern of SIGNAL_PHRASE_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (const m of content.matchAll(re)) {
      const rule = m[0].replace(/^[-*] /, "").trim().replace(/[.;]$/, "");
      if (!rule || rule.length < 10) continue;
      const hash = contentHash(rule);
      if (seen.has(hash)) continue;
      seen.add(hash);

      const matchOffset = m.index ?? 0;
      const lineIdx = content.slice(0, matchOffset).split("\n").length - 1;
      const lineNum = lineIdx + 1;

      candidates.push({
        rule,
        source: `${rel}:${lineNum}`,
        context: surroundingContext(lines, lineIdx),
        hash,
      });
    }
  }

  return candidates;
}

/**
 * The constraints a project has already written down, so a mined candidate
 * restating one is deduped rather than offered again.
 *
 * Reads **both** markdown list forms. The first version matched only `- `,
 * and `## Hard Constraints` in this repository is a numbered list, so all
 * seven rules parsed to nothing: the section matched, 31 lines were read,
 * and the filter kept 0. Nothing refused — a parse failure and a project
 * with no constraints returned the same empty array, which is the Silent
 * Default Substitution `.claude/rules/config-access.md` names. Raised by
 * the required reviewer on #1644.
 *
 * Continuation lines are joined into their item. A wrapped rule is one
 * constraint, and taking only its first line is worse than not reading it:
 * rule 1 here would have yielded the fragment `specs still`, and dedup is
 * substring containment in both directions, so a short fragment silently
 * swallows unrelated candidates that happen to contain it.
 */
export function loadExistingConstraints(projectPath: string): string[] {
  const agentsPath = join(projectPath, "AGENTS.md");
  if (!existsSync(agentsPath)) return [];
  const content = readFileSync(agentsPath, "utf-8");
  const hcMatch = content.match(/## Hard Constraints[^\n]*\n\n([\s\S]*?)(?=\n## |\s*$)/);
  if (!hcMatch) return [];

  const ITEM = /^(?:[-*+]|\d+[.)])\s+/;
  const items: string[] = [];
  for (const line of hcMatch[1].split("\n")) {
    if (ITEM.test(line)) items.push(line.replace(ITEM, ""));
    else if (items.length > 0 && line.trim() !== "" && !line.startsWith("#")) {
      items[items.length - 1] += ` ${line.trim()}`;
    }
  }
  return items
    .map((t) => t.replace(/^\*\*[^*]+\*\*\s*—?\s*/, "").trim().toLowerCase())
    .filter((t) => t !== "");
}

/**
 * A `## Hard Constraints` section holding list items that parse to zero
 * constraints. Returned so the caller can say so instead of reporting a
 * project that simply has none — the two were indistinguishable, and that
 * is how seven rules went unread.
 */
export function unreadConstraintSection(projectPath: string): string | null {
  const agentsPath = join(projectPath, "AGENTS.md");
  if (!existsSync(agentsPath)) return null;
  const hcMatch = readFileSync(agentsPath, "utf-8")
    .match(/## Hard Constraints[^\n]*\n\n([\s\S]*?)(?=\n## |\s*$)/);
  if (!hcMatch) return null;
  const lines = hcMatch[1].split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  if (loadExistingConstraints(projectPath).length > 0) return null;
  return `AGENTS.md '## Hard Constraints' holds ${lines.length} non-blank line(s) and parsed to 0 constraints, so nothing there can dedup a mined candidate. Constraints must be markdown list items ('- ' or '1. ').`;
}

function loadRejectedHashes(projectPath: string): Set<string> {
  const rejectedPath = join(projectPath, "reference", "rejected-constraints.md");
  if (!existsSync(rejectedPath)) return new Set();
  const content = readFileSync(rejectedPath, "utf-8");
  const hashes = new Set<string>();
  for (const line of content.split("\n")) {
    const m = line.match(/^\|\s*([a-f0-9]+)\s*\|/);
    if (m) hashes.add(m[1]);
  }
  return hashes;
}

/**
 * One git subprocess for every document, not one per document (#508).
 *
 * This was `Bun.spawnSync(["git", …, "log", "-1", …, "--", rel])` inside
 * the loop — the exact code #323 removed from `runDocHygiene`, in a file
 * #323 did not touch. 92 documents meant 92 serial subprocesses against
 * the same repository, and nothing was wrong with any single one: the
 * check was load-sensitive by construction, so a busy machine, a cold
 * cache or another suite holding the index pushed it past the 5000ms
 * default test timeout. Measured before the change at 4169ms, 4521ms and
 * 3969ms on an IDLE machine with a warm cache; HYGIENE-6 had been seen red
 * four times in full runs and green standalone every time.
 *
 * `lastCommitDates` walks the whole history newest-first with `--name-only`
 * and returns every path's latest commit date from one call. Imported from
 * `lib/git-dates.ts` rather than copied, because two implementations of
 * one question are behaviourally one and no test can tell them apart.
 */
function computeStaleness(projectPath: string, files: string[]): StalenessEntry[] {
  const considered = files
    .map(f => relative(projectPath, f))
    .filter(rel => !(rel.includes("docs/adr/") || /ADR/i.test(rel)));
  // The exact lookup set is the pathspec, so the keys and the query cannot
  // drift — #323 got this wrong first time by passing the directories.
  const lastCommit = lastCommitDates(projectPath, considered);

  const stale: StalenessEntry[] = [];
  for (const rel of considered) {
    const dateStr = lastCommit.get(rel);
    // No commit means untracked or newly added, which is the opposite of stale.
    if (!dateStr) continue;
    const daysSince = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
    const isSpec = rel.startsWith("specs/");
    const threshold = isSpec ? 90 : 180;
    const type = isSpec ? "spec" : "guide";
    if (daysSince > threshold) {
      stale.push({ file: rel, daysSince: Math.floor(daysSince), threshold, type });
    }
  }
  return stale;
}

function applyToAgentsMd(projectPath: string, candidates: Candidate[]): void {
  const agentsPath = join(projectPath, "AGENTS.md");
  if (!existsSync(agentsPath)) return;
  let content = readFileSync(agentsPath, "utf-8");

  const formatted = candidates
    .map((c) => {
      const short = c.rule.length > 60 ? c.rule.slice(0, 57) + "..." : c.rule;
      return `- **${short}** (${c.source})`;
    })
    .join("\n");

  const markerStart = "<!-- BEGIN AUTO-EXTRACTED -->";
  const markerEnd = "<!-- END AUTO-EXTRACTED -->";

  if (content.includes(markerStart)) {
    content = content.replace(
      new RegExp(`${markerStart}[\\s\\S]*?${markerEnd}`),
      `${markerStart}\n${formatted}\n${markerEnd}`
    );
  } else {
    const hcMatch = content.match(/## Hard Constraints[^\n]*\n\n/);
    if (hcMatch) {
      const insertPos = (hcMatch.index ?? 0) + hcMatch[0].length;
      content =
        content.slice(0, insertPos) +
        `${markerStart}\n${formatted}\n${markerEnd}\n\n` +
        content.slice(insertPos);
    }
  }

  writeFileSync(agentsPath, content);
}

// ── Main export ──────────────────────────────────────────────────

export async function extractConstraints(
  projectPath: string,
  options?: { apply?: boolean; plan?: DocScanPlan }
): Promise<ExtractResult> {
  // `plan` is a seam, and it is here for one reason worth stating: the
  // unread branch below is unreachable from outside this function, because
  // the walk that produces the plan only lists files it has just stat'd. A
  // branch no test can reach is the subject of this repo's central rule, so
  // the plan is an input a caller may supply — which is also the race the
  // branch is about, a plan taken a moment before the tree moved.
  const scan = options?.plan ?? planDocScan(projectPath);
  const scanFiles = scan.files;
  const existingConstraints = loadExistingConstraints(projectPath);
  const rejectedHashes = loadRejectedHashes(projectPath);

  let allCandidates: Candidate[] = [];
  const unread: ScanCoverage["unread"] = [];
  let read = 0;
  for (const filePath of scanFiles) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      unread.push({ file: relative(projectPath, filePath), reason: e.code ?? e.name });
      continue;
    }
    read++;
    allCandidates.push(...extractSignalPhrases(content, filePath, projectPath));
  }

  const beforeCount = allCandidates.length;
  let existingRemoved = 0;
  let rejectedRemoved = 0;

  allCandidates = allCandidates.filter((c) => {
    if (rejectedHashes.has(c.hash)) {
      rejectedRemoved++;
      return false;
    }
    const lower = c.rule.toLowerCase();
    if (existingConstraints.some((ec) => lower.includes(ec) || ec.includes(lower))) {
      existingRemoved++;
      return false;
    }
    return true;
  });

  const staleness = computeStaleness(projectPath, scanFiles);

  // #545. One bounded `git log`, after the document walk, so a repository
  // without one costs nothing and a repository with one is read once.
  const evidence = mineFixCommits(projectPath);

  // #544. The doc candidates arrive with no `evidence` field at all, so the
  // gate withholds every one of them. That is not a bug in the wiring — it is
  // the measurement: signal-phrase extraction produces nothing a promotion
  // criterion based on observed failure can promote.
  // #544 SC-1941. Retirement runs BEFORE promotion and over both
  // populations: a candidate citing a commit that was rebased away, or a
  // `path:line` in a file that has since moved, is dropped rather than
  // ranked. Recency is the only ordering signal the promoter has, so a
  // candidate citing a vanished sha would otherwise rank at the very top.
  //
  // Its reading is folded into the promotion as an upstream, not merged into
  // one here: `0 retired` on a shallow clone means the question could not be
  // asked, and a promotion that reported MEASURED over that population would
  // be claiming a completeness nothing established.
  const retirement = retireUnresolvable(
    [...evidence.candidates, ...allCandidates],
    projectPath,
  );

  const promotion = promoteCandidates(
    retirement.kept,
    {
      budget: PROMOTION_BUDGET_RULES,
      rejectedHashes: rejectedHashes,
      upstream: [evidence, retirement],
    },
  );

  // #544. The gate has to reach the WRITE, or it is a control with no sink.
  //
  // Until this line, `--apply` wrote `allCandidates` — the unfiltered list —
  // so a candidate the retirement pass had just dropped was written into
  // `AGENTS.md` anyway and `retirement` was a field on the result that
  // nothing downstream consulted. A gate whose verdict changes no output is
  // not a fail-open; it is decoration.
  //
  // Filtered by object identity, not by hash: the same candidate objects
  // flow through `retireUnresolvable`, and a hash is a judgement about a
  // SENTENCE — two candidates mined from different positions can share one
  // (`lib/failure-intake.ts` relies on exactly that for a revert and the fix
  // it reverts), so matching on it would drop a survivor alongside a retired
  // twin.
  const keptDocCandidates = survivingSubset(allCandidates, retirement);

  if (options?.apply && keptDocCandidates.length > 0) {
    applyToAgentsMd(projectPath, keptDocCandidates);
  }

  return {
    // The backlog HYGIENE-6 counts is the surviving population, for the same
    // reason: re-reporting a candidate the generator has already retired
    // asks somebody to triage a position that is not there any more.
    candidates: keptDocCandidates,
    deduped: {
      existingConstraints: existingRemoved,
      rejectedPrior: rejectedRemoved,
      candidatesRemoved: existingRemoved + rejectedRemoved,
    },
    staleness,
    coverage: { planned: scanFiles.length, read, unread },
    unreadConstraints: unreadConstraintSection(projectPath),
    evidence,
    retirement,
    promotion,
    scan,
  };
}

// ── CLI entry ────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const projectPath = args.find((a) => !a.startsWith("--"));
  const apply = args.includes("--apply");

  if (!projectPath) {
    console.error("Usage: extract-constraints.ts /path/to/project [--apply]");
    process.exit(1);
  }

  if (!existsSync(projectPath)) {
    console.error(`ERROR: Path does not exist: ${projectPath}`);
    process.exit(1);
  }

  const result = await extractConstraints(projectPath, { apply });
  console.log(JSON.stringify(result, null, 2));
}
