/**
 * #212 — nothing reconciled the matcher registry with its handlers.
 *
 * `matchPattern` iterates the REGISTRY and looks each entry's handler up by
 * name. The two sets were identical, and held that way by nothing:
 * `test/matcher-registry.test.ts` validates the registry's internal shape and
 * contains zero references to the conformity engine. Its only count assertion
 * is a floor pinned to today's number, so adding a handler with no registry
 * entry kept it passing.
 *
 * Two failure directions, and they fail differently:
 *
 *  - A registry entry with no handler: the statement MATCHED — the author's
 *    syntax was recognised — and `matchPattern` still returned `null`, which
 *    downstream is indistinguishable from "no pattern matched at all". That
 *    collapses "recognised but unimplemented" into "unrecognised", and
 *    SUCCESS.md claim 4 says those must be distinct outcomes.
 *  - A handler with no registry entry: dead code. `matchPattern` never
 *    iterates the handler map, so the handler is unreachable however well it
 *    is tested — the shape #200 was filed for.
 *
 * Covers SC-699 through SC-707 of CONFIG-DRIVEN-TESTING-SPEC.md:
 * SC-699, SC-700, SC-701, SC-702, SC-703, SC-704, SC-705, SC-706, SC-707.
 *
 * Criterion ids belonging to the issue are referred to by position, never
 * written as a bare id: `coverageClaimIds` reads a test title as a coverage
 * claim and per-issue numbering collides with the spec-wide namespace (#149).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  matcherHandlerNames,
  resolveMatcher,
  planSCTests,
  matchPattern,
  isMatchablePattern,
  extractSCs,
  isBehavioralSC,
  type ParsedSC,
} from "../lib/conformity";
import { collectSpecFiles } from "../lib/spec-files";

const ROOT = join(import.meta.dir, "..");
const SPECS = join(ROOT, "specs");

const scratch = () => mkdtempSync(join(tmpdir(), "rungate-parity-"));

const sc = (statement: string, id = "SC-9301"): ParsedSC =>
  ({ id, statement, checked: true, specFile: "FIXTURE-SPEC.md" }) as any;

/** A project root carrying a consumer config, which is where a registry entry
 *  can legitimately exist with no handler compiled into the engine. */
function projectWithConfig(contents: string): string {
  const root = scratch();
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "rungate.json"), contents);
  return root;
}

describe("#212 first criterion — registry and handlers reconcile in both directions", () => {
  const registry = JSON.parse(readFileSync(join(ROOT, "config/matcher-registry.json"), "utf-8"));
  const registryNames: string[] = registry.map((e: any) => e.name);
  const handlerNames = matcherHandlerNames();

  test("both sets are non-empty, so an equal comparison cannot pass vacuously", () => {
    // Without this, short-circuiting either side to [] makes every assertion
    // below compare nothing to nothing and report parity.
    expect(registryNames.length).toBeGreaterThan(15);
    expect(handlerNames.length).toBeGreaterThan(15);
  });

  test("every registry entry has a handler — an entry without one asserts nothing", () => {
    const orphanEntries = registryNames.filter((n) => !handlerNames.includes(n));
    expect(orphanEntries).toEqual([]);
  });

  test("every handler has a registry entry — a handler without one is unreachable", () => {
    const deadHandlers = handlerNames.filter((n) => !registryNames.includes(n));
    expect(deadHandlers).toEqual([]);
  });

  test("the registry has no duplicate names, so parity cannot be bought by shadowing", () => {
    expect(registryNames.length).toBe(new Set(registryNames).size);
  });
});

