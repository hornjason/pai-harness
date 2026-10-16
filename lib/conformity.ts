/**
 * Exportable conformity test functions.
 *
 * Projects import these and pass their root path:
 *   import { runScaffoldConformity, runSpecDiscovery, runSpecDrift } from "rungate/lib/conformity";
 *   runScaffoldConformity(import.meta.dir + "/..");
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "fs";
import { collectSpecFiles } from "./spec-files";
import { spawnSync } from "child_process";
import { join, dirname, sep } from "path";
import { fileURLToPath } from "url";
import { deriveDirectoryName } from "../scripts/split-spec";
import { readFreshCache } from "./behavioral-cache";
import { tryLoadRungateConfig } from "./config-loader";
import { stripJsComments } from "./strip-js-comments";
import { parseScDeclarations } from "./sc-ids";
import { isHarnessItself } from "./harness-identity";
import { tsconfigVerdict } from "./typescript-project";
import { readSuccessDoc, readSuccessTemplate, successViolations } from "./success-doc";

// ── Shared utilities ────────────────────────────────────────

export function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  const lines = match[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) {
      fields[kv[1]] = kv[2].trim();
      continue;
    }
    // Block-style key — `tiers:` with its value on the indented lines below.
    // Without this branch the key reads as ABSENT, so a presence check on a
    // field that is plainly there (marcus.md's `tiers`, SC-423) fails against
    // correct input. The value is the flattened block, which is enough for the
    // presence and substring checks the conformity matchers make of it.
    const blockKey = lines[i].match(/^(\w[\w-]*):\s*$/);
    if (!blockKey) continue;
    const block: string[] = [];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
      block.push(lines[++i].trim());
    }
    fields[blockKey[1]] = block.join("; ");
  }
  return fields;
}

/**
 * SC-286: Resolve and validate file paths - reject traversal and absolute paths
 * Returns resolved path or null if path is unsafe
 */
export function resolveAndContain(root: string, target: string): string | null {
  // Reject path traversal
  if (target.includes("../")) return null;
  // Reject absolute paths
  if (target.startsWith("/")) return null;
  // Allow normal relative paths (including those with dots in filenames like .rungate)
  return join(root, target);
}

/**
 * Resolve the actual .git directory, handling worktrees where .git is a file
 * containing "gitdir: /path/to/real/gitdir".
 */
function resolveGitDir(root: string): string {
  const dotGit = join(root, ".git");
  if (!existsSync(dotGit)) return dotGit;
  const stat = statSync(dotGit);
  if (stat.isDirectory()) return dotGit;
  // Worktree: .git is a file with "gitdir: <path>"
  const content = readFileSync(dotGit, "utf-8").trim();
  const match = content.match(/^gitdir:\s*(.+)$/);
  if (match) {
    const gitdir = match[1].trim();
    // gitdir may be absolute or relative
    return gitdir.startsWith("/") ? gitdir : join(root, gitdir);
  }
  return dotGit;
}

/**
 * Resolve a file path that starts with .git/ through the worktree-aware git dir.
 * For non-.git paths, returns the normal join(root, file).
 */
function resolveFilePath(root: string, file: string): string {
  if (file.startsWith(".git/")) {
    const gitDir = resolveGitDir(root);
    // For worktrees, hooks live in the main repo's hooks dir, not the worktree gitdir.
    // The worktree gitdir (e.g. .git/worktrees/name/) doesn't have hooks/.
    // Walk up to the main .git dir if we're in a worktree subdir.
    const suffix = file.slice(".git/".length); // e.g. "hooks/pre-commit"
    const resolved = join(gitDir, suffix);
    if (existsSync(resolved)) return resolved;
    // Try the common dir (main repo .git) for shared resources like hooks
    const commonDirFile = join(gitDir, "commondir");
    if (existsSync(commonDirFile)) {
      const commonDir = readFileSync(commonDirFile, "utf-8").trim();
      const commonResolved = commonDir.startsWith("/")
        ? join(commonDir, suffix)
        : join(gitDir, commonDir, suffix);
      if (existsSync(commonResolved)) return commonResolved;
    }
    return resolved;
  }
  return join(root, file);
}

export { SIGNAL_PHRASE_PATTERNS } from "./signal-phrases";

// ── Structured findings (machine-readable for agents) ──────

export interface ConformityFinding {
  ruleId: string;
  severity: "FAIL" | "WARN";
  file: string;
  message: string;
  fixCommand?: string;
}

export interface ConstraintCandidate {
  rule: string;
  source: string;
  hash: string;
  status: "pending" | "applied" | "rejected";
}

export interface StalenessEntry {
  file: string;
  daysSince: number;
  threshold: number;
  type: string;
}

const _findings: ConformityFinding[] = [];
const _candidates: ConstraintCandidate[] = [];
const _staleness: StalenessEntry[] = [];
let _behavioralCount = 0;

export function addFinding(finding: ConformityFinding): void {
  _findings.push(finding);
}

export function addCandidate(candidate: ConstraintCandidate): void {
  _candidates.push(candidate);
}

export function addStaleness(entry: StalenessEntry): void {
  _staleness.push(entry);
}

export function getFindings(): ConformityFinding[] {
  return [..._findings];
}

export function getCandidates(): ConstraintCandidate[] {
  return [..._candidates];
}

export function getStaleness(): StalenessEntry[] {
  return [..._staleness];
}

export function clearFindings(): void {
  _findings.length = 0;
  _candidates.length = 0;
  _staleness.length = 0;
  _behavioralCount = 0;
}

export function addBehavioralCount(count: number): void {
  _behavioralCount += count;
}

export function getBehavioralCount(): number {
  return _behavioralCount;
}

// ── Auto-flip: track passing SCs and flip checkboxes ────────

interface PassingSC {
  id: string;
  specPath: string;
}

const _passingSCs: PassingSC[] = [];

export function recordPassingSC(id: string, specPath: string): void {
  _passingSCs.push({ id, specPath });
}

export function getPassingSCs(): readonly PassingSC[] {
  return _passingSCs;
}

/**
 * Flip `- [ ] SC-N` to `- [x] SC-N` for every SC recorded as passing in this
 * process.
 *
 * DELIBERATELY HAS NO AUTOMATIC CALLER (#86). It used to run from an afterAll
 * inside runScaffoldConformity, which made a test run mutate the spec files
 * that the next run's test collection reads from — the suite alternated
 * between 57 and 99 tests and reported 0 fail either way.
 *
 * Routine syncing is handled by scripts/sync-sc-status.ts via the `posttest`
 * hook, which re-derives pass state independently. Call this only from an
 * explicitly-invoked command, never from a test lifecycle hook.
 */
export function flipPassingCheckboxes(): number {
  const byFile = new Map<string, Set<string>>();
  for (const { id, specPath } of _passingSCs) {
    if (!byFile.has(specPath)) byFile.set(specPath, new Set());
    byFile.get(specPath)!.add(id);
  }

  let flipped = 0;
  for (const [specPath, ids] of byFile) {
    if (!existsSync(specPath)) continue;
    let content = readFileSync(specPath, "utf-8");
    let changed = false;
    for (const id of ids) {
      const unchecked = `- [ ] ${id}:`;
      if (content.includes(unchecked)) {
        content = content.replace(unchecked, `- [x] ${id}:`);
        changed = true;
        flipped++;
      }
    }
    if (changed) writeFileSync(specPath, content);
  }
  return flipped;
}

export function writeFindingsReport(root: string): string {
  const reportPath = join(root, ".rungate", "conformity-findings.json");
  const dir = join(root, ".rungate");
  if (!existsSync(dir)) {
    require("fs").mkdirSync(dir, { recursive: true });
  }
  require("fs").writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    total: _findings.length + _candidates.length + _staleness.length,
    failures: _findings.filter(f => f.severity === "FAIL").length,
    warnings: _findings.filter(f => f.severity === "WARN").length,
    candidateCount: _candidates.length,
    behavioralCount: _behavioralCount,
    staleCount: _staleness.length,
    findings: _findings,
    constraintCandidates: _candidates,
    staleness: _staleness,
  }, null, 2));
  return reportPath;
}

export interface ParsedSC {
  id: string;
  statement: string;
  specFile: string;
  /**
   * Whether the SC's checkbox is ticked — `- [x]` rather than `- [ ]`.
   *
   * This drives the whole binding: a CHECKED SC claims to be done, so it is
   * run as a real assertion and may fail the suite; an UNCHECKED one is work
   * not started, so it is emitted as `test.todo`. Optional only because
   * ParsedSC is constructed by hand in a dozen call sites that predate the
   * field; `extractSCs` always sets it, and the planner treats a missing
   * value as unchecked.
   */
  checked?: boolean;
}

/** A ParsedSC as produced by extractSCs, where the checkbox state is known. */
export interface ExtractedSC extends ParsedSC {
  checked: boolean;
}

// ── Behavioral SC detection ───────────────────────────────

/**
 * Detects whether an SC has the (behavioral) suffix, indicating it requires
 * runtime verification (agent sessions, transcripts, auditing) and cannot
 * be tested by static file checks.
 */
export function isBehavioralSC(sc: ParsedSC): boolean {
  return /\(behavioral\)\s*$/.test(sc.statement);
}

/**
 * Counts behavioral SCs in a list.
 */
export function countBehavioralSCs(scs: ParsedSC[]): number {
  return scs.filter(isBehavioralSC).length;
}

/**
 * Returns the routing annotation for behavioral SCs.
 * Behavioral SCs are verified via SESSION-AUDIT-SPEC's two feedback loops,
 * not via static conformity checks.
 */
export function getBehavioralRouting(sc: ParsedSC): string | null {
  if (!isBehavioralSC(sc)) return null;
  return "Verified via SESSION-AUDIT-SPEC § Two Feedback Loops (runtime behavioral check)";
}

/**
 * Returns an AssertionFn for a behavioral SC when cached results exist.
 * Returns null when no fresh cache entry exists (treated as unmatchable).
 * Stale entries (>= 7 days old) return null so they're treated as unmatchable.
 */
export function behavioralPattern(sc: ParsedSC, cachePath: string): ((root: string) => void) | null {
  const cache = readFreshCache(cachePath);
  const entry = cache[sc.id];
  if (!entry) return null;

  return (_root: string) => {
    if (!entry.passed) {
      throw new Error(`Behavioral SC ${sc.id} failed: ${entry.evidence}`);
    }
  };
}

/**
 * Pull every success criterion out of a spec, in BOTH checkbox states.
 *
 * This used to be `/^- \[ \] (SC-\w+)/` — unchecked only. Every SC marked
 * done was therefore invisible to the engine: 261 of them in this repo,
 * none asserted, and the suite reported 0 fail because it never looked.
 * Narrowing this pattern again is caught by the floor test in
 * test/phase-1-5.test.ts.
 *
 * The pattern itself moved to `lib/sc-ids.ts` (#330). It was one of four
 * copies in the tree, each with a different idea of what an id looks like:
 * this one admitted `SC-\w+`, the coverage lookup and the uniqueness guard
 * only `SC-\d+`, so an anti-criterion was a declaration to this reader and
 * invisible to the other two.
 */
export function extractSCs(content: string, specFile: string): ExtractedSC[] {
  return parseScDeclarations(content, specFile);
}

export interface SpecMetadata {
  scs: ExtractedSC[];
  compliance: "strict" | "permissive";
  status: "active" | "draft";
}

export function collectTestableSpecs(root: string, extraSpecDirs?: string[]): Map<string, SpecMetadata> {
  const specMap = new Map<string, SpecMetadata>();

  const localSpecs = join(root, "specs");
  if (existsSync(localSpecs)) {
    for (const f of collectSpecFiles(localSpecs)) {
      const content = readFileSync(join(localSpecs, f), "utf-8");
      const fm = parseFrontmatter(content);
      if (fm?.testable === "true") {
        const compliance = fm?.compliance === "permissive" ? "permissive" : "strict";
        const scs = extractSCs(content, f);
        const hasCheckedSC = /- \[x\] SC-/i.test(content);
        specMap.set(f, {
          scs,
          compliance,
          status: hasCheckedSC ? "active" : "draft",
        });
      }
    }
  }

  for (const dir of extraSpecDirs || []) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(f => f.endsWith(".md"))) {
      const content = readFileSync(join(dir, f), "utf-8");
      const fm = parseFrontmatter(content);
      if (fm?.testable !== "true") continue;
      const governs = fm?.governs || "";
      if (!governs.toLowerCase().includes("scaffold") && !governs.toLowerCase().includes("universal")) continue;
      const compliance = fm?.compliance === "permissive" ? "permissive" : "strict";
      const hasCheckedSC = /- \[x\] SC-/i.test(content);
      const specFile = `${dir.split("/").pop()}/${f}`;
      specMap.set(specFile, {
        scs: extractSCs(content, specFile),
        compliance,
        status: hasCheckedSC ? "active" : "draft",
      });
    }
  }

  return specMap;
}

// ── Pattern matchers ────────────────────────────────────────

type AssertionFn = (root: string) => void;
type MatcherHandler = (sc: ParsedSC, match: RegExpMatchArray) => AssertionFn | null;

// Config loading with caching
const _registryCache = new Map<string, Array<{ name: string; regex: string }>>();

/**
 * Project-owned conformity exemptions, read from
 * `<root>/.claude/conformity-allowlists.json`.
 *
 * A file rather than a constant because the callers that need it differ in
 * editability: test/scaffold-conformity.test.ts is harness-managed and
 * regenerated on re-scaffold, so a list written into it would be silently
 * wiped. Keying on `root` is also what keeps a consumer from inheriting
 * rungate's exemptions, which is the defect this replaced.
 *
 * Absent or unreadable means no exemptions adopted, and the checks report
 * advisory rather than failing. That is deliberate: before #80 they could not
 * fail at all, so a missing file must not break an existing consumer.
 */
function loadConformityAllowlists(root: string): {
  untestedSpecs?: string[];
  orphanFiles?: string[];
} {
  try {
    const p = join(root, ".claude", "conformity-allowlists.json");
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    return {
      untestedSpecs: Array.isArray(parsed.untestedSpecs) ? parsed.untestedSpecs : undefined,
      orphanFiles: Array.isArray(parsed.orphanFiles) ? parsed.orphanFiles : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * The exemption lists in a conformity-allowlists file, keyed by list name.
 *
 * Every array-valued key is read, not just the two `loadConformityAllowlists`
 * consumes. A list added later must be covered by the growth check the day it
 * appears, not the day someone remembers to add it here — the opposite
 * arrangement is how an exemption mechanism acquires an unwatched corner.
 */
export function allowlistEntries(json: string): Record<string, string[]> {
  const parsed = JSON.parse(json);
  const lists: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) lists[key] = value.map(String);
  }
  return lists;
}

/**
 * Entries present in `headJson` and absent from `baseJson` (#302).
 *
 * The existing ratchet enforces STALENESS — an entry that stops being a
 * violation fails the build — and that half is real. It does not enforce
 * GROWTH: a new entry for a genuinely new violation is not stale, so every
 * check passes. An agent could introduce a violation and exempt it in the
 * same commit, which is the one move this harness exists to prevent — an
 * agent must not be able to pass a gate by editing the gate.
 *
 * Direction is the whole point. REMOVALS always pass: an agent that fixes a
 * violation and delists it is the case the ratchet is for, and refusing that
 * would trade one outage for another. Only additions are reported.
 *
 * Comparing against `origin/main` rather than the merge base is deliberate
 * and safe in the direction that matters: entries added on main that a branch
 * does not carry read as REMOVALS and pass, so the base can be stale without
 * producing a false refusal.
 */
export function allowlistAdditions(baseJson: string, headJson: string): string[] {
  const base = allowlistEntries(baseJson);
  const head = allowlistEntries(headJson);
  const added: string[] = [];
  for (const [list, entries] of Object.entries(head)) {
    const before = new Set(base[list] ?? []);
    for (const entry of entries) {
      if (!before.has(entry)) added.push(`${list}: ${entry}`);
    }
  }
  return added;
}

/**
 * Report a check that did not run, rather than returning silently.
 *
 * A bare `return` on a missing directory reads as a pass in every report, which
 * is the same failure as the `expect(true).toBe(true)` bodies removed in #80 —
 * the check contributes a green tick while verifying nothing. Wording matches
 * the fallow skips so skipped checks are greppable as one class.
 */
function checkSkipped(check: string, reason: string): void {
  console.warn(`SKIP ${check}: ${reason} — this check did NOT run.`);
}

function loadBuiltInRegistry(): Array<{ name: string; regex: string }> {
  const key = "__builtin__";
  if (_registryCache.has(key)) return _registryCache.get(key)!;
  const configPath = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "matcher-registry.json");
  const entries: Array<{ name: string; regex: string }> = JSON.parse(readFileSync(configPath, "utf-8"));
  _registryCache.set(key, entries);
  return entries;
}

/**
 * Load the matcher registry, optionally merging consumer-defined custom matchers.
 *
 * When projectRoot is provided, looks for .claude/rungate.json in that directory
 * and merges any `customMatchers` array entries with the built-in registry.
 * Consumer entries with the same `name` as a built-in entry override the built-in.
 */
/**
 * `allowBuiltInOverride` is the difference between the AUTHORING view and the
 * VERIFICATION view of the same config, and the two must not be the same.
 *
 * A consumer may name a custom matcher after a built-in, and `create-spec`
 * honours it — that is a documented feature and extending the vocabulary is
 * the point of custom matchers. But the conformity engine is verifying the
 * very project that wrote that config, and `.claude/rungate.json` shadowing
 * `content-contains` with a regex that matches nothing would switch the
 * check off from inside the subject under test. The run would stay green and
 * report nothing unusual, which is the defect class this repo exists to
 * catch, arriving through its own extension point.
 *
 * So the engine takes `allowBuiltInOverride: false`: a consumer may ADD a
 * matcher, never REPLACE one. A shadowing entry is dropped and named, rather
 * than dropped quietly, because a consumer who meant it needs to know it did
 * not take effect.
 *
 * This only became reachable when the runner started passing its project root
 * (#212). Before that the engine ignored consumer config entirely, which is
 * why the asymmetry had never had to be stated.
 */
