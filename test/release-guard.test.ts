/**
 * Covers SC-828, SC-829, SC-830, SC-831 (HARNESS-STANDARD.md).
 *
 * #364 — rungate had no publish step. npm served `0.2.1` while `main` was 741
 * commits past it, so every mutation count and gate measurement in
 * `SUCCESS.md` described software no consumer could install.
 *
 * The issue named the way this fix most likely ships broken, and it is the
 * shape `.claude/rules/checks-must-be-able-to-fail.md` opens with:
 *
 *   > A publish job that exits 0 because npm rejected a duplicate version is
 *   > exactly the "could not measure reads as nothing wrong" shape.
 *
 * So the suite is in three parts, and the second two matter more than the
 * first: the decision (unit), the SCRIPT (spawned, and spawned again as a
 * mutant with its refusal exit zeroed), and the WORKFLOW FILE itself — a
 * guard the pipeline never calls, or calls behind a `continue-on-error`, is
 * the decorative check this repo keeps finding.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  NPM_REGISTRY,
  postflightRefusal,
  preflightRefusal,
  registryState,
} from "../lib/release-preflight";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "release-guard.ts");
const WORKFLOW = join(ROOT, ".github", "workflows", "release.yml");
const scratch: string[] = [];

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

const state = (versions: string[], latest: string | null = versions.at(-1) ?? null) => ({
  versions,
  latest,
});

describe("#364 SC-828: a release that was already cut is refused, not repeated", () => {
  test("a version already on the registry is refused", () => {
    const no = preflightRefusal("0.2.1", "v0.2.1", state(["0.2.0", "0.2.1"]));
    expect(no, "a duplicate publish was allowed to proceed").not.toBeNull();
    expect(no).toContain("already on the registry");
  });

  test("a version that is not on the registry is allowed", () => {
    expect(preflightRefusal("0.2.2", "v0.2.2", state(["0.2.0", "0.2.1"]))).toBeNull();
  });

  test("an older version buried behind `latest` still counts as published", () => {
    // The reason this reads the packument and not /latest. `latest` moves on
    // and leaves every earlier version installable behind it, so a dist-tag
    // cannot answer "has 0.2.1 ever shipped".
    expect(preflightRefusal("0.2.1", "v0.2.1", state(["0.2.1", "0.9.0"], "0.9.0"))).not.toBeNull();
  });

  test("a package that has never been published allows anything", () => {
    expect(preflightRefusal("0.0.1", "v0.0.1", state([], null))).toBeNull();
  });

  test("a tag that disagrees with package.json is refused", () => {
    // Publishing 0.2.3 under a tag reading v0.2.2 is two releases with one
    // set of notes. npm would take it; every human reading the tag is wrong.
    const no = preflightRefusal("0.2.3", "v0.2.2", state(["0.2.1"]));
    expect(no).toContain("does not name the version being published");
  });

  test("a run with no tag skips the tag comparison rather than inventing one", () => {
    expect(preflightRefusal("0.2.3", null, state(["0.2.1"]))).toBeNull();
  });

  test("a version npm would not accept is refused before anything else", () => {
    for (const bad of ["", "0.2", "v0.2.3", "latest", "0.2.3 "]) {
      expect(preflightRefusal(bad, null, state([])), `${JSON.stringify(bad)} was accepted`)
        .not.toBeNull();
    }
    for (const ok of ["0.2.3", "1.0.0-rc.1", "1.0.0+build.5"]) {
      expect(preflightRefusal(ok, null, state([])), `${ok} was refused`).toBeNull();
    }
  });
});

describe("#364 SC-829: a release that did NOT happen is refused too", () => {
  // Preflight alone passes a pipeline whose publish step never ran. This is
  // the half that cannot be satisfied by doing nothing.
  test("an unmoved latest is refused", () => {
    const no = postflightRefusal("0.2.2", "0.2.1");
    expect(no, "a skipped publish reported success").not.toBeNull();
    expect(no).toContain("did not take effect");
  });

  test("a registry with no latest at all is refused", () => {
    expect(postflightRefusal("0.2.2", null)).toContain("the release did not happen");
  });

  test("latest matching the tree version is allowed", () => {
    expect(postflightRefusal("0.2.2", "0.2.2")).toBeNull();
  });

  test("the two phases disagree about the same reading, which is the point", () => {
    // One registry state, read before and after. Exactly one of the two
    // phases may be satisfied by it — if both passed, or neither could, the
    // pair would not distinguish a release from a no-op.
    const before = state(["0.2.0", "0.2.1"], "0.2.1");
    expect(preflightRefusal("0.2.2", null, before)).toBeNull();
    expect(postflightRefusal("0.2.2", before.latest)).not.toBeNull();

    const after = state(["0.2.0", "0.2.1", "0.2.2"], "0.2.2");
    expect(preflightRefusal("0.2.2", null, after)).not.toBeNull();
    expect(postflightRefusal("0.2.2", after.latest)).toBeNull();
  });
});

describe("#364 SC-830: the registry reading fails loudly or not at all", () => {
  const reply = (status: number, body: unknown) =>
    (async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      }) as unknown as Response) as unknown as typeof fetch;

  test("a 404 is a real answer: nothing has ever been published", async () => {
    expect(await registryState("nope", reply(404, {}))).toEqual({ versions: [], latest: null });
  });

  test("a 500 throws rather than reporting an empty registry", async () => {
    // The fail-open this would otherwise be: an unreachable registry
    // returning {versions: []} waves every duplicate straight through.
    expect(registryState("rungate", reply(500, {}))).rejects.toThrow("registry returned 500");
  });

  test("the packument is read for versions and dist-tags", async () => {
    const got = await registryState(
      "rungate",
      reply(200, { versions: { "0.2.0": {}, "0.2.1": {} }, "dist-tags": { latest: "0.2.1" } }),
    );
    expect(got).toEqual({ versions: ["0.2.0", "0.2.1"], latest: "0.2.1" });
  });

  test("a packument with no dist-tags yields null, not a guess", async () => {
    expect(await registryState("rungate", reply(200, { versions: { "0.1.0": {} } }))).toEqual({
      versions: ["0.1.0"],
      latest: null,
    });
  });

  test("the default base is npm", () => {
    expect(NPM_REGISTRY).toBe("https://registry.npmjs.org");
  });
});

/**
 * Spawn the real script, and spawn a mutant copy with REFUSE_EXIT zeroed.
 *
 * Every negative case runs twice. The second assertion is the whole point:
 * it is the removal of the non-zero exit, performed and observed, so a case
 * that later starts passing for an unrelated reason stops being
 * indistinguishable from one that is genuinely caught.
 */