describe("#212 second criterion — recognised-but-unimplemented is not reported as unrecognised", () => {
  test("a statement matching no registry regex at all is unrecognised", () => {
    const outcome = resolveMatcher(sc("this statement resembles no pattern whatsoever"));
    expect(outcome.kind).toBe("unrecognised");
  });

  test("a statement matching a built-in entry resolves to an assertion and names its matcher", () => {
    const outcome = resolveMatcher(sc("AGENTS.md contains [Project Identity]"), ROOT);
    expect(outcome.kind).toBe("assert");
    expect(outcome.kind === "assert" && outcome.matcher).toBe("content-contains");
  });

  test("a registry entry with no handler is UNIMPLEMENTED, and says which matcher", () => {
    const root = projectWithConfig(
      JSON.stringify({
        customMatchers: [{ name: "consumer-only-matcher", regex: "^widget (\\S+) is blessed" }],
      }),
    );
    const outcome = resolveMatcher(sc("widget alpha is blessed"), root);
    expect(outcome.kind).toBe("unimplemented");
    expect(outcome.kind === "unimplemented" && outcome.matcher).toBe("consumer-only-matcher");
  });

  test("the plan carries that distinction rather than collapsing it into unmatched", () => {
    const root = projectWithConfig(
      JSON.stringify({
        customMatchers: [{ name: "consumer-plan-matcher", regex: "^gadget (\\S+) is blessed" }],
      }),
    );
    const plan = planSCTests([sc("gadget beta is blessed"), sc("resembles no pattern at all", "SC-9302")], root);

    expect(plan[0].kind).toBe("unimplemented");
    expect((plan[0] as any).matcher).toBe("consumer-plan-matcher");
    expect(plan[1].kind).toBe("unmatched");
  });

  test("matchPattern keeps returning null for both, so existing callers are unchanged", () => {
    const root = projectWithConfig(
      JSON.stringify({
        customMatchers: [{ name: "consumer-null-matcher", regex: "^doodad (\\S+) is blessed" }],
      }),
    );
    expect(matchPattern(sc("doodad gamma is blessed"), root)).toBeNull();
    expect(matchPattern(sc("resembles no pattern at all"), root)).toBeNull();
  });
});

describe("#212 third criterion — a malformed consumer config is not a silent fallback", () => {
  const warnings: string[] = [];
  const realWarn = console.warn;
  afterEach(() => {
    console.warn = realWarn;
  });

  test("unparseable JSON warns, naming the project, and still falls back to the built-ins", () => {
    const root = projectWithConfig("{ this is not json");
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    const outcome = resolveMatcher(sc("AGENTS.md contains [Project Identity]"), root);
    console.warn = realWarn;

    // The fallback itself is correct — a consumer's broken config must not
    // take the built-in matchers down with it. What was wrong is that it
    // happened in silence.
    expect(outcome.kind).toBe("assert");
    // Names the PROJECT, not a filename. #309 routed this read through the
    // loader, which resolves either the directory layout or the monolith —
    // so there is no single file to point at, and the root is what tells a
    // reader whose config failed. Constructing a path here would also be the
    // very access CONFIG-1 forbids, in the file that hosts CONFIG-1.
    const named = warnings.filter((w) => w.includes(root));
    expect(named.length, warnings.join("\n")).toBeGreaterThan(0);
    expect(named.join(" ")).toContain("built-in");
  });

  test("a well-formed config produces no warning — the warn is not unconditional", () => {
    const root = projectWithConfig(JSON.stringify({ customMatchers: [] }));
    const seen: string[] = [];
    console.warn = (...args: unknown[]) => {
      seen.push(args.join(" "));
    };
    resolveMatcher(sc("AGENTS.md contains [Project Identity]"), root);
    console.warn = realWarn;
    // Filtered on the same token the positive case asserts, or this control
    // would pass by matching a string nothing emits any more.
    expect(seen.filter((w) => w.includes(root))).toEqual([]);
  });
});