function loadRegistry(
  projectRoot?: string,
  opts?: { allowBuiltInOverride?: boolean },
): Array<{ name: string; regex: string }> {
  const allowOverride = opts?.allowBuiltInOverride ?? true;
  const cacheKey = `${projectRoot ?? "__builtin__"}::${allowOverride ? "permissive" : "strict"}`;
  if (_registryCache.has(cacheKey)) return _registryCache.get(cacheKey)!;

  const builtIn = loadBuiltInRegistry();
  if (!projectRoot) {
    return builtIn;
  }

  // Consumer custom matchers, via the loader (ADR-002 D1, #309). Reading the
  // monolith directly saw nothing on a project that had migrated to the
  // directory layout, so a consumer's custom matchers silently stopped
  // existing the moment they ran the scaffold that migrates them.
  // Named without constructing the path — the loader resolves either layout,
  // so there is no single file to point at, and spelling one out here would
  // be the very access CONFIG-1 forbids in the file that hosts CONFIG-1.
  const configDesc = `the rungate config under ${projectRoot}`;
  let customMatchers: Array<{ name: string; regex: string }>;
  try {
    const config = tryLoadRungateConfig(projectRoot);
    if (!config) {
      _registryCache.set(cacheKey, builtIn);
      return builtIn;
    }
    customMatchers = (config as { customMatchers?: Array<{ name: string; regex: string }> })
      .customMatchers ?? [];
  } catch (err) {
    // Falling back to the built-ins is right — one consumer's broken config
    // must not take the engine's own matchers down with it. Doing it in
    // silence was not: every SC written against a custom matcher then reads
    // as unrecognised, with nothing anywhere saying the config failed to
    // parse (#212).
    //
    // The error's TYPE is reported and its message is not. A parse failure's
    // message routinely quotes the bytes around the offending position, and
    // this file is a project's own config — echoing its contents into build
    // logs is how a secret in a misplaced field reaches somewhere it was
    // never meant to go.
    console.warn(
      `WARN: ${configDesc} could not be read as JSON (${err instanceof Error ? err.name : "error"}; ` +
        `message withheld — it can quote file contents). ` +
        `Falling back to the built-in matcher registry — any customMatchers in that file are NOT loaded, ` +
        `so SCs written against them will be reported as having no matcher.`,
    );
    _registryCache.set(cacheKey, builtIn);
    return builtIn;
  }

  if (customMatchers.length === 0) {
    _registryCache.set(cacheKey, builtIn);
    return builtIn;
  }

  const builtInNames = new Set(builtIn.map((e) => e.name));
  const accepted: Array<{ name: string; regex: string }> = [];
  for (const candidate of customMatchers) {
    if (!allowOverride && builtInNames.has(candidate.name)) {
      console.warn(
        `WARN: ${configDesc} defines a custom matcher named "${candidate.name}", which is a built-in. ` +
          `A project cannot replace a built-in matcher while being verified by it — the entry is IGNORED. ` +
          `Rename it to extend the vocabulary instead.`,
      );
      continue;
    }
    // Compiled here rather than at use: a regex that cannot compile would
    // otherwise throw from inside the matcher loop, taking down a run over
    // one bad consumer entry. The entry is refused; the rest still load.
    try {
      new RegExp(candidate.regex, "i");
    } catch {
      console.warn(
        `WARN: ${configDesc} custom matcher "${candidate.name}" has a regex that does not compile — the entry is IGNORED.`,
      );
      continue;
    }
    accepted.push(candidate);
  }

  // Built-ins first. In the permissive view a shadowing entry has already
  // displaced its built-in; in the strict view it was dropped above, so
  // ordering alone cannot let a consumer entry pre-empt a built-in check.
  const merged = allowOverride
    ? [...builtIn.filter((e) => !accepted.some((c) => c.name === e.name)), ...accepted]
    : [...builtIn, ...accepted];

  _registryCache.set(cacheKey, merged);
  return merged;
}

// ── Compound success criteria (#220) ────────────────────────
//
// `content-contains` captures exactly one bracket list and `matchPattern`
// returns on the first registry hit, so "FILE contains [a] and not contains
// [b]" bound, asserted [a], and discarded the rest with no signal. 21 ticked
// SCs were in that state; three of them asserted something false and passed
// anyway. The sweep is in #220.
//
// Two rules the parser follows, both of which a narrower reading gets wrong:
//
//  - An SC's requirement ends where its explanation begins. Everything from
//    the first " — " is rationale, and rationale saying "the reader and the
//    writer agree" must not become a clause.
//  - The defect is NOT about negation. Two of the 21 carry a POSITIVE second
//    clause naming a different file, and a fix written in terms of
//    "not contains" would leave those just as unasserted.

export type SCClause = { file: string; items: string[]; negated: boolean };

const CLAUSE_HEAD = /^(\S+)\s+contains?\s+\[([^\]]+)\]/;
const CLAUSE_TAIL =
  /^\s+and\s+(?:(\S*[./]\S*)\s+)?(not\s+contains?|does\s+not\s+contain|must\s+NOT\s+contain|has\s+no|contains?)\s+\[([^\]]+)\]/i;

/** Rationale is commentary, not requirement. */
const requirementOf = (statement: string) => statement.split(" — ")[0].trimEnd();

const splitItems = (raw: string) => raw.split(",").map(i => i.trim()).filter(Boolean);

const isCodeFile = (file: string) => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file);

/**
 * Parse a contains-family statement into every clause it states.
 * Returns null when the statement is not compound, so callers fall through to
 * the single-clause matcher rather than this becoming a second way to bind.
 */
export function parseCompoundClauses(statement: string): SCClause[] | null {
  const body = requirementOf(statement);
  const head = CLAUSE_HEAD.exec(body);
  if (!head) return null;

  const headFile = head[1].replace(/`/g, "");
  const clauses: SCClause[] = [{ file: headFile, items: splitItems(head[2]), negated: false }];

  let end = head[0].length;
  for (;;) {
    const tail = CLAUSE_TAIL.exec(body.slice(end));
    if (!tail) break;
    end += tail[0].length;
    const verb = tail[2].toLowerCase();
    clauses.push({
      file: (tail[1] ?? headFile).replace(/`/g, ""),
      items: splitItems(tail[3]),
      negated: /\bnot\b|has\s+no/.test(verb),
    });
  }
  return clauses.length > 1 ? clauses : null;
}

/**
 * The guard's view of its own input: text a contains-family statement states
 * but no clause consumed. A leftover bracket list is a requirement that would
 * be silently dropped, so it is named rather than discarded.
 *
 * Prose residue is deliberately NOT refused here. Around eight SCs carry real
 * requirements as prose ("and is under 3,000 tokens"); refusing those turns 39
 * SCs malformed at once, and rewriting them into testable form is #211's work.
 * Returns null for statements no contains-family matcher owns — other matchers
 * answer for their own spans, and "AGENTS.md is under [200] lines" is not a
 * discarded assertion.
 */
export function unconsumedAssertion(statement: string): string | null {
  const body = requirementOf(statement);
  const head = CLAUSE_HEAD.exec(body);
  if (!head) return null;

  let end = head[0].length;
  for (;;) {
    const tail = CLAUSE_TAIL.exec(body.slice(end));
    if (!tail) break;
    end += tail[0].length;
  }
  const residue = body.slice(end).trim();
  return /\[[^\]]+\]/.test(residue) ? residue : null;
}

