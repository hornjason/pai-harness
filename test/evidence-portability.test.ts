/**
 * `evidence-target-valid` asserted nothing, and the rebuild changed its name
 * (#338).
 *
 * The deleted check gated on `codeCommittedPaths` — which no config authors
 * — and past that early return computed an `outside` list and discarded it
 * under a comment saying outside refs are common. No `expect`. It was a name
 * in `config/ceremony-profiles.json` and nothing else.
 *
 * #338 asked for a threshold with evidence behind it before any code. The
 * measurement is in `specs/GATE-CONTRACTS-SPEC.md` and it killed the
 * original premise: across 82 completed runs, 278 of 542 classifiable
 * evidence file references fall OUTSIDE the AC's own `contextFiles`, and the
 * largest single category is the test file that proves the AC. "Within
 * scope" is not a property real runs have.
 *
 * What the same measurement found is what this checks: 50 of 452 evidence
 * commands — 11.1%, across 11 of 82 runs — hardcode a path into a
 * developer's home directory and cannot run anywhere else.
 *
 * Covers SC-792..795 of GATE-CONTRACTS-SPEC.md.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  evidencePortabilityViolations,
  machinePathsIn,
  MACHINE_PATH,
  PORTABLE_FORMS,
} from "../lib/evidence-portability";

const REPO = join(import.meta.dir, "..");

function ac(id: string, command: string | null) {
  return { id, type: "OUTCOME", evidenceMethod: command === null ? null : { type: "COMMAND", command } };
}

/** Built rather than written, so this file does not carry a literal home path. */
const HOME_PREFIX = ["", "Users", "someone", "Projects", "thing"].join("/");

describe("#338: an evidence command pinned to one machine is refused", () => {
  test("a command hardcoding a home path is a violation", () => {
    const v = evidencePortabilityViolations([
      ac("AC-1", `HARNESS_ROOT=${HOME_PREFIX} bun test test/x.test.ts`),
    ]);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("AC-1");
    expect(v[0]).toContain(HOME_PREFIX);
  });

  test("the refusal names the portable form, so it is actionable", () => {
    // A violation a reader cannot act on is the other half of the defect
    // class this repo keeps finding: a report nobody can do anything with.
    const v = evidencePortabilityViolations([ac("AC-1", `cd ${HOME_PREFIX} && bun test`)]);
    expect(v[0]).toContain("$HARNESS_ROOT");
    expect(v[0]).toContain("relative to the project root");
    for (const form of PORTABLE_FORMS) expect(v[0]).toContain(form);
  });

  test("a portable command is NOT a violation", () => {
    // The positive control. A check that refuses everything satisfies every
    // case above and blocks every run.
    expect(
      evidencePortabilityViolations([
        ac("AC-1", "bun test test/evidence-portability.test.ts"),
        ac("AC-2", '$HARNESS_ROOT/scripts/typecheck.ts'),
        ac("AC-3", "bun -e \"import {x} from './lib/y.ts'\""),
      ]),
    ).toEqual([]);
  });

  test("/tmp and /usr are not machine-specific and are left alone", () => {
    // Deliberately narrow. 9 commands in the corpus use /tmp legitimately,
    // and a detector that argued with correct commands would be switched
    // off — which is how the check being replaced died in the first place.
    expect(
      evidencePortabilityViolations([
        ac("AC-1", "bun test --tmpdir /tmp/fixture"),
        ac("AC-2", "/usr/bin/env bun test"),
        ac("AC-3", "ls /var/log"),
      ]),
    ).toEqual([]);
  });

  test("both /Users and /home are recognised", () => {
    const linux = ["", "home", "someone", "src", "proj"].join("/");
    expect(machinePathsIn(`cd ${linux} && bun test`)).toEqual([linux]);
    expect(machinePathsIn(`cd ${HOME_PREFIX} && bun test`)).toEqual([HOME_PREFIX]);
  });

  test("the same path twice is reported once; two different paths are two", () => {
    // Deduped on the whole path, not on its root. `…/thing/a.ts` and
    // `…/thing/b.ts` are two unportable references and collapsing them
    // would hide the second from whoever fixes the first.
    const twice = evidencePortabilityViolations([
      ac("AC-1", `cd ${HOME_PREFIX} && bun test && cd ${HOME_PREFIX}`),
    ]);
    expect(twice.length).toBe(1);
    expect(twice[0].split(HOME_PREFIX).length - 1).toBe(1);

    const two = evidencePortabilityViolations([
      ac("AC-1", `bun ${HOME_PREFIX}/a.ts && bun ${HOME_PREFIX}/b.ts`),
    ]);
    expect(two.length).toBe(1);
    expect(two[0]).toContain(`${HOME_PREFIX}/a.ts`);
    expect(two[0]).toContain(`${HOME_PREFIX}/b.ts`);
    expect(two[0]).toContain("paths");
  });

  test("every offending AC is reported, not just the first", () => {
    // One violation per run is enough to refuse, which is exactly why a
    // check that stops at the first makes the second invisible until the
    // first is fixed — two rounds instead of one.
    const v = evidencePortabilityViolations([
      ac("AC-1", `bun ${HOME_PREFIX}/a.ts`),
      ac("AC-2", "bun test"),
      ac("AC-3", `bun ${HOME_PREFIX}/b.ts`),
    ]);
    expect(v.length).toBe(2);
    expect(v.map(x => x.slice(0, 4))).toEqual(["AC-1", "AC-3"]);
  });
});

