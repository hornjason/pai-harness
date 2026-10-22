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
 * So this module is three checks in cost order, each run only on what
 * survived the one before:
 *
 * | stage | question | instrument |
 * |---|---|---|
 * | `DUPLICATE` | is this new? | string sets over the finding bodies |
 * | `OFF_MAIN` | is this here? | `git grep` against `origin/main` |
 * | `STALE_CITATION` | is this current? | the file's line count |
 *
 * Stage 2 (a failing command as the evidence gate) and stage 3 (a vote over
 * what survives 1 and 2) are #1187's own sequencing and are **not** here.
 * They stay filed. The reason for the split is cost: the expensive instrument
 * must never be spent on what `git grep` settles, and a vote is the most
 * expensive instrument the harness has.
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
import { isAbsolute, join } from "path";

import { contentHash } from "./content-hash";
import { promoteCandidates, type PromotableCandidate, type PromotionReading } from "./rule-promotion";

/** A finding, as little of one as the three checks need. */
export interface Finding {
  /** How the caller names it — an issue number, or `new` for an unfiled one. */
  id: string;
  title: string;
  body: string;
}

export type SymptomKeyKind = "sym" | "file" | "qty";

/** How many cited symbols `OFF_MAIN` will pay a `git grep` for. */
const MAX_SYMBOLS_PROBED = 8;

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
 * Integers a finding reports as a reading.
 *
 * The exclusions are what make this a measurement and not a number: an issue
 * reference (`#1188`), an SC or AC id, a date component, and anything under
 * ten. Without the first of those, every finding that cites the same prior
 * issue collides with every other — which is a reading of the cross-reference
 * graph, not of the defect.
 */
function quantitiesIn(body: string): number[] {
  const out: number[] = [];
  // Blank out the shapes whose digits are identifiers rather than readings,
  // keeping the length so no two tokens are glued together by the removal.
  const masked = body
    .replace(/#\d+/g, m => " ".repeat(m.length))
    .replace(/\b(?:SC|AC|PR|H|R)-?\d+/gi, m => " ".repeat(m.length))
    .replace(/\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g, m => " ".repeat(m.length))
    .replace(/:\d+/g, m => " ".repeat(m.length))
    .replace(/\bv?\d+\.\d+(?:\.\d+)?/g, m => " ".repeat(m.length));
  for (const m of masked.matchAll(/\b\d[\d,]*\b/g)) {
    const n = Number.parseInt(m[0].replace(/,/g, ""), 10);
    if (Number.isFinite(n) && n >= 10) out.push(n);
  }
  return out;
}

/**
 * The keys a finding is deduplicated on.
 *
 * Sorted and de-duplicated, so two runs over one finding agree byte for byte
 * and a caller can print the intersection without re-deriving it.
 */
export function symptomKeys(finding: Finding): string[] {
  const keys = new Set<string>();
  // The title contributes symbols and paths but NOT quantities: a title
  // states a headline number the body also states, and counting it twice
  // would let two findings agree on one reading reported in two places.
  for (const span of [...codeSpans(finding.body), finding.title]) {
    for (const id of identifiersIn(span)) keys.add(`sym:${id}`);
  }
  for (const p of [...pathsIn(finding.body), ...pathsIn(finding.title)]) keys.add(`file:${p}`);
  for (const q of quantitiesIn(finding.body)) keys.add(`qty:${q}`);
  return [...keys].sort();
}

/** A stable identity for the symptom as a whole — the one hashing binding. */
export function symptomHash(finding: Finding): string {
  return contentHash(symptomKeys(finding).join("\n"));
}

/** Keys two findings have in common, sorted. */
export function sharedKeys(a: Finding, b: Finding): string[] {
  const left = new Set(symptomKeys(a));
  return symptomKeys(b).filter(k => left.has(k));
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
  const quantities = keys.filter(k => k.startsWith("qty:")).length;
  const locations = keys.length - quantities;
  return {
    duplicate:
      quantities >= DUPLICATE_MIN_SHARED_QUANTITIES &&
      locations >= DUPLICATE_MIN_SHARED_LOCATIONS,
    keys,
  };
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

/** `path:line` citations a finding makes. */
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
  }
  return out;
}

// ── The verdict ──────────────────────────────────────────────────────────

export type ArbiterRefusal =
  /** The symptom is already filed. `duplicateOf` names where. */
  | "DUPLICATE"
  /** No cited symbol exists on `origin/main`. A PR comment, not an issue. */
  | "OFF_MAIN"
  /** A cited line is past the end of the file it cites. */
  | "STALE_CITATION"
  /** Nothing in the finding could be evaluated. Fails; never skips. */
  | "UNMEASURED";

export interface Verdict {
  id: string;
  /** `true` only when every check that ran returned a reading, and passed. */
  file: boolean;
  refusal: ArbiterRefusal | null;
  /** Why, in words a reader can act on without re-running anything. */
  reason: string;
  /** Issue ids whose symptom this one collides with. */
  duplicateOf: string[];
  /** The keys that produced the collision. Empty when there was none. */
  collidingKeys: string[];
  /**
   * How many filed findings carry this symptom, this one included. #1187's
   * acceptance: a duplicate increments a count rather than opening an issue.
   */
  occurrences: number;
  symptomHash: string;
}

export interface ArbitrateOptions {
  /** Repository root. `origin/main` is read from here; never checked out. */
  projectRoot: string;
  /** Findings already filed. The dedupe compares against these only. */
  existing: readonly Finding[];
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
  const base = { id: finding.id, duplicateOf: [] as string[], collidingKeys: [] as string[], occurrences: 1, symptomHash: hash };