// Handler registry — one function per pattern type
const matcherHandlers: Record<string, MatcherHandler> = {
  "file-exists": (sc, match) => {
    const target = match[1].replace(/`/g, "");
    if (target.startsWith("~/") || target.startsWith("/")) return null;
    const limitMatch = sc.statement.match(/≤\s*(\d+)\s*lines/);
    return (root) => {
      expect(existsSync(join(root, target))).toBe(true);
      if (limitMatch) {
        const content = readFileSync(join(root, target), "utf-8");
        const lineCount = content.trimEnd().split("\n").length;
        expect(lineCount).toBeLessThanOrEqual(parseInt(limitMatch[1]));
      }
    };
  },

  "dir-exists": (sc, match) => {
    const dir = match[1].replace(/`/g, "");
    const minMatch = sc.statement.match(/(?:with\s+)?≥\s*(\d+)\s+(\w+)/);
    const aliases: Record<string, string[]> = {
      "tests": ["tests", "test"],
      "test": ["test", "tests"],
      "reference": ["reference", "ref", "docs/archive"],
    };
    const candidates = aliases[dir] || [dir];
    return (root) => {
      const found = candidates.find(d => existsSync(join(root, d)));
      if (!found) {
        addFinding({
          ruleId: "SCAFFOLD-DIR-EXISTS",
          severity: "FAIL",
          file: dir,
          message: `Required directory "${dir}" not found`,
          fixCommand: `mkdir -p ${dir}`,
        });
      }
      expect(found).toBeDefined();
      if (minMatch && found) {
        const count = readdirSync(join(root, found)).length;
        const required = parseInt(minMatch[1]);
        if (count < required) {
          addFinding({
            ruleId: "SCAFFOLD-DIR-COUNT",
            severity: "FAIL",
            file: found,
            message: `${found}/ has ${count} files (requires ≥${required})`,
            fixCommand: `Add files to ${found}/ — needs at least ${required}`,
          });
        }
        expect(count).toBeGreaterThanOrEqual(required);
      }
    };
  },

  "all-specs-frontmatter": (sc) => {
    return (root) => {
      const specsDir = join(root, "specs");
      if (!existsSync(specsDir)) return;

      // #225 — the hand-rolled one-level descent that used to live here is
      // now the shared collector, so the seven flat callers get the same
      // behaviour instead of this one site being the only correct reader.
      const specFiles = collectSpecFiles(specsDir);

      const missing = specFiles.filter(f => {
        const fm = parseFrontmatter(readFileSync(join(specsDir, f), "utf-8"));
        // Skip redirect files (status: split)
        if (fm?.status === "split") return false;
        return !fm || !("testable" in fm);
      });
      expect(missing).toEqual([]);
    };
  },

  "paths-resolve": (sc, match) => {
    const target = match[1]?.replace(/`/g, "") || "AGENTS.md";
    return (root) => {
      const p = join(root, target);
      if (!existsSync(p)) return;
      const content = readFileSync(p, "utf-8");
      const linkPattern = /\[.*?\]\(([^)]+)\)/g;
      let m;
      const broken: string[] = [];
      while ((m = linkPattern.exec(content)) !== null) {
        if (m[1].startsWith("http") || m[1].startsWith("#")) continue;
        if (!existsSync(join(root, m[1]))) broken.push(m[1]);
      }
      expect(broken).toEqual([]);
    };
  },

  "root-clean": (sc) => {
    const contentLimit = sc.statement.match(/content:\s*≤\s*(\d+)/i);
    const codeLimit = sc.statement.match(/code:\s*≤\s*(\d+)/i);
    return (root) => {
      const items = readdirSync(root).filter(f => !f.startsWith(".") && f !== "node_modules");
      const isCode = existsSync(join(root, "src")) || existsSync(join(root, "lib")) ||
        existsSync(join(root, "gates")) || existsSync(join(root, "Makefile"));
      const limit = isCode
        ? (codeLimit ? parseInt(codeLimit[1]) : 30)
        : (contentLimit ? parseInt(contentLimit[1]) : 10);
      if (items.length > limit) {
        addFinding({
          ruleId: "SCAFFOLD-ROOT-CLEAN",
          severity: "FAIL",
          file: ".",
          message: `Root has ${items.length} items (limit: ${limit}). Move non-essential files to subdirectories.`,
          fixCommand: `Review root items and move docs to docs/, scripts to scripts/, specs to specs/`,
        });
      }
      expect(items.length).toBeLessThanOrEqual(limit);
    };
  },

  "pointer-exists": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const target = match[2].replace(/`/g, "");
    return (root) => {
      const path = resolveFilePath(root, file);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf-8")).toContain(target);
    };
  },


  "canary": () => {
    return (root) => {
      const testDir = existsSync(join(root, "test")) ? join(root, "test") : join(root, "tests");
      if (!existsSync(testDir)) return;
      const testFiles = readdirSync(testDir).filter(f => f.includes("conformity") || f.includes("canary"));
      expect(testFiles.length).toBeGreaterThanOrEqual(1);
    };
  },

  "content-contains-compound": (sc) => {
    const clauses = parseCompoundClauses(sc.statement);
    // Not actually compound — fall through so `content-contains` handles it.
    if (!clauses) return null;
    return (root) => {
      for (const clause of clauses) {
        const path = resolveFilePath(root, clause.file);
        if (!existsSync(path)) {
          expect(existsSync(path)).toBe(true);
          return;
        }
        const content = readFileSync(path, "utf-8");
        const view = clause.negated && isCodeFile(clause.file)
          ? stripJsComments(content)
          : content;
        for (const item of clause.items) {
          if (clause.negated) {
            expect(view).not.toContain(item);
          } else {
            expect(view).toContain(item);
          }
        }
      }
    };
  },

  "content-contains": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const items = match[2].split(",").map(i => i.trim());
    return (root) => {
      const path = resolveFilePath(root, file);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      for (const item of items) {
        expect(content).toContain(item);
      }
    };
  },

  "content-not-contains": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const items = match[2].split(",").map(i => i.trim());
    return (root) => {
      const path = resolveFilePath(root, file);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      for (const item of items) {
        expect(content).not.toContain(item);
      }
    };
  },

  "count-threshold": (sc, match) => {
    // #225 — the registry's regex is `^(.+?)\s+(?:is under|at most)…`, which
    // is wider than this handler was. "AGENTS.md Rules section at most [200]
    // words" matched, and the whole phrase "AGENTS.md Rules section" was then
    // treated as a path: the file did not exist, so the check failed an SC
    // that the tree satisfies (97 words against a threshold of 200). The
    // registry's own `syntax` field says `{file} is under [N] lines|words`
    // and never promised sections, so the regex admitted a form the handler
    // could not honour — the shape #212 is about, met from the handler side.
    const subject = match[1].replace(/`/g, "").trim();
    const sectionMatch = subject.match(/^(\S+)\s+(.+?)\s+section$/i);
    const file = sectionMatch ? sectionMatch[1] : subject;
    const section = sectionMatch ? sectionMatch[2] : null;
    const threshold = parseInt(match[2]);
    const unit = match[3].toLowerCase();
    // "(excluding tables/headers)" is part of the criterion, not commentary:
    // a Rules section is mostly a table, and counting the table's words
    // measures the opposite of the leanness the SC asks for.
    const excludeTables = /excluding\s+tables/i.test(sc.statement);
    return (root) => {
      const path = join(root, file);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      let content = readFileSync(path, "utf-8");
      if (section) {
        const lines = content.split("\n");
        const start = lines.findIndex(l => new RegExp(`^#+\\s+${section}\\s*$`, "i").test(l));
        // A named section that is not there is a failure of the criterion,
        // not a reason to measure the whole file and probably pass.
        expect(start, `${file} has no "${section}" section to measure`).toBeGreaterThan(-1);
        const rest = lines.slice(start + 1);
        const end = rest.findIndex(l => /^#+\s/.test(l));
        content = (end === -1 ? rest : rest.slice(0, end)).join("\n");
      }
      if (excludeTables) {
        content = content
          .split("\n")
          .filter(l => !/^\s*\|/.test(l) && !/^#+\s/.test(l))
          .join("\n");
      }
      if (unit.startsWith("line")) {
        const lineCount = content.trimEnd().split("\n").length;
        expect(lineCount).toBeLessThanOrEqual(threshold);
      } else {
        const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;
        expect(wordCount).toBeLessThanOrEqual(threshold);
      }
    };
  },

  "json-field-equals": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const field = match[2];
    const expectedValue = match[3];
    return (root) => {
      const path = join(root, file);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      const json = JSON.parse(content);
      // Support nested fields like "config.name"
      const fieldParts = field.split(".");
      let value = json;
      for (const part of fieldParts) {
        value = value?.[part];
      }
      expect(value).toBe(expectedValue);
    };
  },

  "section-exists": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const sectionName = match[2];
    return (root) => {
      const path = join(root, file);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      // Match both # and ## headings
      const hasSection = new RegExp(`^#+ ${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "mi").test(content);
      expect(hasSection).toBe(true);
    };
  },

  "regex-match": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const pattern = match[2];
    const flags = match[3] || "";
    return (root) => {
      const path = join(root, file);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      const regex = new RegExp(pattern, flags);
      expect(regex.test(content)).toBe(true);
    };
  },

  "source-contains": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    // Only match if it's a source file path (lib/, scripts/, hooks/, gates/) or has "harness" prefix
    const isSourceFile = /^(lib|scripts|hooks|gates)\//.test(file) || sc.statement.toLowerCase().includes("harness");
    if (isSourceFile) {
      const items = match[2].split(",").map(i => i.trim());
      return (root) => {
        const path = join(root, file);
        if (!existsSync(path)) {
          expect(existsSync(path)).toBe(true);
          return;
        }
        const content = readFileSync(path, "utf-8");
        for (const item of items) {
          expect(content).toContain(item);
        }
      };
    }
    return null;
  },

  "json-has-field": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const filePath = file.endsWith(".json") ? file : `${file}.json`;
    const field = match[2];
    return (root) => {
      const path = join(root, filePath);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      const json = JSON.parse(content);
      // Support nested fields like "config.name"
      const fieldParts = field.split(".");
      let value = json;
      for (const part of fieldParts) {
        value = value?.[part];
      }
      expect(value).toBeDefined();
    };
  },

  "scaffold-produces": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    return (root) => {
      // For now, this checks if the file exists in the root
      // A more complete implementation would actually run scaffold and check output
      const path = join(root, file);
      expect(existsSync(path)).toBe(true);
    };
  },

  "frontmatter-field": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const field = match[2];
    const expectedValue = match[3]?.trim();
    return (root) => {
      const path = join(root, file);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      const fm = parseFrontmatter(content);
      expect(fm).toBeDefined();
      expect(fm?.[field]).toBeDefined();
      if (expectedValue !== undefined) {
        expect(fm?.[field]).toBe(expectedValue);
      }
    };
  },

  "file-line-range": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const min = parseInt(match[2]);
    const max = parseInt(match[3]);
    return (root) => {
      const path = join(root, file);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      const lineCount = content.trimEnd().split("\n").length;
      expect(lineCount).toBeGreaterThanOrEqual(min);
      expect(lineCount).toBeLessThanOrEqual(max);
    };
  },

  "command-output": (sc, match) => {
    const command = match[1];
    const items = match[2].split(",").map(i => i.trim());
    return (root) => {
      const result = spawnSync("sh", ["-c", command], {
        cwd: root,
        timeout: 10000,
        encoding: "utf-8",
        env: { ...process.env },
      });
      const exitCode = result.status ?? 1;
      expect(exitCode).toBe(0);
      const stdout = result.stdout || "";
      for (const item of items) {
        expect(stdout.includes(item)).toBe(true);
      }
    };
  },
};

/**
 * The names the engine can actually assert. Exported so the registry can be
 * reconciled against it (#212) instead of the two drifting apart unobserved —
 * `matchPattern` iterates the REGISTRY, so a handler missing from it is
 * unreachable however well tested, and an entry missing a handler asserts
 * nothing while still matching the author's syntax.
 */
export function matcherHandlerNames(): string[] {
  return Object.keys(matcherHandlers);
}

/**
 * Why a statement did or did not become an assertion.
 *
 * `matchPattern` answered `null` for two different situations, and collapsing
 * them is the defect in #212: a statement that matched a registry regex whose
 * entry has no handler was reported exactly like a statement that matched
 * nothing at all. The first means "recognised, and nothing implements it";
 * the second means "unrecognised". SUCCESS.md claim 4 — "could not measure"
 * must never read as "nothing wrong" — needs them distinct.
 */
export type MatcherResolution =
  | { kind: "assert"; matcher: string; assertion: AssertionFn }
  | { kind: "unimplemented"; matcher: string }
  | { kind: "unrecognised" };

export function resolveMatcher(sc: ParsedSC, projectRoot?: string): MatcherResolution {
  // Strict view: the project being verified may add matchers, never replace a
  // built-in one. See loadRegistry's docblock — `isMatchablePattern` keeps the
  // permissive view because it answers an authoring question, not a
  // verification one.
  const registry = loadRegistry(projectRoot, { allowBuiltInOverride: false });
  let recognisedBy: string | null = null;

  for (const entry of registry) {
    const regex = new RegExp(entry.regex, "i");
    const match = sc.statement.match(regex);
    if (!match) continue;

    const handler = matcherHandlers[entry.name];
    if (!handler) {
      // Recognised. Remember which matcher claimed it, but keep looking — a
      // later entry may both match and be implemented, and that is a better
      // answer than refusing.
      recognisedBy ??= entry.name;
      continue;
    }
    const result = handler(sc, match);
    if (result) return { kind: "assert", matcher: entry.name, assertion: result };
  }

  return recognisedBy ? { kind: "unimplemented", matcher: recognisedBy } : { kind: "unrecognised" };
}

export function matchPattern(sc: ParsedSC, projectRoot?: string): AssertionFn | null {
  const outcome = resolveMatcher(sc, projectRoot);
  return outcome.kind === "assert" ? outcome.assertion : null;
}

/**
 * Check if an SC statement matches any pattern in the registry (built-in + consumer).
 * Unlike matchPattern, this only checks regex matches — it does not require a handler.
 * Used by create-spec for SC validation: a consumer custom pattern without a handler
 * is still a valid SC pattern for specification purposes.
 */
export function isMatchablePattern(sc: ParsedSC, projectRoot?: string): boolean {
  const registry = loadRegistry(projectRoot);
  for (const entry of registry) {
    const regex = new RegExp(entry.regex, "i");
    if (regex.test(sc.statement)) {
      return true;
    }
  }
  return false;
}

// ── SC → test binding ───────────────────────────────────────

/**
 * How a single SC becomes (or fails to become) a test.
 *
 * Kept as data, separate from `describe`/`test`, so the binding rules can be
 * asserted directly — see test/conformity-sc-binding.test.ts. The important
 * property is that an `assert` entry hands back the RAW assertion: nothing
 * here catches, so a failing checked SC fails the suite.
 */
export type SCPlanEntry =
  | { kind: "behavioral"; sc: ParsedSC; routing: string | null }
  | { kind: "todo"; sc: ParsedSC }
  | { kind: "unmatched"; sc: ParsedSC }
  | { kind: "unimplemented"; sc: ParsedSC; matcher: string }
  | { kind: "assert"; sc: ParsedSC; assertion: AssertionFn };

/**
 * Decide what each SC becomes:
 *   behavioral  — runtime-only, routed to SESSION-AUDIT-SPEC
 *   todo        — unchecked, i.e. work not started; never a silent assertion
 *   assert      — checked and matchable; runs for real and may fail
 *   unmatched   — checked but the statement binds to no matcher: a coverage
 *                 gap, reported and ratcheted rather than silently dropped
 *   unimplemented — checked, and the statement DID match a registry entry
 *                 that has no handler. Reported apart from `unmatched`
 *                 because "recognised and nothing implements it" is a
 *                 different defect from "unrecognised", and the author of
 *                 such an SC was told by create-spec that it was valid (#212)
 */
export function planSCTests(scs: ParsedSC[], projectRoot?: string): SCPlanEntry[] {
  return scs.map((sc): SCPlanEntry => {
    if (isBehavioralSC(sc)) return { kind: "behavioral", sc, routing: getBehavioralRouting(sc) };
    if (!sc.checked) return { kind: "todo", sc };
    const outcome = resolveMatcher(sc, projectRoot);
    if (outcome.kind === "assert") return { kind: "assert", sc, assertion: outcome.assertion };
    if (outcome.kind === "unimplemented") return { kind: "unimplemented", sc, matcher: outcome.matcher };
    return { kind: "unmatched", sc };
  });
}

// ── Exported test runners ───────────────────────────────────

export function runScaffoldConformity(root: string, opts?: { extraSpecDirs?: string[] }) {
  const specMap = collectTestableSpecs(root, opts?.extraSpecDirs ?? []);
  const specsDir = join(root, "specs");

  function resolveSpecPath(specFile: string): string {
    if (specFile.includes("/")) {
      const parts = specFile.split("/");
      for (const dir of opts?.extraSpecDirs ?? []) {
        if (dir.endsWith(parts[0])) return join(dir, parts.slice(1).join("/"));
      }
    }
    return join(specsDir, specFile);
  }

  describe("Spec-Driven Conformity Tests", () => {
    if (specMap.size === 0) {
      test.skip("at least one testable spec with SCs exists (no specs found — consumer project)", () => {});
      return;
    }

    // No afterAll checkbox flip here, deliberately (#86).
    //
    // This describe builds its test list at collection time by reading SC
    // checkboxes off disk. Writing those same files back at the end of the run
    // meant run N mutated the input run N+1 collected from, so the generated
    // test list alternated between two shapes — 57 tests, then 99, then 57.
    // Both parities reported 0 fail, so nothing ever surfaced it: the suite was
    // not hiding a failure, it was hiding whether 42 checks ran at all.
    //
    // Checkbox syncing still happens, deliberately and separately, via the
    // `posttest` hook in package.json -> scripts/sync-sc-status.ts. That script
    // re-derives pass state from the specs itself rather than riding on a test
    // run's in-memory bookkeeping, so it is not load-bearing for this suite and
    // nothing is lost by removing the hook.

    for (const [specFile, metadata] of specMap) {
      describe(specFile, () => {
        const unmatched: string[] = [];
        const unimplemented: string[] = [];
        const behavioral: string[] = [];
        const specPath = resolveSpecPath(specFile);
        // `root`, not nothing: without it `loadRegistry` never reads the
        // consumer's `.claude/rungate.json`, so every custom matcher is
        // invisible to the engine while `create-spec` — which DOES pass a
        // project root to `isMatchablePattern` — accepts criteria written
        // against them. That is the authoring-tool/engine divergence in #212,
        // and it was not hypothetical: the planted-project test in
        // test/matcher-registry-parity.test.ts reported its criterion as
        // `unmatched` until this argument was supplied.
        for (const entry of planSCTests(metadata.scs, root)) {
          const { sc } = entry;
          if (entry.kind === "behavioral") {
            behavioral.push(`${sc.id}: ${sc.statement} → ${entry.routing}`);
          } else if (entry.kind === "todo") {
            // bun-types declares test.todo as requiring a body even though the
            // runtime accepts a bare label. A no-op body satisfies both: todo
            // tests are not executed unless `bun test --todo` is passed.
            test.todo(`${sc.id}: ${sc.statement}`, () => {});
          } else if (entry.kind === "unmatched") {
            unmatched.push(`${sc.id}: ${sc.statement}`);
          } else if (entry.kind === "unimplemented") {
            // Not folded into `unmatched`: this SC's syntax WAS recognised,
            // and create-spec would have told its author it was valid. The
            // gap is a registry entry with no handler, which is a different
            // thing to fix and a different thing to report (#212).
            unimplemented.push(`${sc.id}: matched "${entry.matcher}", which has no handler — ${sc.statement}`);
          } else {
            // A CHECKED SC claims the work is done. Run its assertion for
            // real: no try/catch, so it fails the suite when the claim is
            // false. The old body swallowed the throw, which is why 13 false
            // claims sat green for months (#209).
            test(`${sc.id}: ${sc.statement}`, () => {
              entry.assertion(root);
              recordPassingSC(sc.id, specPath);
            });
          }
        }
        if (behavioral.length > 0) {
          addBehavioralCount(behavioral.length);
          // This is a REPORT, not a test, and that is the fix (#328).
          //
          // It used to be a `test()` whose body was `expect(true).toBe(true)`
          // — shape three in .claude/rules/checks-must-be-able-to-fail.md,
          // written out literally rather than arrived at by accident, and the
          // only executable check on 40 ticked criteria.
          //
          // The first attempt at a repair kept the `test()` and asserted that
          // every listed SC carries the `(behavioral)` marker. The mutation
          // harness measured that at ZERO red, and it was right to: this list
          // is only ever appended to when `entry.kind === "behavioral"`, which
          // happens only when `isBehavioralSC(sc)` is already true. The
          // assertion was a tautology — a second unfalsifiable check wearing
          // the first one's clothes.
          //
          // There is nothing locally falsifiable to put here. Whether a
          // behavioral criterion is SATISFIED is a runtime question this file
          // cannot answer, and whether it is CLASSIFIED correctly is true by
          // construction. So the slot stops pretending: the listing stays,
          // because findability is genuinely useful, and the teeth live in
          // test/behavioral-sc-ratchet.test.ts, which bounds the population
          // and which the same harness measures at 1 red when slackened.
          //
          // A report that admits it is a report is strictly better than a test
          // that cannot fail, because only one of them is counted as evidence.
          console.log(
            `Behavioral SCs in ${specFile} — NOT VERIFIED HERE, bounded by ` +
              `BEHAVIORAL_TICKED_RATCHET (#328):\n  ${behavioral.join("\n  ")}`,
          );
        }
        if (unmatched.length > 0) {
          // SC-287 used to FAIL here in strict mode. That branch had never
          // fired: the only SCs that reached it were unchecked ones, and
          // unchecked SCs now become `todo` before the matcher runs. The
          // population is now CHECKED SCs written in prose no matcher binds
          // to — 54 of them on the day they first became visible (#209).
          //
          // Failing 54 specs at once would get the whole file skipped, so the
          // teeth live in a single repo-wide ratchet instead:
          // test/conformity-sc-binding.test.ts asserts the total may fall but
          // never rise. Here we name them, per spec, so they are findable.
          const level = metadata.compliance === "permissive" ? "WARN" : "WARN (strict)";
          test(`${level}: ${unmatched.length} checked SCs have no pattern matcher`, () => {
            console.warn(`Unmatched checked SCs in ${specFile}:\n  ${unmatched.join("\n  ")}`);
            expect(unmatched.length).toBeGreaterThan(0);
          });
        }
        // Deliberately BELOW the unmatched branch, not between it and the
        // behavioral report. #328's guard slices the source from the
        // behavioral branch to `if (unmatched.length > 0) {` and asserts that
        // region contains no `test(` — the behavioral slot must stay a report.
        // This block legitimately IS a test, so placing it in that window
        // turns #328's guard red. The guard is right; this belongs here.
        if (unimplemented.length > 0) {
          // Unlike the unmatched aggregate above, this one FAILS, and it can
          // afford to: the population is zero in this repo and the parity
          // test in test/matcher-registry-parity.test.ts keeps it there, so
          // it cannot turn specs red en masse. A registry entry with no
          // handler is a harness defect, not a backlog of prose criteria
          // waiting to be rewritten — the author was told by create-spec that
          // their syntax was valid, and the engine then asserted nothing.
          test(`FAIL: ${unimplemented.length} SCs matched a registry entry that has no handler`, () => {
            expect(unimplemented).toEqual([]);
          });
        }
      });
    }
  });

  describe("Scaffold: structural checks", () => {
    test("AGENTS.md has required standard sections", () => {
      if (!existsSync(join(root, "AGENTS.md"))) {
        addFinding({ ruleId: "SCAFFOLD-AGENTS-MISSING", severity: "FAIL", file: "AGENTS.md", message: "AGENTS.md not found", fixCommand: "Run scaffold to generate AGENTS.md" });
        expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
        return;
      }
      const content = readFileSync(join(root, "AGENTS.md"), "utf-8");
      const required = ["Project Identity", "Rules", "Commands", "Workflow"];
      const missing = required.filter(s => !content.toLowerCase().includes(s.toLowerCase()));
      if (missing.length > 0) {
        addFinding({ ruleId: "SCAFFOLD-AGENTS-SECTIONS", severity: "FAIL", file: "AGENTS.md", message: `Missing sections: ${missing.join(", ")}`, fixCommand: "Re-run scaffold to regenerate AGENTS.md" });
      }
      expect(missing).toEqual([]);
    });

    test("rungate config has required fields (if configured)", () => {
      // Through the loader (ADR-002 D1, #309). Reading the monolith directly
      // meant a project on the directory layout skipped this check entirely —
      // `existsSync` was false, the test returned, and a config missing
      // `project` or `repo` passed by never being looked at. Exactly the
      // shape .claude/rules/checks-must-be-able-to-fail.md opens with, in the
      // check that validates config.
      const config = tryLoadRungateConfig(root);
      if (!config) return;
      expect(config.project).toBeDefined();
      expect(config.repo).toBeDefined();
    });

    test("AGENTS.md/CLAUDE.md no duplication (if both exist)", () => {
      if (!existsSync(join(root, "AGENTS.md")) || !existsSync(join(root, "CLAUDE.md"))) return;
      const agents = readFileSync(join(root, "AGENTS.md"), "utf-8");
      const claude = readFileSync(join(root, "CLAUDE.md"), "utf-8");
      const sentences = agents.split(/[.!?\n]/).map(s => s.trim()).filter(s => s.length > 30);
      expect(sentences.filter(s => claude.includes(s))).toEqual([]);
    });
  });
}

export function runSpecDiscovery(root: string) {
  const specsDir = join(root, "specs");

  describe("Spec Discovery: frontmatter enforcement", () => {
    test("specs/ directory exists", () => {
      expect(existsSync(specsDir)).toBe(true);
    });

    test("every .md in specs/ has testable field", () => {
      if (!existsSync(specsDir)) return;
      const missing = collectSpecFiles(specsDir).filter(f => {
        const fm = parseFrontmatter(readFileSync(join(specsDir, f), "utf-8"));
        return !fm || !("testable" in fm);
      });
      for (const f of missing) {
        addFinding({ ruleId: "SPEC-FRONTMATTER", severity: "FAIL", file: `specs/${f}`, message: `Spec "${f}" missing testable field in frontmatter`, fixCommand: `Add "testable: true" or "testable: false" to frontmatter of specs/${f}` });
      }
      expect(missing).toEqual([]);
    });

    test("at least one testable spec exists", () => {
      if (!existsSync(specsDir)) return;
      const testable = collectSpecFiles(specsDir).filter(f => {
        const fm = parseFrontmatter(readFileSync(join(specsDir, f), "utf-8"));
        return fm?.testable === "true";
      });
      if (testable.length === 0) {
        addFinding({
          ruleId: "SPEC-DISCOVERY-TESTABLE",
          severity: "WARN",
          file: "specs/",
          message: "No spec has testable: true. Add testable: true to a spec when ready for conformity testing.",
          fixCommand: `Add "testable: true" to frontmatter of a spec in specs/`,
        });
        console.warn("SPEC-DISCOVERY: No testable specs found — skipping (add testable: true when ready)");
      } else {
        expect(testable.length).toBeGreaterThan(0);
      }
    });
  });
}

/**
 * @param options.untestedAllowlist Specs permitted to have no referencing test,
 *   owned by the CALLING project. Omitted means the caller has not adopted the
 *   ratchet, and DRIFT-2 reports advisory instead of failing — see the comment
 *   on DRIFT-2 for why a consumer must not inherit rungate's backlog.
 *
 * The allowlist is deliberately in `options`, not position 2: the consumer test
 * that lib/scaffold/steps.ts generates calls `runSpecDrift(ROOT, findings)`, so
 * a positional second parameter would receive a findings array and exempt
 * nothing, failing every consumer build.
 */
