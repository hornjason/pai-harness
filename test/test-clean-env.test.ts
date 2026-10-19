/**
 * `scripts/test-clean-env.ts` promised more than it modelled (#168).
 *
 * It stripped the developer's environment and then ran in the developer's
 * checkout — a full clone with every ref and all of history. CI runs
 * `actions/checkout@v4`, which fetches one commit onto a detached HEAD with
 * no local branches. On 2026-10-07 the script reported 2998 pass / 0 fail on
 * a tree where CI reported 2 fail, and both failures were real:
 * `test/prior-branch.test.ts` counts `main..<ref>`, which resolves on a
 * developer's clone and does not resolve in CI.
 *
 * That is this repo's defining defect — a check that passed because of what
 * it never looked at — in the tool CLAUDE.md's MANDATORY GATE leans on.
 *
 * ## What these tests have to prove, and in which order
 *
 * The easy half is that the harness builds a shallow detached clone. The half
 * that matters is that the clone **discriminates**: a test depending on a ref
 * CI does not have must fail inside it, and a test depending on nothing must
 * pass. Without the second, a harness that simply broke every run would
 * satisfy the first, and would be indistinguishable from a working model
 * right up to the point someone trusted it.
 *
 * Covers SC-580..582 and SC-777 of HARNESS-STANDARD.md.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ciCheckoutPlan,
  executeCheckoutPlan,
  isSafeRefspec,
  parseCheckoutModel,
  suiteJobName,
  prepareCiCheckout,
  UNMODELLED,
  type CheckoutModel,
  type Runner,
} from "../lib/ci-checkout";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "test-clean-env.ts");

const run: Runner = (cmd, cwd) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf-8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** A throwaway git repo with two commits and a `main` branch. */
function sourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cce-src-"));
  const git = (...a: string[]) =>
    execFileSync("git", a, {
      cwd: dir,
      stdio: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
    });
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(dir, "a.txt"), "one");
  git("add", "-A");
  git("commit", "--quiet", "-m", "one");
  writeFileSync(join(dir, "a.txt"), "two");
  git("add", "-A");
  git("commit", "--quiet", "-m", "two");
  return dir;
}

