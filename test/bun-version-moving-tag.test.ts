/**
 * #932: the generator writes a value `contract-parity` then refuses.
 *
 * `isPinnedBunVersion` is this repository's definition of "a value that names
 * the same runtime tomorrow", and #622 left it with exactly one consumer —
 * `scripts/contract-parity.ts`, the CHECKER. `setupBunWith`, the GENERATOR,
 * never asked. So a consumer declaring `ci.bunVersion: "latest"` had an
 * unpinned runtime written into a managed workflow under a comment reading
 * *"From ci.bunVersion … Add one and re-scaffold"* — prose that describes a
 * successful declaration — and the only way to find out was to run the
 * checker, which then called that same line a violation.
 *
 * One predicate, two positions, opposite behaviour.
 *
 * ## The rung ordering this corrects
 *
 * Before: a project declaring NOTHING got the loud `UNPINNED:` block, and a
 * project declaring `latest` got silence. Declaring a moving tag was reported
 * strictly worse than declaring nothing at all, which inverts the thing
 * `.claude/rules/config-access.md` is about — a declaration that does not pin
 * is a state, and a state nothing reports is one nobody fixes.
 *
 * ## What is deliberately NOT asserted
 *
 * That the emitted version CHANGES. `MOVING_BUN_TAGS`' own doc comment says
 * declaring one "is a legitimate thing for a consumer to choose", so the
 * value still reaches CI verbatim and AC-7's no-silent-substitution property
 * holds at both rungs. What changes is that the file says what it is. The
 * verbatim-emission cases below exist to keep a future fix from "helping" by
 * substituting a pin the operator never asked for.
 *
 * It cost a measured red: hornjason/agentgrit#318. Its PR #313 read 1 under
 * local bun 1.3.14 and 3 under CI's 1.4.3 on an identical commit, because
 * `ci.bunVersion: "latest"` resolved differently on the two days.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BUN_VERSION_FILE,
  MOVING_BUN_TAGS,
  bunVersionSourceLabel,
  declaredBunVersion,
  isPinnedBunVersion,
  setupBunWith,
} from "../lib/bun-version";
import { mergeManagedWorkflow } from "../lib/scaffold/managed-workflow";
import { createCiWorkflows } from "../lib/scaffold/steps";
import { toolchainParity } from "../scripts/contract-parity";

/** The marker the generator writes when what it emits is not a pin. */
const UNPINNED = "UNPINNED";

/** The two files `createCiWorkflows` writes that install bun. */
// #1013 added the third: `ai-review.yml` installs bun for the findings
// adjudicator, and it resolves the version from the same single declaration.
const GENERATED = ["ai-review.yml", "ci.yml", "gates.yml"] as const;

interface SetupBunStep {
  file: string;
  job: string;
  version: string | null;
  versionFile: string | null;
}

/**
 * Every `oven-sh/setup-bun` step under a generated workflow directory.
 *
 * Parsed rather than grepped, and with the same instrument check
 * `test/bun-version-agreement.test.ts` uses: a parse that silently stopped
 * seeing steps reads exactly like a directory with nothing to find, which is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s third shape and the way
 * every case in this file would die at once.
 */