export function runSpecDrift(
  root: string,
  _findings?: unknown[],
  options?: { untestedAllowlist?: string[] },
) {
  const untestedAllowlist =
    options?.untestedAllowlist ?? loadConformityAllowlists(root).untestedSpecs;
  const specsDir = join(root, "specs");
  const testDirs = [join(root, "test"), join(root, "tests")].filter(d => existsSync(d));

  interface SpecRef { specFile: string; section: string; testFile: string; line: number; }

  function extractRefs(testFile: string, dir: string): SpecRef[] {
    const content = readFileSync(join(dir, testFile), "utf-8");
    const refs: SpecRef[] = [];
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const structured = lines[i].match(/\/\/\s*SPEC-REF:\s*(\S+\.md)\s*§\s*(.+)/);
      if (structured && !structured[1].match(/^(filename|FILENAME|example)\./i)) {
        refs.push({ specFile: structured[1], section: structured[2].trim(), testFile, line: i + 1 });
      }
    }
    return refs;
  }

  describe("Spec-Test Drift Detector", () => {
    test("DRIFT-1: Every SPEC-REF points to an existing spec file", () => {
      const allRefs: SpecRef[] = [];
      for (const dir of testDirs) {
        for (const tf of readdirSync(dir).filter(f => f.endsWith(".test.ts"))) {
          allRefs.push(...extractRefs(tf, dir));
        }
      }
      const broken = allRefs.filter(r => !existsSync(join(specsDir, r.specFile)))
        .map(r => `${r.testFile}:${r.line} → ${r.specFile}`);
      expect(broken).toEqual([]);
    });

    test("DRIFT-2: Every testable spec is referenced by at least one test", () => {
      if (!existsSync(specsDir)) return checkSkipped("DRIFT-2", "no specs/ directory");
      const testable = collectSpecFiles(specsDir).filter(f => {
        const fm = parseFrontmatter(readFileSync(join(specsDir, f), "utf-8"));
        return fm?.testable === "true";
      });

      let allContent = "";
      for (const dir of testDirs) {
        for (const tf of readdirSync(dir).filter(f => f.endsWith(".test.ts"))) {
          allContent += readFileSync(join(dir, tf), "utf-8");
        }
      }

      const orphaned = testable.filter(s => !allContent.includes(s));

      // Was `expect(true).toBe(true)` after a console.warn, so the mechanical
      // enforcement of CLAUDE.md's "SCs without tests are wishes" could never
      // fail (#80). Turning it on revealed 10 testable specs in rungate with no
      // test referencing them at all — over half the testable surface.
      //
      // That backlog cannot be asserted to zero without writing ten tests, so
      // adopters pass a RATCHET list: anything on it may stay untested, an
      // addition fails the build, and a listed spec that GAINS a test must be
      // delisted or the build fails — otherwise the allowlist rots into another
      // artifact that certifies nothing.
      //
      // The list belongs to the CALLING PROJECT, never to this file. An earlier
      // version hardcoded rungate's ten spec filenames here, and
      // lib/scaffold/steps.ts generates a consumer conformity test that calls
      // this function — so every consumer inherited rungate's backlog. A
      // consumer with an untested spec of a matching name was silently
      // exempted, and a consumer that HAD such a spec with a test failed its
      // own build demanding it delist an entry from a file inside rungate that
      // it cannot edit.
      if (!untestedAllowlist) {
        // No ratchet adopted. Report, but do not fail: before #80 this check
        // could not fail at all, so failing here would break every existing
        // consumer on upgrade for a backlog they never opted into.
        if (orphaned.length > 0) {
          console.warn(
            `WARN DRIFT-2: ${orphaned.length} testable spec(s) have no referencing test — ` +
              `${orphaned.join(", ")}. This check is ADVISORY because no untestedAllowlist ` +
              `was supplied. Pass one to runSpecDrift to enforce it as a ratchet.`,
          );
        }
        return;
      }

      const newlyOrphaned = orphaned.filter(s => !untestedAllowlist.includes(s));
      expect(newlyOrphaned).toEqual([]);

      const staleAllowlist = untestedAllowlist.filter(
        s => testable.includes(s) && !orphaned.includes(s),
      );
      expect(staleAllowlist).toEqual([]);
    });

    test("DRIFT-3: the exemption lists did not GROW", () => {
      // #302. The staleness checks above enforce one direction: an entry that
      // stops being a violation fails. A NEW entry for a genuinely new
      // violation is not stale, so until now an agent could introduce a
      // conformity violation and exempt it in the same commit — passing a
      // gate by editing the gate, which is the one move this harness exists
      // to refuse.
      //
      // It sits here rather than in the collection guard deliberately. The
      // collection guard sees paths, not contents, and would catch only
      // growth arriving via agent collection — not a human commit, a heal
      // round, or a single-worktree run that bypasses collection entirely.
      const allowlistPath = join(root, ".claude", "conformity-allowlists.json");
      if (!existsSync(allowlistPath)) return;

      const show = spawnSync("git", ["-C", root, "show", `origin/main:.claude/conformity-allowlists.json`], {
        encoding: "utf-8",
        timeout: 20_000,
      });

      if (show.error || show.status !== 0) {
        // ADVISORY, not a refusal, and only here. A consumer may legitimately
        // have no `origin/main` — a fresh scaffold, a local-only repo — and
        // refusing for want of a comparison base would break every one of
        // them on upgrade for a rule they never opted into. That is the same
        // judgement loadConformityAllowlists already makes about a missing
        // allowlist file. rungate's own suite asserts the base IS readable,
        // because in this repo an unreadable one is a fault, not a setup.
        console.warn(
          `WARN DRIFT-3: could not read origin/main's copy of the conformity allowlist, so ` +
            `growth was NOT checked. This is UNMEASURED, not clean.`,
        );
        return;
      }

      const added = allowlistAdditions(show.stdout, readFileSync(allowlistPath, "utf-8"));
      expect(
        added,
        `an exemption was ADDED relative to origin/main. Fix the violation, or make the ` +
          `exemption a deliberate recorded decision rather than a diff.`,
      ).toEqual([]);
    });
  });
}

/**
 * @param options.orphanAllowlist Files permitted to have zero references, owned
 *   by the CALLING project. Same contract and same positional constraint as
 *   runSpecDrift's untestedAllowlist — the generated consumer test calls
 *   `runDocHygiene(ROOT, findings)`.
 */
/**
 * Every path's most recent commit date, from ONE git subprocess (#323).
 *
 * Exported so the regression test can run it against the repository and
 * compare it to the per-file calls it replaced — a single site to mutate, and
 * the only way to prove the parser still agrees with git rather than merely
 * being faster. A detector that got quicker by finding less would pass every
 * timing test and none of the ones that matter.
 *
 * Walks newest-first, so the first time a path appears is its latest commit
 * and later entries are ignored. Paths deleted or renamed earlier in history
 * also appear; they are never looked up, which is cheaper than filtering them.
 *
 * `pathspecs` must be the SET OF PATHS THE CALLER WILL LOOK UP, not the
 * directories they mostly live in. The first version of this took the six doc
 * directories, which is where the staleness scan finds most of its files — but
 * the scan also walks root-level markdown, and `git log -- specs docs` cannot
 * report a commit for `AGENTS.md`. Six files silently dropped out of the
 * lookup and `if (!dateStr) continue` read that as "newly added, so not
 * stale". A detector narrower than what it detects, shipped inside the fix for
 * a different instance of the same thing. Passing the lookup set makes the
 * pathspec and the keys the same list by construction, so they cannot drift.
 *
 * Fails CLOSED. `spawnSync` does not throw when git exits non-zero, so a
 * broken invocation would otherwise return an empty map and every file would
 * read as newly added — total blindness that looks exactly like a clean run.
 */
