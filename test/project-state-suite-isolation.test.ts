/**
 * #1135 — the project-state suites must not write the tree they measure.
 *
 * `test/update-project-state.test.ts` pointed its fixtures at the real
 * `project-state.json` and `PROJECT-STATE.md`, ran the renderer against the
 * repo root, and put the originals back in `afterAll`. Restoring is not
 * isolation: the window is open for the whole run, it is lost on a crash, and
 * several agents share this checkout.
 *
 * Measured on the unfixed suite, with a reader polling the live
 * `project-state.json` the way `test/project-state-currency.test.ts:94` and
 * `test/closing-keywords.test.ts:426` do:
 *
 * | row | reads | usable | no `session` | ENOENT |
 * |---|---|---|---|---|
 * | **control** — idle tree, 5s | 11,889 | 11,889 | 0 | 0 |
 * | **witness** — during one suite run | 111,645 | 57,655 | 43,775 | 10,215 |
 *
 * 48.4% of the run window hands those two suites a document they cannot read:
 * either a fixture with no `session` field, or no file at all — the suite
 * deletes `project-state.json` outright to exercise the missing-source
 * refusal. Both readers are deliberately pointed at the live record and must
 * stay that way, so the writer is what moves.
 *
 * The guard below is behavioural, not a grep: it samples the two DA-owned
 * paths while the suite actually runs. A grep for `writeFileSync` would go
 * green on a suite that reached the same files through a helper.
 */

import { describe, test, expect } from "bun:test";
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");

/** The records the DA owns (#296). A test may read them; nothing here may write them. */
const DA_OWNED = ["project-state.json", "PROJECT-STATE.md"];

/**
 * A sampler that runs in its OWN process.
 *
 * An in-process sampler cannot work: the suite under test is launched with
 * `spawnSync`, which blocks this thread for the whole run, so every sample
 * would be taken after the writes had already been undone — an instrument
 * that reports clean by construction.
 */
const SAMPLER = `
import { existsSync, readFileSync, appendFileSync } from "fs";
const [, , out, ...targets] = process.argv;
const seen = new Set();
// No SIGTERM handler on purpose. Registering one defers the kill to an event
// loop this busy wait never yields to, and the sampler would outlive the test.
for (;;) {
  for (const t of targets) {
    let obs;
    try {
      obs = existsSync(t) ? t + "\\t" + Bun.hash(readFileSync(t)).toString(16) : t + "\\tABSENT";
    } catch {
      obs = t + "\\tUNREADABLE";
    }
    if (!seen.has(obs)) { seen.add(obs); appendFileSync(out, obs + "\\n"); }
  }
  Bun.sleepSync(2);
}
`;

/**
 * Run `work()` while watching `targets`, and return the distinct states each
 * path was observed in. One state per path means the path never moved.
 */
