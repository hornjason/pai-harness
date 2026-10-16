/**
 * Execute a workflow script with no agents, and record what it did (#61).
 *
 * WHAT THIS IS FOR
 *
 * `workflows/ship.js` is 7,300 lines of orchestration — phase boundaries,
 * ceremony paths, regression targets, schema handoffs — and the only way to
 * find out whether a change to it is correct has been to run the pipeline,
 * which costs real agents and fifteen minutes. So 98 test files read it as
 * TEXT instead, and this repo's own record is that every source-text
 * assertion it has written survived its first mutation.
 *
 * The harness earns its place by doing the one thing none of the other
 * mechanisms can: **executing the whole script and observing the ORDER of
 * what happened.** Not a region lifted out of markers, not a regex over the
 * source — the real control flow, with the real conditionals, reporting the
 * real sequence of phases and agent calls.
 *
 * It runs in well under a second because there is nothing in a workflow
 * script but control flow: the sandbox gives it no filesystem, no subprocess
 * and no imports (#69), so stubbing `agent`, `phase`, `log`, `parallel`,
 * `pipeline` and `workflow` removes everything slow by construction. That is
 * not a happy accident — it is the same property that makes the script
 * untestable by ordinary means.
 *
 * WHAT IT REFUSES TO DO
 *
 * **It will not invent a result for a call site that declares no schema.**
 * A mock that returns `{}` for an unschemaed call is a mock testing itself:
 * the script reads a field, gets `undefined`, and either throws somewhere
 * unrelated or silently takes a branch nobody chose. Those calls are
 * REPORTED, in `unschemaed`, and the caller decides. `0`, `{}` and silence
 * are indistinguishable from success; a named list is not.
 *
 * **It does not check that agent labels are unique.** #61 asked for that and
 * it is false as a requirement: a label legitimately repeats when a
 * remediation round re-runs a call site, which is why
 * `scripts/record-agent-timings.ts` pairs brackets FIFO per label rather
 * than collapsing them. A harness enforcing uniqueness would refuse the
 * runs that matter most.
 */

/** The one exit code every refusal goes through. */
export const HARNESS_REFUSE_EXIT = 2;

export class HarnessRefusal extends Error {}

/** The placeholder every synthetic string takes. Named so it is identifiable if it escapes. */
export const SYNTHETIC_TEXT = "synthetic value produced by the workflow test harness";

export interface AgentCall {
  kind: "agent";
  label: string | undefined;
  phase: string | undefined;
  /** Whether the call site declared a schema the harness could synthesise from. */
  schemaed: boolean;
}

export interface PhaseCall {
  kind: "phase";
  title: string;
}

export type HarnessCall = AgentCall | PhaseCall;

export interface HarnessRun {
  /** Everything the script did, in the order it did it. */
  calls: HarnessCall[];
  /** Whatever the script returned, or `undefined` if it threw. */
  result: unknown;
  /**
   * The error the script threw, verbatim.
   *
   * NOT swallowed and not converted to a verdict. A harness that reported
   * "the workflow did not complete" would be indistinguishable from one whose
   * own stubs were wrong, which is the failure mode a mock harness is most
   * prone to and least able to see.
   */
  error: Error | null;
  /** Call sites that declared no schema, by label. Reported, never defaulted. */
  unschemaed: string[];
  /** Wall-clock milliseconds. */
  ms: number;
}

// ── synthetic results ────────────────────────────────────────

/**
 * A value conforming to a JSON Schema, built from the schema itself.
 *
 * Generated rather than fixtured, because `agent(prompt, {schema})` hands the
 * schema to the harness at the call site: a per-call-site fixture file would
 * be 39 fixtures that go stale one at a time and silently, and the staleness
 * would show up as the script taking a wrong branch rather than as a failure.
 *
 * Every optional property is populated too, not just the required ones. A
 * minimal object satisfies the schema and exercises only the branches that
 * handle absence, so the harness would systematically run the script's
 * fallback paths and never its main ones.
 *
 * `enum` takes its FIRST value, which is a choice the caller usually needs to
 * override — ceremony tier, gate result, regression target are all enums, and
 * they are the branches worth driving. `overrides` exists for exactly that.
 */
