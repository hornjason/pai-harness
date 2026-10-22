/**
 * Where observed-failure candidates come from, and how a source refuses when
 * its input is not there (#545).
 *
 * ## The decision this file is, and why it comes before a fourth scanner
 *
 * #545 names four intake sources. `lib/failure-intake.ts` ships one — `git
 * log` — and its docblock records why the other three stopped there: each
 * needs something a check running in the configuration CI runs it in does not
 * have.
 *
 * | Source | Needs | Present under an empty `HOME`, no credentials |
 * |---|---|---|
 * | `git log` fix/revert | the repository | yes |
 * | gate refusals | a populated run store | no |
 * | CI failures on merged PRs | an authenticated API client | no |
 * | transcript corrections | a session store, and a confidentiality decision | no |
 *
 * **A miner whose input is absent has no failing input, so it passes
 * vacuously.** Adding a second scanner before deciding how absence is
 * reported produces a detector that is green everywhere it matters — the
 * defect class `.claude/rules/checks-must-be-able-to-fail.md` opens with, one
 * level up, because here the thing that cannot fail is the thing that decides
 * what the rules are.
 *
 * So this module is the contract, not a scanner:
 *
 * - every source declares a **precondition** naming what it needs;
 * - a source whose precondition is unmet reports `UNMEASURED` with a reason
 *   that names the source AND the missing input — never an empty candidate
 *   list;
 * - the aggregate reads `MEASURED` only if **every registered source** did,
 *   so a reading cannot be completed by the sources that happened to work;
 * - and `test/intake-sources.test.ts` drives every registered source in a
 *   **barren context** — an empty directory, no repository, no store — and
 *   requires each to refuse there. A scanner added without a reachable
 *   unavailable state fails that case rather than passing silently.
 *
 * That last point is the mechanical half. It is cheap to write a source that
 * reports `MEASURED` over nothing; it is not possible to register one here
 * and keep the suite green.
 *
 * ## Why gate refusals are the second source and the other two are not
 *
 * The run store is **offline, local, and needs no credential** — the same
 * three properties that made `git log` first. CI failures need an
 * authenticated client, and transcripts need a confidentiality decision
 * nobody has made; both are still unregistered, deliberately, because
 * registering a source whose `read` cannot run is dead code wearing a
 * contract.
 *
 * ## What a gate refusal contributes that a commit subject cannot
 *
 * A `fix:` subject is one author's account of one failure. A gate refusal is
 * the harness's own record that a check stopped a run, and it REPEATS.
 * Measured across this machine's 44 run stores: 111 refusal entries over 19
 * distinct check names, 28 of the 44 runs carrying at least one. The most
 * frequent single check accounts for 22 of them.
 *
 * That ratio is the reason the dedup key here is the CHECK NAME and not the
 * entry: one candidate per entry would produce 111 candidates ranked by
 * recency, dominated by repeats of one check, against a promotion budget of
 * 16. One candidate per distinct check produces 19, and the repetition
 * becomes evidence rather than noise.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * - **A check that fails because it is broken, not because the tree is.** A
 *   flaky or mis-written gate check repeats exactly like a real one, and
 *   nothing here reads the detail to tell them apart. The repetition this
 *   module treats as evidence is the same signal in both cases.
 * - **Occurrence count does not reach the ranker.** It is written into the
 *   candidate's `context`, where a human reads it, and `lib/rule-promotion.ts`
 *   ranks on `evidence` alone. Wiring frequency into the score is a change to
 *   #544's criterion and is deliberately not taken here.
 * - **The store is this machine's, not the project's.** A candidate mined
 *   here cites a run id nobody else can resolve. That is why the source is
 *   UNMEASURED on a runner rather than merely empty — the citation is as
 *   local as the evidence.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

import { contentHash } from "./content-hash";
import type { EvidenceCandidate, FailureIntakeReading } from "./failure-intake";
import { mineFixCommits } from "./failure-intake";
import { workStoreRoot } from "./paths";

/**
 * Prefixes a reason that means "this source could not be read here", as
 * distinct from "this source was read and found nothing".
 *
 * Exported because a caller distinguishing the cases must compare against the
 * producer's own spelling rather than a second copy of it.
 */