function statesDuring(targets: string[], work: () => void): Map<string, Set<string>> {
  const dir = mkdtempSync(join(tmpdir(), "ps-isolation-"));
  const log = join(dir, "observations.tsv");
  const samplerSrc = join(dir, "sampler.ts");
  writeFileSync(samplerSrc, SAMPLER);
  writeFileSync(log, "");

  const sampler = spawn("bun", [samplerSrc, log, ...targets], { stdio: "ignore" });
  try {
    // Let the sampler record the resting state before anything moves,
    // otherwise a fast write could be the FIRST state seen and read as "never
    // changed".
    spawnSync("sleep", ["1"]);
    work();
    spawnSync("sleep", ["0.3"]);
  } finally {
    sampler.kill("SIGKILL");
  }

  const states = new Map<string, Set<string>>();
  for (const t of targets) states.set(t, new Set());
  for (const line of readFileSync(log, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const [path, obs] = line.split("\t");
    states.get(path!)?.add(obs!);
  }
  rmSync(dir, { recursive: true, force: true });
  return states;
}

describe("#1135: the project-state suites leave the measured tree alone", () => {
  /**
   * The instrument check, and it is not optional.
   *
   * "One state observed" is the same reading a blind sampler produces — a
   * typo in the path, a log that never got written, a child that died at
   * startup. So the identical instrument is pointed at a tree that IS written
   * during the run, and has to see it. The differing input is the root: a
   * temp copy rather than the repo, so the control can dirty files with the
   * same names without touching the records this test exists to protect.
   */
  test("negative control: the sampler sees a write-then-restore it is pointed at", () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-control-"));
    try {
      const targets = DA_OWNED.map(f => join(dir, f));
      for (const t of targets) writeFileSync(t, "original\n");

      const mutator = join(dir, "mutate.ts");
      writeFileSync(
        mutator,
        `import { writeFileSync, rmSync } from "fs";\n` +
          `const targets = ${JSON.stringify(targets)};\n` +
          // Exactly the shape the unfixed suite had: replace, delete, restore.
          `for (const t of targets) writeFileSync(t, "fixture\\n");\n` +
          `Bun.sleepSync(400);\n` +
          `rmSync(targets[0]);\n` +
          `Bun.sleepSync(400);\n` +
          `for (const t of targets) writeFileSync(t, "original\\n");\n`,
      );

      const states = statesDuring(targets, () => {
        const r = spawnSync("bun", [mutator], { encoding: "utf-8" });
        expect(r.status, r.stderr ?? "").toBe(0);
      });

      // The replaced content is a second state; the delete is a third.
      expect(
        states.get(targets[0]!)!.size,
        "the sampler could not see a write it was pointed directly at — it is blind, " +
          "and the witness below proves nothing",
      ).toBeGreaterThan(1);
      expect(
        [...states.get(targets[0]!)!].some(s => s === "ABSENT"),
        "the sampler missed an outright deletion",
      ).toBe(true);
      expect(states.get(targets[1]!)!.size).toBeGreaterThan(1);

      // …and it settles back, so "more than one state" is about the window
      // and not about the file ending up different.
      expect(readFileSync(targets[0]!, "utf-8")).toBe("original\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  /**
   * The witness. Red before the fix with 3 states on `project-state.json`
   * (committed, fixture, ABSENT) and 2 on `PROJECT-STATE.md`; 1 each after.
   */
  test("running update-project-state.test.ts never moves the DA-owned records", () => {
    const targets = DA_OWNED.map(f => join(REPO, f));
    for (const t of targets) {
      expect(existsSync(t), `${t} is missing before the run — nothing to measure`).toBe(true);
    }
    const before = targets.map(t => readFileSync(t, "utf-8"));

    const states = statesDuring(targets, () => {
      const r = spawnSync("bun", ["test", "test/update-project-state.test.ts"], {
        cwd: REPO,
        encoding: "utf-8",
        timeout: 180_000,
      });
      const out = (r.stdout ?? "") + (r.stderr ?? "");
      // UNMEASURED must fail, not skip. A suite that errored out wrote
      // nothing for reasons that have nothing to do with this fix.
      expect(r.status, `the suite under test did not pass, so its writes were never exercised:\n${out}`).toBe(0);

      /**
       * The issue's own negative control: "a suite that no longer writes
       * because it no longer runs its write path is indistinguishable from
       * one that was fixed, and the checkbox count going to zero is the same
       * number both produce."
       *
       * So the run has to be shown to have HAPPENED. Deleting the suite,
       * skipping every case, or commenting out the renderer calls all drive
       * the state count to 1 — and all of them trip this.
       */
      const passing = Number(out.match(/^\s*(\d+) pass$/m)?.[1] ?? 0);
      expect(
        passing,
        `the suite reported ${passing} passing tests — too few to have exercised the renderer, ` +
          `so a state count of 1 would mean "did not run", not "did not write":\n${out}`,
      ).toBeGreaterThanOrEqual(18);
      expect(out).toMatch(/^\s*0 fail$/m);
    });

    for (const t of targets) {
      const seen = states.get(t)!;
      expect(
        seen.size,
        `${t} was observed in ${seen.size} distinct states during the run ` +
          `(${[...seen].join(", ")}). The suite is writing the tree it measures.`,
      ).toBe(1);
      expect([...seen], `${t} was deleted during the run`).not.toContain("ABSENT");
    }

    // Belt and braces: the content is also identical end to end, so a suite
    // that moved a file and put it back between two samples still fails if it
    // landed somewhere different.
    targets.forEach((t, i) => expect(readFileSync(t, "utf-8")).toBe(before[i]!));
  }, 300_000);

  /**
   * The other four `project-state-*` suites already run against `mkdtemp`
   * copies. Pinned so the fix cannot be read as making all five safe when
   * four of them always were — and so a later edit cannot quietly point one
   * of them back at the repo.
   */
  test("the four sibling suites were already isolated, and stay that way", () => {
    const siblings = [
      "test/project-state-currency.test.ts",
      "test/project-state-derivation.test.ts",
      "test/project-state-root.test.ts",
      "test/project-state-shape.test.ts",
    ];
    const targets = DA_OWNED.map(f => join(REPO, f));

    const states = statesDuring(targets, () => {
      const r = spawnSync("bun", ["test", ...siblings], {
        cwd: REPO,
        encoding: "utf-8",
        timeout: 300_000,
      });
      expect(r.status, `the sibling suites did not pass:\n${r.stderr ?? ""}`).toBe(0);
    });

    for (const t of targets) {
      expect(states.get(t)!.size, `${t} moved while the sibling suites ran`).toBe(1);
    }
  }, 300_000);

  /**
   * The filed issue said 21 SC checkboxes in `specs/HARNESS-STANDARD.md` and
   * `specs/AGENT-BRIEF-TEMPLATE-SPEC.md`. Measured, the real number is 0 —
   * `scripts/update-project-state.ts` only ever READS `specs/` to promote SC
   * status into `project-state.json`, and the 21 flips were flips of
   * `"done": false` inside that JSON, not edits to the specs.
   *
   * Pinned anyway, because the direction is the whole point: specs are an
   * input to this script and an input it writes is an input it fabricates.
   */
  test("the renderer never writes the specs it reads", () => {
    const src = readFileSync(join(REPO, "scripts", "update-project-state.ts"), "utf-8");
    const writes = [...src.matchAll(/writeFileSync\(\s*([A-Za-z_$][\w$]*)/g)].map(m => m[1]);
    expect(writes.length, "no write call found at all — the pattern stopped matching").toBeGreaterThan(0);
    expect(new Set(writes)).toEqual(new Set(["STATE_JSON", "STATE_MD"]));
    expect(writes, "the renderer writes into the specs directory it promotes from").not.toContain("SPECS_DIR");
  });
});
