/**
 * #1261 — the finding arbiter, wired to the filing chokepoint.
 *
 * Covers SC-370, SC-371 (HOOK-ARCHITECTURE-SPEC) for hooks/FindingArbiterGate.hook.ts.
 *
 * ## What this file refuses to accept as evidence
 *
 * `test/finding-arbiter.test.ts` is 1,175 lines of thorough, passing tests
 * for `arbitrateBatch`, and for the whole life of that function it had no
 * production caller. **A passing suite for the decider is not evidence that
 * anything is decided.** So the acceptance cases here are not unit calls:
 * they SPAWN `hooks/FindingArbiterGate.hook.ts` as a subprocess, write a
 * real `gh issue create` payload to its stdin, and read the decision off
 * its stdout — the same path Claude Code drives it down.
 *
 * Two of them are the whole issue:
 *
 * - AC-1 — a duplicate filing attempt is REFUSED, naming the issue it
 *   duplicates.
 * - AC-2 — the control. A genuinely novel finding is ALLOWED. Without this
 *   row, a hook that refused everything would pass AC-1.
 *
 * ## The direction of the fail-safe, asserted rather than promised
 *
 * `lib/finding-gate.ts` is the one guard in `hooks/` that fails OPEN. A
 * header saying so is not a fail-open, so AC-3 drives six different failures
 * — a throwing tracker read, a timeout, unparseable JSON, a population with
 * no ids, a truncated population, an unreadable body — through the decider
 * and asserts an allow from each. Any of those turning into a refusal is a
 * finding deleted with nobody told, which is #1162 by a new route.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  DEFAULT_POPULATION_LIMIT,
  earlierInCommand,
  FINDING_GATE_DECISION,
  FINDING_GATE_ENV,
  FINDING_GATE_OFF,
  findingGateReading,
  proposedIssues,
} from "../lib/finding-gate";

const ROOT = join(import.meta.dir, "..");
const HOOK = join(ROOT, "hooks", "FindingArbiterGate.hook.ts");
const DECIDER = join(ROOT, "lib", "finding-gate.ts");

/**
 * The comparison population, and the pair that makes a duplicate.
 *
 * `duplicateOverlap` needs **two shared quantities and one shared location**
 * — that threshold is `lib/finding-arbiter.ts`'s, measured over a 40-issue
 * corpus, and it is not restated here. So the fixture shares the path
 * `lib/widget-cache.ts`, the symbol `evictOldest`, and the readings 144 and
 * 5060. The novel control shares the file and nothing else, which is
 * deliberately the HARDEST control to pass: a dedupe keyed on area of code
 * alone would call it a duplicate and AC-2 would go red.
 */
const EXISTING = [
  {
    number: 4242,
    title: "evictOldest drops the newest entry when the cache is full",
    body:
      "In `lib/widget-cache.ts` the `evictOldest` comparator is inverted.\n" +
      "Measured over 5060 sampled operations, 144 of them evicted the wrong entry.",
  },
  {
    number: 4243,
    title: "An unrelated issue about something else entirely",
    body: "Nothing in `lib/other-thing.ts` resembles the case above. 77 rows, 88 columns.",
  },
];

/** A filing attempt whose symptom is already #4242. */
const DUPLICATE_BODY =
  "The `evictOldest` comparator in `lib/widget-cache.ts` is backwards.\n" +
  "Across 5060 operations I counted 144 wrong evictions.";

/**
 * A filing attempt that is genuinely new.
 *
 * Same FILE as #4242 on purpose — see the fixture note. It shares one
 * location key and zero quantity keys, so it must come through.
 */
const NOVEL_BODY =
  "Separately, `lib/widget-cache.ts` never calls `flushPending` on shutdown, " +
  "so 31 queued writes are lost. Nothing to do with eviction order.";

