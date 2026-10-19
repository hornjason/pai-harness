/**
 * #669: `bun test --grep` is accepted by the shell, accepted by bun, and does
 * nothing.
 *
 * Measured on run `wf_448af2c4-6c1` (#664). AC-2 and AC-5 both ran
 *
 *     bun test test/source-slice-structural.test.ts --grep '<word>'
 *
 * Bun's flag is `-t, --test-name-pattern`. `--grep` does not appear in
 * `bun test --help`, and bun does not reject it — it exits 0 with no
 * unknown-flag error. So AC-2's command is byte-equivalent in behaviour to
 * AC-1's: the criterion that exists to be INDEPENDENT of AC-1 was checked by
 * the same observation, and AC-5's recorded evidence was the version banner
 * alone.
 *
 * This is the worst shape a bad flag can have. A flag the tool REJECTS shows
 * up as a broken command in the dry run. A flag the tool IGNORES produces a
 * clean run, a plausible number, and a gate that measured something other
 * than what its AC says.
 *
 * ## Why an allowlist, and why only bun
 *
 * A refusal needs the tool's own list of flags to be honest, and this holds
 * one list: bun's, transcribed from `bun test --help` and `bun --help` on
 * v1.3.x. Every other tool is unknown and therefore never refused — the
 * direction this is allowed to be wrong in. The transcription is checked
 * against the real binary below, so a bun release that adds `--grep` turns
 * this red rather than leaving the table quietly wrong.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { satisfiabilityRefusal } from "../lib/evidence-satisfiability";
import { BUN_TEST_FLAGS } from "../lib/evidence-satisfiability";

const REPO_ROOT = join(import.meta.dir, "..");

interface FixtureAc {
  id: string;
  threshold?: { op?: string; value?: string | number; unit?: string };
  evidenceMethod?: { type?: string; command?: string };
}

const FIXTURE: { acs: FixtureAc[] } = JSON.parse(
  readFileSync(join(REPO_ROOT, "test", "fixtures", "ac-set-664.json"), "utf-8"),
);

const ac664 = (id: string): FixtureAc => {
  const found = FIXTURE.acs.find((a) => a.id === id);
  if (!found) throw new Error(`the #664 fixture no longer carries ${id}`);
  return found;
};

const cmd = (command: string) => ({
  id: "AC-1",
  evidenceMethod: { type: "BUN_TEST", command },
  threshold: { op: ">=", value: 2 },
});

describe("#669 AC-3: the planted --grep, replayed from the run that shipped it", () => {
  test("the fixture really carries the planted flag", () => {
    // Vacuity. A case that replays an AC set proves nothing if the AC set has
    // been tidied up on the way into the repository.
    expect(ac664("AC-2").evidenceMethod?.command).toContain("--grep");
    expect(ac664("AC-5").evidenceMethod?.command).toContain("--grep");
  });

  test("#664 AC-2 is refused, naming both --grep and --test-name-pattern", () => {
    const refusal = satisfiabilityRefusal(ac664("AC-2"));
    expect(refusal, "bun test --grep was accepted").not.toBeNull();
    expect(refusal, "the refusal does not name the flag").toContain("--grep");
    expect(refusal, "the refusal does not name the accepted alternative").toContain(
      "--test-name-pattern",
    );
    expect(refusal).toContain("AC-2");
  });

  test("#664 AC-5 is refused for the same reason", () => {
    expect(satisfiabilityRefusal(ac664("AC-5"))).toContain("--test-name-pattern");
  });

  test("the refusal says the flag is IGNORED, not rejected", () => {
    // The actionable half. "bun does not accept --grep" sends the next reader
    // to look for an error that never happened; the command exits 0.
    expect(satisfiabilityRefusal(ac664("AC-2"))).toMatch(/ignore|silently/i);
  });
});

describe("#669 AC-3: the flag table is bun's, measured against bun", () => {
  /**
   * `bun test --help` with a path argument, so the suite lock reads this as a
   * targeted invocation rather than a full-suite run (lib/test-suite-lock.ts
   * treats an argument containing `/` as a path). It prints help and runs
   * nothing.
   */
  const help = execFileSync("bun", ["test", "--help", "test/__no_such_file__.test.ts"], {
    encoding: "utf-8",
    cwd: tmpdir(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  test("bun's help still has no --grep, and still has --test-name-pattern", () => {
    expect(help, "could not read bun test --help").toContain("Usage: bun test");
    expect(help, "bun has added --grep — the table and the alternative must change").not.toContain(
      "--grep",
    );
    expect(help).toContain("--test-name-pattern");
  });

  test("every flag bun's own help documents is accepted by the table", () => {
    // The control that keeps this from being a refuser of everything. A flag
    // bun documents and the table omits would refuse a correct AC, which is
    // the expensive direction.
    const documented = [...help.matchAll(/(?:^|\s)(--[a-z0-9][a-z0-9-]*)/g)].map((m) => m[1]);
    expect(documented.length, "no flags were read out of bun's help").toBeGreaterThan(20);
    const missing = documented.filter((f) => !BUN_TEST_FLAGS.has(f.slice(2)));
    expect(missing, "bun documents flags the table does not accept").toEqual([]);
  });

  test("a documented flag in a real command is not refused", () => {
    for (const command of [
      `bun test test/a.test.ts`,
      `bun test test/a.test.ts --test-name-pattern 'read'`,
      `bun test test/a.test.ts -t 'read'`,
      `bun test test/a.test.ts --reporter=junit --reporter-outfile=/tmp/j.xml`,
      `bun test --parallel --no-isolate`,
      `bun test test/a.test.ts --timeout=30000 --bail=1`,
      `bun test test/a.test.ts 2>&1 | tail -3`,
    ]) {
      expect(satisfiabilityRefusal(cmd(command)), command).toBeNull();
    }
  });
});

describe("#669 AC-3: the boundary of the flag clause", () => {
  test("an undocumented flag is refused even with no known alternative", () => {
    const refusal = satisfiabilityRefusal(cmd(`bun test test/a.test.ts --verbose`));
    expect(refusal, "--verbose is not a bun test flag and was accepted").not.toBeNull();
    expect(refusal).toContain("--verbose");
  });

  test("a tool whose flags this does not hold is never refused", () => {
    // One table, one tool. Refusing a flag on a tool nobody transcribed would
    // be a guess, and a false refusal stops a correct run cold.
    for (const command of [
      `grep --what-is-this 'x' lib/a.ts`,
      `rg --invented-flag 'x' lib`,
      `npm test -- --grep 'read'`,
      `bun run typecheck --grep 'read'`,
      `bun build ./a.ts --grep x`,
    ]) {
      expect(satisfiabilityRefusal(cmd(command)), command).toBeNull();
    }
  });

  test("the flag is found wherever the pipeline puts the bun test stage", () => {
    expect(
      satisfiabilityRefusal(cmd(`bun test test/a.test.ts --grep 'x' | tail -1`)),
    ).not.toBeNull();
    expect(
      satisfiabilityRefusal(cmd(`cd /tmp && bun test test/a.test.ts --grep 'x'`)),
    ).not.toBeNull();
    // …and a `--grep` that belongs to another stage is that stage's business.
    expect(satisfiabilityRefusal(cmd(`bun test test/a.test.ts | rg --grep 'x'`))).toBeNull();
  });

  test("a --grep inside a quoted argument is not read as a flag", () => {
    expect(
      satisfiabilityRefusal(cmd(`bun test test/a.test.ts -t '--grep is not a flag'`)),
    ).toBeNull();
  });
});