describe("#168: the checkout model is read from the workflow, not assumed", () => {
  test("this repo's own ci.yml parses, and says depth 1", () => {
    // `actions/checkout@v4` documents its default as 1, and the absence of a
    // `fetch-depth:` key is that default rather than an unknown. Reading the
    // real file means a change to CI shows up here rather than silently
    // widening the gap this issue exists to close.
    const yaml = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf-8");
    const { model, why } = parseCheckoutModel(yaml, suiteJobName(yaml));
    expect(model, why).not.toBeNull();
    expect(model!.depth).toBe(1);
  });

  test("the fetch #347 added to the job is part of the model", () => {
    // The whole argument for parsing rather than hardcoding. A model that
    // said "shallow, detached, no main" would be wrong about THIS repo
    // today, because the job fetches origin/main at depth 200 before the
    // suite runs — and would report failures CI does not have.
    const yaml = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf-8");
    const { model } = parseCheckoutModel(yaml, suiteJobName(yaml));
    expect(model!.fetches.length).toBeGreaterThan(0);
    expect(model!.fetches.some(f => f.refspec.includes("refs/heads/main"))).toBe(true);
    expect(model!.fetches[0].depth).toBe(200);
  });

  test("an explicit fetch-depth is read, and 0 means full history", () => {
    const withDepth = `jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 50\n`;
    expect(parseCheckoutModel(withDepth, "test").model!.depth).toBe(50);
    const full = withDepth.replace("fetch-depth: 50", "fetch-depth: 0");
    expect(parseCheckoutModel(full, "test").model!.depth).toBeNull();
  });

  test("a depth belonging to a LATER step is not read as this one's", () => {
    // A detector narrower than what it detects is one failure; a detector
    // WIDER than its subject is the other. Scanning the whole job would pick
    // up a second checkout's depth and model a checkout that never happens.
    const two = [
      "jobs:",
      "  test:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/checkout@v4",
      "        with:",
      "          fetch-depth: 99",
    ].join("\n");
    expect(parseCheckoutModel(two, "test").model!.depth).toBe(1);
  });

  test("a job that is not there, or has no checkout, is refused with a reason", () => {
    // Not defaulted. A guessed checkout is the defect being modelled, so the
    // absence of a reading has to be a refusal the caller can print.
    const a = parseCheckoutModel("jobs:\n  other:\n    steps: []\n", "test");
    expect(a.model).toBeNull();
    expect(a.why).toContain("test");

    const b = parseCheckoutModel("jobs:\n  test:\n    steps:\n      - run: echo hi\n", "test");
    expect(b.model).toBeNull();
    expect(b.why).toContain("checkout");
  });

  test("a refspec that is secretly a git option is refused, not fetched", () => {
    // Found by a security review of the first commit. The refspec is read
    // from a workflow and pushed into an argv, and `git fetch` takes options
    // anywhere on its line — `--upload-pack=<cmd>` makes git EXECUTE that
    // command. An argv array stops shell metacharacters and does nothing
    // about a value that is itself an option.
    //
    // rungate scaffolds other projects, so this parses workflow files it
    // does not own.
    const hostile = [
      "jobs:",
      "  test:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - run: git fetch origin '--upload-pack=refs/heads/x;id'",
    ].join("\n");
    const r = parseCheckoutModel(hostile, "test");
    expect(r.model).toBeNull();
    expect(r.why).toContain("upload-pack");

    // And the plan builder refuses independently, because it is exported and
    // a caller can hand it a model this parser never saw.
    const plan = ciCheckoutPlan({
      source: "/s",
      dest: "/d",
      model: { jobName: "test", depth: 1, fetches: [{ refspec: "--upload-pack=id", depth: null }] },
    });
    expect(plan.some(c => c.argv.includes("--upload-pack=id"))).toBe(false);
  });

  test("ordinary refspecs are still accepted, including the wildcard forms", () => {
    // The control. An allowlist tight enough to reject every real refspec
    // would satisfy the case above and break every consumer project.
    for (const ok of [
      "+refs/heads/main:refs/remotes/origin/main",
      "refs/heads/main",
      "refs/heads/*:refs/remotes/origin/*",
      "refs/heads/release-1.2",
      "refs/heads/feature/thing_two",
    ]) {
      expect(isSafeRefspec(ok), ok).toBe(true);
    }
    for (const bad of ["--upload-pack=id", "-q", "", "--depth=1"]) {
      expect(isSafeRefspec(bad), bad).toBe(false);
    }
  });

  test("what this does NOT model is written down, not implied", () => {
    // SC-582. The claim being replaced failed by being absolute, so the
    // replacement carries its own limits.
    expect(UNMODELLED.length).toBeGreaterThanOrEqual(5);
    const all = UNMODELLED.join(" ").toLowerCase();
    for (const subject of ["ubuntu", "bun install", "merge", "ignore"]) {
      expect(all).toContain(subject);
    }
  });
});

