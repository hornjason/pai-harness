/**
 * What "the same answer twice" means for DISCOVERY's model output (#523).
 *
 * #61 bundled two questions and only answered one. `lib/workflow-test-harness.ts`
 * proves the ORCHESTRATION is deterministic — same call graph, k=5, in
 * milliseconds, every suite run. This module is the other half: given the same
 * issue, does the model produce the same *decisions*?
 *
 * ## The equality this asserts, and the one it refuses to
 *
 * **Byte-identical model output is not the property.** Asserting it produces a
 * check that reds on wording and is disabled inside a week, which is strictly
 * worse than no check — see `.claude/rules/checks-must-be-able-to-fail.md`. So
 * this compares a NORMALISED PROJECTION, and the projection is chosen by one
 * criterion rather than by a hand-written list:
 *
 *   **A discovery field is required to be stable exactly when something
 *   downstream BRANCHES on it.**
 *
 * Variance in a field nothing reads is prose. Variance in a field a gate reads
 * means two runs of the same issue took different code paths — the harness
 * making a different decision about one input, which is the thing worth
 * measuring whatever it is called this month.
 *
 * Every entry in `STABLE_DISCOVERY_FIELDS` therefore carries `branchedOnBy`:
 * the consumer that makes it load-bearing. An entry with no branch consumer
 * does not belong here, and `NOT_ASSERTED` records what is deliberately
 * excluded so the silence is legible rather than accidental.
 *
 * ## What this is NOT
 *
 * Not a gate. The issue is explicit that a rerun next week measures a
 * different model-day, so a red row cannot be distinguished from drift; the
 * output is a dated MEASUREMENT. Nothing here is wired into a CI gate and
 * nothing should be. The CI-runnable part is the comparator's own behaviour,
 * tested against synthetic states — no model call, no flake.
 *
 * ## Why the refusals are the load-bearing part
 *
 * A comparator over k run states has three ways to report perfect stability
 * while having measured nothing, and all three have happened to instruments in
 * this repository:
 *
 *   1. **k < 2.** One run cannot vary. Reported as REFUSED, not as stable.
 *   2. **The runs are not the same input.** Measured on 2026-10-21 against the
 *      44 recorded run states in `~/.rungate`: exactly one issue (agentgrit
 *      #258) appears more than once, and all three of its runs carry a
 *      DIFFERENT `issueGoal` — they were re-dispatched with new instructions
 *      after a failure. Comparing them reports wild model instability when what
 *      actually varied was the prompt. `seriesInputIdentity` refuses that
 *      series rather than reporting its variance.
 *   3. **The projection read nothing.** A path that resolves to `undefined` in
 *      every run is identical in every run. `unobserved` names those, and a
 *      series where every declared field is unobserved is REFUSED.
 *
 * The first two are the reason this file exists at all rather than a `diff`.
 */

/** How two readings of one field are compared. */
export type Equality =
  /** Same string. For enums and paths a gate switches on. */
  | "exact"
  /** Same multiset of strings, order ignored. Discovery does not promise an order. */
  | "set"
  /** Same number of elements. The values are not compared. */
  | "count";

export interface StableField {
  /**
   * Dotted path into the workflow state. `[]` marks an array the remaining
   * segments are read from on every element — `acs[].id` reads `id` off each
   * entry of `acs`.
   */
  path: string;
  equality: Equality;
  /**
   * The consumer that BRANCHES on this field. This is the justification for
   * the entry, not a note about it: an entry whose consumer does not branch is
   * asserting stability on prose.
   */
  branchedOnBy: string;
  /**
   * The properties of the DISCOVERY object in `workflows/ship.js` that this
   * state path is written from — `sizing.ceremonyTier` in the state file is
   * `discovery.ceremonyTier` in the workflow, because ship.js flattens one
   * into the other when it writes the state.
   *
   * This is not documentation. `test/discovery-branch-coverage.test.ts` parses
   * the workflow, collects every discovery property a CONDITION reads, and
   * reddens on any name this mapping does not cover — which is how a branch
   * added tomorrow on a field nobody declared stable gets caught, instead of
   * the measurement quietly going on reporting "0 varied" over the wrong set.
   * An entry with no `readAs` covers no branch.
   */
  readAs?: readonly string[];
}

/** An exclusion, with the reason it is one. */
export interface NotAssertedField {
  path: string;
  reason: string;
  /** As `StableField.readAs` — the workflow properties this excuse covers. */
  readAs?: readonly string[];
}