describe("#212 — the engine's refusal is executed, not just written", () => {
  // The refusal branch only runs when the unimplemented list is non-empty,
  // and in this repo the parity test keeps it empty forever. A branch that
  // never executes is the first shape in checks-must-be-able-to-fail.md — the
  // prompt-immutability gate that had never once run in CI. Neutralising its
  // assertion in place measures 0 red for exactly that reason, which is why
  // the branch is driven here against a planted project instead.
  const SPEC = `---
doc-type: spec
status: active
owner: test
created: 2026-10-12
updated: 2026-10-12
governs: A fixture spec whose only criterion matches a matcher with no handler
testable: true
compliance: strict
---

# Fixture

## Success Criteria

- [x] SC-9401: widget alpha is blessed
`;

  function plantedProject(): string {
    const root = scratch();
    mkdirSync(join(root, "specs"), { recursive: true });
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, "specs", "FIXTURE-SPEC.md"), SPEC);
    // Enough scaffold for the project's OTHER structural checks to pass, so
    // the run's only refusal is the one under test. Without this the suite is
    // red for missing AGENTS.md, and "exits non-zero" would be satisfied by a
    // project that never reached the matcher at all.
    writeFileSync(
      join(root, "AGENTS.md"),
      "# Fixture\n\n## Project Identity\n\nFixture\n\n## Rules\n\n- none\n\n## Commands\n\n| Action | Command |\n|---|---|\n| Test | `bun test` |\n",
    );
    writeFileSync(
      join(root, ".claude", "rungate.json"),
      JSON.stringify({
        project: "fixture",
        customMatchers: [{ name: "orphan-matcher", regex: "^widget (\\S+) is blessed" }],
      }),
    );
    writeFileSync(
      join(root, "drive.test.ts"),
      `import { runScaffoldConformity } from ${JSON.stringify(join(ROOT, "lib/conformity.ts"))};\n` +
        `runScaffoldConformity(${JSON.stringify(root)});\n`,
    );
    return root;
  }

  test("a criterion matching a handler-less matcher makes the suite refuse, naming the matcher", () => {
    const root = plantedProject();
    const run = Bun.spawnSync(["bun", "test", join(root, "drive.test.ts")], {
      cwd: ROOT,
      env: { ...process.env },
    });
    const output = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr);

    // Observed running, not merely absent: a suite that failed to load is red
    // too, and would otherwise be indistinguishable from a refusal.
    expect(output).toContain("FIXTURE-SPEC.md");
    expect(output).toContain("has no handler");
    expect(output).toContain("orphan-matcher");
    expect(run.exitCode).not.toBe(0);
  });

  test("the same project with the handler-less matcher removed does not refuse", () => {
    // The positive control. Without it the assertions above are satisfied by
    // any project that fails for any reason.
    const root = plantedProject();
    writeFileSync(
      join(root, ".claude", "rungate.json"),
      JSON.stringify({ project: "fixture", customMatchers: [] }),
    );
    const run = Bun.spawnSync(["bun", "test", join(root, "drive.test.ts")], {
      cwd: ROOT,
      env: { ...process.env },
    });
    const output = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr);

    expect(output).not.toContain("has no handler");
  });
});