export function lastCommitDates(root: string, pathspecs: string[]): Map<string, string> {
  const lastCommit = new Map<string, string>();
  // Not a git repository: nothing is tracked, so no path has a commit date.
  // That is a real answer, not a failure, and scaffolded projects hit it.
  if (!existsSync(join(root, ".git"))) return lastCommit;
  if (pathspecs.length === 0) return lastCommit;
  {
    const log = spawnSync(
      "git",
      ["-C", root, "log", "--format=%H %ci", "--name-only", "--", ...pathspecs],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    if (log.error) {
      throw new Error(`lastCommitDates: git log could not run in ${root}: ${log.error.message}`);
    }
    if (log.status !== 0) {
      throw new Error(
        `lastCommitDates: git log exited ${log.status} in ${root}: ` +
          `${log.stderr?.toString().trim() || "(no stderr)"}`,
      );
    }
    let currentDate = "";
    for (const line of log.stdout.toString().split("\n")) {
      const header = /^[0-9a-f]{7,40} (\d{4}-\d{2}-\d{2})/.exec(line);
      if (header) {
        currentDate = header[1];
        continue;
      }
      const path = line.trim();
      if (!path || !currentDate) continue;
      if (!lastCommit.has(path)) lastCommit.set(path, currentDate);
    }
  }
  return lastCommit;
}

export function runDocHygiene(
  root: string,
  _findings?: unknown[],
  options?: { orphanAllowlist?: string[] },
) {
  const orphanAllowlist =
    options?.orphanAllowlist ?? loadConformityAllowlists(root).orphanFiles;
  const specsDir = join(root, "specs");
  const refDir = join(root, "reference");
  // .claude/agents/ excluded — Claude Code reads those by name convention, not import
  const scanPaths = ["specs", "scripts", "prompts"];
  const scanDirs = scanPaths.map(d => join(root, d)).filter(d => existsSync(d));
  const testDirs = [join(root, "test"), join(root, "tests")].filter(d => existsSync(d));

  // Build reference index once — scan code/config/docs directories only (skip data/cache)
  function buildReferenceIndex(): string {
    const exts = [".ts", ".js", ".md", ".json"];
    const skipDirs = new Set(["node_modules", "reference", ".git", "dist", "build", ".next",
      "cache", "logs", "reports", "ctrf", "eval", "MEMORY"]);
    const skipPrefixes = ["data-", "data/"];

    const searchDirs: string[] = [root];
    for (const entry of readdirSync(root)) {
      if (entry.startsWith(".") || skipDirs.has(entry) || skipPrefixes.some(p => entry.startsWith(p))) continue;
      const full = join(root, entry);
      try { if (require("fs").statSync(full).isDirectory()) searchDirs.push(full); } catch {}
    }
    const dotClaude = join(root, ".claude");
    if (existsSync(dotClaude)) searchDirs.push(dotClaude);

    const chunks: string[] = [];
    for (const dir of searchDirs) {
      try {
        const files = dir === root
          ? readdirSync(dir).filter(f => exts.some(e => f.endsWith(e)))
          : readdirSync(dir, { recursive: true }).map(f => String(f)).filter(f => exts.some(e => f.endsWith(e)));
        for (const f of files) {
          const rel = String(f);

          // skipDirs above only filters TOP-LEVEL entries of root, so the
          // recursive walk still descended into .claude/worktrees/ — which
          // holds full copies of the repo, 39 of them on the machine where
          // this was found. Every file in every worktree counted as a
          // reference, so nothing was ever an orphan locally while a clean CI
          // checkout saw three. That divergence is what made HYGIENE-3 look
          // intermittent and got a real failure dismissed as flake.
          if (rel.includes("worktrees/") || skipDirs.has(rel.split("/")[0])) continue;

          // The allowlist names the very files it exempts, so counting it as a
          // reference makes every listed orphan stop being an orphan — the
          // ratchet then fails demanding they be delisted, and delisting makes
          // them orphans again. A list that invalidates itself by existing.
          if (rel.endsWith("conformity-allowlists.json")) continue;

          try { chunks.push(readFileSync(join(dir, rel), "utf-8")); } catch {}
        }
      } catch {}
    }
    return chunks.join("\n");
  }

  let _refIndex: string | null = null;
  function getRefIndex(): string {
    if (_refIndex === null) _refIndex = buildReferenceIndex();
    return _refIndex;
  }

  describe("Doc Hygiene", () => {
    test("HYGIENE-1: All specs have non-empty governs field", () => {
      if (!existsSync(specsDir)) return checkSkipped("HYGIENE-1", "no specs/ directory");
      const missing: string[] = [];
      for (const f of collectSpecFiles(specsDir)) { // #225 — subdirectories too
        const content = readFileSync(join(specsDir, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (!fm) continue;
        const governs = fm.governs || "";
        if (!governs || governs.includes("TODO")) missing.push(f);
      }
      // Was unconditionally passing after a console.warn (#80).
      expect(missing).toEqual([]);
    });

    test("HYGIENE-2: All specs have updated field in frontmatter", () => {
      if (!existsSync(specsDir)) return;
      const missing: string[] = [];

      // #225 — the hand-rolled one-level descent that used to live here is
      // now the shared collector, so the seven flat callers get the same
      // behaviour instead of this one site being the only correct reader.
      const specFiles = collectSpecFiles(specsDir);

      for (const f of specFiles) {
        const content = readFileSync(join(specsDir, f), "utf-8");
        const fm = parseFrontmatter(content);
        // Skip redirect files (status: split)
        if (fm?.status === "split") continue;
        if (!fm || !fm.updated) missing.push(f);
      }
      expect(missing).toEqual([]);
    });

    test("HYGIENE-3: No orphaned files (zero references outside reference/)", () => {
      const index = getRefIndex();
      const orphans: string[] = [];
      for (const dir of scanDirs) {
        const relPath = dir.startsWith(root) ? dir.slice(root.length + 1) : dir.split("/").pop()!;
        for (const f of readdirSync(dir).filter(f => !f.startsWith("."))) {
          if (!index.includes(f)) orphans.push(`${relPath}/${f}`);
        }
      }
      // Was unconditionally passing after a console.warn (#80). Two orphans it
      // had been quietly reporting — specs/bootstrap-data-flow.png and
      // scripts/self-containment-check.sh — were archived to reference/, the
      // remedy this check recommends in its own message.
      //
      // Converting it to a bare `expect(orphans).toEqual([])` then turned Gates
      // red on main, because sizing from the warn output was taken as the
      // post-merge state without re-running the check against a clean tree. The
      // warn output listed two; a clean checkout has three more that local runs
      // did not surface. Same instrument as DRIFT-2 applies here and was not
      // used: list what cannot be fixed now, fail on an addition, fail if a
      // listed file gains a reference and is not delisted.
      //
      // Caller-owned for the same reason as DRIFT-2 — consumers must not
      // inherit rungate's exemptions.
      if (!orphanAllowlist) {
        if (orphans.length > 0) {
          console.warn(
            `WARN HYGIENE-3: ${orphans.length} file(s) with zero references — ` +
              `${orphans.join(", ")}. ADVISORY because no orphanAllowlist was supplied. ` +
              `Pass one to runDocHygiene to enforce it as a ratchet.`,
          );
        }
        return;
      }

      const newOrphans = orphans.filter(o => !orphanAllowlist.includes(o));
      expect(newOrphans).toEqual([]);

      const staleAllowlist = orphanAllowlist.filter(o => !orphans.includes(o));
      expect(staleAllowlist).toEqual([]);
    });

    test("HYGIENE-4: Every spec appears in the specs routing table", () => {
      // The table lives in .claude/rules/specs-routing.md, NOT AGENTS.md. This
      // check read AGENTS.md, which contains no spec references at all, so it
      // "found" 22 violations — every spec in the repo — and reported none of
      // them because it ended in expect(true).toBe(true) (#80). The premise was
      // stale, which is how a check this wrong stayed invisible.
      const routingPath = join(root, ".claude", "rules", "specs-routing.md");
      if (!existsSync(specsDir)) return checkSkipped("HYGIENE-4", "no specs/ directory");
      if (!existsSync(routingPath)) return checkSkipped("HYGIENE-4", "no .claude/rules/specs-routing.md");
      const routing = readFileSync(routingPath, "utf-8");
      const specFiles = readdirSync(specsDir)
        .filter(f => f.endsWith(".md"))
        // SPEC-TEMPLATE.md documents how to write a spec; it governs nothing.
        .filter(f => f !== "SPEC-TEMPLATE.md");
      const unlisted = specFiles.filter(f => !routing.includes(f));
      expect(unlisted).toEqual([]);
    });

    test("HYGIENE-5: reference/ contents not in active routing", () => {
      if (!existsSync(refDir)) return checkSkipped("HYGIENE-5", "no reference/ directory");
      if (!existsSync(join(root, "AGENTS.md"))) return checkSkipped("HYGIENE-5", "no AGENTS.md");
      const agentsContent = readFileSync(join(root, "AGENTS.md"), "utf-8");
      const leaked: string[] = [];
      for (const sub of readdirSync(refDir)) {
        const subPath = join(refDir, sub);
        try {
          if (require("fs").statSync(subPath).isDirectory()) {
            for (const f of readdirSync(subPath)) {
              if (agentsContent.includes(f) && !agentsContent.includes("reference/")) leaked.push(`reference/${sub}/${f}`);
            }
          } else {
            if (agentsContent.includes(sub) && !agentsContent.includes("reference/")) leaked.push(`reference/${sub}`);
          }
        } catch {}
      }
      // Was unconditionally passing after a console.warn (#80).
      expect(leaked).toEqual([]);
    });

    test("HYGIENE-10: All ADRs have doc-type: adr in frontmatter", () => {
      const adrDir = join(root, "docs", "adr");
      if (!existsSync(adrDir)) return;
      const missing: string[] = [];
      for (const f of readdirSync(adrDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(adrDir, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (!fm || fm["doc-type"] !== "adr") {
          missing.push(f);
          addFinding({
            ruleId: "HYGIENE-10",
            severity: "WARN",
            file: `docs/adr/${f}`,
            message: `ADR "${f}" missing doc-type: adr in frontmatter`,
            fixCommand: `Add "doc-type: adr" to frontmatter of docs/adr/${f}`,
          });
        }
      }
      if (missing.length > 0) {
        console.warn(`HYGIENE-10 WARN: ADRs missing doc-type: ${missing.join(", ")}. Fix: add "doc-type: adr" to frontmatter.`);
      }
    });

    test("HYGIENE-7: No spec files at root (must be in specs/)", () => {
      const allowlist = new Set([
        "AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", "CODE-MAP.md",
        "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE.md",
        "ARCHITECTURE.md", "PRINCIPLES.md", "MODEL.md", "PROJECT-STATE.md",
      ]);
      const misplaced: string[] = [];
      for (const f of readdirSync(root).filter(f => f.endsWith(".md"))) {
        if (allowlist.has(f)) continue;
        const content = readFileSync(join(root, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (fm?.["doc-type"] === "spec") {
          misplaced.push(f);
          addFinding({
            ruleId: "HYGIENE-7",
            severity: "FAIL",
            file: f,
            message: `Spec "${f}" is at root — must be in specs/`,
            fixCommand: `mv ${f} specs/${f}`,
          });
        }
      }
      if (misplaced.length > 0) {
        console.error(`HYGIENE-7 FAIL: Specs at root: ${misplaced.join(", ")}. Move to specs/.`);
      }
      expect(misplaced).toEqual([]);
    });

    test("HYGIENE-8: No ADR files outside docs/adr/", () => {
      const misplaced: string[] = [];
      const checkDirs = [root, join(root, "docs"), join(root, "specs")];
      for (const dir of checkDirs) {
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir).filter(f => f.endsWith(".md"))) {
          const content = readFileSync(join(dir, f), "utf-8");
          const fm = parseFrontmatter(content);
          if (fm?.["doc-type"] === "adr") {
            const relPath = dir === root ? f : `${dir.replace(root + "/", "")}/${f}`;
            misplaced.push(relPath);
            addFinding({
              ruleId: "HYGIENE-8",
              severity: "FAIL",
              file: relPath,
              message: `ADR "${relPath}" is outside docs/adr/ — must be in docs/adr/`,
              fixCommand: `mv ${relPath} docs/adr/${f}`,
            });
          }
        }
      }
      if (misplaced.length > 0) {
        console.error(`HYGIENE-8 FAIL: ADRs outside docs/adr/: ${misplaced.join(", ")}. Move to docs/adr/.`);
      }
      expect(misplaced).toEqual([]);
    });

    test("HYGIENE-9: No doc files at root (except allowlisted)", () => {
      const allowlist = new Set([
        "AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", "CODE-MAP.md",
        "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE.md",
        "ARCHITECTURE.md", "PRINCIPLES.md", "MODEL.md", "PROJECT-STATE.md",
      ]);
      const misplaced: string[] = [];
      for (const f of readdirSync(root).filter(f => f.endsWith(".md"))) {
        if (allowlist.has(f)) continue;
        const content = readFileSync(join(root, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (fm?.["doc-type"] === "guide" || fm?.["doc-type"] === "doc") {
          misplaced.push(f);
          addFinding({
            ruleId: "HYGIENE-9",
            severity: "FAIL",
            file: f,
            message: `Doc "${f}" is at root — must be in docs/`,
            fixCommand: `mv ${f} docs/${f}`,
          });
        }
      }
      if (misplaced.length > 0) {
        console.error(`HYGIENE-9 FAIL: Docs at root: ${misplaced.join(", ")}. Move to docs/.`);
      }
      expect(misplaced).toEqual([]);
    });

    // WARN, not a gate, and the name now says so. This reports a review
    // BACKLOG — 119 pending candidates on rungate as of #80 — so asserting it
    // to zero would block every push until someone triages all of them. It
    // previously claimed "No unreviewed constraint candidates" while ending in
    // expect(true).toBe(true), which is the dishonest combination: a gate-
    // sounding name over an unconditional pass. Advisory is the honest shape
    // here; the lie was the name, not the leniency.
    test("WARN HYGIENE-6: Unreviewed constraint candidates in changed docs", async () => {
      const { extractConstraints } = await import("../scripts/extract-constraints");
      const result = await extractConstraints(root, { apply: false });

      for (const s of result.staleness) {
        addStaleness({ file: s.file, daysSince: s.daysSince, threshold: s.threshold, type: s.type });
      }

      for (const c of result.candidates) {
        addCandidate({ rule: c.rule, source: c.source, hash: c.hash, status: "pending" });
      }

      if (result.staleness.length > 0) {
        console.warn(
          `Stale docs (past threshold): ${result.staleness.map((s: any) => `${s.file} (${s.daysSince}d, ${s.type} threshold=${s.threshold}d)`).join(", ")}`
        );
      }

      if (result.candidates.length > 0) {
        console.warn(
          `${result.candidates.length} unreviewed constraint candidates found. Run \`bunx rungate extract-constraints ${root}\` to review.`
        );
      }

      expect(true).toBe(true);
    });

    test("HYGIENE-11: Stale unreferenced files warn with archival suggestion", () => {
      const index = getRefIndex();
      // stalenessThreshold through the loader (ADR-002 D1, #309), default 90
      // days. The bare `catch {}` is kept deliberately narrow in meaning: a
      // config that cannot be read must not take HYGIENE-11 down, but it also
      // must not silently become 90 — which, with nothing logged, is what it
      // used to do.
      let threshold = 90;
      try {
        const config = tryLoadRungateConfig(root);
        if (typeof config?.stalenessThreshold === "number") {
          threshold = config.stalenessThreshold;
        }
      } catch (err) {
        console.warn(
          `WARN: HYGIENE-11 could not read the rungate config (${(err as Error).name}); ` +
            `using the ${threshold}-day default. A configured threshold is NOT in effect.`,
        );
      }

      // Scan docs directories for markdown files — skip reference/ entirely (AC-2)
      const scanTargets: string[] = [];
      const docDirs = ["specs", "docs", "docs/adr", "docs/research", "docs/council", "docs/guides"];
      for (const rel of docDirs) {
        const dir = join(root, rel);
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir).filter(f => f.endsWith(".md"))) {
          const fullPath = join(dir, f);
          try {
            if (statSync(fullPath).isFile()) {
              scanTargets.push(`${rel}/${f}`);
            }
          } catch {}
        }
      }

      // Also scan root-level markdown (excluding reference/)
      for (const f of readdirSync(root).filter(f => f.endsWith(".md"))) {
        scanTargets.push(f);
      }

      // Filter out reference/ paths (AC-2)
      const filtered = scanTargets.filter(f => !f.startsWith("reference/") && !f.includes("/reference/"));

      // One git call for every file, not one per file (#323).
      //
      // This was `spawnSync("git", ["log", "-1", ..., "--", rel])` inside the
      // loop: 60 serial subprocesses against the same repository, each with
      // its own 5-second timeout. Nothing was wrong with any single call — the
      // test was load-sensitive by construction, and if any one spawn was slow
      // (another suite holding the index, a busy machine, a cold cache) it hit
      // the timeout and the test went red. Measured at 1 failure in 3
      // identical runs, always at ~5007 ms. It also got worse on its own as
      // the repo grew, because more docs means more dice rolls.
      //
      // `--name-only` over the whole history, walked newest-first, gives every
      // path's most recent commit date from a single subprocess. The first
      // time a path is seen is its latest commit, so later entries are
      // ignored.
      //
      // `filtered` is passed, NOT `docDirs`. The first cut of this fix passed
      // the six doc directories, and `git log -- specs docs` has nothing to
      // say about the six root-level markdown files this scan also walks —
      // AGENTS.md, CLAUDE.md, SUCCESS.md and friends dropped out of the map,
      // and the `if (!dateStr) continue` below read that as "newly added, so
      // not stale". Handing it the exact lookup set keeps the pathspec and the
      // keys the same list by construction.
      const lastCommit = lastCommitDates(root, filtered);

      const staleUnreferenced: { file: string; daysSince: number }[] = [];
      for (const rel of filtered) {
        const dateStr = lastCommit.get(rel);
        // No commit for this path means it is untracked or newly added, which
        // is the opposite of stale.
        if (!dateStr) continue;
        const daysSince = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince <= threshold) continue;

        // Check cross-references: filename must appear somewhere in the codebase index
        const basename = rel.split("/").pop()!;
        if (index.includes(basename)) continue;

        staleUnreferenced.push({ file: rel, daysSince: Math.floor(daysSince) });
      }

      // AC-3: Each warning includes git mv archival command
      if (staleUnreferenced.length > 0) {
        for (const entry of staleUnreferenced) {
          const archiveDest = `reference/${entry.file.split("/").pop()}`;
          addFinding({
            ruleId: "HYGIENE-11",
            severity: "WARN",
            file: entry.file,
            message: `Stale unreferenced file (${entry.daysSince}d, threshold=${threshold}d)`,
            fixCommand: `git mv ${entry.file} ${archiveDest}`,
          });
          console.warn(`HYGIENE-11: ${entry.file} — stale (${entry.daysSince}d) and unreferenced. Fix: git mv ${entry.file} ${archiveDest}`);
        }
      }

      // AC-1: At least 2 assertions
      // 1. reference/ files were filtered out
      const referenceFiles = scanTargets.filter(f => f.startsWith("reference/") || f.includes("/reference/"));
      expect(filtered.every(f => !f.startsWith("reference/") && !f.includes("/reference/"))).toBe(true);

      // 2. All stale unreferenced entries have git mv fix commands
      const hygieneFindings = getFindings().filter(f => f.ruleId === "HYGIENE-11");
      expect(hygieneFindings.every(f => f.fixCommand?.startsWith("git mv "))).toBe(true);
    });

    test("HYGIENE-REPORT: Write unified findings report", () => {
      const findings = getFindings();
      const candidates = getCandidates();
      const staleness = getStaleness();
      const totalItems = findings.length + candidates.length + staleness.length;

      if (totalItems > 0) {
        const reportPath = writeFindingsReport(root);
        console.log(`\n📋 Findings written to ${reportPath}`);
        if (findings.length > 0) {
          console.log(`   Issues: ${findings.filter(f => f.severity === "FAIL").length} FAIL, ${findings.filter(f => f.severity === "WARN").length} WARN`);
          for (const f of findings) {
            console.log(`   ${f.severity}: ${f.file} — ${f.message}`);
            if (f.fixCommand) console.log(`     Fix: ${f.fixCommand}`);
          }
        }
        if (candidates.length > 0) {
          console.log(`   Constraint candidates: ${candidates.length} pending review`);
          for (const c of candidates) {
            console.log(`     "${c.rule}" (${c.source})`);
          }
          console.log(`   → Run \`bunx rungate extract-constraints ${root}\` to apply or reject`);
        }
        if (staleness.length > 0) {
          console.log(`   Stale docs: ${staleness.length}`);
          for (const s of staleness) {
            console.log(`     ${s.file} — ${s.daysSince}d old (${s.type} threshold: ${s.threshold}d)`);
          }
        }
      }
      expect(true).toBe(true);
    });
  });
}

// ── Agent file validation ──────────────────────────────────

export function runAgentFileValidation(root: string) {
  const agentsDir = join(root, ".claude", "agents");

  describe("Agent File Validation", () => {
    test("AGENT-1: .claude/agents/ directory exists (code projects)", () => {
      const isCode = existsSync(join(root, "src")) || existsSync(join(root, "lib")) ||
        existsSync(join(root, "gates")) || existsSync(join(root, "Makefile"));
      if (!isCode) return;
      expect(existsSync(agentsDir)).toBe(true);
    });

    test("AGENT-2: All agent files have required frontmatter (name + description)", () => {
      if (!existsSync(agentsDir)) return;
      const invalid: string[] = [];
      for (const f of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(agentsDir, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (!fm || !fm.name) invalid.push(`${f}: missing 'name' field`);
        else if (!fm.description) invalid.push(`${f}: missing 'description' field`);
      }
      if (invalid.length > 0) {
        console.warn(`Invalid agent files (Claude Code will SKIP these silently):\n  ${invalid.join("\n  ")}`);
      }
      expect(invalid).toEqual([]);
    });

    test("AGENT-3: Agent file names are lowercase (Claude Code matching requirement)", () => {
      if (!existsSync(agentsDir)) return;
      const bad: string[] = [];
      for (const f of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
        const basename = f.replace(/\.md$/, "");
        if (basename !== basename.toLowerCase() || basename.includes(" ")) {
          bad.push(f);
        }
      }
      expect(bad).toEqual([]);
    });

    test("AGENT-4: Agent name field matches filename", () => {
      if (!existsSync(agentsDir)) return;
      const mismatched: string[] = [];
      for (const f of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(agentsDir, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (!fm?.name) continue;
        const basename = f.replace(/\.md$/, "");
        if (fm.name !== basename) {
          mismatched.push(`${f}: name="${fm.name}" but filename="${basename}"`);
        }
      }
      if (mismatched.length > 0) {
        console.warn(`Agent name/filename mismatch (subagent_type won't match):\n  ${mismatched.join("\n  ")}`);
      }
      expect(mismatched).toEqual([]);
    });

    test("AGENT-5: Shared agent principles exist as unconditional rule", () => {
      const rulesDir = join(root, ".claude", "rules");
      if (!existsSync(rulesDir)) {
        addFinding({ ruleId: "AGENT-5", severity: "FAIL", file: ".claude/rules/", message: "No rules directory found", fixCommand: "Re-scaffold to generate rules" });
        expect(existsSync(rulesDir)).toBe(true);
        return;
      }
      const principlesFile = join(rulesDir, "agent-principles.md");
      expect(existsSync(principlesFile)).toBe(true);
      const content = readFileSync(principlesFile, "utf-8");
      expect(content).toContain("Core Principles");
    });

    test("AGENT-7: All agent briefs have required sections", () => {
      if (!existsSync(agentsDir)) return;
      const sectionChecks: Array<{ name: string; pattern: RegExp }> = [
        { name: "frontmatter", pattern: /^---\n[\s\S]*?\n---/ },
        { name: "identity", pattern: /You are\s+\w+/i },
        { name: "agent-specific-section", pattern: /^##\s+(Workflow|Rules|Testing|Discovery|What you|TDD|CLI|UI|Project Type|Efficiency|Design|Architecture|Context|Report)/im },
      ];
      const missing: string[] = [];
      for (const f of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(agentsDir, f), "utf-8");
        for (const check of sectionChecks) {
          if (!check.pattern.test(content)) {
            missing.push(`${f}: missing required section '${check.name}'`);
            addFinding({
              ruleId: "AGENT-REQUIRED-SECTION",
              severity: "FAIL",
              file: `.claude/agents/${f}`,
              message: `Brief missing required section: ${check.name}`,
            });
          }
        }
      }
      if (missing.length > 0) {
        console.error(`Agent briefs missing required sections:\n  ${missing.join("\n  ")}`);
      }
      expect(missing).toEqual([]);
    });

    test("AGENT-8: Agent brief models match the roles config", () => {
      if (!existsSync(agentsDir)) return;
      // Was hardcoded to "sonnet". Roles are now routed per-role, so the
      // meaningful check is that each brief matches its configured model —
      // briefs are generated from that config, and a mismatch means someone
      // hand-edited generated output.
      //
      // #90: this read `.claude/rungate.json` directly, which is the LEGACY
      // monolith. Scaffold migrated projects to `.claude/rungate/` and
      // generates briefs from `roles.json` there, so on any migrated project
      // the generator and this validator read different files. They disagreed
      // in this very repo — roles.json said sonnet, the stale monolith said
      // opus — and AGENT-8 reported a violation against output that exactly
      // matched its real source.
      //
      // The failure mode was worse than a false alarm: the message told the
      // reader to "re-scaffold instead of editing the brief", and
      // re-scaffolding reproduced the same briefs, so following the advice
      // could not clear it.
      //
      // Go through the canonical loader, which understands both layouts and
      // prefers the directory. tryLoadRungateConfig is the non-throwing
      // variant: absent config is "nothing to check", while a MALFORMED
      // config still throws, per ADR-001 D2 — a broken config must not read
      // as an unconfigured one.
      const VALID_MODELS = ["sonnet", "opus", "haiku", "fable"];
      const roles: Record<string, { model?: string }> =
        (tryLoadRungateConfig(root)?.roles as Record<string, { model?: string }>) ?? {};

      const wrong: string[] = [];
      for (const f of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(agentsDir, f), "utf-8");
        const fm = parseFrontmatter(content);
        const role = f.replace(/\.md$/, "");
        const expected = roles[role]?.model;
        if (!fm?.model) {
          wrong.push(`${f}: missing model field`);
        } else if (!VALID_MODELS.includes(fm.model)) {
          wrong.push(`${f}: model is "${fm.model}", expected one of ${VALID_MODELS.join("|")}`);
        } else if (expected && fm.model !== expected) {
          wrong.push(`${f}: model is "${fm.model}", but the roles config says "${expected}" — re-scaffold instead of editing the brief`);
        }
      }
      if (wrong.length > 0) {
        wrong.forEach(w => addFinding({
          ruleId: "AGENT-MODEL",
          severity: "FAIL",
          file: `.claude/agents/${w.split(":")[0]}`,
          message: w,
        }));
        console.error(`Agent briefs with wrong model:\n  ${wrong.join("\n  ")}`);
      }
      expect(wrong).toEqual([]);
    });

    test("AGENT-9: All agent briefs are under 120 lines", () => {
      if (!existsSync(agentsDir)) return;
      const over: string[] = [];
      for (const f of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(agentsDir, f), "utf-8");
        const lineCount = content.trimEnd().split("\n").length;
        if (lineCount > 120) {
          over.push(`${f}: ${lineCount} lines (max 120)`);
          addFinding({
            ruleId: "AGENT-LINECOUNT",
            severity: "FAIL",
            file: `.claude/agents/${f}`,
            message: `Brief is ${lineCount} lines, exceeds 120-line cap`,
          });
        }
      }
      if (over.length > 0) {
        console.error(`Agent briefs over 120 lines:\n  ${over.join("\n  ")}`);
      }
      expect(over).toEqual([]);
    });

    test("AGENT-11: AGENTS.md is under line cap (sigmoid collapse prevention)", () => {
      const agentsMdPath = join(root, "AGENTS.md");
      if (!existsSync(agentsMdPath)) return;
      const content = readFileSync(agentsMdPath, "utf-8");
      const lineCount = content.trimEnd().split("\n").length;
      const consumerLines = (content.match(/^- \w/gm) || []).length;
      const cap = 100 + Math.max(0, consumerLines - 10);
      if (lineCount > cap) {
        addFinding({
          ruleId: "AGENTS-MD-LINECOUNT",
          severity: "FAIL",
          file: "AGENTS.md",
          message: `AGENTS.md is ${lineCount} lines, exceeds ${cap}-line cap (base 100 + ${Math.max(0, consumerLines - 10)} consumer lines). Move reference tables to .claude/rules/`,
        });
      }
      expect(lineCount).toBeLessThanOrEqual(cap);
    });

    test("AGENT-10: No unfilled template variables in agent briefs", () => {
      if (!existsSync(agentsDir)) return;
      const unfilled: string[] = [];
      for (const f of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(agentsDir, f), "utf-8");
        const vars = content.match(/\$\{[A-Z_]+\}/g);
        if (vars && vars.length > 0) {
          unfilled.push(`${f}: unfilled template variables: ${vars.join(", ")}`);
          addFinding({
            ruleId: "AGENT-TEMPLATE-VAR",
            severity: "FAIL",
            file: `.claude/agents/${f}`,
            message: `Brief has unfilled template variables: ${vars.join(", ")}`,
          });
        }
      }
      if (unfilled.length > 0) {
        console.error(`Agent briefs with unfilled template variables:\n  ${unfilled.join("\n  ")}`);
      }
      expect(unfilled).toEqual([]);
    });

    test("AGENT-6: All file paths referenced in briefs exist", () => {
      if (!existsSync(agentsDir)) return;
      const broken: string[] = [];
      for (const f of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(agentsDir, f), "utf-8");
        const refs = content.match(/node_modules\/[^\s`*)"']+/g) || [];
        for (const ref of refs) {
          const clean = ref.replace(/[`*)"']+$/, "");
          if (!existsSync(join(root, clean))) {
            broken.push(`${f} → ${clean}`);
            addFinding({
              ruleId: "AGENT-BROKEN-REF",
              severity: "FAIL",
              file: `.claude/agents/${f}`,
              message: `Brief references "${clean}" but file does not exist`,
              fixCommand: `Check prompts/ directory for correct filename — may be a typo or renamed file`,
            });
          }
        }
      }
      if (broken.length > 0) {
        console.error(`Broken references in agent briefs:\n  ${broken.join("\n  ")}`);
      }
      expect(broken).toEqual([]);
    });
  });
}

// ── SC-294: Directory validation ───────────────────────────

export function runDirectoryValidation(root: string) {
  const specsDir = join(root, "specs");

  describe("Directory Validation (SC-294)", () => {
    test("SC-294: Every specs/ subdirectory has a parent spec file", () => {
      if (!existsSync(specsDir)) return;

      const invalid: string[] = [];

      // Find all subdirectories in specs/
      const entries = readdirSync(specsDir);
      const subdirs = entries.filter(entry => {
        const fullPath = join(specsDir, entry);
        try {
          return statSync(fullPath).isDirectory();
        } catch {
          return false;
        }
      });

      // For each subdirectory, check if there's a corresponding parent spec
      for (const subdir of subdirs) {
        // Find all .md files in specs/
        const specFiles = entries.filter(f => f.endsWith(".md"));

        // Check if any spec file derives to this directory name
        let found = false;
        for (const specFile of specFiles) {
          const derived = deriveDirectoryName(specFile);
          if (derived === subdir) {
            found = true;
            break;
          }
        }

        if (!found) {
          invalid.push(`${subdir}/: no parent spec derives to this directory name`);
        }
      }

      if (invalid.length > 0) {
        console.error(`Hand-created directories (SC-294 violation):\n  ${invalid.join("\n  ")}\n\nDirectories MUST be created by split-spec.ts, not manually.`);
      }
      expect(invalid).toEqual([]);
    });
  });
}

// ── Fallow integration ─────────────────────────────────────

interface FallowResult {
  total_issues: number;
  elapsed_ms: number;
  summary: Record<string, number>;
  unused_files: Array<{ path: string }>;
  unused_exports: Array<{ path: string; export_name: string; line?: number }>;
  unused_dependencies: Array<{ name: string }>;
  circular_dependencies: Array<{ path: string; chain?: string[] }>;
  workspace_diagnostics: Array<{ kind: string; message: string }>;
}

// `fallow` is an optional external tool and is NOT a declared dependency. When
// it is absent, `npx fallow` does a registry fetch on every invocation — four
// tests x one fetch each, each outliving bun's per-test timeout. The tests then
// fail as timeouts instead of skipping, which blocks the pre-push conformity
// gate on a tool nobody installed.
//
// Resolve it locally instead, with no network path. Memoised PER ROOT —
// runFallowCheck is exported and consumer projects call it with their own
// root, so a single process can ask about several. A root-independent cache
// would answer for the wrong directory.
const FALLOW_AVAILABLE = new Map<string, boolean>();

function fallowAvailable(root: string): boolean {
  const cached = FALLOW_AVAILABLE.get(root);
  if (cached !== undefined) return cached;
  const available =
    existsSync(join(root, "node_modules", ".bin", "fallow")) ||
    Bun.which("fallow") !== null;
  FALLOW_AVAILABLE.set(root, available);
  return available;
}

/** Shared skip notice — a skipped check must say so, not read as a pass. */
function fallowSkipped(check: string): void {
  console.warn(
    `SKIP ${check}: fallow is not installed (not a declared dependency) — ` +
      `this check did NOT run. Install it to enable static analysis.`,
  );
}

function runFallowCommand(root: string, args: string[]): FallowResult | null {
  if (!fallowAvailable(root)) return null;
  const result = Bun.spawnSync(["npx", "fallow", ...args, "--format", "json", "--quiet"], {
    cwd: root,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    timeout: 30_000,
  });
  const stdout = result.stdout.toString().trim();
  if (!stdout || stdout.startsWith("{\"error\"")) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export function runFallowCheck(root: string, opts?: { skipUnusedExports?: boolean; warnOnly?: boolean }) {
  const fail = !opts?.warnOnly;
  describe("Fallow: static analysis", () => {
    test("FALLOW-1: No unused files", () => {
      const result = runFallowCommand(root, ["dead-code", "--unused-files"]);
      if (!result) { fallowSkipped("FALLOW-1 (unused files)"); return; }
      const unused = result.unused_files.map(f => f.path).filter(p => !p.includes("test/fixtures/") && !p.includes("reference/"));
      if (unused.length > 0) {
        console.warn(`Unused files (${unused.length}):\n  ${unused.slice(0, 10).join("\n  ")}${unused.length > 10 ? `\n  ... and ${unused.length - 10} more` : ""}`);
      }
      if (fail) expect(unused).toEqual([]);
    });

    if (!opts?.skipUnusedExports) {
      test("FALLOW-2: No unused exports", () => {
        const result = runFallowCommand(root, ["dead-code", "--unused-exports"]);
        if (!result) { fallowSkipped("FALLOW-2 (unused exports)"); return; }
        const unused = (result.unused_exports || [])
          .filter(e => !e.path.includes("test/fixtures/") && !e.path.includes("reference/"))
          .map(e => `${e.path}:${e.line ?? "?"} ${e.export_name}`);
        if (unused.length > 0) {
          console.warn(`Unused exports (${unused.length}):\n  ${unused.slice(0, 10).join("\n  ")}${unused.length > 10 ? `\n  ... and ${unused.length - 10} more` : ""}`);
        }
        if (fail) expect(unused).toEqual([]);
      });
    }

    test("FALLOW-3: No unused dependencies", () => {
      const result = runFallowCommand(root, ["dead-code", "--unused-deps"]);
      if (!result) { fallowSkipped("FALLOW-3 (unused dependencies)"); return; }
      const unused = result.unused_dependencies?.map(d => d.name) || [];
      if (unused.length > 0) {
        console.warn(`Unused dependencies (${unused.length}):\n  ${unused.join("\n  ")}`);
      }
      if (fail) expect(unused).toEqual([]);
    });

    test("FALLOW-4: No circular dependencies", () => {
      const result = runFallowCommand(root, ["dead-code"]);
      if (!result) { fallowSkipped("FALLOW-4 (circular dependencies)"); return; }
      const circles = result.circular_dependencies || [];
      if (circles.length > 0) {
        console.warn(`Circular dependencies (${circles.length}):\n  ${circles.slice(0, 5).map(c => c.path || JSON.stringify(c.chain ?? c)).join("\n  ")}${circles.length > 5 ? `\n  ... and ${circles.length - 5} more` : ""}`);
      }
      if (fail) expect(circles).toEqual([]);
    });
  });
}

export function runPackageValidation(root: string) {
  describe("Package validation", () => {
    test("PKG-1: package.json exists", () => {
      expect(existsSync(join(root, "package.json"))).toBe(true);
    });

    test("PKG-2: required fields present", () => {
      const pkgPath = join(root, "package.json");
      if (!existsSync(pkgPath)) return;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      expect(pkg.name).toBeDefined();
      expect(pkg.type).toBe("module");
      expect(pkg.scripts?.test).toBeDefined();
    });

    test("PKG-3: devDependencies.rungate present", () => {
      const pkgPath = join(root, "package.json");
      if (!existsSync(pkgPath)) return;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      // The harness is not a consumer of itself. npm has no way to express
      // a self-dependency and would be wrong to: `rungate` IS the thing
      // this check asks every other project to depend on. Surfaced by #208
      // — once rungate's own conformity test stopped being frozen by
      // `safeWrite`, this check ran here for the first time and failed on a
      // requirement it is not possible to satisfy.
      if (isHarnessItself(root)) return;
      expect(pkg.devDependencies?.rungate).toBeDefined();
    });
  });
}

/**
 * #87 — TSC-1 demanded a tsconfig.json that the generator had deliberately
 * decided not to write.
 *
 * `createTsconfig` skips a project with no hand-written TypeScript, because a
 * tsconfig whose `include` matches nothing is tsc error TS18003 — a type check
 * that reads as broken rather than as "nothing to check". `createCiWorkflows`
 * and the AGENTS.md generator both agreed and emitted no step and no row. Then
 * this hard assert ran in that same consumer's generated conformity suite and
 * failed over the absent file. Both halves of the question were asserted at
 * once, which is the contradiction #87 was filed to settle.
 *
 * Settled in favour of "consumers may be non-TypeScript projects", so TSC-1
 * asks `tsconfigVerdict` — the one predicate `createTsconfig` uses — whether
 * it has anything to assert. The skip is RECORDED as a finding rather than
 * taken quietly: an unmeasured check and a satisfied check look identical from
 * the outside, and `.claude/rules/config-access.md` names the silent form as
 * the anti-pattern it is.
 */
export function runTsconfigValidation(root: string) {
  describe("TSConfig validation", () => {
    test("TSC-1: tsconfig.json exists where TypeScript source does", () => {
      const verdict = tsconfigVerdict(root);
      if (!verdict.applicable) {
        addFinding({
          ruleId: "TSC-1",
          severity: "WARN",
          file: "tsconfig.json",
          message: `UNMEASURED: ${verdict.reason}`,
        });
        return;
      }
      expect(verdict.present, verdict.reason).toBe(true);
    });

    test("TSC-2: strict mode enabled", () => {
      const tscPath = join(root, "tsconfig.json");
      if (!existsSync(tscPath)) return;
      const tsconfig = JSON.parse(readFileSync(tscPath, "utf-8"));
      if (!tsconfig.compilerOptions?.strict) {
        console.warn("WARN: tsconfig.json strict mode not enabled");
      }
    });
  });
}

export function runModuleDepthCheck(root: string) {
  describe("Module depth analysis", () => {
    test("DEPTH-1: no shallow modules (more exports than internal functions)", () => {
      const srcDir = join(root, "src");
      if (!existsSync(srcDir)) return;
      const shallow: string[] = [];
      for (const f of readdirSync(srcDir).filter(f => f.endsWith(".ts"))) {
        const content = readFileSync(join(srcDir, f), "utf-8");
        const exportCount = (content.match(/export\s+(function|const|class|type|interface)\s/g) || []).length;
        const internalCount = (content.match(/(?<!export\s)(function|const)\s+[a-z]/g) || []).length;
        if (exportCount > 0 && internalCount > 0 && exportCount > internalCount) {
          shallow.push(`${f}: ${exportCount} exports, ${internalCount} internal`);
        }
      }
      if (shallow.length > 0) {
        console.warn(`WARN: Shallow modules:\n  ${shallow.join("\n  ")}`);
      }
    });

    test("DEPTH-2: modules with >3 importers have contract tests", () => {
      const srcDir = join(root, "src");
      const testDir = join(root, "test");
      if (!existsSync(srcDir)) return;
      const importCounts: Record<string, number> = {};
      for (const f of readdirSync(srcDir).filter(f => f.endsWith(".ts"))) {
        const content = readFileSync(join(srcDir, f), "utf-8");
        const imports = content.match(/from\s+["']\.\/([^"']+)["']/g) || [];
        for (const imp of imports) {
          const target = imp.match(/["']\.\/([^"']+)["']/)?.[1] || "";
          importCounts[target] = (importCounts[target] || 0) + 1;
        }
      }
      const highImport = Object.entries(importCounts).filter(([, c]) => c > 3);
      if (highImport.length > 0 && existsSync(testDir)) {
        const testFiles = readdirSync(testDir).filter(f => f.endsWith(".test.ts"));
        for (const [mod, count] of highImport) {
          const hasTest = testFiles.some(t => t.includes(mod.replace(/\.ts$/, "")));
          if (!hasTest) {
            console.warn(`WARN: ${mod} has ${count} importers but no contract test`);
          }
        }
      }
    });
  });
}

// ── Config access conformity (ADR-002 D4, #309) ────────────────
//
// ADR-001 decided the single-loader policy on 2026-10-05 and specified this
// check as the enforcement. It was never built. Six days later the thing it
// was written to stop had gone from ~24 sites to ~89 — the policy was
// written down the whole time, which is the measurement that makes
// "a rule nothing executes is not a rule" a number rather than a slogan.
//
// TWO checks, not one, because there are two bypass routes and ADR-001's
// single check would have missed eleven of them: `workflows/*.js` reaches
// config from inside agent PROMPT TEXT, which a TypeScript-source scan does
// not look at.
//
// ## The self-reference trap
//
// This file is inside the scanned set and is about to contain the literals
// it searches for. An allowlist naming the exempt files becomes evidence
// those files are referenced — this repo has hit that three times. So the
// pattern is ASSEMBLED from fragments that never appear adjacent in this
// source, and the test asserts the check reports zero against its own file.
// The three real violations this file used to carry are migrated to the
// loader in the same change, so that zero is a fact and not an exemption.
const CFG_DOT = ".";
const CFG_DIR = "claude";
const CFG_NAME = "rungate";

/**
 * A path being built to the config, in CODE.
 *
 * Comments are blanked by `stripJsComments` before this runs — offset
 * preserving, already proven on `ship.js` by its own suite — rather than by a
 * line rule of my own. Prose that DISCUSSES the config is not an access, and
 * counting it would bury the real sites in noise until the ratchet became a
 * number nobody reads.
 *
 * STATED LIMIT, carried over from ADR-001 and not an oversight: this is
 * string matching, so `join(root, CFG_DOT + CFG_DIR, dynamicName)` is not
 * caught. It catches every one of the present sites; a variable-constructed
 * path is not the realistic failure mode and an AST check is not worth the
 * dependency.
 */
function configAccessPattern(): RegExp {
  return new RegExp(
    "\\" + CFG_DOT + CFG_DIR + "[\"'`/\\\\,\\s)]+\\s*[\"'`]?" + CFG_NAME,
    "g",
  );
}

/**
 * Calls whose arguments are FILESYSTEM PATHS (#415).
 *
 * The positive list IS the definition, not a heuristic: a config path that
 * reaches the disk is either built by a path API or handed straight to an fs
 * one. Everything a `node:path` call touches is a path by construction.
 */
const FS_PATH_CALLS = new Set([
  "existsSync", "readFileSync", "writeFileSync", "appendFileSync", "readdirSync",
  "mkdirSync", "rmSync", "rmdirSync", "unlinkSync", "statSync", "lstatSync",
  "copyFileSync", "cpSync", "renameSync", "realpathSync", "readlinkSync", "openSync",
]);

/**
 * `node:path` builders. Receiver-checked, unlike the fs names above, because
 * `Array.prototype.join` shares one of them and `["a", "b"].join(", ")` is
 * text. A bare `join` is the named import this repo uses; `path.join` is the
 * namespace form.
 */
const PATH_BUILDERS = new Set(["join", "resolve", "relative", "normalize"]);

/**
 * Handing a shell a command that names the config is a read, and the literal
 * carrying it has spaces in it by construction — `cat <root>/…json` would
 * otherwise read as prose and go uncounted, which is the one fail-open the
 * prose rule could have opened on its own.
 */
const SHELL_CALLS = new Set(["execSync", "exec", "execFileSync", "spawnSync", "spawn"]);

function isPathCall(callee: string | null): boolean {
  if (!callee) return false;
  const bare = callee.slice(callee.lastIndexOf(".") + 1);
  if (FS_PATH_CALLS.has(bare) || SHELL_CALLS.has(bare)) return true;
  return PATH_BUILDERS.has(bare) && (callee === bare || callee === `path.${bare}`);
}

/**
 * Calls that take TEXT. Both are universal JS idioms rather than names out of
 * this repo — `x.push(…)` into a list of messages, and `console.*` — and both
 * are needed because a documentation entry can carry a path-SHAPED literal:
 * `keyFiles.push({ file: "…/" })` is a row in a generated table, not a read.
 */
function isTextCall(callee: string | null): boolean {
  if (!callee) return false;
  return callee.endsWith(".push") || callee.startsWith("console.");
}

/** The dotted name immediately left of an open paren, or `""` for a group. */
function calleeBefore(text: string, parenIndex: number): string {
  let j = parenIndex - 1;
  while (j >= 0 && /\s/.test(text[j]!)) j--;
  const end = j + 1;
  while (j >= 0 && /[A-Za-z0-9_$.]/.test(text[j]!)) j--;
  return text.slice(j + 1, end);
}

/** What a config-path match turned out to be. */
export type ConfigSiteKind = "use" | "mention";

export interface ConfigSite {
  /** Offset in the comment-stripped source. */
  index: number;
  kind: ConfigSiteKind;
  /** Innermost enclosing call, or null at statement level. */
  callee: string | null;
  /** The literal run the match sits in, or null if it is not in one. */
  literal: string | null;
}

/**
 * Is this path being BUILT, or merely NAMED? (#415)
 *
 * The one place that decides, so the mutation harness has one site to
 * collapse (`.claude/rules/checks-must-be-able-to-fail.md`). Collapsing it
 * either way moves a banked number and the both-ways ratchet refuses, which
 * is the property `test/config-access-mentions.test.ts` SC-1553 pins down.
 *
 * ## How the two views are read
 *
 * There is NO second lexer here. `stripJsComments` already scans code,
 * strings, templates (with `${}` to any depth) and regex literals, offset
 * preserving, and `blankLiterals` gives a view in which every literal's
 * CONTENTS are spaces and its delimiters are not. Over that view a naive
 * paren counter is exact — no quote, paren or brace inside a string or a
 * regex can reach it — and the literal a match sits in is simply the maximal
 * run of blanked offsets around it. A second scanner answering the same
 * question is a second scanner to drift.
 *
 * ## The decision, and which way each branch is allowed to be wrong
 *
 * 1. an fs, shell or `node:path` call
 *    around it                                → USE, whatever the text says
 * 2. otherwise, prose around the path         → MENTION
 * 3. otherwise, a path-shaped literal into a
 *    message list or the console              → MENTION
 * 4. otherwise                                → USE
 *
 * Rule 4 is the fail-closed default and it is the reason an unrecognised
 * helper, a bare `const p = "…"` or a path built by concatenation still
 * counts: a path-shaped literal is a path until something shows otherwise.
 *
 * STATED LIMIT, in the tradition of ADR-001's: a literal containing
 * whitespace, passed to a call this cannot recognise, reads as prose. Both
 * halves have to be true at once, which is why the remaining blind spot is a
 * sentence that is also a path.
 */
export function classifyConfigSites(source: string): ConfigSite[] {
  const code = stripJsComments(source);
  const bare = stripJsComments(source, { blankLiterals: true });

  const sites: ConfigSite[] = [];
  const pattern = configAccessPattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    const at = match.index;

    let depthCallee: string | null = null;
    const stack: string[] = [];
    for (let i = 0; i < at; i++) {
      const c = bare[i];
      if (c === "(") stack.push(calleeBefore(bare, i));
      else if (c === ")") stack.pop();
    }
    depthCallee = stack.length > 0 ? stack[stack.length - 1]! : null;

    let literal: string | null = null;
    if (bare[at] === " " && code[at] !== " ") {
      let lo = at;
      let hi = at;
      while (lo > 0 && bare[lo - 1] === " ") lo--;
      while (hi + 1 < bare.length && bare[hi + 1] === " ") hi++;
      literal = code.slice(lo, hi + 1);
    }

    const kind: ConfigSiteKind = isPathCall(depthCallee)
      ? "use"
      : literal !== null && /\s/.test(literal)
        ? "mention"
        : isTextCall(depthCallee)
          ? "mention"
          : "use";

    sites.push({ index: at, kind, callee: depthCallee, literal });
  }
  return sites;
}

/** Directories CHECK-1 walks. Tests and `test/` are excluded by ADR-002 D4. */
const CONFIG_SCAN_DIRS = ["lib", "gates", "scripts", "hooks", "generators"];

/** The one module allowed to read the config. ADR-002 D1. */
const CONFIG_LOADER = "lib/config-loader.ts";

function walkSources(dir: string, rel: string, out: Array<{ path: string; text: string }>) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      // NOT a test-directory skip, and not `isTestSourceFile` below. The first draft of
      // the #500 fix widened both here to match the evidence walk, and that
      // silently REDUCED enforcement: `lib/tests/sneaky.ts`, `lib/spec/y.ts`,
      // `lib/__mocks__/x.ts`, `lib/sneaky.test.js` and `lib/sneaky.spec.ts`
      // each carried a real direct config read, were counted as violations
      // before, and became silent green after — no WARN, no UNMEASURED, no
      // record, because a non-empty scan never engages the waiver.
      //
      // The invariant the waiver needs is ONE-DIRECTIONAL: the evidence walk
      // must not claim source the scan would never read. The scan reading
      // MORE than the walk is harmless — a file the scan reads makes
      // `filesScanned > 0`, and the waiver is never reached. So the walk is
      // the side that narrows, and this stays where ADR-002 D4 left it.
      if (e.name === "test" || e.name === "node_modules") continue;
      walkSources(abs, relPath, out);
      continue;
    }
    if (!/\.(ts|js)$/.test(e.name) || /\.test\.ts$/.test(e.name)) continue;
    out.push({ path: relPath, text: readFileSync(abs, "utf-8") });
  }
}

