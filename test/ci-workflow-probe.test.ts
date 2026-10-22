/**
 * #1098 — the workflow probe cannot answer `0` when it could not look.
 *
 * `ciBlocksReadiness`'s `workflowCount === 0` branch is the only one that
 * undrafts a PR without reading CI, and the comment three lines above it
 * states why the count is taken by the shell: *an agent asked "does this
 * project have CI" can answer wrongly in the direction that unblocks itself*.
 * The decision was moved off the agent and onto the shell — and the shell's
 * own failure mode WAS that answer:
 *
 *     workflows=$(ls DIR/.github/workflows/*.yml DIR/.github/workflows/*.yaml \
 *       2>/dev/null | wc -l | tr -d ' ')
 *
 * An unreadable `commitDir`, a `.github` that cannot be traversed, a
 * `.github/workflows` with no read bit and a project that genuinely has no CI
 * all produced `0`. Five states, one byte. The prompt tried to cover it in
 * prose — *"Zero is a real answer … not the same as the command failing"* —
 * and could not, because the shell handed the agent the same `0` in each.
 *
 * Two halves, tested two ways:
 *
 *  - Does the probe TELL THEM APART? The shell block is extracted from
 *    `workflows/ship.js` and EXECUTED against real fixture directories. A
 *    source-text assertion that the probe "prints a token" is satisfied by a
 *    token printed on every path.
 *  - Does the consumer require it? `ciBlocksReadiness` is extracted by marker
 *    and executed, with the exemption driven from both sides.
 *
 * THE CONTROL IS THE POINT, twice over. A probe that refuses everything
 * satisfies "an unreadable directory does not undraft" perfectly, so a project
 * genuinely without workflows must still undraft — and so must this
 * repository's own shape, where `.github/workflows` holds `.yml` files and no
 * `.yaml`. That second control is not decoration: it is the row on which the
 * repair the issue itself proposed fails, and it is measured below.
 *
 * WHAT WAS BROKEN TO PROVE THESE FAIL
 * (.claude/rules/checks-must-be-able-to-fail.md): the mutants are built here,
 * on every run, from the real source. Each builder throws when its
 * substitution changes nothing, so a rename aborts this file rather than
 * passing it. The counts are in the PR body.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { structuralCut } from "../lib/source-slice";

const REPO_ROOT = join(import.meta.dir, "..");
/** The one call site spelling, so a rename aborts rather than measuring nothing. */
const PROBE_CALL = "${workflowProbeCommand(shellQuote(commitDir))}";
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

function markedBlock(name: string, source: string = shipSource): string {
  return structuralCut(source, `// ──── ${name}-START ────`, {
    endAnchor: `// ──── ${name}-END ────`,
  });
}

/** ship.js's real probe builder, executed rather than transcribed. */
function loadProbe(source = shipSource): (dir: string) => string {
  const body = markedBlock("WORKFLOW-PROBE", source);
  if (!body.includes("WORKFLOW_PROBE_FAILED")) {
    throw new Error("could not build the harness: the probe no longer emits a failure token");
  }
  return new Function(`${body}\nreturn workflowProbeCommand`)() as (dir: string) => string;
}

interface ProbeRun {
  code: number;
  out: string;
  token: "OK" | "FAILED" | "NEITHER";
  count: number | null;
}

/**
 * Run a probe script and read what it said.
 *
 * `workflows` is echoed by the harness, not by the probe: the probe leaves it
 * in a shell variable for the block around it, and a test that could not see
 * it would be asserting the token alone — which every path prints.
 */