describe("#338: what is NOT measured is not reported as clean", () => {
  test("an AC with no command is left to all-acs-have-evidence", () => {
    // Not a fail-open: that check refuses a missing command, and two checks
    // judging one fact disagree the moment either changes.
    expect(evidencePortabilityViolations([ac("AC-1", null), ac("AC-2", "")])).toEqual([]);
  });

  test("a state with no acs array yields nothing rather than throwing", () => {
    expect(evidencePortabilityViolations(undefined)).toEqual([]);
    expect(evidencePortabilityViolations("not an array")).toEqual([]);
  });
});

describe("#338: the gate and the ceremony profiles name the same check", () => {
  /**
   * The check is SPAWNED against a planted state, not grepped for.
   *
   * A mutation that left the call in place and threw its result away —
   * `const violations: string[] = []; const _u = evidencePortabilityViolations(…)`
   * — scored **0 red** against a source-text assertion. The grep saw the
   * call and the gate was inert. That is the defect class this whole issue
   * is about, reintroduced inside the test meant to catch it.
   *
   * So the gate check is run twice over the same planted workflow-state:
   * once with an unportable command and once without. `ran === 1` is
   * asserted first, because a `-t` filter matching nothing reports zero
   * failures and is indistinguishable from the check passing.
   */
  function runGateCheck(command: string): { ran: number; failed: number; output: string } {
    const dir = mkdtempSync(join(tmpdir(), "ev-port-"));
    writeFileSync(
      join(dir, "workflow-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        issue: 338,
        phase: "VERIFY",
        acs: [{ id: "AC-1", type: "OUTCOME", evidenceMethod: { type: "COMMAND", command } }],
      }),
    );
    const r = spawnSync(
      "bun",
      ["test", join(REPO, "gates", "workflow.test.ts"), "-t", "evidence-portable"],
      { cwd: REPO, encoding: "utf-8", env: { ...process.env, TEST_WORK_DIR: dir }, timeout: 120_000 },
    );
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    rmSync(dir, { recursive: true, force: true });
    const pass = /^\s*(\d+) pass\s*$/m.exec(output);
    const fail = /^\s*(\d+) fail\s*$/m.exec(output);
    return {
      ran: (pass ? +pass[1] : 0) + (fail ? +fail[1] : 0),
      failed: fail ? +fail[1] : 0,
      output,
    };
  }

  test("the gate REFUSES a planted unportable command", () => {
    const r = runGateCheck(`HARNESS_ROOT=${HOME_PREFIX} bun test`);
    expect(r.ran, `the check did not run:\n${r.output}`).toBe(1);
    expect(r.failed, r.output).toBe(1);
    // A suite that failed to load is also red, so the refusal text is
    // asserted too — otherwise a broken import reads as the guard working.
    expect(r.output).toContain("home directory");
  }, 180_000);

  test("the gate PASSES a planted portable command", () => {
    const r = runGateCheck("bun test test/evidence-portability.test.ts");
    expect(r.ran, `the check did not run:\n${r.output}`).toBe(1);
    expect(r.failed, r.output).toBe(0);
  }, 180_000);

  test("the profiles that named the deleted check name this one", () => {
    // SC-4: added in the same change, so the profile and the test cannot
    // disagree. #315 removed `evidence-target-valid` from STANDARD and
    // THOROUGH `verify`; those are the two lists restored.
    const profiles = JSON.parse(
      readFileSync(join(REPO, "config", "ceremony-profiles.json"), "utf-8"),
    );
    for (const tier of ["STANDARD", "THOROUGH"]) {
      expect(profiles.tiers[tier].checks.verify, tier).toContain("evidence-portable");
    }
    // LIGHT carried neither, then or now — this is a restoration, not growth.
    expect(profiles.tiers.LIGHT.checks.verify).not.toContain("evidence-portable");
  });

  test("the check that asserted nothing is gone from both", () => {
    const src = readFileSync(join(REPO, "gates", "workflow.test.ts"), "utf-8");
    const profiles = readFileSync(join(REPO, "config", "ceremony-profiles.json"), "utf-8");
    expect(src).not.toContain('test("evidence-target-valid');
    expect(profiles).not.toContain("evidence-target-valid");
  });
});

