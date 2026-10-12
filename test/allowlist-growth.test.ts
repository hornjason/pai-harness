/**
 * #302 — the conformity allowlist ratchet enforced staleness but not growth.
 *
 * `.claude/conformity-allowlists.json` describes itself as "a RATCHET, not a
 * mute: adding an entry that is not a real current violation fails, and an
 * entry that stops being a violation must be removed or the build fails."
 * Half of that was true. Staleness is enforced — `runSpecDrift` and the
 * orphan check both refuse an entry that no longer names a violation. Growth
 * was not: a new entry for a genuinely new violation is not stale, so every
 * check passed and the build stayed green.
 *
 * So an agent could introduce a conformity violation and exempt it in the
 * same commit. That is the single move this harness exists to prevent — an
 * agent must not be able to pass a gate by editing the gate
 * (.claude/rules/checks-must-be-able-to-fail.md, pointed at itself).
 *
 * ## Why the live check lives here and not in lib/
 *
 * `allowlistAdditions` is exported from lib/conformity.ts so a consumer can
 * adopt it, but the GIT COMPARISON is wired here, in rungate's own suite,
 * rather than into the generated consumer test. A consumer may have no
 * `origin/main` — a fresh scaffold, a local-only repo — and a check that
 * refuses for want of a comparison base would break every one of them on
 * upgrade for a rule they never opted into. That is the same reasoning
 * `loadConformityAllowlists` already applies to a missing allowlist file.
 *
 * In THIS repo `origin/main` always exists, so an unreadable base is a fault
 * and is refused rather than passed — UNMEASURED is not PASS.
 *
 * Covers SC-711, SC-712, SC-713 of CONFIG-DRIVEN-TESTING-SPEC.md.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { allowlistAdditions, allowlistEntries } from "../lib/conformity";
import { stripJsComments } from "../lib/strip-js-comments";

const ROOT = join(import.meta.dir, "..");
const ALLOWLIST_REL = ".claude/conformity-allowlists.json";

const BASE_REF = "origin/main";

function baseCopy(ref: string = BASE_REF): { ok: boolean; json: string; why: string } {
  const show = spawnSync("git", ["-C", ROOT, "show", `${ref}:${ALLOWLIST_REL}`], {
    encoding: "utf-8",
    timeout: 20_000,
  });
  if (show.error) return { ok: false, json: "", why: `git could not run: ${show.error.message}` };
  if (show.status !== 0) {
    return { ok: false, json: "", why: `git show ${ref}:${ALLOWLIST_REL} exited ${show.status}` };
  }
  return { ok: true, json: show.stdout, why: "" };
}

describe("#302: allowlistAdditions reports growth and only growth", () => {
  const base = JSON.stringify({
    untestedSpecs: ["a.md", "b.md"],
    orphanFiles: ["scripts/x.sh"],
  });

  test("an unchanged file has no additions", () => {
    expect(allowlistAdditions(base, base)).toEqual([]);
  });

  test("a REMOVED entry is not growth — the legitimate direction always passes", () => {
    // The case #296 was filed for: an agent fixes a violation and delists it.
    // A check that refused this would trade one outage for another.
    const head = JSON.stringify({ untestedSpecs: ["a.md"], orphanFiles: ["scripts/x.sh"] });
    expect(allowlistAdditions(base, head)).toEqual([]);
  });

  test("an ADDED entry is reported, and named", () => {
    const head = JSON.stringify({
      untestedSpecs: ["a.md", "b.md", "SNEAKY-SPEC.md"],
      orphanFiles: ["scripts/x.sh"],
    });
    const added = allowlistAdditions(base, head);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain("SNEAKY-SPEC.md");
    expect(added[0], "the failure does not say which list grew").toContain("untestedSpecs");
  });

  test("adding to one list and removing from another reports only the addition", () => {
    const head = JSON.stringify({
      untestedSpecs: ["a.md"],
      orphanFiles: ["scripts/x.sh", "scripts/new.sh"],
    });
    expect(allowlistAdditions(base, head)).toEqual(["orphanFiles: scripts/new.sh"]);
  });

  test("a brand-new list is growth in full, not an unwatched corner", () => {
    // A list added later must be covered the day it appears. The opposite
    // arrangement is how an exemption mechanism grows a blind spot.
    const head = JSON.stringify({
      untestedSpecs: ["a.md", "b.md"],
      orphanFiles: ["scripts/x.sh"],
      someNewExemptionList: ["p", "q"],
    });
    expect(allowlistAdditions(base, head).sort()).toEqual([
      "someNewExemptionList: p",
      "someNewExemptionList: q",
    ]);
  });

  test("reordering is not growth", () => {
    const head = JSON.stringify({
      untestedSpecs: ["b.md", "a.md"],
      orphanFiles: ["scripts/x.sh"],
    });
    expect(allowlistAdditions(base, head)).toEqual([]);
  });

  test("prose keys are ignored — only array values are exemption lists", () => {
    const head = JSON.stringify({
      _comment: "a different explanation entirely",
      untestedSpecs: ["a.md", "b.md"],
      orphanFiles: ["scripts/x.sh"],
    });
    expect(allowlistAdditions(base, head)).toEqual([]);
  });

  test("allowlistEntries reads every array key, not a hardcoded pair", () => {
    const lists = allowlistEntries(
      JSON.stringify({ _note: "x", untestedSpecs: ["a"], orphanFiles: [], futureList: ["z"] }),
    );
    expect(Object.keys(lists).sort()).toEqual(["futureList", "orphanFiles", "untestedSpecs"]);
  });
});

describe("#302: CI is given the comparison base the ratchet needs", () => {
  // The check was correct and CI could not run it: `actions/checkout` fetches
  // one commit and no remote-tracking ref, so `git show origin/main:…` exited
  // 128 and DRIFT-3 reported UNMEASURED on every run. The environment was
  // wrong, not the assertion, so the fix is to supply the base rather than to
  // relax the check.
  const FETCH_STEP = /git fetch --no-tags --depth=1 origin '\+refs\/heads\/\S+:refs\/remotes\/origin\/[^']+'/;

  test("the scaffold generator emits a base-ref fetch step", () => {
    // Fix the source, not the output: the workflow file is harness-managed
    // and regenerated, so a hand-edit there would be wiped.
    const generator = readFileSync(join(ROOT, "lib/scaffold/steps.ts"), "utf-8");
    expect(generator).toMatch(FETCH_STEP);
  });

  test("it fetches ONE commit, not the whole history", () => {
    // The full-history alternative would also work and costs every consumer a
    // full clone for a single file read.
    //
    // Comments stripped first: the generator's own comment explains why that
    // alternative was rejected, and names it. A detector reading raw source
    // reports the defect the comment says was avoided — this test failed
    // exactly that way on its first run.
    const generator = stripJsComments(readFileSync(join(ROOT, "lib/scaffold/steps.ts"), "utf-8"));
    expect(generator).not.toMatch(/fetch-depth:\s*0/);
  });

  test("a failed fetch prints rather than being swallowed", () => {
    // `|| true` would keep CI green and leave the ratchet unmeasured with no
    // trace. Non-fatal is right; silent is not.
    const generator = stripJsComments(readFileSync(join(ROOT, "lib/scaffold/steps.ts"), "utf-8"));
    expect(generator).toMatch(/\|\|\s*echo "WARN: could not fetch/);
    expect(generator, "the fetch failure is swallowed").not.toMatch(/git fetch[^\n]*\|\|\s*true/);
  });

  test("the branch name is validated AND quoted, not one or the other", () => {
    // It reaches a shell command. The charset excludes every shell
    // metacharacter and both quote marks, which is what makes the
    // single-quoted refspec safe — two defences chosen to agree, rather than
    // a validator that admits something its consumer treats differently.
    const generator = stripJsComments(readFileSync(join(ROOT, "lib/scaffold/steps.ts"), "utf-8"));
    expect(generator).toMatch(/SAFE_BRANCH\s*=\s*\/\^\[A-Za-z0-9\]/);
    expect(generator).toMatch(/SAFE_BRANCH\.test\(baseBranch\)/);
    expect(generator, "a traversal segment would reach the refspec").toMatch(/baseBranch\.includes\("\.\."\)/);
  });

  test("the committed workflow carries it too — re-scaffold does not rewrite existing files (#208)", () => {
    // Fixing the generator is necessary and not sufficient while safeWrite
    // skips files that already exist. Without this the two drift and CI
    // silently stops measuring again.
    const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf-8");
    expect(workflow).toMatch(FETCH_STEP);
  });
});

describe("#302: this repo's allowlist has not grown against origin/main", () => {
  test("the comparison base is readable — UNMEASURED is not PASS", () => {
    const b = baseCopy();
    expect(
      b.ok,
      `the allowlist growth check could not read its base (${b.why}). This is UNMEASURED, ` +
        `not PASS: without a base, growth is invisible and the ratchet is decorative.`,
    ).toBe(true);
  });

  test("an unreadable base is reported as unreadable, not as an empty one", () => {
    // The refusal above only runs when the base IS unreadable, which never
    // happens in a healthy checkout — so without this it is a branch that
    // has never executed, the first shape in checks-must-be-able-to-fail.md.
    // Driven here against a ref that cannot exist.
    const b = baseCopy("refs/heads/no-such-ref-2d41f0");
    expect(b.ok).toBe(false);
    expect(b.why, "the refusal says nothing about why it could not measure").not.toBe("");
    // The dangerous shape is an unreadable base masquerading as an empty
    // allowlist: every head entry would then read as an addition, or worse,
    // an empty head would read as clean. It must not return parseable JSON.
    expect(b.json).toBe("");
  });

  test("the base parses and is non-empty, so an empty comparison cannot read as clean", () => {
    const b = baseCopy();
    if (!b.ok) return; // the case above already failed; do not double-report
    const lists = allowlistEntries(b.json);
    expect(Object.keys(lists).length).toBeGreaterThan(0);
    expect(Object.values(lists).flat().length).toBeGreaterThan(0);
  });

  test("no exemption was added relative to origin/main", () => {
    const b = baseCopy();
    if (!b.ok) return;
    const head = readFileSync(join(ROOT, ALLOWLIST_REL), "utf-8");

    const added = allowlistAdditions(b.json, head);
    expect(
      added,
      `an exemption was ADDED relative to ${BASE_REF}. A violation introduced and exempted in ` +
        `the same change is the move this ratchet exists to refuse. Fix the violation, or make ` +
        `the exemption a deliberate recorded decision rather than a diff.`,
    ).toEqual([]);
  });

  test("the live check would catch an addition — planted control", () => {
    // The three assertions above are absence claims against the real file,
    // and they pass trivially while the file is unchanged. This plants the
    // exact move the issue describes and requires the same function to
    // refuse it, so a green run means "nothing was added", not "nothing was
    // looked at".
    const b = baseCopy();
    if (!b.ok) return;
    const head = readFileSync(join(ROOT, ALLOWLIST_REL), "utf-8");
    const parsed = JSON.parse(head);
    parsed.untestedSpecs = [...(parsed.untestedSpecs ?? []), "PLANTED-VIOLATION-SPEC.md"];

    const added = allowlistAdditions(b.json, JSON.stringify(parsed));
    expect(added).toContain("untestedSpecs: PLANTED-VIOLATION-SPEC.md");
  });

  test("the removal this repo actually made still passes — measured, not hypothetical", () => {
    // #310 delisted CONFIG-DIRECTORY-STRUCTURE-SPEC.md once a test began
    // referencing it. Removals must never refuse, and this is a real one.
    const b = baseCopy();
    if (!b.ok) return;
    const head = readFileSync(join(ROOT, ALLOWLIST_REL), "utf-8");
    const parsed = JSON.parse(head);
    parsed.untestedSpecs = (parsed.untestedSpecs ?? []).slice(1);

    expect(allowlistAdditions(b.json, JSON.stringify(parsed))).toEqual([]);
  });
});