function setupBunStepsUnder(dir: string): SetupBunStep[] {
  const files = readdirSync(dir).filter(f => f.endsWith(".yml")).sort();
  if (files.length === 0) throw new Error(`${dir} holds no workflow files`);
  const found: SetupBunStep[] = [];
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf-8");
    const doc = Bun.YAML.parse(text) as any;
    const jobs = doc?.jobs;
    if (!jobs || typeof jobs !== "object") throw new Error(`${file} has no jobs: block`);
    let seen = 0;
    for (const [job, body] of Object.entries<any>(jobs)) {
      for (const step of (body?.steps ?? []) as any[]) {
        if (typeof step?.uses !== "string" || !step.uses.startsWith("oven-sh/setup-bun@")) continue;
        seen++;
        const w = (step.with ?? {}) as Record<string, unknown>;
        found.push({
          file,
          job,
          version: w["bun-version"] === undefined ? null : String(w["bun-version"]),
          versionFile: w["bun-version-file"] === undefined ? null : String(w["bun-version-file"]),
        });
      }
    }
    const raw = (text.match(/oven-sh\/setup-bun@/g) ?? []).length;
    if (raw !== seen) throw new Error(`${file} names setup-bun ${raw} time(s), the parse found ${seen}`);
  }
  if (found.length === 0) throw new Error(`no workflow under ${dir} installs bun`);
  return found;
}

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rungate-bun-moving-tag-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let fixtureSeq = 0;
/** A scaffolded project declaring bun through one rung, or neither. */
function fixture(opts: { file?: string; configVersion?: string }): string {
  const root = join(dir, `p${fixtureSeq++}`);
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "rungate", "config.json"),
    JSON.stringify(
      {
        project: "moving-tag-fixture",
        ci: {
          runner: "ubuntu-latest",
          branches: ["main"],
          ...(opts.configVersion ? { bunVersion: opts.configVersion } : {}),
        },
      },
      null,
      2,
    ) + "\n",
  );
  if (opts.file) writeFileSync(join(root, BUN_VERSION_FILE), `${opts.file}\n`);
  createCiWorkflows(root, []);
  return root;
}

const generatedText = (root: string, file: string) =>
  readFileSync(join(root, ".github", "workflows", file), "utf-8");

// ── the defect ──────────────────────────────────────────────────────────────