/** What a scan saw: per-file counts, and how much it actually read. */
export interface ConfigAccessScan {
  /** Repo-relative path -> site count. Allowlisted files are excluded. */
  counts: Record<string, number>;
  /** Files walked. ZERO means the scan found nothing to look at. */
  filesScanned: number;
  /** Bytes read. Zero with a non-zero file count means empty sources. */
  bytesScanned: number;
}

/**
 * CHECK-1's reading: direct config access in TypeScript sources.
 *
 * A separate function from the refusal so there is ONE site for the mutation
 * harness to short-circuit (`.claude/rules/checks-must-be-able-to-fail.md`,
 * and ADR-002 D4's third mutation).
 */
export function scanConfigAccess(root: string): ConfigAccessScan {
  const files: Array<{ path: string; text: string }> = [];
  for (const d of CONFIG_SCAN_DIRS) walkSources(join(root, d), d, files);

  const counts: Record<string, number> = {};
  let bytesScanned = 0;
  for (const f of files) {
    bytesScanned += f.text.length;
    if (f.path === CONFIG_LOADER) continue;
    const n = classifyConfigSites(f.text).filter(site => site.kind === "use").length;
    if (n > 0) counts[f.path] = n;
  }
  return { counts, filesScanned: files.length, bytesScanned };
}

