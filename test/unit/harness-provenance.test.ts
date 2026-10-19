/**
 * #602 — which harness graded this run, and whether anything says so.
 *
 * The defect is the SILENCE, not the version. A stale harness and a
 * current one emit byte-identical artefacts, so the fixtures here are
 * built to make the two distinguishable and then to assert that they are.
 *
 * The criterion that matters most is the third: **two harness checkouts
 * at different commits grading the same state record DIFFERENT SHAs.**
 * It pins the divergence rather than a fixed value, so it survives the
 * tree moving — a case asserting a literal SHA would be red the next time
 * anybody commits.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { HarnessSchema } from "../../gates/schema";
import { COMMIT_SHA } from "../../lib/commit-sha";
import {
  GRADING_PATHS,
  harnessProvenance,
  harnessProvenanceWarning,
  porcelainPaths,
} from "../../lib/harness-provenance";
import { harnessRecord } from "../../scripts/record-harness-provenance";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const scratch = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `harness-prov-${tag}-`));
  made.push(d);
  return d;
};
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A bare "remote" plus a clone of it, so `@{upstream}` genuinely resolves. */
function harnessWithUpstream(tag: string): { root: string; remote: string } {
  const holder = scratch(tag);
  const remote = join(holder, "remote.git");
  const root = join(holder, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, root]);
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  for (const d of GRADING_PATHS) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "gates", "schema.ts"), "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "harness v1");
  git(root, "push", "-q", "-u", "origin", "main");
  return { root, remote };
}