function mutantScript(): string {
  const src = readFileSync(SCRIPT, "utf-8");

  const DECL = "export const REFUSE_EXIT = 1;";
  const n = src.split(DECL).length - 1;
  if (n !== 1) {
    throw new Error(`could not build the mutant: the exit constant appears ${n} times`);
  }

  // The copy runs from a temp directory, so every relative specifier is
  // rewritten to an absolute path. One the rewriter cannot see would make the
  // mutant die on module resolution — a non-zero exit, which would read as
  // the mutation having been rejected on the merits.
  let out = src.replace(DECL, "export const REFUSE_EXIT = 0;");
  out = out.replace(/from "(\.\.?\/[^"]+)"/g, (_m, spec) => `from ${JSON.stringify(join(ROOT, "scripts", spec))}`);
  const leftover = out.match(/from "\.\.?\//);
  if (leftover) throw new Error("could not build the mutant: a relative import survived rewriting");

  const dir = mkdtempSync(join(tmpdir(), "rungate-relmut-"));
  scratch.push(dir);
  const path = join(dir, "release-guard.mutant.ts");
  writeFileSync(path, out);
  return path;
}

/** A project root holding just the package.json the guard reads. */
function fakeRoot(version: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "rungate-relroot-"));
  scratch.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "rungate", version }));
  return dir;
}

/** A file:// registry stub, so no case below touches the network. */
function fakeRegistry(packument: unknown | null): string {
  const dir = mkdtempSync(join(tmpdir(), "rungate-relreg-"));
  scratch.push(dir);
  if (packument !== null) writeFileSync(join(dir, "rungate"), JSON.stringify(packument));
  return `file://${dir}`;
}