export const SOURCE_UNAVAILABLE = "SOURCE_UNAVAILABLE";

/** The run store held no `workflow-state.json` this process could read. */
export const NO_RUN_STORE = "NO_RUN_STORE";
/** The store exists and a state file in it would not parse. */
export const RUN_STORE_UNREADABLE = "RUN_STORE_UNREADABLE";

/** Everything a source is allowed to read. Explicit so a test can be barren. */
export interface IntakeContext {
  /** The project being mined. */
  projectRoot: string;
  /** The run store root — `lib/paths.ts` owns the default. */
  workStore: string;
}

/**
 * The default context. Separate from `mineObservedFailures` so a caller can
 * mine a project without inheriting this machine's store, and so the test can
 * build one that is barren by construction.
 */
export function defaultIntakeContext(projectRoot: string): IntakeContext {
  return { projectRoot, workStore: workStoreRoot() };
}

export interface IntakeSource {
  /** Stable id. Appears in every reason this source produces. */
  id: string;
  /** What the source needs, in words a reader can act on. */
  needs: string;
  /**
   * `null` when the source can be read here; otherwise a short reason naming
   * what is absent. A source that can never return non-null has no reachable
   * unavailable state, which `test/intake-sources.test.ts` refuses.
   */
  precondition(ctx: IntakeContext): string | null;
  /** Only called when `precondition` returned `null`. */
  read(ctx: IntakeContext): FailureIntakeReading;
}

/**
 * The aggregate reading — `MEASURED` only when every registered source was,
 * and a union rather than a record so that **`candidates` exists only on the
 * measured variant**.
 *
 * The hazard that shape is for: a reader who takes `candidates.length`
 * without consulting `reading` gets a number that looks like a measurement
 * and is a function of something else entirely. The worked instance is this
 * repository's own development checkout — `mineFixCommits` correctly reports
 * `UNMEASURED` / `SHALLOW_HISTORY` there and still returns 182 candidates,
 * because the clone has a depth. 182 is a reading of a clone parameter, not
 * of the project's history, and nothing about the list says so.
 *
 * Adjacency does not fix that. A warning beside a number is read after the
 * number, if at all. So on the `UNMEASURED` variant the key is **absent**: a
 * consumer that narrows on `reading` is handed `candidates`, and one that
 * does not gets a type error at compile time and `undefined` at runtime,
 * which throws instead of returning something plausible. The partial list is
 * still reachable — withholding it would make a partial reading and an empty
 * one look alike — but under a name nobody reaches for by accident.
 *
 * **Applied here and deliberately not to `FailureIntakeReading`.** That type
 * is shipped and has a production consumer, and that consumer already does
 * the right thing: `scripts/extract-constraints.ts` spreads
 * `evidence.candidates` into the promotion AND passes the reading as an
 * `upstream`, so `promoteCandidates` folds `UNMEASURED` into its own verdict.
 * The hazard is latent there, not live. Converting a shipped type to prevent
 * a hazard nobody has hit is a wider change than this one should make.
 */
export type AggregateIntakeReading =
  | {
      reading: "MEASURED";
      unmeasuredReasons: string[];
      /** Per source, so "read and empty" and "not readable" stay tellable apart. */
      bySource: Record<string, FailureIntakeReading>;
      /** Every candidate every source produced. Present only on this variant. */
      candidates: EvidenceCandidate[];
    }
  | {
      reading: "UNMEASURED";
      unmeasuredReasons: string[];
      bySource: Record<string, FailureIntakeReading>;
      /**
       * What the sources that COULD be read produced. Deliberately not
       * spelled `candidates`: counting these is a decision, and the name is
       * the place that decision gets made.
       */
      partialCandidates: EvidenceCandidate[];
    };