  const keys = symptomKeys(finding);
  if (keys.length === 0) {
    return {
      ...base,
      file: false,
      refusal: "UNMEASURED",
      reason: "the finding names no symbol, no file and no reading — nothing here can be evaluated",
    };
  }

  // ── 1. is this new? ──
  const collisions: Array<{ id: string; keys: string[] }> = [];
  for (const other of options.existing) {
    if (other.id === finding.id) continue;
    const overlap = duplicateOverlap(finding, other);
    if (overlap.duplicate) collisions.push({ id: other.id, keys: overlap.keys });
  }
  if (collisions.length > 0) {
    // Strongest overlap first, so the reader lands on the best match.
    collisions.sort((a, b) => b.keys.length - a.keys.length || a.id.localeCompare(b.id));
    return {
      ...base,
      file: false,
      refusal: "DUPLICATE",
      reason:
        `the symptom is already filed as ${collisions.map(c => c.id).join(", ")} — ` +
        `shared ${collisions[0].keys.length} key(s): ${collisions[0].keys.slice(0, 6).join(", ")}`,
      duplicateOf: collisions.map(c => c.id),
      collidingKeys: collisions[0].keys,
      occurrences: collisions.length + 1,
    };
  }

  if (options.skipRepoChecks === true) {
    return {
      ...base,
      file: false,
      refusal: "UNMEASURED",
      reason: "branch scope and citation currency were not read: skipRepoChecks",
    };
  }

  // ── 2. is this here? ──
  const symbols = citedSymbols(finding);
  if (symbols.length === 0) {
    return {
      ...base,
      file: false,
      refusal: "UNMEASURED",
      reason: "the finding cites no symbol, so whether it describes `origin/main` cannot be read",
    };
  }
  const probe = git(options.projectRoot, ["rev-parse", "--verify", "--quiet", "origin/main"]);
  if (!probe.ok) {
    return {
      ...base,
      file: false,
      refusal: "UNMEASURED",
      reason: `no origin/main at ${options.projectRoot} — branch scope is unreadable, which fails rather than passes`,
    };
  }
  const present = symbols.filter(
    s => git(options.projectRoot, ["grep", "--quiet", "--fixed-strings", "-e", s, "origin/main"]).ok,
  );
  if (present.length === 0) {
    return {
      ...base,
      file: false,
      refusal: "OFF_MAIN",
      reason:
        `none of the cited symbols exist on origin/main (${symbols.join(", ")}) — ` +
        "this is a comment on the branch that carries them, not an issue",
    };
  }

  // ── 3. is this current? ──
  const stale: string[] = [];
  for (const c of citedLines(finding)) {
    const abs = isAbsolute(c.path) ? c.path : join(options.projectRoot, c.path);
    let text: string | null = null;
    if (existsSync(abs)) {
      text = readFileSync(abs, "utf-8");
    } else {
      const shown = git(options.projectRoot, ["show", `origin/main:${c.path}`]);
      if (shown.ok) text = shown.out;
    }
    // A path that resolves nowhere is not a stale citation — stage 2 is
    // where an unresolvable citation is adjudicated, and guessing here would
    // put a second decider in front of it.
    if (text === null) continue;
    const lines = text.split("\n").length;
    if (c.line > lines) stale.push(`${c.path}:${c.line} (file is ${lines} lines)`);
  }
  if (stale.length > 0) {
    return {
      ...base,
      file: false,
      refusal: "STALE_CITATION",
      reason: `cited line(s) past the end of the file: ${stale.join("; ")} — re-read before filing`,
    };
  }

  return { ...base, file: true, refusal: null, reason: `cites ${present.join(", ")} on origin/main` };
}

/** One line a caller can print without re-deriving any of the above. */
export function verdictSummary(v: Verdict): string {
  return v.file ? `FILE ${v.id}: ${v.reason}` : `${v.refusal} ${v.id}: ${v.reason}`;
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

export interface BatchReading {
  /** Per-finding stage-1 verdicts, in input order. */
  verdicts: Verdict[];
  /** `lib/rule-promotion.ts`'s reading over the survivors. */
  promotion: PromotionReading;
  /** Ids cleared to file, after both the three checks and the budget. */
  toFile: string[];
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
 * A finding refused by any of the three checks is withheld before it reaches
 * the promoter, so it cannot be ranked above one that passed them.
 */
export function arbitrateBatch(
  findings: readonly Finding[],
  options: ArbitrateOptions & { budget?: number; now?: string },
): BatchReading {
  const verdicts = findings.map(f => arbitrate(f, options));
  const date = options.now ?? new Date().toISOString();

  const survivors: PromotableCandidate[] = verdicts
    .filter(v => v.file)
    .map(v => ({
      rule: findings.find(f => f.id === v.id)!.title,
      source: `finding:${v.id}`,
      hash: v.symptomHash,
      evidence: { kind: "finding" as const, date, citation: v.reason, issues: [] },
    }));

  // The arbiter's own reading is an upstream, so a batch in which nothing
  // could be evaluated does not report a measured zero.
  const unmeasured = verdicts.filter(v => v.refusal === "UNMEASURED");
  const promotion = promoteCandidates(survivors, {
    budget: options.budget ?? FILING_BUDGET_FINDINGS,
    upstream: {
      reading: unmeasured.length > 0 ? "UNMEASURED" : "MEASURED",
      unmeasuredReasons: unmeasured.map(v => `${v.id}: ${v.reason}`),
    },
  });

  return {
    verdicts,
    promotion,
    toFile: promotion.promoted.map(c => c.source.replace(/^finding:/, "")),
  };
}