describe("#338: driven against the corpus the threshold came from", () => {
  /**
   * Every case above hands the function a hand-written command, which proves
   * it can read a string. The threshold was measured on real runs, so the
   * rule is run against them too — otherwise the 11.1% is a number in a
   * commit message rather than something the suite can still see.
   */
  const RUNS = join(homedir(), ".rungate");

  function stateFiles(): string[] {
    if (!existsSync(RUNS)) return [];
    const out: string[] = [];
    for (const base of [RUNS, join(RUNS, ".archive")]) {
      if (!existsSync(base)) continue;
      for (const d of readdirSync(base)) {
        const p = join(base, d, "workflow-state.json");
        if (existsSync(p)) out.push(p);
      }
    }
    return out;
  }

  test("the rule finds the population the threshold was set from", () => {
    const files = stateFiles();
    if (files.length === 0) {
      // No local run history — a fresh clone or CI. Saying so beats a test
      // that silently passes over an empty corpus, which is the shape this
      // whole issue is about.
      expect(existsSync(RUNS)).toBe(false);
      return;
    }
    let withCommand = 0;
    let offending = 0;
    const runsHit = new Set<string>();
    for (const f of files) {
      let state: { acs?: unknown };
      try {
        state = JSON.parse(readFileSync(f, "utf-8"));
      } catch {
        continue;
      }
      const acs = Array.isArray(state.acs) ? state.acs : [];
      for (const a of acs) {
        const cmd = (a as { evidenceMethod?: { command?: unknown } })?.evidenceMethod?.command;
        if (typeof cmd === "string" && cmd.trim() !== "") withCommand++;
      }
      const v = evidencePortabilityViolations(acs);
      offending += v.length;
      if (v.length > 0) runsHit.add(f);
    }
    // Not an equality assertion: the corpus grows with every run. The claim
    // is that the rule still discriminates — it fires on some real runs and
    // not on most of them. A rule that fired on everything or nothing would
    // fail one of these two bounds.
    expect(withCommand, "no evidence commands in the local corpus").toBeGreaterThan(0);
    expect(offending, "the rule no longer fires on any recorded run").toBeGreaterThan(0);
    expect(
      runsHit.size / files.length,
      `fires on ${runsHit.size} of ${files.length} runs — measured at 11 of 82 when this shipped`,
    ).toBeLessThan(0.5);
  });

  test("a global regex cannot leak lastIndex between calls", () => {
    // MACHINE_PATH carries /g, so an implementation using `.exec` without
    // running it to exhaustion leaves lastIndex advanced and the NEXT call
    // on the same input returns nothing — a check that passes because of
    // where the last one stopped reading.
    //
    // Called three times with different inputs interleaved, because two
    // identical calls are satisfied by an implementation that resets only
    // when it reaches the end of the string.
    const a = `cd ${HOME_PREFIX} && bun test`;
    const b = `bun ${HOME_PREFIX}/x.ts`;
    expect(machinePathsIn(a)).toEqual([HOME_PREFIX]);
    expect(machinePathsIn(b)).toEqual([`${HOME_PREFIX}/x.ts`]);
    expect(machinePathsIn(a)).toEqual([HOME_PREFIX]);
    expect(MACHINE_PATH.lastIndex).toBe(0);

    // And through the exported entry point, where the leak would actually
    // bite: two ACs in one call, the second one short.
    const v = evidencePortabilityViolations([
      ac("AC-1", `bun ${HOME_PREFIX}/a-very-long-path-here.ts`),
      ac("AC-2", `cd ${HOME_PREFIX}`),
    ]);
    expect(v.length).toBe(2);
  });
});
