/**
 * Does every gate check a ceremony profile names actually exist? (#339)
 *
 * `config/ceremony-profiles.json` names 41 checks across its tiers. Nine had
 * no `test("<name>: …")` in `gates/workflow.test.ts`, and nothing checked.
 *
 * A profile that names a check which does not exist is the same defect class
 * as a check gated on a config key nobody authors (#315, #294, #307): the
 * contract claims a measurement that never happens, and it claims it in the
 * file a reader consults to find out what a tier covers.
 *
 * ## The thing that makes this worth data rather than a grep
 *
 * Resolving the nine by hand took three passes and got it wrong twice.
 * `acs-have-threshold` and `acs-no-behavioral-language` are both real — they
 * are `superRefine` clauses on `ACSchema`, spelled `missing threshold` and
 * `BEHAVIORAL_PATTERN`. No search for the profile's name finds either.
 * `spec-drift` is `runSpecDrift` in the conformity suite. `dead-exports` is
 * FALLOW-2 inside `runFallowCheck`.
 *
 * That is the issue's point stated precisely: the information exists, it is
 * not recoverable from the name, and until now it lived in whoever last
 * looked. `config/check-registry.json` is that knowledge as data, and the
 * test beside it refuses both drift directions.
 *
 * ## What nothing selects on
 *
 * The profile check lists are **documentation, not control flow**.
 * `applyCeremonyOverrides` reads them only to re-add protected checks;
 * nothing filters which tests run, and `gates/workflow.test.ts` executes all
 * of its checks at every tier, gating internally on phase instead.
 *
 * So an unimplemented name is not an unrun check — it is a claim of coverage
 * in a document, which is worse in one specific way: it is the thing a
 * reader trusts when deciding a tier is enough.
 *
 * It also means the reverse direction cannot be "a check not in a profile
 * never runs". It is "a check not in a profile is undocumented", which is
 * why `alwaysRun` exists and why every one of its entries is asserted to be
 * real rather than taken on trust.
 */

export interface CheckImpl {
  /** Repo-relative path the check is implemented in. */
  impl: string;
  /** A literal the implementation must contain — a function name or message. */
  symbol?: string;
  note?: string;
}

export interface CheckRegistry {
  gateDescribes: string[];
  checks: Record<string, CheckImpl>;
  alwaysRun: Record<string, string>;
  delisted: Record<string, string>;
}

const COMMENT = "$comment";

function stripComments<T extends Record<string, unknown>>(o: T): T {
  const { [COMMENT]: _drop, ...rest } = o;
  return rest as T;
}

export function parseCheckRegistry(raw: unknown): CheckRegistry {
  const r = raw as Partial<CheckRegistry>;
  return {
    gateDescribes: Array.isArray(r.gateDescribes) ? r.gateDescribes : [],
    checks: stripComments((r.checks ?? {}) as Record<string, CheckImpl>),
    alwaysRun: stripComments((r.alwaysRun ?? {}) as Record<string, string>),
    delisted: stripComments((r.delisted ?? {}) as Record<string, string>),
  };
}

/** Every distinct check name a ceremony profile mentions, with where. */
export function profileCheckNames(profiles: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const tiers = (profiles as { tiers?: Record<string, { checks?: Record<string, unknown> }> })?.tiers;
  if (!tiers) return out;
  for (const [tier, cfg] of Object.entries(tiers)) {
    for (const [phase, list] of Object.entries(cfg?.checks ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const name of list) {
        if (typeof name !== "string") continue;
        out.set(name, [...(out.get(name) ?? []), `${tier}.${phase}`]);
      }
    }
  }
  return out;
}

export interface GateTest {
  name: string;
  describe: string;
}

/**
 * Every test declared inside a gate-check `describe`.
 *
 * The describe block is the discriminator, and it is the only honest one
 * available. A kebab-case heuristic over the whole file also collects
 * `baseline`, `zero`, `subtracts` and `pre-existing` from
 * `test-baseline-subtraction`, which are prose. The numbered `// 32. name`
 * comments are not usable either: 40 of them for 65 tests, with 12, 13, 14
 * and 32 each used twice and eight numbers skipped — a numbering scheme
 * nobody checks, which is this issue's own subject one level down.
 *
 * The leading `skipped — no active workflow` placeholder each gate describe
 * opens with is not a check; it is the standalone-run guard.
 */