interface HookRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the hook the way Claude Code does: JSON on stdin, JSON on stdout. */
function runHook(
  payload: unknown,
  opts: { existing?: string; workDir?: string; env?: Record<string, string>; hook?: string } = {},
): HookRun {
  const r = spawnSync("bun", [opts.hook ?? HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf-8",
    cwd: ROOT,
    timeout: 60_000,
    env: {
      ...process.env,
      ...(opts.existing ? { RUNGATE_FINDING_GATE_EXISTING: opts.existing } : {}),
      ...(opts.workDir ? { RUNGATE_WORK_DIR: opts.workDir } : {}),
      ...opts.env,
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A scratch dir holding the pinned population and a work dir for the log. */
function fixture(): { dir: string; existing: string; workDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rg1261-"));
  const existing = join(dir, "existing.json");
  writeFileSync(existing, JSON.stringify(EXISTING));
  const workDir = join(dir, "work");
  mkdirSync(workDir, { recursive: true });
  return { dir, existing, workDir };
}

const createCmd = (title: string, bodyFile: string) =>
  `gh issue create --title ${JSON.stringify(title)} --body-file ${bodyFile} --label follow-up`;

describe("#1261 AC-1/AC-2: the hook refuses a duplicate and passes a novel finding", () => {
  test("AC-1: a duplicate `gh issue create` is REFUSED, naming the issue it duplicates", () => {
    const f = fixture();
    try {
      const bodyFile = join(f.dir, "dup.md");
      writeFileSync(bodyFile, DUPLICATE_BODY);

      const r = runHook(
        {
          tool_name: "Bash",
          tool_input: { command: createCmd("evictOldest evicts the wrong entry", bodyFile) },
        },
        { existing: f.existing, workDir: f.workDir },
      );

      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout.trim());
      expect(out.decision).toBe(FINDING_GATE_DECISION);
      // The refusal must be ACTIONABLE: #1162's defect is a finding dropped
      // with no trace, and a refusal that does not say what it collided with
      // is the same loss with a message attached.
      expect(out.reason).toContain("#4242");
      expect(out.reason).toContain("already reported as");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("AC-2 (control): a genuinely novel finding is ALLOWED, silently", () => {
    const f = fixture();
    try {
      const bodyFile = join(f.dir, "novel.md");
      writeFileSync(bodyFile, NOVEL_BODY);

      const r = runHook(
        {
          tool_name: "Bash",
          tool_input: { command: createCmd("flushPending is never called on shutdown", bodyFile) },
        },
        { existing: f.existing, workDir: f.workDir },
      );

      expect(r.status).toBe(0);
      // No decision at all. A PreToolUse hook that says nothing allows the
      // call; emitting an "allow" would be a second vocabulary for silence.
      expect(r.stdout.trim()).toBe("");
      // And it is allowed for the RIGHT reason — nothing was unreadable.
      expect(r.stderr).not.toContain("UNMEASURED");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("AC-2b: the two cases differ ONLY in the body, so the control is not vacuous", () => {
    // Both commands name the same file and carry the same flags. If the
    // control passed because of a difference in the COMMAND rather than in
    // the finding, this file would be measuring its own fixture.
    const f = fixture();
    try {
      const dup = join(f.dir, "a.md");
      const novel = join(f.dir, "b.md");
      writeFileSync(dup, DUPLICATE_BODY);
      writeFileSync(novel, NOVEL_BODY);
      const title = "a title that is identical in both runs";

      const blocked = runHook(
        { tool_name: "Bash", tool_input: { command: createCmd(title, dup) } },
        { existing: f.existing, workDir: f.workDir },
      );
      const allowed = runHook(
        { tool_name: "Bash", tool_input: { command: createCmd(title, novel) } },
        { existing: f.existing, workDir: f.workDir },
      );

      expect(JSON.parse(blocked.stdout.trim()).decision).toBe(FINDING_GATE_DECISION);
      expect(allowed.stdout.trim()).toBe("");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("a Bash call that is not a `gh issue create` is passed over in silence", () => {
    const r = runHook({ tool_name: "Bash", tool_input: { command: "git status" } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("a non-Bash tool carrying the same text is passed over", () => {
    const f = fixture();
    try {
      const bodyFile = join(f.dir, "dup.md");
      writeFileSync(bodyFile, DUPLICATE_BODY);
      const r = runHook(
        { tool_name: "Write", tool_input: { command: createCmd("t", bodyFile) } },
        { existing: f.existing, workDir: f.workDir },
      );
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("the documented bypass turns the gate off for one command", () => {
    const f = fixture();
    try {
      const bodyFile = join(f.dir, "dup.md");
      writeFileSync(bodyFile, DUPLICATE_BODY);
      const r = runHook(
        { tool_name: "Bash", tool_input: { command: createCmd("dup", bodyFile) } },
        {
          existing: f.existing,
          workDir: f.workDir,
          env: { [FINDING_GATE_ENV]: FINDING_GATE_OFF },
        },
      );
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("the bypass is read EXACTLY — a near-miss value does not disable the gate", () => {
    // `.claude/rules/config-access.md`: a loose reading of a variable that
    // turns a gate off is a gate that turns itself off by accident.
    const f = fixture();
    try {
      const bodyFile = join(f.dir, "dup.md");
      writeFileSync(bodyFile, DUPLICATE_BODY);
      for (const value of ["OFF", "Off", "0", "off ", "offline", "true"]) {
        const r = runHook(
          { tool_name: "Bash", tool_input: { command: createCmd("dup", bodyFile) } },
          { existing: f.existing, workDir: f.workDir, env: { [FINDING_GATE_ENV]: value } },
        );
        expect(JSON.parse(r.stdout.trim()).decision, `${FINDING_GATE_ENV}=${value}`).toBe(
          FINDING_GATE_DECISION,
        );
      }
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe("#1261 AC-3: every unreadable reading ALLOWS, because this gate fails open", () => {
  const base = { projectRoot: ROOT, logPath: null } as const;
  const cmd = 'gh issue create --title "t" --body "about `evictOldest` in lib/widget-cache.ts, 144 of 5060"';

  const cases: Array<[string, () => Promise<unknown>]> = [
    [
      "the tracker read throws",
      () => findingGateReading(cmd, ROOT, {
        ...base,
        listIssues: () => { throw new Error("gh: could not authenticate"); },
      }),
    ],
    [
      "the tracker read times out",
      () => findingGateReading(cmd, ROOT, {
        ...base,
        listIssues: () => { const e: any = new Error("ETIMEDOUT"); e.code = "ETIMEDOUT"; throw e; },
      }),
    ],
    [
      "the tracker answers with something that is not a list",
      () => findingGateReading(cmd, ROOT, { ...base, listIssues: () => ("not an array at all" as any) }),
    ],
    [
      "the population is JSON but not an array",
      () => findingGateReading(cmd, ROOT, { ...base, listIssues: () => ({ oops: 1 } as any) }),
    ],
    [
      "an entry has neither `number` nor `id`",
      () => findingGateReading(cmd, ROOT, {
        ...base,
        listIssues: () => [{ title: "x", body: "y" }],
      }),
    ],
    [
      "the population is truncated",
      () => findingGateReading(cmd, ROOT, {
        ...base,
        limit: 2,
        listIssues: () => [1, 2, 3, 4].map(n => ({ number: n, title: `t${n}`, body: "b" })),
      }),
    ],
  ];

  for (const [name, run] of cases) {
    test(`ALLOW when ${name}`, async () => {
      const reading = (await run()) as Awaited<ReturnType<typeof findingGateReading>>;
      expect(reading.refusal, `${name} produced a REFUSAL; this gate must fail open`).toBeNull();
      // An allow nobody can distinguish from a clean one is the silent
      // default `.claude/rules/config-access.md` names. It must say so.
      expect(reading.unmeasured, `${name} allowed SILENTLY`).not.toBeNull();
    });
  }

  test("ALLOW when the body cannot be read, and the reason names which flag", async () => {
    for (const [why, command] of [
      ["no body flag", 'gh issue create --title "t" --label follow-up'],
      ["stdin body", 'gh issue create --title "t" --body-file - --label follow-up'],
      ["missing file", 'gh issue create --title "t" --body-file /nonexistent/nope.md'],
    ] as const) {
      const reading = await findingGateReading(command, ROOT, {
        ...base,
        listIssues: () => EXISTING,
      });
      expect(reading.refusal, why).toBeNull();
      expect(reading.unmeasured, why).not.toBeNull();
    }
  });

  test("the fail-open cases are reached through a REAL duplicate, not a novel finding", async () => {
    // Shape five in `.claude/rules/checks-must-be-able-to-fail.md`: if the
    // command above were not a duplicate, every row in this describe would
    // allow for the ordinary reason and the block would be vacuous. So the
    // same command is driven through a WORKING tracker read and must refuse.
    const reading = await findingGateReading(cmd, ROOT, {
      ...base,
      listIssues: () => EXISTING,
    });
    expect(reading.refusal).not.toBeNull();
    expect(reading.refusal).toContain("#4242");
  });
});

describe("#1261 AC-4: it gates on DUPLICATE and can gate on nothing else", () => {
  test("a finding the full arbiter would DROP as a nit is still allowed through", async () => {
    // `arbitrate` would refuse this one `DROPPED_CATEGORY` with a verifier
    // group attached. The hook convenes none, so the finding short-circuits
    // at the quorum check and comes through. That is the design: duplicate
    // detection is measurable, "worth filing" is not, and a gate guessing at
    // the second would suppress exactly what this lane is good at.
    const reading = await findingGateReading(
      'gh issue create --title "nit: rename this variable" --body "style only, `fooBar` in lib/x.ts"',
      ROOT,
      { projectRoot: ROOT, logPath: null, listIssues: () => EXISTING },
    );
    expect(reading.refusal).toBeNull();
  });

  test("no refusal other than DUPLICATE is reachable, over a sweep of shapes", async () => {
    const shapes = [
      'gh issue create --title "t" --body "no symbols, no numbers, nothing keyable"',
      'gh issue create --title "t" --body "cites lib/x.ts:9999 which is past the end"',
      'gh issue create --title "t" --body "`onlyBranchSymbol` exists nowhere on main"',
      'gh issue create --title "t" --body "style nit in `camelCase` at lib/y.ts, 11 and 12"',
    ];
    for (const shape of shapes) {
      const reading = await findingGateReading(shape, ROOT, {
        projectRoot: ROOT,
        logPath: null,
        listIssues: () => EXISTING,
      });
      expect(reading.refusal, shape).toBeNull();
      const refusals = reading.rows.map(r => r.refusal).filter(r => r !== null);
      expect(refusals.every(r => r === "UNMEASURED"), `${shape} → ${refusals}`).toBe(true);
    }
  });

  test("the decider passes no `votes`, which is what makes that true", () => {
    // The structural half of the claim above. A `votes:` here would reopen
    // every check after the quorum, and the sweep could not see it until a
    // finding happened to trip one.
    const src = readFileSync(DECIDER, "utf-8");
    expect(src).toContain("skipRepoChecks: true");
    expect(src).not.toContain("votes:");
  });
});

describe("#1261 AC-5: every refusal is recorded where a human can read it", () => {
  test("a refusal appends a JSONL row naming the duplicate", () => {
    const f = fixture();
    try {
      const bodyFile = join(f.dir, "dup.md");
      writeFileSync(bodyFile, DUPLICATE_BODY);
      runHook(
        { tool_name: "Bash", tool_input: { command: createCmd("dup", bodyFile) } },
        { existing: f.existing, workDir: f.workDir },
      );

      const log = readFileSync(join(f.workDir, "finding-gate.jsonl"), "utf-8").trim();
      const row = JSON.parse(log.split("\n").at(-1)!);
      expect(row.decision).toBe(FINDING_GATE_DECISION);
      expect(row.findings[0].duplicateOf).toEqual(["4242"]);
      expect(row.findings[0].allowed).toBe(false);
      expect(typeof row.at).toBe("string");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("an UNMEASURED allow is recorded too, so a broken arbiter is visible", async () => {
    const rows: unknown[] = [];
    await findingGateReading(
      'gh issue create --title "t" --body "`evictOldest` in lib/widget-cache.ts, 144 of 5060"',
      ROOT,
      {
        projectRoot: ROOT,
        log: r => rows.push(r),
        listIssues: () => { throw new Error("gh exploded"); },
      },
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).decision).toBe("allow");
    expect((rows[0] as any).unmeasured).toContain("gh exploded");
  });

  test("a log that cannot be written does not turn an allow into a block", async () => {
    const reading = await findingGateReading(
      'gh issue create --title "t" --body "`evictOldest` in lib/widget-cache.ts, 144 of 5060"',
      ROOT,
      {
        projectRoot: ROOT,
        logPath: "/proc/definitely/not/writable/x.jsonl",
        listIssues: () => EXISTING,
      },
    );
    // It is a duplicate, so it IS a refusal — the point is that the failed
    // log write neither threw nor changed the decision.
    expect(reading.refusal).toContain("#4242");
  });
});

describe("#1261: the command parse is the VerifyPhaseLock walk, not a second one", () => {
  test("a title that merely contains `--body=` is a title", () => {
    const got = proposedIssues(
      `gh issue create --title "--body=gotcha" --body "real body"`,
      ROOT,
    );
    expect(got).toHaveLength(1);
    expect(got[0].title).toBe("--body=gotcha");
    expect(got[0].body).toBe("real body");
  });

  test("two creates chained in one command are two proposals", () => {
    // The in-batch case #1187 was filed for: #1195 and #1196 were the same
    // symptom a minute apart, neither in the tracker when the other was
    // adjudicated. One command carrying both is the same shape, compressed.
    const got = proposedIssues(
      'gh issue create --title "a" --body "x" && gh issue create --title "b" --body "y"',
      ROOT,
    );
    expect(got.map(p => p.title)).toEqual(["a", "b"]);
  });

  test("two IDENTICAL findings in one command: the second is refused as a duplicate of the first", async () => {
    // `arbitrateBatch` accumulates as it walks, so the first survivor joins
    // the comparison set. A tracker-only dedupe cannot catch this and #1195
    // and #1196 are what that costs.
    const reading = await findingGateReading(
      `gh issue create --title "one" --body ${JSON.stringify(DUPLICATE_BODY)} && ` +
        `gh issue create --title "two" --body ${JSON.stringify(DUPLICATE_BODY)}`,
      ROOT,
      { projectRoot: ROOT, logPath: null, listIssues: () => [] },
    );
    expect(reading.refusal).not.toBeNull();
    const refused = reading.rows.filter(r => r.refusal === "DUPLICATE");
    expect(refused).toHaveLength(1);
    expect(reading.rows.filter(r => r.allowed)).toHaveLength(1);
  });

  test("the in-command corpus ids carry a POSITION, so two entries cannot share one", async () => {
    // Three creates: two distinct novel findings, then a copy of the second.
    // The refusal must name WHICH earlier create it collided with. Before
    // the ids carried a position every allowed finding joined the corpus
    // under one string, which is the "already reported as X, X" shape #1253
    // closed elsewhere.
    const third =
      "A third thing: `drainBacklog` in lib/widget-cache.ts spins 97 times " +
      "per flush across 4210 sampled flushes.";
    const reading = await findingGateReading(
      `gh issue create --title "one" --body ${JSON.stringify(NOVEL_BODY)} && ` +
        `gh issue create --title "two" --body ${JSON.stringify(third)} && ` +
        `gh issue create --title "three" --body ${JSON.stringify(third)}`,
      ROOT,
      { projectRoot: ROOT, logPath: null, listIssues: () => [] },
    );
    expect(reading.rows.filter(r => r.allowed)).toHaveLength(2);
    const refused = reading.rows.filter(r => !r.allowed);
    expect(refused).toHaveLength(1);
    // It collided with the SECOND create, and says so.
    expect(refused[0].duplicateOf).toEqual([earlierInCommand(2)]);
    // And the id is not rendered with a `#`, which would read as an issue.
    expect(reading.refusal).not.toContain(`#${earlierInCommand(2)}`);
  });

  test("an echo of the command text creates nothing", () => {
    expect(proposedIssues(`echo 'gh issue create --title x --body y'`, ROOT)).toEqual([]);
  });

  test("a `bash -c` wrapper IS a create", () => {
    const got = proposedIssues(`bash -c 'gh issue create --title "x" --body "y"'`, ROOT);
    expect(got.map(p => p.title)).toEqual(["x"]);
  });

  test("the default population limit is above the tracker's open count, with headroom", () => {
    expect(DEFAULT_POPULATION_LIMIT).toBeGreaterThan(32);
  });
});

/**
 * AC-6 — the refusal routes through one constant, and the mutation is
 * observed.
 *
 * `FINDING_GATE_DECISION` is the single site the hook emits, so a case that
 * saw `{"decision":"block"}` can be proved to have seen THAT constant rather
 * than a literal elsewhere in the hook. The mutant sets it to a value Claude
 * Code does not act on: real hook blocks, mutant does not, on one input.
 *
 * This is the answer to "what did you break to prove the refusal can fail"
 * (`.claude/rules/checks-must-be-able-to-fail.md`), and it is re-checked on
 * every run rather than asserted once in a PR description.
 */
describe("#1261 AC-6: the block routes through one constant, mutated and observed", () => {
  const hookSource = readFileSync(HOOK, "utf-8");
  const DECLARATION = 'export const FINDING_GATE_DECISION = "block";';

  test("the hook emits no `decision` literal of its own", () => {
    expect(hookSource).toContain("decision: FINDING_GATE_DECISION");
    expect(hookSource).not.toContain("decision: 'block'");
    expect(hookSource).not.toContain('decision: "block"');
  });

  test("the constant is declared exactly once in the decider", () => {
    const src = readFileSync(DECIDER, "utf-8");
    expect(src.split(DECLARATION).length - 1).toBe(1);
    expect(FINDING_GATE_DECISION).toBe("block");
  });

  test("real hook blocks, mutant hook does not, on the same input", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg1261-mutant-"));
    const f = fixture();
    try {
      const bodyFile = join(f.dir, "dup.md");
      writeFileSync(bodyFile, DUPLICATE_BODY);
      const payload = {
        tool_name: "Bash",
        tool_input: { command: createCmd("evictOldest evicts the wrong entry", bodyFile) },
      };

      // The mutant copies the decider and rewrites every relative specifier
      // to an absolute path against the real tree, so a module-resolution
      // death cannot be mistaken for the mutation being rejected on the
      // merits (`.claude/rules/self-referential-tests.md`, Tier 1, last row).
      let deciderMutant = readFileSync(DECIDER, "utf-8").replace(
        DECLARATION,
        'export const FINDING_GATE_DECISION = "mutated-not-a-decision";',
      );
      const deciderRewrites: Array<[string, string]> = [
        ['"./issue-create-override"', JSON.stringify(join(ROOT, "lib", "issue-create-override.ts"))],
        ['"./finding-arbiter"', JSON.stringify(join(ROOT, "lib", "finding-arbiter.ts"))],
        ['"./github"', JSON.stringify(join(ROOT, "lib", "github.ts"))],
        ['"./branch-cleanup"', JSON.stringify(join(ROOT, "lib", "branch-cleanup.ts"))],
      ];
      for (const [from, to] of deciderRewrites) deciderMutant = deciderMutant.split(from).join(to);
      writeFileSync(join(dir, "finding-gate.ts"), deciderMutant);

      let hookMutant = hookSource.replace("'../lib/finding-gate'", "'./finding-gate'");
      const hookRewrites: Array<[string, string]> = [
        ["'./lib/parseStdin'", JSON.stringify(join(ROOT, "hooks", "lib", "parseStdin.ts"))],
        ["'./lib/paths'", JSON.stringify(join(ROOT, "hooks", "lib", "paths.ts"))],
      ];
      for (const [from, to] of hookRewrites) hookMutant = hookMutant.split(from).join(to);
      const mutantHook = join(dir, "FindingArbiterGate.hook.ts");
      writeFileSync(mutantHook, hookMutant);

      // A relative specifier the rewriter does not know about kills the
      // mutant on module resolution, which is indistinguishable from the
      // mutation being rejected. Abort rather than let that read as a result.
      const leftover = (src: string, allowed: string[]) =>
        [...src.matchAll(/(?:from|import\()\s*['"](\.[^'"]*)['"]/g)]
          .map(m => m[1])
          .filter(s => !allowed.includes(s));
      expect(leftover(deciderMutant, []), "the decider gained a relative import").toEqual([]);
      expect(leftover(hookMutant, ["./finding-gate"]), "the hook gained a relative import").toEqual([]);

      const real = runHook(payload, { existing: f.existing, workDir: f.workDir });
      const mutant = runHook(payload, { existing: f.existing, workDir: f.workDir, hook: mutantHook });

      // The mutant must have RUN, not died. A crash reports no decision and
      // would read exactly like the mutation being rejected.
      expect(mutant.status, `mutant did not run: ${mutant.stderr}`).toBe(0);

      expect(JSON.parse(real.stdout.trim()).decision).toBe(FINDING_GATE_DECISION);
      expect(JSON.parse(mutant.stdout.trim()).decision).toBe("mutated-not-a-decision");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

/**
 * The four registration positions (`.claude/rules/self-referential-tests.md`,
 * Tier 2, "a new hook"). Asserted here as the one behavioural claim this PR
 * makes about registration; `test/hook-traceability.test.ts` asks the census
 * question over every hook.
 */
describe("#1261: the new hook is registered in all four positions", () => {
  test("the hook file carries its SC ids", () => {
    const src = readFileSync(HOOK, "utf-8");
    for (const sc of ["SC-370", "SC-371"]) {
      expect(src, `${sc} missing from the hook header`).toContain(sc);
    }
  });

  test("it is in .claude/rungate/hooks.json, enabled, on Bash PreToolUse", () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, ".claude", "rungate", "hooks.json"), "utf-8"));
    const entry = hooks.find((h: any) => h.name === "FindingArbiterGate");
    expect(entry).toBeDefined();
    expect(entry.enabled).toBe(true);
    expect(entry.hookFor).toBe("PreToolUse");
    expect(entry.matcher).toBe("Bash");
    // A `deployToConsumers: false` entry must say why, or off and
    // never-considered look identical in a file.
    expect(entry.notDeployedReason.length).toBeGreaterThan(80);
  });

  test("it is in the HOOK-ARCHITECTURE-SPEC current-state table", () => {
    const spec = readFileSync(join(ROOT, "specs", "HOOK-ARCHITECTURE-SPEC.md"), "utf-8");
    expect(spec).toContain("| FindingArbiterGate | FindingArbiterGate.hook.ts |");
  });

  test("it is registered in .claude/settings.json on Bash", () => {
    const settings = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf-8"));
    const commands = (settings.hooks?.PreToolUse ?? [])
      .filter((g: any) => g.matcher === "Bash")
      .flatMap((g: any) => g.hooks ?? [])
      .map((h: any) => h.command);
    expect(commands.some((c: string) => c.includes("FindingArbiterGate.hook.ts"))).toBe(true);
  });
});