/**
 * The fields a second run of the same issue must agree with the first on.
 *
 * Derived from the branch-point criterion above, not enumerated by taste. Each
 * path is checked against the real `WorkflowStateSchema` by
 * `test/discovery-stability.test.ts` — against the zod object that EMITS the
 * state, never against this list — so a renamed or deleted field reddens here
 * instead of silently becoming an unobservable field that is stable because it
 * is absent.
 */
export const STABLE_DISCOVERY_FIELDS: StableField[] = [
  {
    path: "sizing.ceremonyTier",
    equality: "exact",
    branchedOnBy:
      "the scope gate, Quinn local, container verify and prove each run or do not run on it (#215, #274). Variance here is two different pipelines.",
    readAs: ["ceremonyTier"],
  },
  {
    path: "sizing.predicted",
    equality: "exact",
    branchedOnBy:
      "feeds the ceremony tier floor (#215). The value is already a bucket label (XS/S/M/L), so exact equality on the label IS bucket equality — there is no finer reading to collapse.",
    readAs: ["sizing"],
  },
  {
    path: "acs[]",
    equality: "count",
    branchedOnBy:
      "prove verifies `criteriaResults` count against the SC count (#384). A varying count is a varying definition of done.",
    readAs: ["acs"],
  },
  {
    path: "acs[].id",
    equality: "set",
    branchedOnBy:
      "every per-AC result is keyed by id (#384). Compared as a set because discovery promises no ordering — the three recorded #258 runs emit AC-1..AC-6 in three different orders.",
    readAs: ["acs"],
  },
  {
    path: "acs[].evidenceMethod.type",
    equality: "set",
    branchedOnBy:
      "selects how the evidence is obtained, and the evidence-type ratio check reads it (#235).",
    readAs: ["acs"],
  },
  {
    path: "acs[].evidenceMethod.authoredCommand??command",
    equality: "set",
    branchedOnBy:
      "the scope gate dry-runs every one of them (#235). A command that varies is a gate that varies. `authoredCommand` FIRST and `command` only as the fallback: #614 records that three sites rewrite `command` after the model emits it (discovery's path normaliser, its evidence-type-ratio upgrade, and the git-ref qualification at the execution boundary), and those rewrites are deterministic harness behaviour. Reading `command` would attribute the normaliser's output to the model.",
    readAs: ["acs"],
  },
  {
    path: "governingSpec.path",
    equality: "exact",
    branchedOnBy:
      "selects which rules govern the run. Two runs reading different specs are not two runs of the same thing.",
    readAs: ["governingSpec"],
  },
  {
    path: "sourceSpecs[].path",
    equality: "set",
    branchedOnBy: "same as `governingSpec.path` — the set of rules in force.",
    readAs: ["sourceSpecs"],
  },
];

/**
 * Fields deliberately NOT asserted, with the reason.
 *
 * Written down because an unstated exclusion is indistinguishable from an
 * oversight, and the next reader otherwise has to re-derive why the obvious
 * field is missing.
 */
export const NOT_ASSERTED: NotAssertedField[] = [
  {
    path: "acs[].statement",
    reason:
      "prose. Wording is what a language model is for, and asserting it is the flaky-test failure mode this module exists to avoid.",
  },
  {
    path: "issueGoal",
    reason:
      "NOT A MODEL OUTPUT in the normal path. The ship skill pre-computes it from the issue body via `gh issue view` and hands it in as `goalData`, which makes the workflow skip the extraction agent entirely. A series that leaves `goalData` populated is measuring parsing. It is used here as the series' INPUT IDENTITY instead — see `seriesInputIdentity`.",
  },
  {
    path: "successCriteria",
    reason: "same as `issueGoal` — pre-computed from the issue body, not emitted by the model.",
  },
  {
    path: "acs[].threshold.op",
    reason:
      "a real candidate, deliberately deferred. The evidence pre-validation gate does compare evidence against the operator, so it plausibly meets the branch criterion — but it is not added on plausibility. Adding it needs the branch point read and cited the way every entry above is.",
  },
  {
    path: "priorWork",
    readAs: ["priorWork"],
    reason:
      "BRANCHED ON — `workflows/ship.js:3797` short-circuits the whole run on it, and its `acStatus` then selects which ACs survive into BUILD — and excluded anyway, which is why the reason has to be good. It is not a reading of the ISSUE, it is a reading of the REPOSITORY: whether a branch or PR for this issue already exists. Two runs of the same issue are therefore SUPPOSED to disagree here, because the first run creates the branch the second one finds. Asserting stability would red on the harness working correctly, which is the exact failure mode `.claude/rules/checks-must-be-able-to-fail.md` calls a check that cannot fail for the reason it claims to — inverted.",
  },
  {
    path: "acs[].verdict, acs[].evidence, gates.*, agents.*",
    reason: "not discovery output at all — written later in the run by the phases that produce them.",
  },
];