/**
 * CHECK-2's reading: config access inside `workflows/*.js`, prompts included.
 *
 * Comments are stripped and literals are NOT, which is the whole point —
 * `ship.js` is mostly prompt text, and the eleven sites ADR-001's check could
 * not see all live inside template literals handed to agents.
 *
 * **It does NOT use `classifyConfigSites`, and must not** (#415). CHECK-1's
 * subject is a path being built in code, so a sentence naming the file is
 * noise. CHECK-2's subject is the sentence: "Read ${PROJECT_ROOT}/…" IS the
 * violation, and it is prose by construction. Pointing the classifier at this
 * scan would silently empty the check — every one of its sites would reclassify
 * as a mention. `test/config-access-mentions.test.ts` SC-1552 runs one sentence
 * through both scans and asserts they disagree, so the collapse cannot be made
 * quietly in the name of consistency.
 */
export function scanPromptConfigAccess(root: string): ConfigAccessScan {
  const dir = join(root, "workflows");
  const counts: Record<string, number> = {};
  let filesScanned = 0;
  let bytesScanned = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter(f => f.endsWith(".js"));
  } catch {
    return { counts, filesScanned: 0, bytesScanned: 0 };
  }
  for (const f of entries) {
    const text = readFileSync(join(dir, f), "utf-8");
    filesScanned++;
    bytesScanned += text.length;
    const n = (stripJsComments(text).match(configAccessPattern()) || []).length;
    if (n > 0) counts[`workflows/${f}`] = n;
  }
  return { counts, filesScanned, bytesScanned };
}

/**
 * The banked violations, read from `.claude/config-access-ratchet.json`.
 *
 * Data rather than a constant, because `lib/conformity.ts` travels into every
 * scaffolded project and rungate's own numbers have no business there. A
 * consumer with no ratchet file gets `{}` — zero tolerance, which is the
 * right default for a tree that has never had the defect.
 *
 * NOT `.claude/rungate*`, deliberately: this is harness metadata about a
 * migration, not project config, and routing it through the loader would make
 * the check depend on the thing it is enforcing access to.
 */
export function readConfigAccessRatchet(
  root: string,
  scope: "sources" | "workflows" | "all" = "all",
): Record<string, number> {
  const p = join(root, ".claude", "config-access-ratchet.json");
  if (!existsSync(p)) return {};
  const raw = JSON.parse(readFileSync(p, "utf-8"));
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "number") continue;
    // One file, two checks. Scoping matters because the both-ways ratchet
    // complains about a banked entry with no violations left, and CHECK-1
    // never scans `workflows/` — without this it would demand the removal of
    // every entry CHECK-2 owns, and vice versa.
    const isWorkflow = k.startsWith("workflows/");
    if (scope === "sources" && isWorkflow) continue;
    if (scope === "workflows" && !isWorkflow) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Turn a scan into refusals. Empty allows. BOTH DIRECTIONS.
 *
 * Over its number refuses, and so does UNDER — an entry that has stopped
 * being a violation is an entry nobody will ever remove, and the list rots
 * into one more artefact that certifies nothing. A file absent from the
 * ratchet is allowed nothing, which is ADR-002 D4's requirement that the
 * ratchet "refuses on any new file entering the violation set even while the
 * count is above zero": the migration window is exactly when the next reader
 * is most likely to be written.
 *
 * An EMPTY SCAN REFUSES. A conformity check that silently scans zero files
 * reports zero violations and is indistinguishable from compliance, which is
 * this repo's defining defect and would be the most embarrassing possible
 * place to reproduce it (ADR-002 D4, mutation 5).
 */
export function configAccessViolations(
  scan: ConfigAccessScan,
  banked: Record<string, number>,
  label: string,
  requireNonEmpty = true,
  evidence?: SourceEvidence,
): string[] {
  const out: string[] = [];
  if (requireNonEmpty && scan.filesScanned === 0) {
    // Name the source that made this refusal happen. Without it the consumer
    // reads "the scan read NO files" on a project they believe has no code,
    // with nothing pointing at the file responsible — which is the difference
    // between a two-minute fix and an undiagnosable red. `SourceEvidence`
    // already collects up to three paths and its docstring has always
    // promised this; nothing read the field until now.
    const why = evidence?.found && evidence.examples.length > 0
      ? ` This project DOES contain source — ${evidence.examples.join(", ")}` +
        `${evidence.examples.length === 3 ? " (first 3)" : ""} — none of it in the ` +
        `directories this check reads, so the check is blind rather than satisfied.`
      : evidence && evidence.unreadable.length > 0
        ? ` The source walk could not read ${evidence.unreadable.join(", ")}, so ` +
          `"no code here" could not be established.`
        : "";
    return [
      `${label}: the scan read NO files. A check that scans nothing reports ` +
        `zero violations and cannot be told from compliance — refusing rather ` +
        `than reporting clean (ADR-002 D4).${why}`,
    ];
  }
  if (requireNonEmpty && scan.filesScanned > 0 && scan.bytesScanned === 0) {
    return [`${label}: ${scan.filesScanned} files were walked and none had any content.`];
  }

  for (const [file, n] of Object.entries(scan.counts).sort()) {
    const allowed = banked[file] ?? 0;
    if (n > allowed) {
      out.push(
        `${label}: ${file} has ${n} direct config access site(s), ${allowed} allowed. ` +
          `Only ${CONFIG_LOADER} may read the config (ADR-002 D1). Use ` +
          `loadRungateConfig / tryLoadRungateConfig / resolveConfig.`,
      );
    } else if (n < allowed) {
      out.push(
        `${label}: ${file} is banked at ${allowed} but only ${n} remain — lower the ` +
          `number in .claude/config-access-ratchet.json in the same commit that earned it.`,
      );
    }
  }
  for (const [file, allowed] of Object.entries(banked).sort()) {
    if (allowed > 0 && !(file in scan.counts)) {
      out.push(
        `${label}: ${file} is banked at ${allowed} but has no violations left — ` +
          `remove its entry from .claude/config-access-ratchet.json.`,
      );
    }
  }
  return out;
}

/**
 * Why an empty scan is UNMEASURED rather than a refusal — or `null` when it is
 * a refusal after all (#476).
 *
 * `configAccessViolations`'s empty-scan refusal is correct and stays. What it
 * cannot do on its own is tell two situations apart, because both reach it as
 * `filesScanned === 0`:
 *
 * | Situation | Verdict |
 * |---|---|
 * | a code project whose file walk broke | **refuse** — this is what the refusal is for |
 * | a content project that has no sources of that kind | UNMEASURED, and say so |
 *
 * `--profile=minimal` (#449) exists so a project can take rungate's structure
 * without the ship harness, and the first consumer to use it — a Claude Code
 * plugin shipping a skill, a spec and two reference files, with deliberately
 * no executable surface — got a conformity suite with one permanently-red
 * check it could only satisfy by adding TypeScript it does not want.
 *
 * **Two questions, not one decider asked twice.** `scan.filesScanned` answers
 * "did I read anything"; `sourcesPresent` answers "was there anything to
 * read", over a different directory list and a different traversal
 * (`lib/typescript-project.ts`, #87's one decider for that fact). A project
 * with TypeScript the walk failed to reach still refuses, which is case 3.
 *
 * It returns a REASON, never a bare boolean: `0`, `{}`, `null` and `SKIP` are
 * all indistinguishable from success and `UNMEASURED` is not
 * (`.claude/rules/config-access.md`). A check that skips has to be able to say
 * what it skipped over.
 *
 * The waiver this replaces was `requireNonEmpty = scan.filesScanned > 0`,
 * which required a non-empty scan only when the scan was already non-empty —
 * a blanket disable wearing a conditional's clothes, so CONFIG-2's empty-scan
 * refusal had never been reachable.
 */
/** Anything that can carry code. Deliberately WIDER than any scanner's filter. */
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/** Directories that hold code nobody wrote, or output nobody edits. */
const SOURCE_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next", ".output", "vendor",
]);

/**
 * Test directories and test files — excluded from BOTH readings, by ADR-002 D4.
 *
 * One declaration, consulted by `walkSources` (which produces the scan) and
 * by `projectSourceEvidence` (which decides whether an empty scan is
 * believable). **They have to agree.** The evidence walk asks "should the
 * scan have found something?", so a file the scan would never read is not an
 * answer to that question.
 *
 * The first draft of this fix had them disagree, and the cost was precise:
 * the scaffold writes `tests/scaffold-conformity.test.ts`, which on a
 * `--profile=minimal` content project is the ONLY code-extension file in the
 * tree. The evidence walk saw it, reported source present, and CONFIG-1
 * refused with "the scan read NO files" — on every scaffolded content
 * project, unsatisfiably, since the only ways out were adding config-reading
 * source the project does not want or deleting the suite. **The file that
 * made the evidence true was the generated suite running the check.** That is
 * #476's original complaint — a permanently-red check — arriving through the
 * fix for the fix, measured end-to-end by running the real CLI rather than
 * reasoned about.
 */
// There is deliberately no TEST_DIRECTORY exclusion. `isTestSourceFile`
// below is the only test-related skip, and sec-500 established that the
// directory form was never needed: the scaffold writes exactly one file
// into a test directory (`test/scaffold-conformity.test.ts`, the whole of
// sec-476's B1), and the filename predicate already matches it.
//
// The case the directory skip was defending — `tests/helpers/setup.ts`, a
// non-test file in a test directory — described a project that cannot
// exist in the state where it would matter. The waiver is only reached
// when a project has NO production source, and a project with test
// helpers has production source, so `filesScanned > 0` and the waiver is
// never consulted. Meanwhile the skip cost a real hole: a non-test file
// in `tests/` carrying a live `join(process.cwd(), ".claude", ...)` was
// waived.
export function isTestSourceFile(name: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name);
}

/**
 * Tool configuration at the project root is not the project's source.
 *
 * `prettier.config.js`, `vite.config.ts`, `jest.config.js`. A policy call,
 * and it is the one place this walk is deliberately narrower than "any file
 * with a code extension", so the reasoning is written down rather than
 * implied:
 *
 * The question is "should the scan have read something?" — and the cost of
 * the two wrong answers is wildly asymmetric. Answering yes wrongly gives
 * every content project with a prettier config a permanently red, literally
 * unsatisfiable CONFIG-1, which is the defect #476 was filed about. Answering
 * no wrongly waives a project whose only direct rungate-config read is inside
 * a build tool's config file, which is not a thing that happens — these files
 * configure the tool that loads them and nothing else reads them.
 *
 * Root level only. A `src/app.config.ts` is ordinary source and is counted.
 */
function isRootToolConfig(rel: string, name: string): boolean {
  return !rel.includes("/") && /\.config\.[cm]?[jt]s$/.test(name);
}

/**
 * Whether this project contains code at all, and whether the answer is
 * trustworthy (#476 follow-up).
 *
 * `found` is deliberately BROADER than what any individual check scans —
 * every code extension, every directory, the whole tree. That direction is
 * the whole point. The question it answers is "is this a project with code
 * in it", and a narrower answer turns a blind check into a clean one.
 *
 * `unreadable` exists because "there is no code" and "I could not look" are
 * different facts that a swallowed `readdirSync` makes identical. Before the
 * waiver existed, swallowing was harmless: a failed walk left `filesScanned`
 * at zero and the refusal fired. With a waiver reading the same silence, two
 * fail-opens point the same way and a chmod turns a FAIL into a green run.
 */
export interface SourceEvidence {
  /** The project contains at least one source file somewhere. */
  found: boolean;
  /** Up to three paths, so a refusal can name what went unscanned. */
  examples: string[];
  /** Directories the walk could not read. Non-empty means `found` is unreliable. */
  unreadable: string[];
  /**
   * Entries the walk DECLINED to look at, and why.
   *
   * The third state, and #500's own complaint turned on itself. With only
   * `found` and `unreadable`, a declined entry is indistinguishable from an
   * absent one, and the waiver went on to assert "no source files of any
   * kind were found anywhere in the tree" — a sentence the walk never
   * established and which is FALSE for every skip class below. "True
   * sentence, wrong inference" was this issue's headline; this was the
   * sentence becoming untrue.
   *
   * Recorded rather than fixed by widening, because most of the skips are
   * correct: a content project with a `.github/` release script really does
   * have no project source. What is not correct is saying nothing is there.
   */
  skipped: string[];
}

/**
 * Directories that can never hold the project's own source, so a decline is
 * not worth recording. `.git` and `node_modules` are the whole list, and
 * both were cluttering the waiver message with facts true of every repo.
 */
const NEVER_PROJECT_SOURCE = new Set([".git", "node_modules"]);

/**
 * Scripts the config scan cannot read but a project can absolutely be built
 * from. A `lib/loader.py` or a `hooks/run.sh` doing a direct config read is
 * invisible to `SOURCE_EXTENSIONS` and therefore to CONFIG-1 — which is a
 * defensible limit for a TypeScript check, and an indefensible silence.
 */
const SCRIPT_LIKE = /\.(py|rb|sh|bash|zsh|fish|pl|php|lua|r|go|rs|java|kt|swift|ex|exs)$/i;