describe("#932: a declared moving tag is emitted as UNPINNED at every rung", () => {
  test("the fixture generator produces steps to read at all", () => {
    // The coverage assertion, first and on its own. Every case below reads
    // generated workflows, and all of them pass against a generator that
    // emitted no bun step whatsoever.
    const steps = setupBunStepsUnder(join(fixture({ configVersion: "1.2.0" }), ".github", "workflows"));
    expect(steps.length, "the generated workflows that install bun").toBe(GENERATED.length);
    expect([...new Set(steps.map(s => s.file))].sort()).toEqual([...GENERATED].sort());
  });

  test("ci.bunVersion naming a moving tag is emitted with the warning, not as a declaration", () => {
    for (const tag of MOVING_BUN_TAGS) {
      const root = fixture({ configVersion: tag });
      expect(declaredBunVersion(root).source, tag).toBe("config");
      for (const file of GENERATED) {
        const text = generatedText(root, file);
        expect(text, `${file} is silent about the moving tag ${tag} in ci.bunVersion`).toContain(UNPINNED);
        expect(text, `${file} does not name the tag it is warning about`).toContain(tag);
      }
    }
  });

  test("a .bun-version holding a moving tag is not described as a pin", () => {
    // The rung the old code was most wrong about: it wrote "Pinned by
    // .bun-version — the project's single declaration", which for a file
    // reading `canary` is a flat statement of the opposite of the truth.
    for (const tag of MOVING_BUN_TAGS) {
      const root = fixture({ file: tag });
      expect(declaredBunVersion(root).source, tag).toBe("bun-version-file");
      for (const file of GENERATED) {
        const text = generatedText(root, file);
        expect(text, `${file} calls a ${tag} file a pin`).not.toContain("Pinned by");
        expect(text, `${file} is silent about the moving tag ${tag} in ${BUN_VERSION_FILE}`).toContain(UNPINNED);
      }
    }
  });

  test("the warning itself names which position declared the tag", () => {
    // A warning that cannot be acted on is a warning nobody acts on, and the
    // two rungs are fixed in two different files.
    //
    // Searched inside the UNPINNED block, not over the whole emission — which
    // is `.claude/rules/checks-must-be-able-to-fail.md`'s "search the slice,
    // not the document", and here it is the difference between a witness and
    // nothing at all. Measured: the pre-#932 comments contain BOTH labels in
    // their ordinary prose ("From ci.bunVersion in …", "Pinned by
    // .bun-version"), so a whole-emission assertion is green on the defective
    // source. The first draft of this case was, and the battery's M1 row —
    // 4 red where 6 was predicted — is how it was found.
    const warningOf = (root: string): string => {
      const emitted = setupBunWith(declaredBunVersion(root), "");
      const at = emitted.indexOf(`# ${UNPINNED}:`);
      // A slice that failed to find its own section is the empty string, and
      // an empty string contains nothing — indistinguishable from clean.
      expect(at, `no ${UNPINNED} block in:\n${emitted}`).toBeGreaterThan(-1);
      return emitted.slice(at);
    };
    expect(warningOf(fixture({ configVersion: "latest" }))).toContain(bunVersionSourceLabel("config"));
    expect(warningOf(fixture({ file: "latest" }))).toContain(bunVersionSourceLabel("bun-version-file"));
  });

  test("the declared tag still reaches CI verbatim at both rungs", () => {
    // AC-7 (#622) at this rung. The cheapest wrong fix for "the generator
    // emitted something unpinned" is for the generator to substitute a pin —
    // which silently changes a consumer's runtime, the one thing #622's
    // module comment rules out. These two assertions fail under that fix.
    const fromConfig = setupBunStepsUnder(join(fixture({ configVersion: "canary" }), ".github", "workflows"));
    for (const s of fromConfig) {
      expect(s.version, `${s.file} substituted a version of its own`).toBe("canary");
      expect(s.versionFile, `${s.file} invented a declaration file`).toBeNull();
    }
    // The file rung still points CI AT THE FILE: what is wrong there is the
    // prose, not the mechanism, and rewriting it to a literal would put a
    // second spelling of the version back into the workflow (#622's defect).
    const fromFile = setupBunStepsUnder(join(fixture({ file: "canary" }), ".github", "workflows"));
    for (const s of fromFile) {
      expect(s.versionFile, `${s.file} stopped reading ${BUN_VERSION_FILE}`).toBe(BUN_VERSION_FILE);
      expect(s.version, `${s.file} spelled a version beside the file it reads`).toBeNull();
    }
  });

  test("a real pin is NOT marked unpinned at either rung", () => {
    // The negative control. Without it the whole describe is satisfied by a
    // generator that stamps UNPINNED on every project it touches, which would
    // make the marker worthless the day after it shipped.
    // Deliberately not plain semver: the cheapest repair for "CI fails on a
    // bad pin" is a well-formedness guard with `|| "latest"` behind it, and a
    // `1.2.3`-shaped fixture would survive that repair and certify it (#622
    // AC-7).
    const PIN = "9999.0.0-no-such-bun";
    expect(isPinnedBunVersion(PIN)).toBe(true);

    const fromConfig = fixture({ configVersion: PIN });
    for (const file of GENERATED) {
      const text = generatedText(fromConfig, file);
      expect(text, `${file} called the pin ${PIN} unpinned`).not.toContain(UNPINNED);
      expect(text, `${file} stopped naming the declared version`).toContain(PIN);
    }

    // The file rung does NOT spell the version — that is #622, and asserting
    // the string here would demand the second position #622 removed. What it
    // keeps is its own provenance line, rather than losing it to the branch
    // added for the moving-tag case.
    const fromFile = fixture({ file: PIN });
    for (const file of GENERATED) {
      const text = generatedText(fromFile, file);
      expect(text, `${file} called the pin ${PIN} unpinned`).not.toContain(UNPINNED);
      expect(text, `${file} lost the provenance line for a pinned declaration`).toContain("Pinned by");
    }
    for (const s of setupBunStepsUnder(join(fromFile, ".github", "workflows"))) {
      expect(s.versionFile, `${s.file} stopped reading ${BUN_VERSION_FILE}`).toBe(BUN_VERSION_FILE);
    }
    expect(readFileSync(join(fromFile, BUN_VERSION_FILE), "utf-8").trim()).toBe(PIN);
  });
});

// ── the checker and the generator now agree ─────────────────────────────────