export function syntheticFromSchema(schema: any, seed = 1): any {
  if (!schema || typeof schema !== "object") return null;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  switch (schema.type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = schema.properties ?? {};
      for (const key of Object.keys(props)) out[key] = syntheticFromSchema(props[key], seed);
      return out;
    }
    case "array":
      // One element, not zero. An empty array satisfies the schema and makes
      // every `.map`, `.length` and `for…of` downstream a no-op, so a harness
      // returning `[]` would report a clean run over a script that never
      // entered a loop.
      return schema.items ? [syntheticFromSchema(schema.items, seed)] : [];
    case "number":
    case "integer":
      return seed;
    case "boolean":
      return true;
    case "string":
      // Several words, not one. The script validates free text in places —
      // an AC statement under five words is refused by the state schema —
      // and a one-word default made every tier stop at the same Discovery
      // refusal, so the harness was measuring its own placeholder rather
      // than the orchestration. Still obviously synthetic, so a value that
      // escapes into a report names itself.
      return SYNTHETIC_TEXT;
    default:
      return schema.properties ? syntheticFromSchema({ ...schema, type: "object" }, seed) : SYNTHETIC_TEXT;
  }
}

// ── loading ──────────────────────────────────────────────────

/**
 * A workflow script's executable body, with its `meta` export removed.
 *
 * `export` is a module-level form and the body has to run inside a function,
 * so the declaration cannot come along. It is sliced rather than regexed away
 * because `meta` is required to be a pure literal — the Workflow tool says so
 * — which means the first `\n}\n` after it is its close, and a looser pattern
 * would be a detector narrower than what it detects over a 7,000-line file.
 */
export function workflowBody(source: string): string {
  const at = source.indexOf("export const meta");
  if (at < 0) {
    throw new HarnessRefusal(
      "the workflow script has no `export const meta` — either it is not a workflow script, " +
        "or the Workflow tool's own requirement has changed and this harness is reading the wrong thing",
    );
  }
  const end = source.indexOf("\n}\n", at);
  if (end < 0) throw new HarnessRefusal("could not find the end of the workflow's `meta` literal");
  return source.slice(end + 3);
}

// ── running ──────────────────────────────────────────────────

export interface RunOptions {
  /** `args` as the script sees it. */
  args?: Record<string, unknown>;
  /**
   * Replace the synthetic result for a given label.
   *
   * A function receives the synthetic value and returns the replacement, so a
   * caller can override one field of a large schema without restating it —
   * restating it is how an override goes stale against a schema change and
   * starts driving a branch nobody meant.
   */
  overrides?: Record<string, unknown | ((synthetic: any) => unknown)>;
  /**
   * Hard cap on agent calls. A runaway loop in the script under test must
   * fail the harness, not hang the suite — and the cap is a REFUSAL with a
   * count, not a quiet stop, because a quiet stop looks like a short run.
   */
  maxCalls?: number;
}

export async function runWorkflow(source: string, opts: RunOptions = {}): Promise<HarnessRun> {
  const calls: HarnessCall[] = [];
  const unschemaed: string[] = [];
  const maxCalls = opts.maxCalls ?? 500;
  const overrides = opts.overrides ?? {};

  const agent = async (_prompt: string, o: any = {}) => {
    const label = o?.label;
    calls.push({ kind: "agent", label, phase: o?.phase, schemaed: !!o?.schema });
    if (calls.filter((c) => c.kind === "agent").length > maxCalls) {
      throw new HarnessRefusal(
        `the workflow made more than ${maxCalls} agent calls — it is looping, and a harness ` +
          `that stopped quietly here would report a short run rather than a runaway one`,
      );
    }
    if (!o?.schema) {
      if (label && !unschemaed.includes(label)) unschemaed.push(label);
      // A string, which is what a schemaless `agent()` really returns. Not
      // `{}`: an object that answers every property access with `undefined`
      // lets the script take branches nobody chose, and the harness would be
      // reporting on its own stub.
      return SYNTHETIC_TEXT;
    }
    const synthetic = syntheticFromSchema(o.schema);
    if (label && label in overrides) {
      const o2 = overrides[label];
      return typeof o2 === "function" ? (o2 as (s: any) => unknown)(synthetic) : o2;
    }
    return synthetic;
  };

  const globals: Record<string, unknown> = {
    agent,
    phase: (title: string) => calls.push({ kind: "phase", title }),
    log: () => {},
    parallel: async (thunks: Array<() => Promise<unknown>>) =>
      Promise.all((thunks ?? []).map((t) => t().catch(() => null))),
    pipeline: async (items: unknown[], ...stages: Array<(...a: any[]) => Promise<unknown>>) => {
      const out: unknown[] = [];
      for (const [i, item] of (items ?? []).entries()) {
        let v: unknown = item;
        for (const stage of stages) v = await stage(v, item, i);
        out.push(v);
      }
      return out;
    },
    workflow: async () => ({}),
    args: opts.args ?? {},
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
  };

  const names = Object.keys(globals);
  const started = Date.now();
  let result: unknown;
  let error: Error | null = null;
  try {
    const fn = new Function(...names, `return (async () => {\n${workflowBody(source)}\n})()`);
    result = await fn(...names.map((n) => globals[n]));
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  }
  return { calls, result, error, unschemaed, ms: Date.now() - started };
}