export function gateTestsIn(source: string, gateDescribes: readonly string[]): GateTest[] {
  const out: GateTest[] = [];
  let current: string | null = null;
  for (const line of source.split("\n")) {
    const d = /^describe\(\s*["'`]([^"'`]+)/.exec(line);
    if (d) {
      current = gateDescribes.includes(d[1]) ? d[1] : null;
      continue;
    }
    if (!current) continue;
    const t = /^\s*test\(\s*["'`]([^"'`]+)/.exec(line);
    if (!t) continue;
    const name = t[1].split(/[:—]/)[0].trim();
    if (name.startsWith("skipped")) continue;
    out.push({ name, describe: current });
  }
  return out;
}

export interface RegistryViolation {
  kind: "unregistered" | "unimplemented" | "undocumented" | "stale-always-run" | "delisted-in-profile";
  detail: string;
}

/**
 * Both directions at once (#339 SC-2).
 *
 * `readImpl` returns the contents of a repo-relative path, or null when it
 * does not exist — injected so the resolution can be driven against fixtures
 * as well as the repo.
 */
export function checkRegistryViolations(opts: {
  registry: CheckRegistry;
  profiles: unknown;
  workflowTestSource: string;
  readImpl: (path: string) => string | null;
}): RegistryViolation[] {
  const { registry, profiles, workflowTestSource, readImpl } = opts;
  const out: RegistryViolation[] = [];
  const named = profileCheckNames(profiles);
  const gateTests = gateTestsIn(workflowTestSource, registry.gateDescribes);
  const gateTestNames = new Set(gateTests.map(t => t.name));

  // 1. A profile cannot name a check with no registry entry.
  for (const [name, where] of named) {
    if (registry.checks[name]) continue;
    const delisted = registry.delisted[name];
    out.push({
      kind: delisted ? "delisted-in-profile" : "unregistered",
      detail: delisted
        ? `${name} is named by ${where.join(", ")} but is recorded as delisted: ${delisted}`
        : `${name} is named by ${where.join(", ")} and has no entry in config/check-registry.json. ` +
          `Add one saying where it is implemented, or delist it.`,
    });
  }

  // 2. A registry entry cannot point at an implementation that is not there.
  for (const [name, impl] of Object.entries(registry.checks)) {
    const source = readImpl(impl.impl);
    if (source === null) {
      out.push({ kind: "unimplemented", detail: `${name} points at ${impl.impl}, which does not exist.` });
      continue;
    }
    const needle = impl.symbol ?? name;
    if (!source.includes(needle)) {
      out.push({
        kind: "unimplemented",
        detail: `${name} points at ${impl.impl}, which does not contain ${JSON.stringify(needle)}. ` +
          `Either the check moved or the entry was written from memory.`,
      });
    }
  }

  // 3. A gate check must be named by a profile or recorded as always-run.
  for (const t of gateTests) {
    if (named.has(t.name) || registry.alwaysRun[t.name]) continue;
    out.push({
      kind: "undocumented",
      detail: `${t.name} runs in "${t.describe}" and no profile names it. Add it to a ceremony ` +
        `profile, or to alwaysRun in config/check-registry.json saying which describe it is in.`,
    });
  }

  // 4. alwaysRun ratchets both ways: an entry whose test is gone, or which
  //    moved describe, is a stale record rather than a harmless leftover.
  for (const [name, describe] of Object.entries(registry.alwaysRun)) {
    const found = gateTests.find(t => t.name === name);
    if (!found) {
      out.push({
        kind: "stale-always-run",
        detail: `alwaysRun lists ${name}, which is no longer a test in any gate describe. Remove it.`,
      });
      continue;
    }
    if (found.describe !== describe) {
      out.push({
        kind: "stale-always-run",
        detail: `alwaysRun says ${name} is in "${describe}"; it is in "${found.describe}".`,
      });
    }
  }

  // A profile-named check that is also a gate test but registered against a
  // different file would slip past 2 if that file happened to contain the
  // name. Cheap to rule out: if it IS a workflow test, the entry must say so.
  for (const [name, impl] of Object.entries(registry.checks)) {
    if (!gateTestNames.has(name)) continue;
    if (impl.impl === "gates/workflow.test.ts") continue;
    out.push({
      kind: "unimplemented",
      detail: `${name} is a test in gates/workflow.test.ts but the registry points at ${impl.impl}.`,
    });
  }

  return out;
}