function run(script: string, args: string[]) {
  const r = spawnSync("bun", [script, ...args], { encoding: "utf-8", timeout: 120_000 });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("#364 SC-831: every refusal travels through one exit code", () => {
  const CASES: Array<[string, string[], string]> = [
    ["no phase", ["--phase", "sideways"], "--phase must be"],
    ["an unreadable package.json", ["--phase", "preflight", "--root", "/nope/nope"],
      "could not read package.json"],
  ];

  for (const [name, args, expected] of CASES) {
    test(`refuses ${name}, and the mutant does not`, () => {
      const real = run(SCRIPT, args);
      expect(real.code, `the real script allowed ${name}`).not.toBe(0);
      expect(real.out).toContain(expected);

      const mutant = run(mutantScript(), args);
      expect(mutant.code, "zeroing REFUSE_EXIT changed nothing — the refusal has another path")
        .toBe(0);
      expect(mutant.out, "the mutant took a different branch entirely").toContain(expected);
    }, 180_000);
  }

  test("refuses a duplicate version against a stubbed registry, and the mutant does not", () => {
    const args = [
      "--phase", "preflight",
      "--root", fakeRoot("0.2.1"),
      "--registry", fakeRegistry({ versions: { "0.2.0": {}, "0.2.1": {} }, "dist-tags": { latest: "0.2.1" } }),
    ];
    const real = run(SCRIPT, args);
    expect(real.code, "the duplicate publish was allowed").not.toBe(0);
    expect(real.out).toContain("already on the registry");
    expect(run(mutantScript(), args).code).toBe(0);
  }, 180_000);

  test("refuses a publish that never landed, and the mutant does not", () => {
    const args = [
      "--phase", "postflight",
      "--root", fakeRoot("0.2.2"),
      "--registry", fakeRegistry({ versions: { "0.2.1": {} }, "dist-tags": { latest: "0.2.1" } }),
    ];
    const real = run(SCRIPT, args);
    expect(real.code, "a skipped publish reported success").not.toBe(0);
    expect(real.out).toContain("did not take effect");
    expect(run(mutantScript(), args).code).toBe(0);
  }, 180_000);

  test("allows a real release in both phases", () => {
    const root = fakeRoot("0.3.0");
    const before = fakeRegistry({ versions: { "0.2.1": {} }, "dist-tags": { latest: "0.2.1" } });
    const after = fakeRegistry({ versions: { "0.2.1": {}, "0.3.0": {} }, "dist-tags": { latest: "0.3.0" } });

    const pre = run(SCRIPT, ["--phase", "preflight", "--root", root, "--registry", before]);
    expect(pre.code, pre.out).toBe(0);
    expect(pre.out).toContain("preflight OK");

    const post = run(SCRIPT, ["--phase", "postflight", "--root", root, "--registry", after]);
    expect(post.code, post.out).toBe(0);
    expect(post.out).toContain("postflight OK");
  }, 180_000);

  test("an unreachable registry refuses rather than reporting a clean reading", () => {
    const args = [
      "--phase", "preflight",
      "--root", fakeRoot("0.2.1"),
      "--registry", fakeRegistry(null), // the packument file is absent
    ];
    const real = run(SCRIPT, args);
    expect(real.code, "a release gate that could not look reported no problems").not.toBe(0);
    expect(real.out).toContain("could not read the registry");
  }, 180_000);

  test("the mutant builder aborts rather than passing quietly when its target moves", () => {
    // The property that makes every assertion above mean something. A harness
    // that silently no-ops when the constant is renamed is the decorative
    // check this whole rule is about.
    const original = readFileSync(SCRIPT, "utf-8");
    expect(original.split("export const REFUSE_EXIT = 1;").length - 1,
      "the exit constant must appear exactly once, or a refusal could bypass the mutation",
    ).toBe(1);
    expect(/process\.exit\((?!REFUSE_EXIT)/.test(original),
      "a literal process.exit() would slip past the mutation",
    ).toBe(false);
  });
});

/**
 * The workflow's executable content, with YAML comments removed.
 *
 * Every check below is about what the job DOES, and a comment is not a step.
 * Four of them shipped red on the first run for exactly that reason: the
 * header comment says "do not add `continue-on-error`" and "do not guard
 * `npm publish` behind a condition", so the detectors found their own
 * documentation and reported the thing it warns against.
 *
 * `.claude/rules/checks-must-be-able-to-fail.md` is wary of this — "a
 * detector that first strips comments is a detector whose view of the input
 * can silently shrink" — and the mitigation it asks for is to assert the
 * boundary rather than to trust it. `the comment stripper keeps steps and
 * drops prose` below is that assertion, in both directions.
 */
export function workflowSteps(src: string): string {
  return src
    .split("\n")
    .filter(line => !/^\s*#/.test(line))
    .map(line => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

describe("#364 SC-832: the pipeline cannot report a release it did not make", () => {
  const wf = () => workflowSteps(readFileSync(WORKFLOW, "utf-8"));
  const stepIndex = (src: string, needle: string) => src.indexOf(needle);

  test("the comment stripper keeps steps and drops prose", () => {
    // The direction that matters: a real step must still be seen.
    expect(workflowSteps("jobs:\n  a:\n    steps:\n      - run: npm publish\n"))
      .toContain("npm publish");
    expect(workflowSteps("      - run: x\n        continue-on-error: true\n"))
      .toContain("continue-on-error");
    // ...and the direction that caused the false positives.
    expect(workflowSteps("# do not add continue-on-error\n- run: x\n"))
      .not.toContain("continue-on-error");
    expect(workflowSteps("  id-token: write # npm provenance\n")).not.toContain("provenance");
    expect(workflowSteps("  id-token: write # npm provenance\n")).toContain("id-token: write");
  });

  test("the workflow exists and fires on version tags", () => {
    expect(wf()).toMatch(/on:\s*\n\s*push:\s*\n\s*tags:\s*\n\s*-\s*"v\*"/);
  });

  test("both guard phases are invoked, in the only order that works", () => {
    const src = wf();
    const pre = stepIndex(src, "--phase preflight");
    const publish = stepIndex(src, "npm publish");
    const post = stepIndex(src, "--phase postflight");
    expect(pre, "nothing calls the preflight guard").toBeGreaterThan(-1);
    expect(publish, "the workflow never publishes").toBeGreaterThan(-1);
    expect(post, "nothing calls the postflight guard").toBeGreaterThan(-1);
    expect(pre, "preflight runs after the publish it is supposed to gate").toBeLessThan(publish);
    expect(post, "postflight runs before the publish it is supposed to confirm")
      .toBeGreaterThan(publish);
  });

  test("the suite runs before the artifact ships", () => {
    const src = wf();
    expect(stepIndex(src, "\n      - run: bun test"),
      "the published artifact is never tested",
    ).toBeGreaterThan(-1);
    expect(stepIndex(src, "\n      - run: bun test")).toBeLessThan(stepIndex(src, "npm publish"));
  });

  test("the comparison base the ratchets need is fetched before the suite runs", () => {
    /**
     * The v0.3.0 release job failed here, and the guards were right.
     *
     * This workflow checks out a TAG. A tag checkout is shallow and carries
     * no branches, so `origin/main` does not exist in it — and two checks in
     * the suite measure against that ref: the conformity allowlist ratchet
     * (#302) and the project-state currency check. Both refuse an unreadable
     * base rather than reading it as clean, which is exactly right and is
     * why the release stopped instead of shipping on an unmeasured ratchet.
     *
     * Asserted rather than left to the comment that explains it, because the
     * failure mode is silent in the direction that matters: delete the fetch
     * and the next release fails at `bun test` with two refusals that read
     * as a code defect rather than a missing ref, which is how half an hour
     * goes into the wrong file.
     */
    const src = wf();
    const fetch = stepIndex(src, "refs/heads/main:refs/remotes/origin/main");
    // No comma in this message on purpose: it is SC-1415's assertion token,
    // and the conformity parser splits a token list on commas.
    expect(fetch, "nothing fetches origin/main so the ratchets cannot read their base")
      .toBeGreaterThan(-1);
    expect(fetch, "the base is fetched after the suite that needs it")
      .toBeLessThan(stepIndex(src, "\n      - run: bun test"));
  });

  test("the release does not tolerate a failed fetch the way CI does", () => {
    // ci.yml appends `|| echo WARN` to the same fetch, and that is right
    // there: a PR that cannot reach main should report UNMEASURED and move
    // on. A release is irreversible, so "could not measure" has to stop the
    // pipeline where it happened rather than three steps later. Without
    // this, copying CI's line over would reintroduce a fail-open into the
    // one pipeline that cannot afford one.
    const line = wf()
      .split("\n")
      .find(l => l.includes("refs/remotes/origin/main"));
    expect(line, "the fetch step vanished").toBeDefined();
    expect(line, "the release tolerates an unfetchable base").not.toContain("||");
  });

  test("no step may swallow its own failure", () => {
    // The named failure mode, as a check. `continue-on-error` on the publish
    // step or on either guard turns this file back into a job that reports a
    // release it never made.
    expect(wf()).not.toContain("continue-on-error");
  });

  test("the publish step is not behind a condition", () => {
    // A `if:` that stopped matching is the quietest way for this pipeline to
    // do nothing: the job is green and the tag exists. Postflight would catch
    // it, but it should not be reachable in the first place.
    const src = wf();
    const publishStep = src.slice(src.indexOf("- name: Publish"), src.indexOf("- name: Postflight"));
    expect(publishStep, "the publish step is conditional").not.toMatch(/^\s+if:/m);
  });

  test("the guard is not pointed somewhere other than npm", () => {
    // `--registry` exists for the tests above. If the workflow ever passes
    // it, the release gate is measuring a registry nobody installs from.
    expect(wf(), "the release guard was redirected away from npm").not.toContain("--registry");
  });

  test("every action is pinned to a commit SHA, not a movable tag", () => {
    // This job holds NPM_TOKEN and `id-token: write`. A tag is the action
    // publisher's to repoint at any time, so `@v2` in a credential-bearing
    // job is a supply-chain path to both. Scoping the token to the publish
    // step does not help — an earlier step shares the workspace and can
    // poison what the later one runs.
    const uses = wf().split("\n").filter(l => /^\s*-?\s*uses:/.test(l));
    expect(uses.length, "the workflow uses no actions at all").toBeGreaterThan(0);
    for (const line of uses) {
      const ref = line.split("uses:")[1].trim();
      expect(ref, `not pinned to a SHA: ${ref}`).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  test("provenance is actually requested, and permitted", () => {
    expect(wf()).toContain("--provenance");
    expect(wf(), "npm provenance needs id-token: write or the publish fails")
      .toMatch(/id-token:\s*write/);
  });

  test("the tag never reaches a shell as interpolated text", () => {
    // A tag name is attacker-shaped: git permits quotes and semicolons in
    // one. `${{ github.ref_name }}` inside a run: script is the workflow
    // injection GitHub's own guidance opens with.
    // Every `${{ github.* }}` in the file must be an `env:` assignment. A
    // run: line, or a line inside a `run: |` block, does not match the
    // assignment shape and is therefore caught.
    const ENV_ASSIGNMENT = /^\s*[A-Za-z_][A-Za-z0-9_]*:\s*\$\{\{\s*github\.[A-Za-z_.]+\s*\}\}\s*$/;
    const uses = wf().split("\n").filter(l => l.includes("${{ github."));
    expect(uses.length, "the tag is never read at all").toBeGreaterThan(0);
    for (const line of uses) {
      expect(ENV_ASSIGNMENT.test(line), `a github context reaches a shell: ${line.trim()}`)
        .toBe(true);
    }
    expect(wf(), "the tag should arrive through env:")
      .toMatch(/RELEASE_TAG:\s*\$\{\{\s*github\.ref_name\s*\}\}/);
  });

  test("the scaffold does not own this file, so it survives a re-scaffold", () => {
    // createCiWorkflows regenerates ci.yml and gates.yml BY NAME. If that
    // ever becomes a directory-wide write, this file disappears and the
    // release pipeline goes with it.
    const steps = readFileSync(join(ROOT, "lib", "scaffold", "steps.ts"), "utf-8");
    expect(steps).toContain(`[["ci.yml", ciYml], ["gates.yml", gatesYml]] as const`);
    expect(steps, "the scaffold writes release.yml — it is no longer caller-owned")
      .not.toContain("release.yml");
  });
});