// ── contracts over a recorded run ────────────────────────────

/** The phases `workflows/ship.js` declares, in the order it declares them. */
export const SHIP_PHASES = [
  "Goal", "Discovery", "Scope", "Implement", "Validate", "Commit", "Verify", "Ship", "Prove",
] as const;

/**
 * Phases that ran out of order, as violations.
 *
 * A subsequence check, not an equality check: a run that stops early, or
 * skips a phase its tier does not need, is correct. A run that goes BACKWARDS
 * is not — `Implement` before `Scope` is the boundary violation #61 names,
 * and it is the one a reordering edit introduces silently.
 *
 * A phase the order does not know is a violation too. Adding a phase to
 * ship.js and not to this list means the harness has stopped describing the
 * script, and defaulting it to "fine" is how a contract check goes blind.
 */
export function phaseOrderViolations(calls: HarnessCall[], order: readonly string[] = SHIP_PHASES): string[] {
  const violations: string[] = [];
  let high = -1;
  let highName = "<start>";
  for (const call of calls) {
    if (call.kind !== "phase") continue;
    const at = order.indexOf(call.title);
    if (at < 0) {
      violations.push(
        `phase('${call.title}') is not in the declared phase order — either the order is stale ` +
          `or the phase is new, and a harness that ignored it would stop describing the script`,
      );
      continue;
    }
    // Equal is fine: a phase can be re-entered on a regression path, and
    // re-entry is not a backwards jump.
    if (at < high) violations.push(`phase('${call.title}') ran after phase('${highName}') — the declared order is ${order.join(" → ")}`);
    else {
      high = at;
      highName = call.title;
    }
  }
  return violations;
}

/**
 * Agent calls that ran AFTER the phase they belong to had passed.
 *
 * The other half of a boundary, and narrower than the obvious version. The
 * first draft flagged any agent whose declared phase differed from the
 * current one, and the harness's very first run reported
 * `preload-contexts` — which declares `Discovery` and executes while the run
 * is still in `Goal`, 264 lines before `phase('Discovery')`.
 *
 * That is not a defect. `opts.phase` assigns a PROGRESS GROUP, and the
 * workflow API documents declaring one ahead of the global `phase()` state
 * precisely so parallel stages do not race it. Grouping a preload under the
 * phase it prepares for is the intended usage, and a check that refused it
 * would have been a detector wider than what it detects — loud, wrong, and
 * switched off within a week.
 *
 * Declaring BACKWARDS is the suspicious direction: a call site labelled for
 * `Goal` executing during `Ship` is work that has escaped its phase, and
 * nothing else in the repo can see it, because `phase()` was never called
 * wrongly — the AGENT was placed wrongly.
 */
export function agentPhaseViolations(calls: HarnessCall[], order: readonly string[] = SHIP_PHASES): string[] {
  const violations: string[] = [];
  let current: string | null = null;
  for (const call of calls) {
    if (call.kind === "phase") {
      current = call.title;
      continue;
    }
    if (!call.phase || call.phase === current || current === null) continue;
    const declared = order.indexOf(call.phase);
    const now = order.indexOf(current);
    // An unknown phase on either side is `phaseOrderViolations`'s finding,
    // not this one. Reporting it twice would be two deciders on one fact.
    if (declared < 0 || now < 0 || declared >= now) continue;
    violations.push(
      `agent '${call.label ?? "<unlabelled>"}' belongs to phase '${call.phase}' but ran during ` +
        `'${current}', which is later — the call site has escaped its phase`,
    );
  }
  return violations;
}

/**
 * The run's call graph, as a comparable string.
 *
 * This is the pass^k instrument: k runs with the same inputs must produce the
 * same string. Labels and phases only — timings and prompt text are not part
 * of the contract and would make every run differ for reasons nobody cares
 * about, which is how a determinism metric gets switched off.
 */
export function callGraph(calls: HarnessCall[]): string {
  return calls
    .map((c) => (c.kind === "phase" ? `phase:${c.title}` : `agent:${c.label ?? "?"}@${c.phase ?? "?"}`))
    .join("\n");
}