function runProbe(script: string, dir: string): ProbeRun {
  const r = spawnSync("/bin/sh", ["-c", `${script}\nprintf 'COUNT=%s\\n' "$workflows"`], {
    encoding: "utf-8",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = /^COUNT=(\d*)$/m.exec(r.stdout ?? "");
  return {
    code: r.status ?? -1,
    out,
    token: out.includes("WORKFLOW_PROBE_FAILED")
      ? "FAILED"
      : out.includes("WORKFLOW_PROBE_OK")
        ? "OK"
        : "NEITHER",
    count: m && m[1] !== "" ? Number(m[1]) : null,
  };
}

// ── fixtures ────────────────────────────────────────────────

let root = "";
const dirs: Record<string, string> = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rg-1098-probe-"));
  const make = (name: string, files: string[]) => {
    const d = join(root, name);
    mkdirSync(join(d, ".github", "workflows"), { recursive: true });
    for (const f of files) writeFileSync(join(d, ".github", "workflows", f), "on: push\n");
    dirs[name] = d;
    return d;
  };
  // This repository's own shape: `.yml` files, no `.yaml`. The row the
  // issue's proposed repair fails on.
  make("ymlOnly", ["ci.yml", "gates.yml"]);
  make("both", ["ci.yml", "release.yaml"]);
  make("emptyWorkflowsDir", []);
  chmodSync(make("unreadableWorkflows", ["ci.yml"]) + "/.github/workflows", 0o000);
  chmodSync(make("unreadableGithub", ["ci.yml"]) + "/.github", 0o000);

  // A workflow reached through a SYMLINK. GitHub Actions runs it, so a probe
  // that cannot see it reports 0 and takes the no-CI exemption — the same
  // fail-open as the unreadable directory, through a different door. The
  // target lives OUTSIDE the walked tree, so the fixture cannot satisfy the
  // assertion by a route that bypasses the link.
  const linkTarget = join(root, "outside", "ci.yml");
  mkdirSync(join(root, "outside"), { recursive: true });
  writeFileSync(linkTarget, "on: push\n");
  symlinkSync(linkTarget, join(make("symlinkedWorkflow", []), ".github", "workflows", "ci.yml"));

  // The same shape one level up: `.github/workflows` is itself a link to a
  // directory. `find` does not descend a symlinked START POINT without `-L`,
  // so the enumeration came back empty and the project reported 0 — and this
  // one survived the `-type f` fix, because the predicate was never what
  // stopped it. The real directory is outside the walked tree for the same
  // reason as above: the fixture must not be satisfiable without the link.
  const linkedDir = join(root, "outsideDir");
  mkdirSync(linkedDir, { recursive: true });
  writeFileSync(join(linkedDir, "ci.yml"), "on: push\n");
  const symDirProj = join(root, "symlinkedWorkflowsDir");
  mkdirSync(join(symDirProj, ".github"), { recursive: true });
  symlinkSync(linkedDir, join(symDirProj, ".github", "workflows"));
  dirs.symlinkedWorkflowsDir = symDirProj;

  // A DANGLING link is the control that keeps `-L` from becoming the
  // narrowing it was meant to repair. Under `-L` a broken link is reported
  // as a link and `-type f` is false of it, so `-type l` is the only reason
  // this counts — and counting it asks for CI rather than exempting the run,
  // which is the direction this probe is allowed to be wrong in.
  symlinkSync(
    join(root, "noSuchTarget.yml"),
    join(make("danglingWorkflow", []), ".github", "workflows", "ci.yml"),
  );

  // `commitDir` itself present and not traversable. `[ -d ]` alone says yes
  // to this, and then `.github` is invisible and the count is 0.
  chmodSync(make("unreadableCommitDir", ["ci.yml"]), 0o000);

  const plain = join(root, "noCi");
  mkdirSync(plain, { recursive: true });
  dirs.noCi = plain;

  dirs.missing = join(root, "doesNotExist");
});