/** Advance the remote by one commit, without moving the working checkout. */
function advanceRemote(remote: string, tag: string): string {
  const side = scratch(`${tag}-side`);
  const clone = join(side, "c");
  execFileSync("git", ["clone", "-q", remote, clone]);
  git(clone, "config", "user.email", "t@example.com");
  git(clone, "config", "user.name", "t");
  writeFileSync(join(clone, "gates", "refusal.ts"), "export const refuses = true;\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "a refusal the other checkout does not have");
  git(clone, "push", "-q", "origin", "main");
  return git(clone, "rev-parse", "HEAD");
}

describe("#602: the harness records which version graded the run", () => {
  test("a clean, current checkout is MEASURED with a real SHA and zero behind", () => {
    const { root } = harnessWithUpstream("clean");
    const r = harnessProvenance(root);
    expect(r.reading).toBe("MEASURED");
    if (r.reading !== "MEASURED") throw new Error("unreachable");
    expect(r.sha).toMatch(COMMIT_SHA);
    expect(r.sha).toBe(git(root, "rev-parse", "HEAD"));
    expect(r.branch).toBe("main");
    expect(r.dirty).toEqual([]);
    expect(r.behind).toBe(0);
    expect(r.behindReason).toBeNull();
    // Nothing to warn about is the only state that says nothing.
    expect(harnessProvenanceWarning(r)).toBeNull();
  });

  test("a checkout behind its upstream says how far, and why that is permissive", () => {
    const { root, remote } = harnessWithUpstream("behind");
    advanceRemote(remote, "behind");
    git(root, "fetch", "-q", "origin");

    const r = harnessProvenance(root);
    if (r.reading !== "MEASURED") throw new Error("expected MEASURED");
    expect(r.behind).toBe(1);
    const warning = harnessProvenanceWarning(r);
    expect(warning).toContain("1 commit(s) behind");
    expect(warning, "the direction of the error is the whole point")
      .toContain("strictly more permissive");
  });

  /**
   * The scoping, in both directions. A dirty README does not change a
   * verdict; a dirty `gates/schema.ts` does. A check that refused on the
   * first is one everybody learns to click past, which is worse than no
   * check because it trains people past the cases that matter.
   */
  test("dirty under gates/lib/workflows is reported; dirty elsewhere is not", () => {
    const { root } = harnessWithUpstream("dirty");

    writeFileSync(join(root, "README.md"), "untracked, and irrelevant to a grade\n");
    expect(
      (harnessProvenance(root) as { dirty: string[] }).dirty,
      "a dirty file outside the grading paths must not fire",
    ).toEqual([]);

    writeFileSync(join(root, "gates", "schema.ts"), "export const a = 2;  // edited in place\n");
    const r = harnessProvenance(root);
    if (r.reading !== "MEASURED") throw new Error("expected MEASURED");
    expect(r.dirty).toEqual(["gates/schema.ts"]);
    expect(harnessProvenanceWarning(r)).toContain("is not the code at");
  });

  test("an UNTRACKED file under a grading path counts — it is loadable code the commit lacks", () => {
    const { root } = harnessWithUpstream("untracked");
    writeFileSync(join(root, "lib", "brand-new.ts"), "export const x = 1;\n");
    const r = harnessProvenance(root);
    if (r.reading !== "MEASURED") throw new Error("expected MEASURED");
    expect(r.dirty).toEqual(["lib/brand-new.ts"]);
  });

  /**
   * The porcelain parse, over the three records a fixed-width slice on a
   * trimmed string gets wrong. This caught a live bug: `git()` trims, so
   * `" M gates/schema.ts"` arrived as `"M gates/schema.ts"` and
   * `.slice(3)` returned `"ates/schema.ts"` — a path that names no file,
   * in the message whose job is to say which file to look at.
   */
  test("a modified path keeps its first character", () => {
    expect(porcelainPaths(" M gates/schema.ts\0")).toEqual(["gates/schema.ts"]);
    expect(porcelainPaths("?? lib/new.ts\0")).toEqual(["lib/new.ts"]);
    expect(porcelainPaths("M  gates/a.ts\0 D lib/b.ts\0")).toEqual(["gates/a.ts", "lib/b.ts"]);
  });

  test("a rename's ORIGIN field is not read as a second path", () => {
    // `R  <new>\0<old>` — treating the origin as a record would report it
    // with three characters eaten, which is the same defect from the
    // other side.
    expect(porcelainPaths("R  gates/new.ts\0gates/old.ts\0")).toEqual(["gates/new.ts"]);
    expect(porcelainPaths("R  gates/new.ts\0gates/old.ts\0 M lib/c.ts\0"))
      .toEqual(["gates/new.ts", "lib/c.ts"]);
  });

  test("a path with a non-ASCII byte survives — which is why -z, not newlines", () => {
    // Without `-z`, git C-quotes this as "caf\303\251.ts", quotes
    // included, and the name in the report is not the name on disk.
    expect(porcelainPaths(" M lib/café.ts\0")).toEqual(["lib/café.ts"]);
    expect(porcelainPaths(" M lib/two words.ts\0")).toEqual(["lib/two words.ts"]);
  });

  test("no upstream is null with a reason, NOT zero", () => {
    // The silent-default trap: a checkout nobody can compare reads exactly
    // like one that is perfectly current, and 0 is the number that says so.
    const root = scratch("noupstream");
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");

    const r = harnessProvenance(root);
    if (r.reading !== "MEASURED") throw new Error("expected MEASURED");
    expect(r.behind, "a checkout nobody can compare is not a current one").toBeNull();
    expect(r.behindReason).toContain("no configured upstream");
    expect(harnessProvenanceWarning(r)).toContain("unknown");
  });

  test("a directory that is not a repository is UNMEASURED, and says so", () => {
    const r = harnessProvenance(scratch("norepo"));
    expect(r.reading).toBe("UNMEASURED");
    expect(harnessProvenanceWarning(r)).toContain("HARNESS_UNMEASURED");
    expect(harnessProvenanceWarning(r)).toContain("not been graded in any reproducible sense");
  });

  /**
   * Two guards, two inputs, and this comment is part of the fix.
   *
   * `harnessProvenance` refuses twice: once when HEAD cannot be read, and
   * once when `git status` cannot be read. A directory that is not a
   * repository fails BOTH probes, so with only that fixture the two are
   * two deciders that agree — remove either and the other still refuses,
   * and no behavioural test can tell them apart
   * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
   *
   * Measured before these two cases existed: deleting the HEAD guard was
   * **0 of 23**, and deleting the status guard was **0 of 23**. Both
   * read as collapsed, because both were.
   *
   * They are kept separate rather than collapsed because they answer
   * different questions — WHICH commit, and whether the tree matches it —
   * so each gets an input only it can reach. Do not delete one of these
   * fixtures as redundant; the other guard will hold it up and the row
   * will go quiet again.
   */
  test("a repository with no commits: only the HEAD guard can refuse this", () => {
    // `git status` succeeds here and reports a clean tree. The SHA is the
    // thing that does not exist.
    const root = scratch("nocommit");
    git(root, "init", "-q", "-b", "main");
    expect(
      execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf-8" }),
      "the premise: status must SUCCEED, or this measures the other guard",
    ).toBe("");

    const r = harnessProvenance(root);
    expect(r.reading).toBe("UNMEASURED");
    if (r.reading !== "UNMEASURED") throw new Error("unreachable");
    expect(r.reason).toContain("no readable HEAD");
  });

  test("a repository with a corrupt index: only the status guard can refuse this", () => {
    // `rev-parse HEAD` succeeds and returns a real SHA — HEAD is read
    // from refs, not from the index — so the HEAD guard passes and the
    // status probe is the only thing left that can say anything.
    const root = scratch("badindex");
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    const sha = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, ".git", "index"), "garbage");

    expect(sha, "the premise: HEAD must still resolve, or this measures the other guard").toMatch(COMMIT_SHA);
    const r = harnessProvenance(root);
    expect(r.reading).toBe("UNMEASURED");
    if (r.reading !== "UNMEASURED") throw new Error("unreachable");
    expect(r.reason).toContain("its status could not be read");
    // An unreadable status and a clean one both produce an empty list,
    // and only one of them is a reading.
    expect(r.reason).toContain("unknown is not clean");
    expect(r.reason, "the SHA it DID read belongs in the refusal").toContain(sha);
  });

  test("an empty harnessRoot is UNMEASURED, not a pass", () => {
    expect(harnessProvenance("").reading).toBe("UNMEASURED");
    expect(harnessProvenance("   ").reading).toBe("UNMEASURED");
  });

  /**
   * SC-3, and the case the issue calls the distinguishing fixture: two
   * harness checkouts of the same repo at different commits, one carrying
   * a refusal the other lacks, grading the same project state.
   *
   * It asserts the SHAs DIFFER rather than asserting either value — a
   * literal would be red the next time anybody commits, and pinning the
   * divergence is what the property actually is.
   */
  test("two checkouts at different commits record different SHAs", () => {
    const { root: older, remote } = harnessWithUpstream("pair");
    const newerSha = advanceRemote(remote, "pair");

    const holder = scratch("pair-newer");
    const newer = join(holder, "newer");
    execFileSync("git", ["clone", "-q", remote, newer]);

    const a = harnessProvenance(older);
    const b = harnessProvenance(newer);
    if (a.reading !== "MEASURED" || b.reading !== "MEASURED") throw new Error("both must be MEASURED");

    expect(a.sha).not.toBe(b.sha);
    expect(b.sha).toBe(newerSha);
    // And the newer one really does carry a refusal the older lacks —
    // otherwise this is two SHAs and no reason to care which graded you.
    expect(git(newer, "ls-files", "gates/")).toContain("gates/refusal.ts");
    expect(git(older, "ls-files", "gates/")).not.toContain("gates/refusal.ts");
  });

  test("the warning is a projection of the reading, not a second probe", () => {
    const { root } = harnessWithUpstream("proj");
    for (const r of [harnessProvenance(root), harnessProvenance(scratch("proj-norepo"))]) {
      const w = harnessProvenanceWarning(r);
      if (r.reading === "UNMEASURED") expect(w).toContain(r.reason);
      else if (r.dirty.length === 0 && r.behind === 0) expect(w).toBeNull();
    }
  });
});

