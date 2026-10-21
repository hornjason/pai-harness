/**
 * PROTECT-1 (#909) — the gate that refuses `strict: true` where no merge
 * queue is possible.
 *
 * ## Proof it can fail
 *
 * Every case below runs the REAL `runBranchProtectionValidation` in a spawned
 * bun suite and reads the findings it recorded. The composition is not
 * reimplemented here, for the reason `test/config-access-conformity.test.ts`
 * records in its own helper: a test that rebuilds the check's logic passes
 * with the check deleted.
 *
 * Measured by flipping ONE field in the probe's facts and nothing else:
 *
 * | Fixture | `strict` | Spawned suite |
 * |---|---|---|
 * | user-owned, push-CI present | `true`  | **1 red** — `PROTECT-1` FAIL, remedy `strict: false` |
 * | user-owned, push-CI present | `false` | **0 red**, 0 findings |
 * | org-owned, push-CI present  | `true`  | **1 red** — remedy `merge queue`, and NOT `strict: false` |
 * | user-owned, NO push-CI      | `true`  | **1 red** — remedy REFUSES `strict: false` |
 * | admin-less token (403)      | unread  | **0 red**, 1 WARN beginning `UNMEASURED:` |
 * | admin-less token (404)      | unread  | **0 red**, 1 WARN beginning `UNMEASURED:` |
 *
 * Four mutations of the production code, each reverted after measuring:
 *
 * | Mutation | Red |
 * |---|---|
 * | `strict === true` returns PASS unconditionally | **13 of 36** |
 * | the UNMEASURED `addFinding` deleted from `runBranchProtectionValidation` | **2 of 36** |
 * | the organization branch made unreachable, so one remedy serves both | **1 of 36** |
 * | the push-CI precondition made unreachable | **1 of 36** |
 *
 * The 403 row is the one worth stating twice. It is NOT a pass: the suite is
 * green because an unreadable repo is not evidence of a defect, and the
 * finding it records says `UNMEASURED` in the first word so the report cannot
 * be read as clean. `strictFalse` and `forbidden` differ in exactly that —
 * zero findings versus one UNMEASURED finding — which is the distinction
 * `.claude/rules/checks-must-be-able-to-fail.md` says `0`, `{}`, `null` and
 * SKIP destroy.
 *
 * ## Nothing here touches the network
 *
 * The `probe` parameter is the seam production goes through:
 * `runBranchProtectionValidation` defaults it to `githubProtectionProbe` and
 * calls it by that one binding. Substituting it exercises the real check
 * against planted facts rather than a parallel code path — and a test that
 * hit the live API would measure GitHub's current configuration, which is the
 * thing the gate is supposed to be able to find wrong.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

import {
  branchPatternMatches,
  jobContextNames,
  protectionFactsFromPayload,
  readMergeSerialisation,
  readPushCi,
  runsOnPushTo,
  unreadableFacts,
  type ProtectionFacts,
  type PushCiReading,
} from "../lib/branch-protection";

const REPO = resolve(import.meta.dir, "..");
const CONFORMITY = join(REPO, "lib", "conformity.ts");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-909-"));
  scratch.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

// ── Fixtures ────────────────────────────────────────────

/** A ci.yml whose `test` and `gates` jobs run on push to main. */
const PUSH_CI = `name: CI

on:
  merge_group:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: bun test
  gates:
    runs-on: ubuntu-latest
    steps:
      - run: bun run gates
`;

/** The same jobs, but only on pull_request — the unsafe-to-relax shape. */
const PR_ONLY_CI = `name: CI

on:
  pull_request:
    branches:
      - main

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: bun test
  gates:
    runs-on: ubuntu-latest
    steps:
      - run: bun run gates
`;

function facts(over: Partial<ProtectionFacts> = {}): ProtectionFacts {
  return {
    slug: "someone/consumer",
    branch: "main",
    strict: true,
    ownerType: "User",
    contexts: ["test", "gates"],
    mergeQueueEnabled: null,
    unreadable: null,
    ...over,
  };
}

// ── Running the real check ──────────────────────────────

interface Protect1Run {
  /** Did the spawned suite go red? This is the mutation signal. */
  red: boolean;
  /** How many tests the spawned suite reported as failing. */
  failCount: number;
  fails: string[];
  warns: string[];
}