describe("#212 — the subject under test cannot switch off the check verifying it", () => {
  // Raised by the push security review of this change. Passing the project
  // root to the engine (which is the #212 fix) made consumer config reachable
  // from verification for the first time, and `loadRegistry` lets a consumer
  // entry REPLACE a built-in by name. That is a fine authoring feature and an
  // unacceptable verification one: a project shadowing `content-contains`
  // with a regex matching nothing turns the check off from inside the thing
  // being checked, and the run stays green.
  const realWarn = console.warn;
  afterEach(() => {
    console.warn = realWarn;
  });

  function capture(fn: () => void): string[] {
    const seen: string[] = [];
    console.warn = (...args: unknown[]) => {
      seen.push(args.join(" "));
    };
    try {
      fn();
    } finally {
      console.warn = realWarn;
    }
    return seen;
  }

  test("a consumer entry shadowing a built-in does NOT take effect in the engine", () => {
    const root = projectWithConfig(
      JSON.stringify({
        // Matches nothing. If honoured, every content-contains criterion in
        // the project silently stops being asserted.
        customMatchers: [{ name: "content-contains", regex: "^\\0NEVER_MATCHES\\0$" }],
      }),
    );
    const outcome = resolveMatcher(sc("AGENTS.md contains [Project Identity]"), root);
    expect(outcome.kind).toBe("assert");
    expect(outcome.kind === "assert" && outcome.matcher).toBe("content-contains");
  });

  test("the ignored override is announced, not dropped quietly", () => {
    const root = projectWithConfig(
      JSON.stringify({ customMatchers: [{ name: "file-exists", regex: "^never$" }] }),
    );
    const warnings = capture(() => resolveMatcher(sc("AGENTS.md contains [Project Identity]"), root));
    expect(warnings.join(" ")).toContain("file-exists");
    expect(warnings.join(" ")).toContain("IGNORED");
  });

  test("authoring keeps the documented override — the two views differ on purpose", () => {
    // isMatchablePattern answers create-spec's question and stays permissive,
    // so the existing consumer-override behaviour is unchanged.
    const root = projectWithConfig(
      JSON.stringify({ customMatchers: [{ name: "consumer-adds-vocabulary", regex: "^sprocket \\S+ is fine" }] }),
    );
    expect(isMatchablePattern(sc("sprocket nine is fine"), root)).toBe(true);
  });

  test("a consumer matcher that only ADDS vocabulary still works", () => {
    // The restriction must not be bought by disabling custom matchers wholesale.
    const root = projectWithConfig(
      JSON.stringify({ customMatchers: [{ name: "brand-new-matcher", regex: "^cog \\S+ is turning" }] }),
    );
    const outcome = resolveMatcher(sc("cog seven is turning"), root);
    expect(outcome.kind).toBe("unimplemented");
    expect(outcome.kind === "unimplemented" && outcome.matcher).toBe("brand-new-matcher");
  });

  test("a regex that does not compile refuses that entry instead of taking the run down", () => {
    const root = projectWithConfig(
      JSON.stringify({ customMatchers: [{ name: "broken-regex-matcher", regex: "a(" }] }),
    );
    let outcome: ReturnType<typeof resolveMatcher> | undefined;
    const warnings = capture(() => {
      outcome = resolveMatcher(sc("AGENTS.md contains [Project Identity]"), root);
    });
    // The built-ins still resolved — one bad entry is not a dead engine.
    expect(outcome!.kind).toBe("assert");
    expect(warnings.join(" ")).toContain("broken-regex-matcher");
  });

  test("a parse failure's message is withheld, because it quotes file contents", () => {
    // sensitive-data-to-observability: a config is a project's own file, and
    // JSON parse errors routinely echo the bytes around the fault. A secret
    // in a misplaced field must not reach the build log by that route.
    const secret = "ghp_EXAMPLE_NOT_A_REAL_TOKEN_0123456789";
    // The fixture shape matters, and the first one I wrote did not work: for
    // `{"token": "<secret>" oops` the parser reports `Expected '}'` and names
    // nothing, so the test passed whether or not the message was echoed — an
    // assertion that held for a reason unrelated to the fix. An UNQUOTED
    // value is the shape that leaks, and it is also the likelier mistake:
    // forgetting the quotes around a token produces
    // `Unexpected identifier "ghp_…"`, verbatim.
    const root = projectWithConfig(`{ "token": ${secret} }`);
    const warnings = capture(() => resolveMatcher(sc("AGENTS.md contains [Project Identity]"), root));

    expect(warnings.join(" ")).toContain("could not be read as JSON");
    expect(warnings.join(" "), "the config's contents reached the log").not.toContain(secret);
  });
});

describe("#212 fourth criterion — the authoring tool and the engine agree", () => {
  // `isMatchablePattern` answers create-spec's "is this SC valid?" and checks
  // only the regex; `matchPattern` answers the engine's "can this be asserted?"
  // and needs a handler too. Where they disagree, an author is told their
  // criterion is fine and the engine generates nothing for it.
  //
  // Divergence is legitimate only for a consumer matcher with no handler, and
  // this repo has none — so the exception list is empty and stated, rather
  // than the agreement being implied.
  const KNOWN_DIVERGENCES: string[] = [];

  const corpus = collectSpecFiles(SPECS).flatMap((rel) =>
    extractSCs(readFileSync(join(SPECS, rel), "utf-8"), rel)
      .filter((s) => !isBehavioralSC(s))
      .map((s) => ({ sc: s, spec: rel })),
  );

  test("the sweep sees a real corpus, so an empty result cannot read as agreement", () => {
    expect(corpus.length).toBeGreaterThan(400);
  });

  test("every criterion the authoring tool accepts, the engine can assert", () => {
    const diverging = corpus
      .filter(({ sc: s }) => isMatchablePattern(s, ROOT) !== (matchPattern(s, ROOT) !== null))
      .filter(({ sc: s }) => !KNOWN_DIVERGENCES.includes(s.id))
      .map(({ sc: s, spec }) => `${spec} ${s.id}: accepted by create-spec, asserted by nothing`);

    expect(diverging).toEqual([]);
  });

  test("the exception list holds only ids that genuinely diverge", () => {
    // A ratchet in both directions: an exception that stops diverging must be
    // delisted, or the list becomes a place entries go to be forgotten.
    const stale = KNOWN_DIVERGENCES.filter((id) => {
      const found = corpus.find(({ sc: s }) => s.id === id);
      if (!found) return true;
      return isMatchablePattern(found.sc, ROOT) === (matchPattern(found.sc, ROOT) !== null);
    });
    expect(stale).toEqual([]);
  });
});