describe("#602: the recorded shape, and the contradictions the schema refuses", () => {
  test("every reading produces a record the schema accepts", () => {
    const { root } = harnessWithUpstream("rec");
    const noRepo = scratch("rec-norepo");
    writeFileSync(join(root, "lib", "dirty.ts"), "export const d = 1;\n");

    const readings = [harnessProvenance(root), harnessProvenance(noRepo), harnessProvenance("")];
    const kinds = new Set(readings.map(r => r.reading));
    expect(kinds, "the loop must reach both arms or it proves nothing").toEqual(new Set(["MEASURED", "UNMEASURED"]));
    for (const reading of readings) {
      expect(() => HarnessSchema.parse(harnessRecord(reading))).not.toThrow();
    }
  });

  test("UNMEASURED carrying a SHA is refused — a reading not taken has no SHA", () => {
    expect(() =>
      HarnessSchema.parse({
        reading: "UNMEASURED", sha: "abc1234", branch: null, dirty: [],
        behind: null, behindReason: "why", reason: "could not read",
      }),
    ).toThrow(/UNMEASURED while naming a SHA/);
  });

  test("MEASURED with no SHA is refused — the SHA is the measurement", () => {
    expect(() =>
      HarnessSchema.parse({
        reading: "MEASURED", sha: null, branch: "main", dirty: [], behind: 0, behindReason: null, reason: null,
      }),
    ).toThrow(/MEASURED with no SHA/);
  });

  test("a ref name is refused where a SHA belongs", () => {
    expect(() =>
      HarnessSchema.parse({
        reading: "MEASURED", sha: "main", branch: "main", dirty: [], behind: 0, behindReason: null, reason: null,
      }),
    ).toThrow(/must be a commit SHA/);
  });

  test("behind and behindReason must be exactly one of the two", () => {
    const base = { reading: "MEASURED" as const, sha: "abc1234", branch: "main", dirty: [], reason: null };
    expect(() => HarnessSchema.parse({ ...base, behind: null, behindReason: null }))
      .toThrow(/must say why/);
    expect(() => HarnessSchema.parse({ ...base, behind: 3, behindReason: "also this" }))
      .toThrow(/a count and an excuse for not counting/);
    expect(() => HarnessSchema.parse({ ...base, behind: 3, behindReason: null })).not.toThrow();
    expect(() => HarnessSchema.parse({ ...base, behind: null, behindReason: "no upstream" })).not.toThrow();
  });

  test("the SHA pattern is ONE binding, shared with suiteMeasurement", async () => {
    // Not a style point. `measuredSha` and `harness.sha` ask the same
    // question of two fields, and two copies would be two deciders that
    // agree — a mutation of either leaves the other refusing, and no
    // behavioural test can tell them apart.
    const src = readFileSync(join(import.meta.dir, "..", "..", "gates", "schema.ts"), "utf-8");
    const literals = src.match(/\/\^\[0-9a-f\]\{7,40\}\$\/i/g) ?? [];
    expect(literals, "the pattern must not be respelled in gates/schema.ts").toEqual([]);
    expect(src).toContain("const MEASURED_SHA = COMMIT_SHA;");
  });
});