export function projectSourceEvidence(root: string): SourceEvidence {
  const examples: string[] = [];
  const unreadable: string[] = [];
  const skipped: string[] = [];
  // Symlinked source directories ARE followed — `packages/core` behind
  // `lib/impl` is an ordinary monorepo shape, and a predicate that cannot see
  // it waives a project full of code. `realpathSync` keys the visited set so
  // a cycle terminates instead of hanging.
  const seen = new Set<string>();
  const stack: Array<[string, string]> = [[root, ""]];
  // The walk may not leave the project. A symlink to `$HOME` or `/` would
  // otherwise make `found` true because of code that is not in this project,
  // and walk the whole of it to decide that.
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { found: false, examples: [], unreadable: ["."], skipped: [] };
  }
  const insideProject = (p: string) => p === rootReal || p.startsWith(rootReal + sep);

  while (stack.length > 0) {
    const [dir, rel] = stack.pop()!;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      unreadable.push(rel || ".");
      continue;
    }
    if (!insideProject(real)) {
      if (rel) skipped.push(`${rel}/ (directory resolving outside the project)`);
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable.push(rel || ".");
      continue;
    }
    for (const e of entries) {
      const childRelEarly = rel ? `${rel}/${e.name}` : e.name;
      // RECORDED, not dropped. An earlier cut skipped `.git` and
      // `node_modules` entirely on the grounds that they can never hold the
      // project's own source — true, and still the wrong move, because
      // "I declined 400 entries under node_modules/" is honest and short
      // while silence is neither (sec-485). They collapse to one counted
      // line in the message, which gets the brevity without the silence.
      if (NEVER_PROJECT_SOURCE.has(e.name)) {
        skipped.push(`${childRelEarly}/ (dependency or VCS metadata)`);
        continue;
      }
      // Recorded whether or not it holds anything, and that is deliberate.
      // An earlier cut ran a bounded recursive walk here and recorded the
      // decline only for directories that turned out to contain source,
      // on the grounds that an empty `dist/` is not a fact about this
      // project. sec-485 took it apart and was right: this field is a log
      // of DECISIONS, and the walk declined either way. Measured against
      // the implementation — one tree, one set of decisions, `dist/` empty
      // and then holding a build artifact — the predicate made the evidence
      // record differ between the two, so a reader auditing a waiver saw a
      // different list depending on whether CI had run. A tracked-but-empty
      // `dist/` on a clean checkout is the live shape of that, not a
      // contrived one.
      //
      // What it cost to keep: a recursive walk inside the directories this
      // function exists specifically not to walk, build-state-dependent
      // evidence, and a second predicate to keep correct forever. What it
      // bought, once the message collapses by class: one name inside a
      // capped sample and one off a count. `test/config-access-conformity
      // .test.ts`'s "function of the DECISIONS" case holds this line.
      if (SOURCE_SKIP_DIRS.has(e.name)) {
        skipped.push(`${childRelEarly}/ (build output or dependency)`);
        continue;
      }
      // Tooling lives in dot-directories — `.github/scripts/release.js`,
      // `.husky/`, `.claude/`. `containsTypeScript` skipped every entry
      // starting with "." and this walk replaced it, so dropping that was a
      // silent widening: a release script is not the project's source, and a
      // content project that has one is not a project CONFIG-1 can measure.
      if (e.name.startsWith(".")) {
        skipped.push(`${childRelEarly}/ (dot-directory, tooling)`);
        continue;
      }
      const childRel = childRelEarly;
      const abs = join(dir, e.name);
      // `isDirectory()` is false for a symlink, so the stat is what makes a
      // symlinked directory visible at all.
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try {
          isDir = statSync(abs).isDirectory();
        } catch (err) {
          // A DANGLING symlink is not unmeasured — it is empty. It resolves
          // to nothing, so it cannot be hiding source, and counting it would
          // mean one broken link anywhere in a content project refuses
          // CONFIG-1 for the rest of the project's life. `unreadable` exists
          // for the case where source might be behind something we could not
          // open; that is a permission error, not a link to a file that does
          // not exist.
          //
          // The distinction is the ERRNO, not `existsSync`. The first draft
          // asked `existsSync(abs)`, which returns false for BOTH — so
          // `vendored -> /locked/inner`, with `/locked` at mode 000 and a
          // real config read inside, gave found=false, unreadable=[] and a
          // clean UNMEASURED. The code was invisible AND the walk did not
          // record that it could not look, which is the exact failure the
          // `unreadable` guard exists to prevent, reintroduced inside the
          // guard itself.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") unreadable.push(childRel);
          continue;
        }
      }
      if (isDir) {
        stack.push([abs, childRel]);
      } else if (!SOURCE_EXTENSIONS.test(e.name) && SCRIPT_LIKE.test(e.name)) {
        // Code in a language this check cannot read. sec-500's point, and
        // the reason keying on "extension-less" would have been too narrow:
        // a project whose only config-reading code is `lib/loader.py` or
        // `bin/run.sh` got `skipped: []` and the fallback sentence "the walk
        // found no files of any kind that it counts as source" — which is
        // LITERALLY TRUE, and that is exactly what would have let it outlive
        // the fix. Anywhere in the tree, not just the scan dirs, because
        // `bin/` is not a scan dir and `bin/run.sh` was the example.
        skipped.push(`${childRel} (${e.name.slice(e.name.lastIndexOf("."))} — not a language this check reads)`);
      } else if (
        !SOURCE_EXTENSIONS.test(e.name)
        && !e.name.includes(".")
        && CONFIG_SCAN_DIRS.some(d => childRel === d || childRel.startsWith(`${d}/`))
      ) {
        // An extension-less executable INSIDE a directory this check scans.
        // sec-500's sharpest case, and not hypothetical: this repo ships two
        // of them (`scripts/git-hooks/pre-commit`, `scripts/git-hooks/pre-push`).
        // A node or shell script with no extension reading the config is
        // invisible to `SOURCE_EXTENSIONS`, so the project reads as having no
        // code while carrying a live direct read in a scanned directory.
        //
        // Recorded, not counted: deciding these are source would make every
        // git hook, `Makefile` and CI shim project source, which is a much
        // larger change than this issue. Naming it is what stops the next
        // reader having to rediscover it.
        skipped.push(`${childRel} (extension-less file in a scanned directory)`);
      } else if (SOURCE_EXTENSIONS.test(e.name) && e.name.endsWith(".d.ts")) {
        skipped.push(`${childRel} (type declarations)`);
      } else if (SOURCE_EXTENSIONS.test(e.name) && isTestSourceFile(e.name)) {
        skipped.push(`${childRel} (test file)`);
      } else if (SOURCE_EXTENSIONS.test(e.name) && isRootToolConfig(childRel, e.name)) {
        skipped.push(`${childRel} (root tool config)`);
      } else if (SOURCE_EXTENSIONS.test(e.name)) {
        // The three exclusions that used to be repeated here —
        // `!endsWith(".d.ts")`, `!isTestSourceFile`, `!isRootToolConfig` —
        // are GONE, and their absence is the point. The `else if` chain
        // above already consumes each of those files to record the decline,
        // so re-asking here could never change the outcome: mutating any of
        // the three was 0 red against a prediction of 3, and the three
        // branches above were holding all of it up.
        //
        // Three collapsed pairs, introduced by the commit that added the
        // recording and caught by the battery rather than by reading. The
        // rubric offers two fixes and this is the first one — delete a
        // decider, do not feed it — because the recording branch has to
        // exist anyway and a second copy of its question cannot ever
        // disagree with it.
        // A symlinked FILE is containment-checked too. The directory check
        // above cannot see this case, so `linked.ts -> /outside/x.ts` made
        // `found` true on the strength of code outside the project — which
        // contradicts the invariant the directory check exists to state.
        // Checked here rather than assumed, because "the walk cannot leave
        // the project" is either true of both kinds of entry or it is not a
        // property at all.
        if (e.isSymbolicLink()) {
          try {
            if (!insideProject(realpathSync(abs))) {
              // Recorded. "I chose not to look" was rendering identically to
              // "there was nothing there", which is the distinction
              // `unreadable` exists to preserve — and a pnpm/npm-workspace
              // monorepo with `lib/impl -> ../../packages/core` is an
              // ordinary shape, not an attack. The containment decision is
              // right; the silence was not.
              skipped.push(`${childRel} (symlink pointing outside the project)`);
              continue;
            }
          } catch {
            continue;
          }
        }
        if (examples.length < 3) examples.push(childRel);
      }
    }
  }
  // Ranked, then alphabetical. `readdir` order is neither, so WHICH entries
  // survived the message's truncation differed per machine and per tree —
  // sec-500's point that a consumer and CI could be shown different lists,
  // which makes the message unciteable in a bug report. Ranking also puts
  // the classes that can plausibly hold first-party code above the ones
  // that cannot, so the truncation cuts the least useful entries first
  // rather than arbitrary ones.
  const rank = (entry: string) =>
    /\((?:symlink|directory resolving)/.test(entry) ? 0     // escaped the project
      : /\(extension-less|not a language this check reads/.test(entry) ? 1  // code, unparseable
      : /^(?:build|vendor)\//.test(entry) ? 2                 // generated-from-source
      : /\(dot-directory/.test(entry) ? 3                      // tooling, can hold scripts
      : /\(test (?:file|directory)/.test(entry) ? 4
      : 5;                                                   // dist, coverage, .d.ts
  skipped.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return { found: examples.length > 0, examples, unreadable, skipped };
}

/**
 * Why an empty scan is UNMEASURED rather than a refusal — or `null` when it is
 * a refusal after all (#476).
 *
 * THREE conditions, not two, and the second and third were both missing from
 * the first version of this. A security review found five project layouts
 * carrying a real direct config read that flipped from FAIL to green:
 * `lib/loader.mjs`, `lib/loader.cjs`, `src/app.js`, `bin/cli.ts` and a
 * root-level `index.ts`. The waiver asked `isTypeScriptProject`, which
 * matches `.tsx?` under `TS_SOURCE_DIRS`, while the scan reads `.ts` AND
 * `.js` under a different list — so wherever the scan's reach exceeded the
 * predicate's, a blind check reported clean. `lib/loader.mjs` is the
 * sharpest: the file sits in the FIRST directory CONFIG-1 walks, and the
 * waiver told the consumer the project had no TypeScript. True sentence,
 * wrong inference.
 *
 * The replacement cannot have that defect by construction: `found` is
 * answered over every code extension in the whole tree, so it can never be
 * narrower than a scanner's filter. Widening a scanner later cannot open a
 * hole in it.
 */
/**
 * Collapse the decline list by class, with a count and a capped sample.
 *
 * The first cut printed the first eight entries and ", and N more". On
 * rungate itself the list is 320 entries of which 310 are test files, so
 * the cap showed ten test files and hid everything else — including the two
 * extension-less scripts in scanned directories, which are the entries most
 * likely to explain a waiver and the ones sec-500 filed the issue about.
 *
 * Collapsing rather than dropping is sec-485's correction to my first
 * remedy, and it is the better shape for the reason that applies to this
 * whole field: **every decline stays distinguishable from an absence**, and
 * the reader still gets a message they can read. Dropping entries to shorten
 * the list reintroduces exactly the silence `skipped` exists to remove.
 *
 * The class is the parenthetical each decline already carries, and ordering
 * follows the ranked array, so the classes that can plausibly hold
 * first-party code come first.
 */
function summariseDeclines(skipped: string[], sample = 3): string {
  const order: string[] = [];
  const byClass = new Map<string, string[]>();
  for (const entry of skipped) {
    const m = /^(.*) \(([^()]*)\)$/.exec(entry);
    const kind = m ? m[2] : "other";
    const path = m ? m[1] : entry;
    if (!byClass.has(kind)) {
      byClass.set(kind, []);
      order.push(kind);
    }
    byClass.get(kind)!.push(path);
  }
  return order
    .map(kind => {
      const paths = byClass.get(kind)!;
      const shown = paths.slice(0, sample).join(", ");
      // `kind: N (samples)` rather than `N kinds (samples)`. Pluralising
      // the class prose correctly means handling "test file" -> "test
      // files" but "dot-directory, tooling" -> "dot-directories, tooling"
      // and "type declarations" -> unchanged, and a regex that gets that
      // wrong prints "40 tests file" — which it did. Putting the count
      // after the label sidesteps the whole problem and reads better in a
      // list.
      return `${kind}: ${paths.length}` + (paths.length > sample ? ` (${shown}, …)` : ` (${shown})`);
    })
    .join("; ");
}

export function unmeasuredScanReason(
  scan: ConfigAccessScan,
  evidence: SourceEvidence,
  label: string,
  sourceKind: string,
): string | null {
  // Something was read, so the check measured. Asked first: a non-empty scan
  // is never waived no matter what else is true.
  if (scan.filesScanned > 0) return null;
  // The walk could not complete. "No code here" and "I could not look" are
  // the same silence, and only one of them is a reason to waive.
  if (evidence.unreadable.length > 0) return null;
  // There IS code and this check read none of it. That is a blind check, the
  // first row of the table above, and it must refuse.
  if (evidence.found) return null;
  // What the walk ACTUALLY established, which is narrower than "nothing is
  // there". It looked outside the scan dirs, found no source it counts, and
  // declined to look at these. Naming the declines is the whole fix: the
  // previous sentence asserted "no source files of any kind were found
  // anywhere in the tree", which is false for every skip class and is this
  // issue's own headline complaint — a true-sounding sentence the walk never
  // established — reintroduced in the waiver that #500 added.
  const declined =
    evidence.skipped.length > 0
      ? ` It declined ${evidence.skipped.length} entr${evidence.skipped.length === 1 ? "y" : "ies"}: ` +
        summariseDeclines(evidence.skipped) +
        `. So this is "no source this check counts", not "no files here".`
      : ` The walk found no files of any kind that it counts as source.`;
  return (
    `UNMEASURED: ${label} read no files because this project has no ${sourceKind}.` +
    `${declined} ` +
    `Nothing was checked, which is NOT the same as nothing being wrong — if this ` +
    `project grows ${sourceKind}, this check starts measuring again on the next run.`
  );
}

/**
 * SUCCESS-1 — the project states what it is for, falsifiably (#485).
 *
 * `CLAUDE.md` calls `SUCCESS.md` the measure and the scaffold never wrote
 * one, so `specs/HARNESS-STANDARD.md` carried SC-822..824 asserting
 * properties of a file that did not exist in any consumer.
 *
 * Absent is UNMEASURED and present-but-unfilled is a REFUSAL, and the
 * asymmetry is the point: a project that never opted in has not failed at
 * anything, while a project that ran the generator and stopped has a
 * document that every "does it exist" check waves through. The second is
 * the case this check is for.
 */
export function runSuccessDocValidation(root: string) {
  describe("SUCCESS.md (#485)", () => {
    test("SUCCESS-1: the project states what it is for, and how each claim fails", () => {
      const verdict = successViolations(readSuccessDoc(root), readSuccessTemplate());
      if (verdict.unmeasured) {
        addFinding({
          ruleId: "SUCCESS-1",
          severity: "WARN",
          file: "SUCCESS.md",
          message: verdict.unmeasured,
        });
        return;
      }
      for (const v of verdict.violations) {
        addFinding({
          ruleId: "SUCCESS-1",
          severity: "FAIL",
          file: "SUCCESS.md",
          message: v,
          fixCommand: "Fill in SUCCESS.md — see bunx rungate create-success",
        });
      }
      expect(verdict.violations, verdict.violations.join("\n")).toEqual([]);
    });
  });
}

/**
 * CHECK-1 — direct config access in TypeScript sources (ADR-002 D4).
 *
 * FAILS; does not warn. `DEPTH-1` and `ABSENCE-1` only `console.warn`, and
 * warnings are how 89 sites accumulated with the policy written down.
 */
export function runConfigAccessValidation(root: string) {
  describe("Config access (ADR-002 D1)", () => {
    test("CONFIG-1: only the loader reads the rungate config", () => {
      const scan = scanConfigAccess(root);
      const evidence = projectSourceEvidence(root);
      const unmeasured = unmeasuredScanReason(
        scan,
        evidence,
        "CONFIG-1",
        "TypeScript or JavaScript in lib/, gates/, scripts/, hooks/ or generators/",
      );
      if (unmeasured) {
        addFinding({
          ruleId: "CONFIG-1",
          severity: "WARN",
          file: "",
          message: unmeasured,
        });
        return;
      }
      const violations = configAccessViolations(
        scan,
        readConfigAccessRatchet(root, "sources"),
        "CONFIG-1",
        true,
        evidence,
      );
      for (const v of violations) {
        addFinding({
          ruleId: "CONFIG-1",
          severity: "FAIL",
          file: v.split(": ")[1]?.split(" ")[0] || "",
          message: v,
          fixCommand: "Route the read through lib/config-loader.ts",
        });
      }
      expect(violations, violations.join("\n")).toEqual([]);
    });
  });
}

/**
 * CHECK-2 — config access inside workflow prompt text (ADR-002 D4).
 *
 * The check ADR-001 did not have, and the reason its single check would have
 * been insufficient: `ship.js:1637` reaches the config from inside a prompt.
 * Allowlist is empty — no workflow has any business reading it directly.
 */
export function runPromptConfigAccessValidation(root: string) {
  describe("Config access in workflows (ADR-002 D4)", () => {
    test("CONFIG-2: no workflow reaches the rungate config, prompts included", () => {
      const scan = scanPromptConfigAccess(root);
      // A project with no workflows/ directory is not in violation. A project
      // that HAS one and read nothing out of it still refuses — the previous
      // waiver here was `scan.filesScanned > 0`, which could never be false
      // at the point it was read (#476).
      const unmeasured = unmeasuredScanReason(
        scan,
        { found: existsSync(join(root, "workflows")), examples: [], unreadable: [], skipped: [] },
        "CONFIG-2",
        "workflows/ directory",
      );
      if (unmeasured) {
        addFinding({
          ruleId: "CONFIG-2",
          severity: "WARN",
          file: "",
          message: unmeasured,
        });
        return;
      }
      const violations = configAccessViolations(
        scan,
        readConfigAccessRatchet(root, "workflows"),
        "CONFIG-2",
      );
      for (const v of violations) {
        addFinding({
          ruleId: "CONFIG-2",
          severity: "FAIL",
          file: v.split(": ")[1]?.split(" ")[0] || "",
          message: v,
          fixCommand: "Point the prompt at the resolved-config artefact instead",
        });
      }
      expect(violations, violations.join("\n")).toEqual([]);
    });
  });
}

export function runAbsenceValidation(root: string) {
  describe("Absence validation", () => {
    test("ABSENCE-1: anti-criteria use absence verification", () => {
      const specsDir = join(root, "specs");
      if (!existsSync(specsDir)) return;
      for (const f of collectSpecFiles(specsDir)) { // #225 — subdirectories too
        const content = readFileSync(join(specsDir, f), "utf-8");
        const antiCriteria = content.match(/^- \[ \] SC-A\d+:.+$/gm) || [];
        for (const ac of antiCriteria) {
          if (!ac.match(/not|never|no |absence|must not/i)) {
            console.warn(`WARN: Anti-criterion may not verify absence: ${ac.substring(0, 80)}`);
          }
        }
      }
    });
  });
}