/** One run's recorded state, labelled so a report can name which run varied. */
export interface RunState {
  label: string;
  state: unknown;
}

export interface FieldReading {
  path: string;
  equality: Equality;
  /** One normalised reading per run, in the order the runs were given. */
  readings: { label: string; value: string }[];
  /** True when every run read the same thing under this field's equality. */
  stable: boolean;
  /** True when NO run produced a reading — identical, and meaningless. */
  unobserved: boolean;
}

export interface SeriesIdentity {
  identical: boolean;
  /** A short digest of each run's input, so a reader can see WHICH run differs. */
  fingerprints: { label: string; issue: string; goalDigest: string }[];
}

export type StabilityReport =
  | {
      verdict: "REFUSED";
      /** Why nothing was measured. Never a pass. */
      reason: string;
      identity?: SeriesIdentity;
    }
  | {
      verdict: "MEASURED";
      runs: string[];
      identity: SeriesIdentity;
      fields: FieldReading[];
      /** Fields that varied. The finding. */
      varied: FieldReading[];
      /** Fields no run produced a value for. Not evidence of stability. */
      unobserved: FieldReading[];
    };

/* ─────────────────────────── reading the state ─────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Collapse a value to the string the comparison uses.
 *
 * Whitespace is collapsed and the result trimmed: an evidence command
 * reflowed across two lines is the same command, and treating it as a
 * difference is the noise that gets a check disabled.
 */