/**
 * Run `runBranchProtectionValidation` for real, with `probe` returning
 * `given` and nothing else changed.
 *
 * The facts are serialised into the generated suite rather than passed
 * through a module-level mutable, so each case is a fresh process and no case
 * can see another's findings.
 */
function protect1(root: string, given: ProtectionFacts): Protect1Run {
  const file = join(mkdtempSync(join(tmpdir(), "rungate-909-run-")), "probe.test.ts");
  scratch.push(dirname(file));
  writeFileSync(
    file,
    `import { test } from "bun:test";\n` +
      `import { runBranchProtectionValidation, getFindings, clearFindings } from ${JSON.stringify(CONFORMITY)};\n` +
      `clearFindings();\n` +
      `runBranchProtectionValidation(${JSON.stringify(root)}, {\n` +
      `  probe: async () => (${JSON.stringify(given)}),\n` +
      `  subject: () => ${JSON.stringify(given.slug)},\n` +
      `});\n` +
      `test("zz-report", () => {\n` +
      `  console.log("F:" + JSON.stringify(getFindings().filter(f => f.ruleId === "PROTECT-1")));\n` +
      `});\n`,
  );
  const r = spawnSync("bun", ["test", file], { cwd: REPO, encoding: "utf-8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const found = JSON.parse(out.match(/F:(\[.*\])/)?.[1] ?? "null") as
    | Array<{ severity: string; message: string }>
    | null;
  if (found === null) throw new Error(`the probe suite never reported findings:\n${out}`);
  const failMatch = out.match(/\b(\d+) fail/);
  return {
    red: /\b[1-9]\d* fail/.test(out),
    failCount: failMatch ? Number(failMatch[1]) : 0,
    fails: found.filter(f => f.severity === "FAIL").map(f => f.message),
    warns: found.filter(f => f.severity === "WARN").map(f => f.message),
  };
}

// ── The mutation ────────────────────────────────────────

describe("#909: PROTECT-1 goes red on strict:true and clears on strict:false", () => {
  test("strict:true on a user-owned repo is 1 red; the ONLY change that clears it is strict:false", () => {
    const root = project({ ".github/workflows/ci.yml": PUSH_CI });

    const strictTrue = protect1(root, facts({ strict: true }));
    const strictFalse = protect1(root, facts({ strict: false }));

    // The red direction. One failing test, one FAIL finding.
    expect(strictTrue.failCount).toBe(1);
    expect(strictTrue.fails).toHaveLength(1);

    // The green direction, from the same fixture with one boolean flipped.
    expect(strictFalse.failCount).toBe(0);
    expect(strictFalse.red).toBe(false);
    expect(strictFalse.fails).toEqual([]);
    // And green here means NOTHING recorded — not an UNMEASURED dressed as a
    // pass. The 403 case below is the one that records a WARN, and these two
    // outcomes have to be distinguishable from the report alone.
    expect(strictFalse.warns).toEqual([]);
  });

  test("the refusal names the setting, the serialisation, the measured cost and the remedy", () => {
    const root = project({ ".github/workflows/ci.yml": PUSH_CI });
    const [msg] = protect1(root, facts({ strict: true })).fails;

    expect(msg).toContain("required_status_checks.strict = true");
    expect(msg).toContain("merging one PR invalidates every other open PR");
    expect(msg).toContain("2.5 min per PR");
    expect(msg).toContain("18 open PRs");
    expect(msg).toContain("REMEDY:");
  });

  /**
   * SC-A1 in `test/anti.test.ts` refuses the harness naming a consumer
   * anywhere under `lib/`, and this check is the one place that rule has
   * teeth beyond tidiness: `MEASURED_COST` is not a comment, it ships into
   * the findings report of whichever consumer runs PROTECT-1. Naming the repo
   * it was measured on would print one consumer's name to every other one.
   *
   * Asserted on the EMITTED MESSAGE and not on the source, because the source
   * is already covered by SC-A1 and the thing with the privacy consequence is
   * the output. Caught on this branch by that sibling test; it is a recurring
   * trap, so it gets a check pointed at the artefact that leaks.
   */
  test("the refusal names no consumer repo — it is printed to other consumers", () => {
    const root = project({ ".github/workflows/ci.yml": PUSH_CI });
    const [msg] = protect1(root, facts({ strict: true })).fails;

    expect(msg).toContain("on a real consumer");
    expect(msg).not.toContain("asaCommandCenter");
    // The citation that replaces the name has to actually be there, or the
    // detail is simply lost rather than relocated.
    expect(msg).toContain("rungate#909");
  });
});

// ── The remedy differs by owner type ────────────────────

describe("#909: the remedy differs by owner.type, because the available fix does", () => {
  test("user-owned is told strict:false and is NOT told to enable a merge queue", () => {
    const root = project({ ".github/workflows/ci.yml": PUSH_CI });
    const [msg] = protect1(root, facts({ ownerType: "User" })).fails;

    expect(msg).toContain("GitHub restricts merge queues to ORGANIZATION-owned repositories");
    expect(msg).toContain("Set required_status_checks.strict = false");
    // The whole defect this criterion exists to prevent: advice that cannot
    // be followed on this repo at any price.
    expect(msg).not.toContain("Enable a merge queue");
  });

  test("organization-owned is told to enable a merge queue, and is not told to relax strict", () => {
    const root = project({ ".github/workflows/ci.yml": PUSH_CI });
    const [msg] = protect1(root, facts({ ownerType: "Organization" })).fails;

    expect(msg).toContain("Enable a merge queue");
    expect(msg).toContain("merge_group:");
    expect(msg).not.toContain("Set required_status_checks.strict = false");
  });

  test("the two remedies are not the same string — one message for both is the bug", () => {
    const root = project({ ".github/workflows/ci.yml": PUSH_CI });
    const user = protect1(root, facts({ ownerType: "User" })).fails[0];
    const org = protect1(root, facts({ ownerType: "Organization" })).fails[0];
    expect(user).not.toBe(org);
  });
});

// ── push-CI gates the strict:false advice ───────────────

describe("#909: strict:false is not advised without CI on push to the default branch", () => {
  test("required contexts that run only on pull_request produce a REFUSAL, not the advice", () => {
    const root = project({ ".github/workflows/ci.yml": PR_ONLY_CI });
    const run = protect1(root, facts({ ownerType: "User", strict: true }));

    expect(run.failCount).toBe(1);
    const [msg] = run.fails;
    expect(msg).toContain("REFUSING to recommend strict: false");
    expect(msg).toContain("test, gates");
    expect(msg).toContain("semantic conflict");
    expect(msg).not.toContain("Set required_status_checks.strict = false");
  });

  test("a project with no .github/workflows at all refuses rather than advising", () => {
    const root = project({ "README.md": "# no ci here\n" });
    const [msg] = protect1(root, facts({ ownerType: "User", strict: true })).fails;

    expect(msg).toContain("UNMEASURED push-CI");
    expect(msg).toContain("REFUSING to recommend strict: false");
  });

  test("with push-CI present the same repo DOES get the advice — the refusal is not unconditional", () => {
    const root = project({ ".github/workflows/ci.yml": PUSH_CI });
    const [msg] = protect1(root, facts({ ownerType: "User", strict: true })).fails;
    expect(msg).toContain("Set required_status_checks.strict = false");
    expect(msg).not.toContain("REFUSING to recommend strict: false");
  });
});

// ── UNMEASURED is never a pass ──────────────────────────

describe("#909: an unreadable repo reports UNMEASURED and does not look like a clean one", () => {
  /**
   * The 403 the default Actions token gets. `githubProtectionProbe` turns it
   * into exactly this facts object — see its `partial(...)` path — so the
   * string planted here is the string production produces.
   */
  const FORBIDDEN = {
    ...unreadableFacts(
      "someone/consumer",
      "GET /repos/someone/consumer/branches/main/protection failed — HTTP 403: Resource not accessible " +
        "by integration — this endpoint requires ADMIN on the repository, and the default GitHub " +
        "Actions token does not have it, so this is the ordinary outcome in CI rather than an error",
    ),
    branch: "main",
    ownerType: "User",
  } as ProtectionFacts;

  test("a 403 records one UNMEASURED finding and fails nothing", () => {
    const root = project({ ".github/workflows/ci.yml": PUSH_CI });
    const run = protect1(root, FORBIDDEN);

    expect(run.failCount).toBe(0);
    expect(run.fails).toEqual([]);
    expect(run.warns).toHaveLength(1);
    expect(run.warns[0].startsWith("UNMEASURED:")).toBe(true);
    expect(run.warns[0]).toContain("HTTP 403");
    expect(run.warns[0]).toContain("requires ADMIN");
    expect(run.warns[0]).toContain("NOT the same as nothing being wrong");
  });

  test("a 403 and a correctly-configured repo are distinguishable from the findings alone", () => {
    const root = project({ ".github/workflows/ci.yml": PUSH_CI });
    const forbidden = protect1(root, FORBIDDEN);
    const clean = protect1(root, facts({ strict: false }));

    // Both suites are green. That is not the distinction, and a report keyed
    // on red/green alone would call these the same repo.
    expect(forbidden.red).toBe(false);
    expect(clean.red).toBe(false);
    // The distinction is the recorded finding, and it exists.
    expect(forbidden.warns.length).toBeGreaterThan(0);
    expect(clean.warns).toEqual([]);
  });

  /**
   * The measured non-admin response, which is a 404 and not a 403.
   *
   * Probed against `oven-sh/bun` on 2026-10-21 with a token holding no admin
   * there: `GET /branches/main` said `protected: true`, and
   * `GET /branches/main/protection` said 404 — the same status an unprotected
   * branch returns. It is UNMEASURED for the same reason the 403 is, and the
   * `getBranch` pre-call in `githubProtectionProbe` is what keeps it from
   * being mistaken for "no protection configured".
   */
  const NOT_FOUND = {
    ...unreadableFacts(
      "someone/consumer",
      "GET /repos/someone/consumer/branches/main/protection failed — HTTP 404: Not Found — this " +
        "endpoint requires ADMIN on the repository, and the default GitHub Actions token does not " +
        "have it, so this is the ordinary outcome in CI rather than an error",
    ),
    branch: "main",
    ownerType: "Organization",
  } as ProtectionFacts;

  test("a 404 from the admin-only endpoint is UNMEASURED, not 'no protection configured'", () => {
    const root = project({ ".github/workflows/ci.yml": PUSH_CI });
    const run = protect1(root, NOT_FOUND);

    expect(run.failCount).toBe(0);
    expect(run.warns).toHaveLength(1);
    expect(run.warns[0].startsWith("UNMEASURED:")).toBe(true);
    expect(run.warns[0]).toContain("HTTP 404");
  });

  test("no origin remote is UNMEASURED too, not a silent skip", () => {
    const root = project({ "README.md": "# detached\n" });
    const file = join(mkdtempSync(join(tmpdir(), "rungate-909-nosub-")), "probe.test.ts");
    scratch.push(dirname(file));
    writeFileSync(
      file,
      `import { test } from "bun:test";\n` +
        `import { runBranchProtectionValidation, getFindings, clearFindings } from ${JSON.stringify(CONFORMITY)};\n` +
        `clearFindings();\n` +
        `let probed = false;\n` +
        `runBranchProtectionValidation(${JSON.stringify(root)}, {\n` +
        `  probe: async () => { probed = true; throw new Error("the probe must not run without a subject"); },\n` +
        `  subject: () => null,\n` +
        `});\n` +
        `test("zz-report", () => {\n` +
        `  console.log("P:" + probed);\n` +
        `  console.log("F:" + JSON.stringify(getFindings().filter(f => f.ruleId === "PROTECT-1")));\n` +
        `});\n`,
    );
    const r = spawnSync("bun", ["test", file], { cwd: REPO, encoding: "utf-8" });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const found = JSON.parse(out.match(/F:(\[.*\])/)?.[1] ?? "null") as
      | Array<{ severity: string; message: string }>
      | null;
    if (found === null) throw new Error(`the probe suite never reported findings:\n${out}`);

    expect(out).toContain("P:false");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("WARN");
    expect(found[0].message.startsWith("UNMEASURED:")).toBe(true);
  });
});

// ── The classification, unit by unit ────────────────────

const PUSH_OK: PushCiReading = { onPush: ["test", "gates"], missing: [], unmeasured: null };

describe("#909: readMergeSerialisation reaches PASS only on positive evidence", () => {
  test("strict:false passes and says what it kept", () => {
    const r = readMergeSerialisation(facts({ strict: false }), PUSH_OK);
    expect(r.verdict).toBe("PASS");
    expect(r.reason).toContain("test, gates");
    expect(r.remedy).toBe("");
  });

  test("an unread strict is UNMEASURED, not a pass", () => {
    const r = readMergeSerialisation(facts({ strict: null }), PUSH_OK);
    expect(r.verdict).toBe("UNMEASURED");
  });

  test("strict:true with an unknown owner type is UNMEASURED, because the remedy is unknown", () => {
    const r = readMergeSerialisation(facts({ strict: true, ownerType: null }), PUSH_OK);
    expect(r.verdict).toBe("UNMEASURED");
    expect(r.reason).toContain("the remedy differs by it");
    expect(r.remedy).toBe("");
  });

  test("strict:true behind an enabled merge queue passes — that is what strict is for", () => {
    const r = readMergeSerialisation(
      facts({ strict: true, ownerType: "Organization", mergeQueueEnabled: true }),
      PUSH_OK,
    );
    expect(r.verdict).toBe("PASS");
    expect(r.mergeQueuePossible).toBe(true);
  });

  test("a merge queue reported as absent does not excuse strict:true — only an explicit true does", () => {
    for (const mergeQueueEnabled of [null, false] as const) {
      const r = readMergeSerialisation(
        facts({ strict: true, ownerType: "Organization", mergeQueueEnabled }),
        PUSH_OK,
      );
      expect(r.verdict).toBe("FAIL");
    }
  });

  test("a user-owned repo is told a merge queue is impossible, not merely unconfigured", () => {
    const r = readMergeSerialisation(facts({ strict: true, ownerType: "User" }), PUSH_OK);
    expect(r.mergeQueuePossible).toBe(false);
    expect(r.reason).toContain("422");
  });
});

// ── The push-CI reading ─────────────────────────────────

describe("#909: readPushCi distinguishes 'no push trigger' from 'did not look'", () => {
  test("push to the default branch covers the jobs that workflow declares", () => {
    const root = project({ ".github/workflows/ci.yml": PUSH_CI });
    const r = readPushCi(root, ["test", "gates"], "main");
    expect(r.unmeasured).toBeNull();
    expect(r.onPush).toEqual(["test", "gates"]);
    expect(r.missing).toEqual([]);
  });

  test("a pull_request-only workflow leaves every required context missing", () => {
    const root = project({ ".github/workflows/ci.yml": PR_ONLY_CI });
    const r = readPushCi(root, ["test", "gates"], "main");
    expect(r.unmeasured).toBeNull();
    expect(r.missing).toEqual(["test", "gates"]);
  });

  test("a push filter naming another branch does not count for this one", () => {
    const root = project({
      ".github/workflows/ci.yml": PUSH_CI.replace("      - main", "      - release"),
    });
    expect(readPushCi(root, ["test"], "main").missing).toEqual(["test"]);
    expect(readPushCi(root, ["test"], "release").missing).toEqual([]);
  });

  test("an absent workflows directory is UNMEASURED and not an empty 'nothing missing'", () => {
    const root = project({ "README.md": "# none\n" });
    const r = readPushCi(root, ["test"], "main");
    expect(r.unmeasured).toContain("UNMEASURED push-CI");
    // The field that would otherwise be read as "all clear".
    expect(r.missing).toEqual([]);
  });

  test("a context required by protection but declared in no workflow is missing", () => {
    const root = project({ ".github/workflows/ci.yml": PUSH_CI });
    expect(readPushCi(root, ["test", "ai-review"], "main").missing).toEqual(["ai-review"]);
  });
});

describe("#909: the YAML this reads", () => {
  test("push: with no branches filter fires on every branch", () => {
    expect(runsOnPushTo("on:\n  push:\njobs:\n  test:\n    runs-on: x\n", "anything")).toBe(true);
  });

  test("the quoted 'on' key is read — unquoted on is a YAML 1.1 boolean and files quote it", () => {
    const quoted = PUSH_CI.replace(/^on:/m, `"on":`);
    expect(runsOnPushTo(quoted, "main")).toBe(true);
    expect(runsOnPushTo(PUSH_CI.replace(/^on:/m, `'on':`), "main")).toBe(true);
  });

  test("the flow sequence form of branches is read", () => {
    const flow = "on:\n  push:\n    branches: [main, release]\njobs:\n  test:\n    runs-on: x\n";
    expect(runsOnPushTo(flow, "main")).toBe(true);
    expect(runsOnPushTo(flow, "topic")).toBe(false);
  });

  test("branches-ignore inverts the question", () => {
    const y = "on:\n  push:\n    branches-ignore:\n      - gh-pages\njobs:\n  test:\n    runs-on: x\n";
    expect(runsOnPushTo(y, "main")).toBe(true);
    expect(runsOnPushTo(y, "gh-pages")).toBe(false);
  });

  test("a workflow with no push trigger at all is not a push workflow", () => {
    expect(runsOnPushTo(PR_ONLY_CI, "main")).toBe(false);
    expect(runsOnPushTo("jobs:\n  test:\n    runs-on: x\n", "main")).toBe(false);
  });

  test("a job's name: is its context, because that is what protection records", () => {
    const y = "on:\n  push:\njobs:\n  test:\n    name: Suite\n    runs-on: x\n  gates:\n    runs-on: x\n";
    expect(jobContextNames(y)).toEqual(["Suite", "gates"]);
  });

  test("glob branch patterns match the way GitHub's filters do", () => {
    expect(branchPatternMatches("main", "main")).toBe(true);
    expect(branchPatternMatches("main", "mainline")).toBe(false);
    expect(branchPatternMatches("releases/*", "releases/v1")).toBe(true);
    expect(branchPatternMatches("releases/*", "releases/v1/hotfix")).toBe(false);
    expect(branchPatternMatches("releases/**", "releases/v1/hotfix")).toBe(true);
  });
});

// ── The payload reading ─────────────────────────────────

describe("#909: protectionFactsFromPayload", () => {
  test("protection with no required_status_checks is measured not-strict, not unread", () => {
    const f = protectionFactsFromPayload("o/r", "main", "User", { required_pull_request_reviews: {} });
    expect(f.strict).toBe(false);
    expect(f.unreadable).toBeNull();
    expect(f.contexts).toEqual([]);
  });

  test("both the legacy contexts list and the current checks list are read", () => {
    const f = protectionFactsFromPayload("o/r", "main", "User", {
      required_status_checks: { strict: true, contexts: ["test"], checks: [{ context: "test" }, { context: "gates" }] },
    });
    expect(f.strict).toBe(true);
    expect(f.contexts).toEqual(["test", "gates"]);
  });

  test("a strict field of the wrong type is null, not coerced to a pass", () => {
    const f = protectionFactsFromPayload("o/r", "main", "User", { required_status_checks: { contexts: [] } });
    expect(f.strict).toBeNull();
  });
});

// ── It reads. It never writes. ──────────────────────────

describe("#909: the gate never mutates branch protection", () => {
  /**
   * Structural, because the behavioural version of this assertion cannot be
   * written: proving a module does not make a request requires knowing every
   * request it could make. What CAN be proved is that the source contains no
   * mutating call at all, and #909 puts the write out of scope precisely
   * because a tool that silently rewrites a repo's security settings is a
   * worse problem than the one it fixes.
   */
  test("lib/branch-protection.ts contains no mutating HTTP verb or Octokit write", () => {
    const src = readFileSync(join(REPO, "lib", "branch-protection.ts"), "utf-8");
    const code = src
      .split("\n")
      .filter(l => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join("\n");
    for (const forbidden of [
      "updateBranchProtection",
      "deleteBranchProtection",
      "createOrUpdate",
      '"PUT',
      '"POST',
      '"PATCH',
      '"DELETE',
      ".put(",
      ".post(",
      ".patch(",
      ".delete(",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  test("the refusal hands over a READ-ONLY command and not a fix-it-for-me one", () => {
    const root = project({ ".github/workflows/ci.yml": PUSH_CI });
    const [msg] = protect1(root, facts({ ownerType: "User", strict: true })).fails;
    expect(msg).toContain("this check reads and refuses and never writes protection");
    expect(msg).toContain("gh api repos/someone/consumer/branches/main/protection -q .required_status_checks");
  });
});

// ── Both wiring sides (#208: the generated suite and the real one) ──────

describe("#909: PROTECT-1 is wired into the suite consumers actually run", () => {
  test("the generated conformity suite calls it", async () => {
    const { generateConformityTest } = await import("../lib/scaffold/steps");
    expect(generateConformityTest(REPO)).toContain("runBranchProtectionValidation(ROOT);");
  });

  test("this repo's own conformity suite calls it", () => {
    const suite = readFileSync(join(REPO, "test", "scaffold-conformity.test.ts"), "utf-8");
    expect(suite).toContain("runBranchProtectionValidation(ROOT);");
  });
});