afterAll(() => {
  for (const n of ["unreadableWorkflows", "unreadableGithub", "unreadableCommitDir"]) {
    try {
      chmodSync(dirs[n]!, 0o755);
      chmodSync(join(dirs[n]!, ".github"), 0o755);
      chmodSync(join(dirs[n]!, ".github", "workflows"), 0o755);
    } catch {
      /* already restored */
    }
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

// ── the probe, executed ─────────────────────────────────────

describe("#1098: the probe distinguishes a count of zero from a count not taken", () => {
  const ROWS: Array<[string, ProbeRun["token"], number | null]> = [
    ["ymlOnly", "OK", 2],
    ["both", "OK", 2],
    ["emptyWorkflowsDir", "OK", 0],
    ["noCi", "OK", 0],
    // A symlinked workflow file is a workflow. `-type f` skipped it, which
    // reported 0 and took the no-CI exemption — a fail-open reintroduced one
    // `find` predicate at a time.
    ["symlinkedWorkflow", "OK", 1],
    // …and a symlinked workflows DIRECTORY, which `-type f` never touched:
    // `find` will not descend a linked start point without `-L`.
    ["symlinkedWorkflowsDir", "OK", 1],
    // A broken link counts. `-L` alone would report 0 here, which is the
    // exemption, so the two predicates are load-bearing in opposite cases.
    ["danglingWorkflow", "OK", 1],
    ["unreadableWorkflows", "FAILED", null],
    // `[ -d ]` says yes to a directory that exists and cannot be entered.
    ["unreadableCommitDir", "FAILED", null],
    ["unreadableGithub", "FAILED", null],
    ["missing", "FAILED", null],
  ];

  for (const [name, token, count] of ROWS) {
    test(`${name} -> ${token}${count === null ? "" : `, ${count}`}`, () => {
      const got = runProbe(loadProbe()(dirs[name]!), dirs[name]!);
      expect(got.token, got.out).toBe(token);
      if (token === "FAILED") {
        expect(got.code, "the probe reported FAILED and still exited zero").not.toBe(0);
      } else {
        expect(got.count, got.out).toBe(count);
      }
    });
  }

  test("every state prints a token — silence is not a reading", () => {
    // `0`, `{}`, `null`, `SKIP` and silence are indistinguishable from
    // success (.claude/rules/config-access.md). So is a probe that says
    // nothing, and this is the only case that would notice.
    for (const name of Object.keys(dirs)) {
      expect(runProbe(loadProbe()(dirs[name]!), dirs[name]!).token, name).not.toBe("NEITHER");
    }
  });

  test("the pre-#1098 probe gives the same 0 to a project with CI it cannot read", () => {
    // The defect, reconstructed and run. Without this row the cases above
    // are green over a problem nobody has shown exists.
    //
    // This is the probe AS #1101 LEFT IT, not the `ls` form it replaced:
    // #1101 added the `test -d` and switched to `find`, which closes the
    // missing-`commitDir` case and nothing else. `2>/dev/null` is still there
    // and the count is still a pipeline, so a directory that EXISTS and
    // cannot be read is still a silent `0` — and `0` is the exemption.
    const old = (d: string) =>
      `test -d ${d} || { echo "WORKFLOW_PROBE_FAILED: cannot read" ${d}; exit 1; }\n` +
      `workflows=$(find ${d}/.github/workflows -maxdepth 1 \\( -name '*.yml' -o -name '*.yaml' \\) 2>/dev/null | wc -l | tr -d ' ')`;

    const unreadable = runProbe(old(dirs.unreadableWorkflows!), dirs.unreadableWorkflows!);
    const genuine = runProbe(old(dirs.noCi!), dirs.noCi!);
    expect(unreadable.count, "#1101's probe no longer reports zero for an unreadable directory")
      .toBe(0);
    expect(genuine.count).toBe(0);
    expect(unreadable.count, "the two states were already distinguishable")
      .toBe(genuine.count);
    expect(unreadable.token, "#1101's probe already refused the unreadable directory")
      .not.toBe("FAILED");

    // And the case #1101 DID close stays closed — this is not a revert.
    expect(runProbe(old(dirs.missing!), dirs.missing!).token).toBe("FAILED");

    // And the new one tells them apart, on the same two inputs.
    expect(runProbe(loadProbe()(dirs.unreadableWorkflows!), dirs.unreadableWorkflows!).token)
      .toBe("FAILED");
    expect(runProbe(loadProbe()(dirs.noCi!), dirs.noCi!).token).toBe("OK");
  });

  test("the repair #1098 itself proposes changes nothing — the `||` is unreachable", () => {
    // The cheapest wrong fix, named before the repair was written, and it is
    // the one the issue body spells out: drop the `2>/dev/null` and make a
    // non-zero enumeration the failure token.
    //
    // `workflows=$(… | wc -l | tr -d ' ') || { … }` tests the exit status of
    // the PIPELINE, which is `tr`'s, which is 0. The `||` cannot fire on any
    // input. So the unreadable directory still reports `0` — the exemption —
    // and a test written only around "the probe prints a failure token when
    // it should" would go green over a probe that never prints one. This is
    // also why #1101's `find` rewrite did not close the case: same pipeline.
    const proposed = (d: string) =>
      `workflows=$(ls ${d}/.github/workflows/*.yml ${d}/.github/workflows/*.yaml | wc -l | tr -d ' ') || { echo WORKFLOW_PROBE_FAILED; exit 1; }\necho WORKFLOW_PROBE_OK`;

    const bad = runProbe(proposed(dirs.unreadableWorkflows!), dirs.unreadableWorkflows!);
    expect(bad.token, "the proposed repair caught it — this case measures nothing").toBe("OK");
    expect(bad.count, "the defect is unchanged by the proposed repair").toBe(0);

    // The shipped probe, same input.
    expect(runProbe(loadProbe()(dirs.unreadableWorkflows!), dirs.unreadableWorkflows!).token)
      .toBe("FAILED");
  });

  test("…and making that `||` reachable refuses every ordinary project", () => {
    // The follow-up repair, which is the natural next move once the row
    // above is understood: take the pipeline out so `ls`'s own status
    // survives. It refuses EVERYTHING of this repository's shape.
    //
    // `ls A/*.yml A/*.yaml` exits 1 when only ONE glob matches — the
    // unmatched one is passed through literally and `ls` ENOENTs on it while
    // still printing the files it did find — and `.yml` files with no
    // `.yaml` is the shape of this repository's own `.github/workflows`.
    // This is why the acceptance row needs its control: a probe that refuses
    // everything satisfies "an unreadable directory does not undraft".
    const reachable = (d: string) =>
      `found=$(ls ${d}/.github/workflows/*.yml ${d}/.github/workflows/*.yaml) || { echo WORKFLOW_PROBE_FAILED; exit 1; }\nworkflows=$(printf '%s\\n' "$found" | wc -l | tr -d ' ')\necho WORKFLOW_PROBE_OK`;

    expect(
      runProbe(reachable(dirs.unreadableWorkflows!), dirs.unreadableWorkflows!).token,
      "the follow-up repair does not even catch the case it was written for",
    ).toBe("FAILED");
    expect(
      runProbe(reachable(dirs.ymlOnly!), dirs.ymlOnly!).token,
      "the follow-up repair would have passed — it does not refuse a normal project",
    ).toBe("FAILED");

    // The shipped probe, on the same input, does not. `find` is used instead
    // precisely because a no-match is exit 0 and an enumeration error is not.
    const ok = runProbe(loadProbe()(dirs.ymlOnly!), dirs.ymlOnly!);
    expect(ok.token).toBe("OK");
    expect(ok.count).toBe(2);
  });

  test("a pipeline would hide the enumeration error a third time", () => {
    // `find … | wc -l` reads correctly and reinstates the defect for the same
    // reason the proposed repair is a no-op: a pipeline's status is the LAST
    // command's. Measured, because the expression looks right — and this is
    // the form the shipped probe deliberately does not use.
    const piped = (d: string) =>
      `workflows=$(find ${d}/.github/workflows -maxdepth 1 -type f -name '*.yml' 2>/dev/null | wc -l | tr -d ' ') || { echo WORKFLOW_PROBE_FAILED; exit 1; }\necho WORKFLOW_PROBE_OK`;
    const got = runProbe(piped(dirs.unreadableWorkflows!), dirs.unreadableWorkflows!);
    expect(got.token, "the pipeline form caught it — this case measures nothing").toBe("OK");
    expect(got.count).toBe(0);
    expect(runProbe(loadProbe()(dirs.unreadableWorkflows!), dirs.unreadableWorkflows!).token)
      .toBe("FAILED");
  });
});

// ── the undraft block, executed ─────────────────────────────

/**
 * The MARK_READY shell block with the two GitHub calls replaced by echoes.
 *
 * The block is the enforcement — #46's `&&` and now #1098's `exit 1` — so it
 * is run rather than read. Replacing only the `bun` lines keeps the control
 * flow this file is making a claim about.
 */
function undraftScript(dir: string, source = shipSource): string {
  const tail = source.slice(source.indexOf("Take the PR out of draft."));
  // A named end anchor is EXCLUSIVE, so the `fi` the anchor matched is put
  // back. `sh -n` below is what stops that from papering over a block whose
  // structure has changed.
  const block = `${structuralCut(tail, "sha=$(git -C ${shellQuote(commitDir)} rev-parse HEAD)", {
    endAnchor: "\nfi\n",
  })}\nfi`;
  // Not required to be present: the pre-#1098 mutant below replaces the call
  // with the inline `ls` it used to be, and that block is the one whose
  // behaviour this file is comparing against.
  if (!block.includes('[ "$workflows" -eq 0 ]')) {
    throw new Error("could not build the harness: the undraft block no longer branches on the count");
  }
  if (!block.includes("pr-ready")) {
    throw new Error("could not build the harness: the undraft block no longer calls pr-ready");
  }
  const script = block
    .replace(PROBE_CALL, () => loadProbe(source)(dir))
    .replaceAll("${shellQuote(commitDir)}", dir)
    // `ci-status` stubbed to REFUSE, so the `&&` below it is the thing being
    // observed: a `pr-ready` that ran anyway is #46 reopened.
    .replace(/bun --cwd \$\{shellQuote\(HARNESS_ROOT\)\} scripts\/github-op\.ts ci-status[^\n]*\\/, "false \\")
    .replaceAll(
      /bun --cwd \$\{shellQuote\(HARNESS_ROOT\)\} scripts\/github-op\.ts pr-ready[^\n]*/g,
      "echo CALLED_PR_READY",
    )
    // The block is read as SOURCE, so a `\\(` in it is one template-literal
    // escape that the agent would receive as `\(`. Resolved last, because the
    // probe text injected above has already been through JS and the
    // replacements above match on the source spelling. Without this the
    // pre-#1098 block does not parse as shell, and a case asserting that no
    // `pr-ready` ran would be green because NOTHING ran.
    .replaceAll("\\\\", "\\");
  // A script that does not parse exits non-zero and prints nothing, which is
  // indistinguishable from the refusal three of the cases below assert.
  const lint = spawnSync("/bin/sh", ["-n"], { input: script, encoding: "utf-8" });
  if (lint.status !== 0) {
    throw new Error(`could not build the harness: the undraft block does not parse — ${lint.stderr}`);
  }
  return script;
}

describe("#1098: an unreadable directory never reaches the undraft", () => {
  const run = (dir: string, source = shipSource) =>
    spawnSync("/bin/sh", ["-c", undraftScript(dir, source)], { encoding: "utf-8" });

  test("a project with no workflows still undrafts", () => {
    // THE CONTROL. Blocking here would leave every PR a draft forever for
    // any consumer with no GitHub Actions, which is how a correct check gets
    // switched off within a week.
    const r = run(dirs.noCi!);
    expect(`${r.stdout}${r.stderr}`).toContain("CALLED_PR_READY");
  });

  test("a directory whose workflows cannot be enumerated does not", () => {
    const r = run(dirs.unreadableWorkflows!);
    const out = `${r.stdout}${r.stderr}`;
    expect(out, "the PR was undrafted over a directory nobody could read")
      .not.toContain("CALLED_PR_READY");
    expect(out).toContain("WORKFLOW_PROBE_FAILED");
    expect(r.status, "the block reported a probe failure and exited zero").not.toBe(0);
  });

  test("a project WITH workflows is still gated on a live CI pass (#46)", () => {
    // The `&&` half, unchanged by this issue and asserted so that a probe
    // change cannot quietly become a bypass. `ci-status` is stubbed to fail.
    const r = run(dirs.ymlOnly!);
    const out = `${r.stdout}${r.stderr}`;
    expect(out, "pr-ready ran after a failing ci-status").not.toContain("CALLED_PR_READY");
  });

  test("the pre-#1098 block undrafts over the unreadable directory", () => {
    // The mutation, and the reason the case above is a witness rather than a
    // description. Built from the real source so a rename aborts the file.
    const anchor = PROBE_CALL;
    expect(shipSource.split(anchor).length - 1, "the probe is not called at exactly two sites")
      .toBe(2);
    const old =
      "workflows=$(ls ${commitDir}/.github/workflows/*.yml ${commitDir}/.github/workflows/*.yaml 2>/dev/null | wc -l | tr -d ' ')";
    const mutant = shipSource.replaceAll(anchor, old);
    expect(mutant, "the mutation changed nothing").not.toBe(shipSource);

    const r = run(dirs.unreadableWorkflows!, mutant);
    expect(`${r.stdout}${r.stderr}`, "the mutant refused — this case witnesses nothing")
      .toContain("CALLED_PR_READY");
  });
});

// ── the consumer ────────────────────────────────────────────

function loadReadiness(source = shipSource) {
  const body = `${markedBlock("PROVE-STATUS", source)}\n${markedBlock("PR-READINESS", source)}`;
  if (!body.includes("ciBlocksReadiness")) {
    throw new Error("could not build the harness: the readiness block lost its CI decision");
  }
  return new Function(`${body}\nreturn prReadiness`)() as (
    status: string,
    pr: unknown,
    ci: unknown,
  ) => { action: string; reason: string | null };
}

const OPENED = { ok: true, prNumber: 7 };
const SHIPPED = "SHIPPED_AND_PROVEN";

describe("#1098: the zero exemption requires a probe that reported OK", () => {
  test("a project with no CI, probe OK, undrafts", () => {
    // THE CONTROL on the consumer side.
    const r = loadReadiness()(SHIPPED, OPENED, {
      verdict: "UNMEASURED",
      workflowCount: 0,
      workflowProbe: "OK",
      reason: "no check has been recorded",
    });
    expect(r.action).toBe("MARK_READY");
  });

  test("a zero with no probe reading does not", () => {
    // The relay shape (#646): a field the schema does not declare is
    // filtered out on the way back, so "absent" is the state a dropped field
    // arrives in and it must not be the permissive one.
    for (const probe of [undefined, null, "", "FAILED", "ok", true, 0]) {
      const ci = { verdict: "UNMEASURED", workflowCount: 0, workflowProbe: probe };
      const r = loadReadiness()(SHIPPED, OPENED, ci);
      expect(r.action, `workflowProbe=${JSON.stringify(probe ?? null)} earned a mergeable PR`)
        .toBe("LEAVE_DRAFT");
      expect(r.reason).toContain("cannot be told apart");
    }
  });

  test("a probe failure does not change the answer when the count is non-zero", () => {
    // Checked inside the exemption, not above it. A probe reading is only
    // load-bearing where the count decides alone; where `ci-status` decides,
    // hoisting the check would refuse runs CI has already passed.
    const r = loadReadiness()(SHIPPED, OPENED, {
      verdict: "PASS",
      workflowCount: 3,
      workflowProbe: "FAILED",
    });
    expect(r.action).toBe("MARK_READY");
  });

  test("removing the probe requirement undrafts over a count nobody took", () => {
    // The mutation, built from the real block.
    const anchor = "if (ci.workflowProbe !== 'OK') {";
    expect(shipSource.split(anchor).length - 1, "the probe requirement is not at exactly one site")
      .toBe(1);
    const mutant = shipSource.replace(anchor, "if (false) {");
    expect(mutant, "the mutation changed nothing").not.toBe(shipSource);

    const unread = { verdict: "UNMEASURED", workflowCount: 0 };
    expect(loadReadiness()(SHIPPED, OPENED, unread).action).toBe("LEAVE_DRAFT");
    expect(loadReadiness(mutant)(SHIPPED, OPENED, unread).action, "the pre-#1098 behaviour")
      .toBe("MARK_READY");

    // And the control survives the mutation, which is what says the two
    // cases are measuring different things.
    expect(
      loadReadiness(mutant)(SHIPPED, OPENED, { ...unread, workflowProbe: "OK" }).action,
    ).toBe("MARK_READY");
  });

  test("the schema declares workflowProbe, or the field never arrives", () => {
    // #646 exactly: a structured-output schema is a FILTER, not a
    // description. An undeclared field is removed on the way back, and
    // `ciBlocksReadiness` would then refuse every run — fail-closed, for the
    // wrong reason, on every consumer with no CI.
    const schema = structuralCut(shipSource, "label: 'ci-verify'", { balanced: "{" });
    expect(schema.length, "the ci-verify schema cut came back empty").toBeGreaterThan(0);
    expect(schema.length, "the cut is the whole of ship.js").toBeLessThan(shipSource.length);
    expect(schema).toContain("workflowProbe");
    expect(schema).toContain("enum: ['OK', 'FAILED']");
  });

  test("the probe's directory is quoted at every call site, and SHELL-QUOTE-1 cannot see that", () => {
    // `commitDir` is agent-derived (#155), and #1056 put every such value
    // through `shellQuote` at the point of interpolation. This helper keeps
    // that: the parameter is named `quotedDir` and both sites pass
    // `shellQuote(commitDir)`, so the census in
    // `test/workflow-shell-interpolation.test.ts` counts them as quoted.
    //
    // What that census CANNOT see is the inside of this function. SHELL-QUOTE-1
    // matches `${<name>}` for names in its own TAINTED list, so a parameter
    // rename moves the interpolations out of its population entirely — the
    // membership-derivation gap #1103 is about, which this is a live instance
    // of and which is NOT fixed here. So the contract is asserted locally
    // instead: every interpolation in the body is the already-quoted
    // parameter, and nothing else.
    const body = markedBlock("WORKFLOW-PROBE");
    const builder = body.slice(body.indexOf("function workflowProbeCommand("));
    const interpolated = [...builder.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1]);
    expect(interpolated.length, "the builder interpolates nothing — this case measures nothing")
      .toBeGreaterThan(0);
    expect(
      [...new Set(interpolated)],
      "the probe body interpolates something other than its already-quoted parameter",
    ).toEqual(["quotedDir"]);

    // …and the parameter really is quoted by every caller. A site passing
    // `commitDir` raw would satisfy the assertion above and still be bare.
    const mentions = shipSource.split("workflowProbeCommand(").length - 1;
    const declarations = shipSource.split("function workflowProbeCommand(quotedDir)").length - 1;
    expect(declarations, "the builder is declared other than exactly once").toBe(1);
    expect(mentions - declarations, "no call site found — this case measures nothing").toBe(2);
    // Every mention that is not the declaration is the quoted spelling, so
    // there is no third site reaching the shell with a raw path.
    expect(
      shipSource.split(PROBE_CALL).length - 1,
      "a call site passes the directory without shellQuote",
    ).toBe(mentions - declarations);
  });

  test("the probe is one binding — no site counts workflow files on its own", () => {
    // A second copy would survive any mutation of the first, and both would
    // read as covered. Asserted as a boolean so a failure names the string
    // rather than printing 400kB of ship.js.
    expect(shipSource.includes("$(ls "), "a site still counts files with an inline ls")
      .toBe(false);
    expect(
      shipSource.split("function workflowProbeCommand(").length - 1,
      "the probe builder is declared other than exactly once",
    ).toBe(1);
    expect(
      shipSource.split(PROBE_CALL).length - 1,
      "the probe is not called at exactly the two prompt sites",
    ).toBe(2);
  });
});