// ── The gate-refusal source ──────────────────────────────────────────────

/** One refusal entry, as `workflow-state.json` writes it. */
interface StoredFailure {
  check?: unknown;
  result?: unknown;
}

function refusalsIn(state: unknown): Array<{ gate: string; check: string; ts: string }> {
  const out: Array<{ gate: string; check: string; ts: string }> = [];
  const gates = (state as { gates?: unknown } | null)?.gates;
  if (!gates || typeof gates !== "object") return out;
  for (const [gate, entry] of Object.entries(gates as Record<string, unknown>)) {
    const e = entry as { failures?: unknown; ts?: unknown } | null;
    if (!e || !Array.isArray(e.failures)) continue;
    const ts = typeof e.ts === "string" ? e.ts : "";
    for (const f of e.failures as StoredFailure[]) {
      if (!f || typeof f.check !== "string" || f.check.trim().length === 0) continue;
      out.push({ gate, check: f.check.trim(), ts });
    }
  }
  return out;
}

/**
 * Mine gate refusals out of the run store.
 *
 * **An unreadable state file is a refusal, not a skip.** `lib/gate-
 * enforcement.ts`'s reader of the same files wraps its walk in
 * `catch { /* skip *\/ }`, which converts a corrupt store into an empty one —
 * the fail-open `.claude/rules/config-access.md` names by name. Here a file
 * that will not parse pushes `RUN_STORE_UNREADABLE` and the reading says so,
 * because "no run ever refused" and "I could not read the runs" are opposite
 * facts about this project's history.
 */