describe("#168: the prepared checkout has CI's refs and not the developer's", () => {
  const model: CheckoutModel = { jobName: "test", depth: 1, fetches: [] };

  test("the plan clones at --depth 1 and detaches before deleting refs", () => {
    // Order matters and is not incidental: git refuses to delete the branch
    // that is checked out, so a plan that deleted before detaching would
    // fail every time — or, worse, be made tolerant and silently leave
    // `main` standing.
    const plan = ciCheckoutPlan({ source: "/src", dest: "/dst", model });
    const flat = plan.map(c => (c.kind === "exec" ? c.argv.join(" ") : `<${c.kind}>`));
    expect(flat[0]).toContain("--depth=1");
    expect(flat.findIndex(c => c.includes("--detach")))
      .toBeLessThan(flat.findIndex(c => c === "<delete-local-refs>"));
  });

  test("a real clone comes out detached with no local main", () => {
    const src = sourceRepo();
    const parent = mkdtempSync(join(tmpdir(), "cce-dst-"));
    const dest = join(parent, "repo");
    try {
      const r = executeCheckoutPlan(ciCheckoutPlan({ source: src, dest, model }), dest, parent, run);
      expect(r.ok, r.ok ? "" : r.why).toBe(true);

      // no local main, and HEAD detached — the two facts CI has and a clone
      // does not.
      expect(run(["git", "rev-parse", "--verify", "main"], dest).status).not.toBe(0);
      expect(run(["git", "rev-parse", "--abbrev-ref", "HEAD"], dest).stdout.trim()).toBe("HEAD");
      expect(run(["git", "rev-list", "--count", "HEAD"], dest).stdout.trim()).toBe("1");
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a replayed fetch restores exactly the ref the workflow asks for", () => {
    const src = sourceRepo();
    const parent = mkdtempSync(join(tmpdir(), "cce-dst-"));
    const dest = join(parent, "repo");
    try {
      const withFetch: CheckoutModel = {
        jobName: "test",
        depth: 1,
        fetches: [{ refspec: "+refs/heads/main:refs/remotes/origin/main", depth: 200 }],
      };
      const r = executeCheckoutPlan(ciCheckoutPlan({ source: src, dest, model: withFetch }), dest, parent, run);
      expect(r.ok, r.ok ? "" : r.why).toBe(true);
      // origin/main back, local main still gone — CI's exact position.
      expect(run(["git", "rev-parse", "--verify", "origin/main"], dest).status).toBe(0);
      expect(run(["git", "rev-parse", "--verify", "main"], dest).status).not.toBe(0);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  // SC-1471 — #183. `actions/checkout@v4` leaves `origin` on the GitHub
  // repository; this plan repoints it at `file://source` so the replayed
  // fetches resolve offline, and used to leave it there. A test asking "which
  // repository is this a checkout of" then got a filesystem path under the
  // model and `github.com/owner/name` in CI — the model failing a test CI
  // passes, which is the inversion this module exists to prevent.
  test("origin is restored to the source's own remote, after the fetches", () => {
    const plan = ciCheckoutPlan({
      source: "/src",
      dest: "/dst",
      model: { jobName: "test", depth: 1, fetches: [{ refspec: "refs/heads/main", depth: null }] },
      originUrl: "https://github.com/owner/name",
    });
    const flat = plan.map(c => (c.kind === "exec" ? c.argv.join(" ") : `<${c.kind}>`));
    const restore = flat.findIndex(c => c.includes("set-url origin https://github.com/owner/name"));
    expect(restore, "origin is never restored").toBeGreaterThan(-1);
    expect(restore, "origin was restored before a fetch that needs file://")
      .toBeGreaterThan(flat.findIndex(c => c.includes("fetch")));
    expect(restore).toBe(flat.length - 1);
  });

  test("no origin on the source means the file:// URL stays", () => {
    // The control. A plan that always rewrote `origin` would satisfy the case
    // above and break offline fetch replay for a source that has no remote.
    const plan = ciCheckoutPlan({ source: "/src", dest: "/dst", model });
    const flat = plan.map(c => (c.kind === "exec" ? c.argv.join(" ") : "")).join("\n");
    expect((flat.match(/set-url origin/g) || []).length).toBe(1);
    expect(flat).toContain("set-url origin file:///src");
  });

  test("a real clone reports the source's remote, not the temp directory", () => {
    const src = sourceRepo();
    const parent = mkdtempSync(join(tmpdir(), "cce-dst-"));
    const dest = join(parent, "repo");
    try {
      const url = "https://github.com/owner/name.git";
      const r = executeCheckoutPlan(
        ciCheckoutPlan({ source: src, dest, model, originUrl: url }),
        dest, parent, run,
      );
      expect(r.ok, r.ok ? "" : r.why).toBe(true);
      expect(run(["git", "remote", "get-url", "origin"], dest).stdout.trim()).toBe(url);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a plan that leaves a local branch standing is refused, not reported clean", () => {
    // The fail-open this whole file is about, aimed at itself. A preparer
    // that ran every command successfully and left `refs/heads/main` in
    // place has modelled nothing, and its output is indistinguishable from a
    // working-tree run.
    const src = sourceRepo();
    const parent = mkdtempSync(join(tmpdir(), "cce-dst-"));
    const dest = join(parent, "repo");
    try {
      const plan = ciCheckoutPlan({ source: src, dest, model })
        .filter(c => c.kind !== "delete-local-refs");
      const r = executeCheckoutPlan(plan, dest, parent, run);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.why).toContain("refs/heads/");
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a command that fails and is not tolerated refuses the whole plan", () => {
    const r = executeCheckoutPlan(
      [{ kind: "exec", argv: ["git", "rev-parse", "--verify", "no-such-ref"], inClone: false }],
      "/nonexistent-dest",
      "/tmp",
      run,
    );
    expect(r.ok).toBe(false);
  });
});

describe("#168: a checkout that cannot be built is a refusal, never a fall-back", () => {
  /**
   * This whole describe exists because the measurement demanded it. With the
   * decision written inline in the script, replacing its refusal with "warn
   * and run in the working tree anyway" scored **0 red** — the worst
   * fail-open the change could produce, since the caller asked for the
   * strict check and would be handed the unmodelled run reported as strict.
   */
  function deps(over: Partial<Parameters<typeof prepareCiCheckout>[0]> = {}) {
    const logs: string[] = [];
    const base: Parameters<typeof prepareCiCheckout>[0] = {
      source: "/src",
      workflowPath: "/wf.yml",
      jobName: "test",
      tmpRoot: "/tmp-root",
      readFile: () => "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n",
      run: () => ({ status: 0, stdout: "", stderr: "" }),
      carryOver: () => {},
      link: () => {},
      exists: () => false,
      log: l => logs.push(l),
    };
    return { opts: { ...base, ...over }, logs };
  }

  test("an unreadable workflow refuses and names the hint", () => {
    const { opts } = deps({ readFile: () => { throw new Error("ENOENT"); } });
    const r = prepareCiCheckout(opts);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("ENOENT");
    expect(r.ok === false && r.hint).toContain("--no-ci-checkout");
  });

  test("an unparseable job refuses rather than guessing a shape", () => {
    const { opts } = deps({ readFile: () => "jobs:\n  other:\n    steps: []\n" });
    const r = prepareCiCheckout(opts);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("checkout");
  });

  test("a plan that fails to execute refuses", () => {
    const { opts } = deps({ run: () => ({ status: 1, stdout: "", stderr: "boom" }) });
    const r = prepareCiCheckout(opts);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("could not build");
  });

  test("an unreadable working tree refuses — a carried-over nothing is not nothing to carry", () => {
    // `git status` failing means the uncommitted work is unknown, not
    // absent. Treating the empty stdout as "clean tree" would run the last
    // commit's code and report it as the developer's.
    let call = 0;
    const { opts } = deps({
      run: (argv) => {
        call++;
        if (argv[1] === "status") return { status: 128, stdout: "", stderr: "not a git repository" };
        if (argv[1] === "for-each-ref") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const r = prepareCiCheckout(opts);
    expect(call).toBeGreaterThan(0);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("status");
  });

  test("no option exists that turns a refusal into a working-tree run", () => {
    // The property, asserted rather than left as a convention. A fall-back
    // parameter is how the measured fail-open comes back: it would be
    // reachable from the script without anything going red.
    const src = readFileSync(join(REPO, "lib", "ci-checkout.ts"), "utf-8");
    const body = src.slice(src.indexOf("export function prepareCiCheckout"));
    expect(body).not.toMatch(/fall\s*back\s*(?:to)?\s*:/i);
    for (const outcome of body.matchAll(/return \{ ok: false/g)) expect(outcome).toBeTruthy();
    // ...and the script's only response to one is the shared exit code.
    const script = readFileSync(SCRIPT, "utf-8");
    expect(script).toContain("process.exit(CLEAN_ENV_REFUSE_EXIT)");
    expect(script.match(/CLEAN_ENV_REFUSE_EXIT/g)!.length).toBe(2); // the import and the one use
  });

  test("a successful prepare reports what it built, including the unmodelled count", () => {
    // The positive control. Without it, making prepareCiCheckout refuse
    // unconditionally would satisfy every case above.
    const { opts, logs } = deps({
      run: (argv) => {
        if (argv[1] === "status") return { status: 0, stdout: "", stderr: "" };
        if (argv[1] === "for-each-ref") return { status: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const r = prepareCiCheckout(opts);
    expect(r.ok, r.ok ? "" : (r as any).why).toBe(true);
    expect(logs.join("\n")).toContain("CI checkout:");
    expect(logs.join("\n")).toContain("NOT modelled");
  });
});

describe("#168: the harness discriminates, which is the only thing that matters", () => {
  /**
   * Plant two tests in this repo and run the real script over both.
   *
   * One asserts a local `main` ref resolves — the shape of the #164 failure,
   * which counted `main..<ref>`. The other asserts arithmetic. CI has no
   * local `main`, so the first must fail inside the modelled checkout and the
   * second must pass. The second is not decoration: without it a harness that
   * broke every run would satisfy this test and look exactly like a working
   * one.
   */
  const PLANTED = [
    `import { execSync } from "child_process";`,
    `import { expect, test } from "bun:test";`,
    `test("depends on a ref CI does not have", () => {`,
    `  execSync("git rev-parse --verify main", { cwd: process.cwd(), stdio: "pipe" });`,
    `  expect(true).toBe(true);`,
    `});`,
    `test("depends on nothing the checkout can take away", () => { expect(1 + 1).toBe(2); });`,
    ``,
  ].join("\n");

  /**
   * The planted file goes in a FIXTURE repo, not in this one.
   *
   * The first version wrote it into `test/fixtures/generated/` here and
   * invoked the real script. It worked in isolation and put two failures
   * into the full suite, because `bun test` with no path argument finds every
   * `*.test.ts` — including a file another test had just written. A test that
   * plants a landmine in its own repo for the duration of its run is a test
   * that only works when nothing else is running, which is the opposite of
   * what a suite is.
   */
  function fixtureWithPlantedTests(): string {
    const dir = sourceRepo();
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "test", "planted.test.ts"), PLANTED);
    const git = (...a: string[]) =>
      execFileSync("git", a, {
        cwd: dir,
        stdio: "pipe",
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
      });
    git("add", "-A");
    git("commit", "--quiet", "-m", "planted");
    return dir;
  }

  function bunTestIn(dir: string): string {
    const r = spawnSync("bun", ["test", join("test", "planted.test.ts")], { cwd: dir, encoding: "utf-8" });
    return (r.stdout ?? "") + (r.stderr ?? "");
  }

  test("inside the modelled checkout the ref-dependent test fails and the control passes", () => {
    const src = fixtureWithPlantedTests();
    const parent = mkdtempSync(join(tmpdir(), "cce-disc-"));
    try {
      const outcome = prepareCiCheckout({
        source: src,
        workflowPath: "/wf.yml",
        jobName: "test",
        tmpRoot: parent,
        readFile: () => "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n",
        run,
        carryOver: () => {},
        link: () => {},
        exists: () => false,
        log: () => {},
      });
      expect(outcome.ok, outcome.ok ? "" : outcome.why).toBe(true);

      const out = bunTestIn((outcome as { dir: string }).dir);
      // One of each. The control passing is the half that matters: without
      // it a harness that simply broke every run would satisfy this test and
      // look exactly like a working one.
      expect(out, out.slice(-600)).toContain("1 pass");
      expect(out, out.slice(-600)).toContain("1 fail");
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("the same two tests both pass in the fixture's own working tree", () => {
    // The before-picture, measured rather than described. Without it the
    // case above could be passing because the planted test is broken
    // outright rather than because the checkout took a ref away.
    const src = fixtureWithPlantedTests();
    try {
      const out = bunTestIn(src);
      expect(out, out.slice(-600)).toContain("2 pass");
      expect(out, out.slice(-600)).toContain("0 fail");
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test("the script runs the suite in the prepared directory, not the working tree", () => {
    // The two cases above exercise the library. This is the wiring: the one
    // line that decides which directory `bun test` is spawned in. Without
    // it, every library case stays green while the script ignores the
    // checkout it just built — #194's lesson, one domain over.
    const script = readFileSync(SCRIPT, "utf-8");
    expect(script).toContain("cwd: checkoutDir ?? ROOT");
    expect(script).toContain("checkoutDir = buildCiCheckout(ROOT)");
    expect(script).toContain("prepareCiCheckout(");
  });
});