describe("#602: the recorder writes the state and says what it found", () => {
  const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "record-harness-provenance.ts");
  const run = (args: string[]) => spawnSync("bun", [SCRIPT, ...args], { encoding: "utf-8", maxBuffer: 16e6 });

  test("it merges into the existing state rather than replacing it", () => {
    const { root } = harnessWithUpstream("cli");
    const statePath = join(scratch("cli-state"), "workflow-state.json");
    writeFileSync(statePath, JSON.stringify({ issue: 602, buildCommit: "deadbee" }, null, 2));

    const r = run(["--state", statePath, "--harness-root", root]);
    expect(r.status, r.stderr).toBe(0);

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.issue, "the run's other fields must survive").toBe(602);
    expect(state.buildCommit).toBe("deadbee");
    expect(state.harness.reading).toBe("MEASURED");
    expect(state.harness.sha).toBe(git(root, "rev-parse", "HEAD"));
    expect(() => HarnessSchema.parse(state.harness)).not.toThrow();
  });

  test("a dirty harness is recorded AND said out loud, and still exits zero", () => {
    const { root } = harnessWithUpstream("cli-dirty");
    writeFileSync(join(root, "workflows", "ship.js"), "// edited\n");
    const statePath = join(scratch("cli-dirty-state"), "s.json");
    writeFileSync(statePath, "{}");

    const r = run(["--state", statePath, "--harness-root", root]);
    expect(r.status, "a dirty harness is a finding to record, not a reason to refuse").toBe(0);
    expect(r.stderr).toContain("HARNESS_DIVERGENCE");
    expect(r.stderr).toContain("workflows/ship.js");
    expect(JSON.parse(readFileSync(statePath, "utf-8")).harness.dirty).toEqual(["workflows/ship.js"]);
  });

  test("an unreadable harness is recorded as UNMEASURED, not omitted", () => {
    const statePath = join(scratch("cli-unm-state"), "s.json");
    writeFileSync(statePath, "{}");
    const r = run(["--state", statePath, "--harness-root", scratch("cli-unm")]);
    expect(r.status).toBe(0);
    const harness = JSON.parse(readFileSync(statePath, "utf-8")).harness;
    expect(harness.reading).toBe("UNMEASURED");
    expect(harness.reason).toBeTruthy();
    expect(r.stderr).toContain("HARNESS_UNMEASURED");
  });

  test("an unreadable STATE is refused — nothing is silently recreated", () => {
    const { root } = harnessWithUpstream("cli-badstate");
    const statePath = join(scratch("cli-badstate-s"), "s.json");
    writeFileSync(statePath, "{not json");
    const r = run(["--state", statePath, "--harness-root", root]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("REFUSED");
    // A fresh object here would discard everything the run accumulated.
    expect(readFileSync(statePath, "utf-8")).toBe("{not json");
  });

  test("both arguments are required", () => {
    expect(run([]).stderr).toContain("--state is required");
    expect(run(["--state", "/tmp/x"]).stderr).toContain("--harness-root is required");
  });
});