describe("#932: contract-parity does not count the emitted step as a pin when it is not one", () => {
  const EMITTED_SITE = "the step the scaffold would emit";

  test("the emitted step is reported as a violation, not banked as a pinned position", () => {
    const root = fixture({ configVersion: "latest" });
    // `running` is passed rather than read, so the case does not depend on the
    // machine: #622's AC-4 reason, applied to its own checker.
    const report = toolchainParity(root, "1.3.14");
    const banked = report.sites.filter(s => s.site.includes(EMITTED_SITE));
    expect(banked.length, "the emitted step was not examined at all").toBe(1);
    expect(
      report.violations.some(v => v.includes(EMITTED_SITE)),
      `no violation names the emitted step; violations were:\n${report.violations.join("\n")}`,
    ).toBe(true);
    expect(report.verdict).toBe("FAIL");
  });

  test("a pinned project's emitted step is still banked as a position, with no violation about it", () => {
    // The other direction. A fix that simply stopped reading the emitted step
    // would satisfy the case above and leave the category blind.
    const root = fixture({ configVersion: "9999.0.0-no-such-bun" });
    const report = toolchainParity(root, "9999.0.0-no-such-bun");
    const banked = report.sites.filter(s => s.site.includes(EMITTED_SITE));
    expect(banked.length).toBe(1);
    expect(banked[0].value).toBe("9999.0.0-no-such-bun");
    expect(
      report.violations.filter(v => v.includes(EMITTED_SITE)),
      "a pinned emission was reported as a violation",
    ).toEqual([]);
  });
});

// ── and it reaches a repo that was scaffolded before the fix ────────────────

describe("#932: the corrected step reaches an already-scaffolded consumer", () => {
  /**
   * The question `mergeManagedWorkflow` decides, and the reason it has to be
   * asserted rather than reasoned about: #917 made the merge keep the
   * CONSUMER's value for any top-level sub-key both sides declare. Under that
   * rule a generator improvement inside `jobs:` could plausibly be a no-op on
   * every repo already scaffolded — which is exactly the failure #839 was
   * filed about for `on:` and `permissions:`.
   *
   * It is not a no-op here, for a reason that is in the code rather than in
   * the shape of the merge: `HARNESS_OWNED_JOBS` names `test` and `gates`, so
   * those two job bodies come from the generated side whole, bun step
   * included. Both directions are asserted below, because "the merge takes the
   * generated file" and "the merge takes the generated file AND DROPS THE
   * CONSUMER'S WORK" are the same reading from one assertion.
   */
  const root = () => fixture({ configVersion: "latest" });

  test("the warning replaces the pre-fix step inside a harness-owned job", () => {
    const generated = generatedText(root(), "ci.yml");
    expect(generated, "the fixture is not exercising the new branch").toContain(UNPINNED);
    // The consumer's on-disk copy: the same file with the pre-#932 comment
    // block, spelled out because no generator in this tree emits it any more.
    const consumer = generated.replace(
      /^ +# UNPINNED:[\s\S]*?bun-version: "latest"$/m,
      '          # From ci.bunVersion in .claude/rungate/config.json — this project declares no\n' +
        '          # .bun-version. Add one and re-scaffold to let CI read the declaration directly.\n' +
        '          bun-version: "latest"',
    );
    expect(consumer, "the pre-fix text was not substituted, so this proves nothing").not.toContain(UNPINNED);

    const merged = mergeManagedWorkflow(consumer, generated);
    expect(merged, "the merge left the consumer's pre-fix bun step in place").toContain(UNPINNED);
    expect(merged).not.toContain("Add one and re-scaffold to let CI read the declaration directly");
  });

  test("the same merge still carries the consumer's own job and top-level key", () => {
    const generated = generatedText(root(), "ci.yml");
    const consumer =
      generated.replace(/\n$/, "") +
      "\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo consumer-owned\n" +
      "\nconcurrency:\n  group: consumer-group\n";
    const merged = mergeManagedWorkflow(consumer, generated);
    expect(merged, "a consumer-only job was dropped").toContain("echo consumer-owned");
    expect(merged, "a consumer-only top-level key was dropped").toContain("group: consumer-group");
    expect(merged, "the generated bun step did not survive beside the consumer's work").toContain(UNPINNED);
  });
});