function normalise(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    const t = v.replace(/\s+/g, " ").trim();
    return t === "" ? null : t;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/**
 * Resolve a declared path to the raw nodes it reaches, before normalisation.
 *
 * Kept separate from `readPath` because `count` has to count what the path
 * REACHED, not what survived normalisation: `acs[]` reaches two AC objects,
 * and an object normalises to nothing, so counting after normalisation
 * reported every run as having zero ACs — identical, and therefore stable,
 * for the one field whose whole point is that a varying count is a varying
 * definition of done.
 */
function resolveNodes(state: unknown, path: string): unknown[] {
  const segments = path.split(".");
  let frontier: unknown[] = [state];

  for (const rawSeg of segments) {
    const isArray = rawSeg.endsWith("[]");
    const seg = isArray ? rawSeg.slice(0, -2) : rawSeg;
    const alternatives = seg.split("??");
    const next: unknown[] = [];

    for (const node of frontier) {
      if (!isRecord(node)) continue;
      let picked: unknown = undefined;
      for (const name of alternatives) {
        if (node[name] !== undefined && node[name] !== null) {
          picked = node[name];
          break;
        }
      }
      if (picked === undefined) continue;
      if (isArray) {
        if (Array.isArray(picked)) next.push(...picked);
      } else {
        next.push(picked);
      }
    }
    frontier = next;
  }

  return frontier;
}

/**
 * The normalised readings one declared path produced — one entry for a scalar
 * path, one per array element for a `[]` path, and `[]` when the path resolves
 * to nothing. `a??b` as a segment reads `a` and falls back to `b`.
 */
export function readPath(state: unknown, path: string): string[] {
  return resolveNodes(state, path)
    .map(normalise)
    .filter((s): s is string => s !== null);
}

/**
 * The reading one field contributes for one run, already reduced by its
 * equality kind to the single string the comparison tests.
 */
function reduce(nodes: unknown[], equality: Equality): string | null {
  if (equality === "count") return String(nodes.length);
  const readings = nodes.map(normalise).filter((s): s is string => s !== null);
  if (readings.length === 0) return null;
  if (equality === "set") return [...readings].sort().join(" | ");
  // "exact": a scalar path. More than one reading means the path was written
  // for an array and declared as a scalar — report it rather than pick one.
  return readings.length === 1 ? readings[0] : `AMBIGUOUS(${readings.length}): ${readings.join(" | ")}`;
}

/* ───────────────────────────── input identity ──────────────────────────── */

/** A short, stable digest. Not cryptographic — it only has to separate inputs. */
function digest(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + s.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/**
 * Whether these runs are runs of THE SAME THING.
 *
 * This is the control the measurement needs and the one a plain diff has no
 * way to express. The three recorded runs of agentgrit #258 in `~/.rungate`
 * disagree on `sizing.predicted` three ways (M, XS, S) — which reads as severe
 * model instability until you notice their `issueGoal` values are three
 * different sets of instructions. They are one run each of three inputs, not
 * three runs of one input.
 */
export function seriesInputIdentity(runs: RunState[]): SeriesIdentity {
  const fingerprints = runs.map(r => {
    const s = isRecord(r.state) ? r.state : {};
    return {
      label: r.label,
      issue: String(s.issue ?? "?"),
      goalDigest: digest(normalise(s.issueGoal) ?? ""),
    };
  });
  const key = (f: { issue: string; goalDigest: string }) => `${f.issue}/${f.goalDigest}`;
  const identical = fingerprints.length > 0 && fingerprints.every(f => key(f) === key(fingerprints[0]));
  return { identical, fingerprints };
}

/* ──────────────────────────── the comparison ───────────────────────────── */

export function compareDiscoveryRuns(
  runs: RunState[],
  fields: StableField[] = STABLE_DISCOVERY_FIELDS,
): StabilityReport {
  if (runs.length < 2) {
    return {
      verdict: "REFUSED",
      reason: `a series of ${runs.length} cannot vary — k must be at least 2. One run reporting "stable" is the vacuous pass this comparator exists to refuse.`,
    };
  }

  const identity = seriesInputIdentity(runs);
  if (!identity.identical) {
    const shown = identity.fingerprints
      .map(f => `${f.label}: issue=${f.issue} goal=${f.goalDigest}`)
      .join("; ");
    return {
      verdict: "REFUSED",
      reason:
        `these runs do not share an input, so their differences measure the PROMPT, not the model. ` +
        `Re-dispatch the series with one fixed issue body and no re-instruction between runs. ` +
        `Fingerprints — ${shown}`,
      identity,
    };
  }

  if (fields.length === 0) {
    return {
      verdict: "REFUSED",
      reason: "no fields declared stable — a comparison over zero fields is stable over anything.",
      identity,
    };
  }

  const readings: FieldReading[] = fields.map(f => {
    const perRun = runs.map(r => ({
      label: r.label,
      value: reduce(resolveNodes(r.state, f.path), f.equality) ?? "«absent»",
    }));
    // Nothing was compared when no run produced a value — and for a `count`
    // that means a count of zero everywhere, which is "no ACs in any run",
    // not "every run agreed on the number of ACs".
    const nothing = f.equality === "count" ? "0" : "«absent»";
    const unobserved = perRun.every(p => p.value === nothing);
    const stable = perRun.every(p => p.value === perRun[0].value);
    return { path: f.path, equality: f.equality, readings: perRun, stable, unobserved };
  });

  const observable = readings.filter(r => !r.unobserved);
  if (observable.length === 0) {
    return {
      verdict: "REFUSED",
      reason:
        `not one of the ${fields.length} declared fields produced a value in any run. ` +
        `A projection that reads nothing reports perfect stability, which is why this is a refusal and not a pass.`,
      identity,
    };
  }

  return {
    verdict: "MEASURED",
    runs: runs.map(r => r.label),
    identity,
    fields: readings,
    varied: readings.filter(r => !r.stable && !r.unobserved),
    unobserved: readings.filter(r => r.unobserved),
  };
}

/** The dated measurement, as text. Never a verdict a gate consumes. */
export function formatStabilityReport(report: StabilityReport, measuredOn: string): string {
  const head = `Discovery-output stability (#523) — measured ${measuredOn}`;
  if (report.verdict === "REFUSED") {
    return `${head}\n\nUNMEASURED — ${report.reason}`;
  }
  const lines = [
    head,
    ``,
    `k = ${report.runs.length}: ${report.runs.join(", ")}`,
    `input identity: shared (issue ${report.identity.fingerprints[0].issue}, goal ${report.identity.fingerprints[0].goalDigest})`,
    ``,
    `${report.fields.length - report.unobserved.length} field(s) observed, ${report.varied.length} varied, ${report.unobserved.length} unobserved.`,
    ``,
  ];
  for (const f of report.fields) {
    const mark = f.unobserved ? "UNOBSERVED" : f.stable ? "stable    " : "VARIED    ";
    lines.push(`${mark} ${f.path} [${f.equality}]`);
    if (!f.stable || f.unobserved) {
      for (const r of f.readings) lines.push(`             ${r.label}: ${r.value}`);
    }
  }
  if (report.unobserved.length > 0) {
    lines.push(
      ``,
      `An UNOBSERVED field is not a stable one — no run produced a value, so nothing was compared.`,
    );
  }
  return lines.join("\n");
}