export function mineGateRefusals(workStore: string): FailureIntakeReading {
  const unmeasuredReasons: string[] = [];
  if (!existsSync(workStore)) {
    return { reading: "UNMEASURED", unmeasuredReasons: [NO_RUN_STORE], commitsScanned: 0, candidates: [] };
  }

  let dirs: string[];
  try {
    dirs = readdirSync(workStore, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    return {
      reading: "UNMEASURED",
      unmeasuredReasons: [`${RUN_STORE_UNREADABLE}: ${(e as Error).message}`],
      commitsScanned: 0,
      candidates: [],
    };
  }

  /** check name → the evidence, newest kept. */
  const byCheck = new Map<
    string,
    { gate: string; ts: string; slug: string; issues: number[]; occurrences: number; runs: Set<string> }
  >();
  let statesRead = 0;

  for (const slug of dirs.sort()) {
    const path = join(workStore, slug, "workflow-state.json");
    if (!existsSync(path)) continue;
    let state: unknown;
    try {
      state = JSON.parse(readFileSync(path, "utf-8"));
    } catch (e) {
      unmeasuredReasons.push(`${RUN_STORE_UNREADABLE}: ${slug}: ${(e as Error).message}`);
      continue;
    }
    statesRead++;
    const issue = (state as { issue?: unknown }).issue;
    const issues = typeof issue === "number" ? [issue] : [];
    for (const r of refusalsIn(state)) {
      const prior = byCheck.get(r.check);
      if (prior === undefined) {
        byCheck.set(r.check, {
          gate: r.gate, ts: r.ts, slug, issues, occurrences: 1, runs: new Set([slug]),
        });
        continue;
      }
      prior.occurrences++;
      prior.runs.add(slug);
      // Newest citation wins, matching `mineFixCommits`' newest-first rule, so
      // a reader following the citation lands on the most recent observation.
      // An entry with no `ts` never displaces one that has a date.
      if (r.ts !== "" && r.ts > prior.ts) {
        prior.ts = r.ts;
        prior.gate = r.gate;
        prior.slug = slug;
        prior.issues = issues;
      }
    }
  }

  // A store directory with no state files in it is not a measured zero: the
  // walk found nothing to read, which is the NO_RUN_STORE case arriving by a
  // different route.
  if (statesRead === 0) unmeasuredReasons.push(NO_RUN_STORE);

  const candidates: EvidenceCandidate[] = [];
  for (const [check, ev] of [...byCheck.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // A refusal with no date is not evidence-backed — `CandidateEvidence`
    // says so in its own comment — so it is dropped rather than dated `""`.
    if (ev.ts === "") continue;
    candidates.push({
      rule: check,
      source: `run:${ev.slug}`,
      context:
        `gate '${ev.gate}' refused on this check — ` +
        `${ev.occurrences} occurrence(s) across ${ev.runs.size} run(s)`,
      hash: contentHash(check),
      evidence: { kind: "gate-refusal", date: ev.ts, citation: ev.slug, issues: ev.issues },
    });
  }

  return {
    reading: unmeasuredReasons.length > 0 ? "UNMEASURED" : "MEASURED",
    unmeasuredReasons,
    // Reusing the field's meaning: units of history this source actually read.
    commitsScanned: statesRead,
    candidates,
  };
}

// ── The registry ─────────────────────────────────────────────────────────

/**
 * Every source that is wired up. Adding one here puts it under
 * `test/intake-sources.test.ts`'s barren-context case immediately — which is
 * the point, and is why the two unregistered sources below are named in prose
 * rather than stubbed in code.
 */
export const INTAKE_SOURCES: readonly IntakeSource[] = [
  {
    id: "fix-commits",
    needs: "a git repository with unshallowed history",
    precondition: (ctx) =>
      existsSync(join(ctx.projectRoot, ".git")) ? null : "no git repository at the project root",
    read: (ctx) => mineFixCommits(ctx.projectRoot),
  },
  {
    id: "gate-refusals",
    needs: "a populated rungate run store (RUNGATE_WORK_DIR, or $HOME/.rungate)",
    precondition: (ctx) =>
      existsSync(ctx.workStore) ? null : `no run store at ${ctx.workStore}`,
    read: (ctx) => mineGateRefusals(ctx.workStore),
  },
];

/**
 * Read every registered source, and say which ones could not be read.
 *
 * The aggregate is `MEASURED` only when every source was. A reading completed
 * by the sources that happened to work is the Silent Default Substitution
 * this whole module exists to refuse: zero CI-failure candidates because
 * there is no API client reads exactly like zero because CI never failed.
 */
export function mineObservedFailures(
  ctx: IntakeContext,
  sources: readonly IntakeSource[] = INTAKE_SOURCES,
): AggregateIntakeReading {
  const bySource: Record<string, FailureIntakeReading> = {};
  const unmeasuredReasons: string[] = [];
  const candidates: EvidenceCandidate[] = [];

  for (const source of sources) {
    const missing = source.precondition(ctx);
    if (missing !== null) {
      const reason = `${SOURCE_UNAVAILABLE}: ${source.id}: ${missing} (needs ${source.needs})`;
      bySource[source.id] = {
        reading: "UNMEASURED",
        unmeasuredReasons: [reason],
        commitsScanned: 0,
        candidates: [],
      };
      unmeasuredReasons.push(reason);
      continue;
    }
    const reading = source.read(ctx);
    bySource[source.id] = reading;
    for (const r of reading.unmeasuredReasons) unmeasuredReasons.push(`${source.id}: ${r}`);
    candidates.push(...reading.candidates);
  }

  // The discriminator and the key are chosen together, in one place, so the
  // two cannot disagree — there is no path that reports UNMEASURED and still
  // hands back a `candidates` a caller can count without asking.
  if (unmeasuredReasons.length > 0) {
    return { reading: "UNMEASURED", unmeasuredReasons, bySource, partialCandidates: candidates };
  }
  return { reading: "MEASURED", unmeasuredReasons, bySource, candidates };
}
