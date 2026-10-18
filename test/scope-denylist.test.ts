/**
 * Covers SC-1423, SC-1424, SC-1425, SC-1426 (HARNESS-STANDARD.md) — #306.
 *
 * #274 attempt 4 (`wf_b3714a40-bb7`). The goal said, under a heading in
 * capitals, "ALSO DO NOT FIX, ALREADY FILED: #295 … leave it there". The
 * `to-issues` decomposer emitted a sub-issue whose `filesToModify` was
 * `gates/schema.ts`, `lib/evidence-prevalidator.ts`, `gates/SCHEMA-GUIDE.md`
 * — the three files you would touch to fix #295. The agent did what its file
 * list permitted, and the run refused on its own contradiction: one sub-issue
 * documented the defect and removed it.
 *
 * ## The correction this suite is built around
 *
 * #306 proposes a deny-list on the premise that "the goal already names
 * them". **It does not.** The quoted prohibition names an issue (`#295`) and
 * three code symbols — `prevalidationViolations`, `reading.broken`,
 * `acs[].status`. Not one file path. The paths came from
 * `discovery.filesToModify`, which `workflows/ship.js` hands the decomposer
 * verbatim as "Files to modify".
 *
 * A deny-list built on the issue's premise would therefore have returned `[]`
 * for the exact run that motivated it, and passed. That is the decorative
 * check `.claude/rules/checks-must-be-able-to-fail.md` is about, shipped as
 * its own remedy, so #274's real goal text is the first fixture in this file
 * and it is asserted to be UNENFORCEABLE rather than clean.
 *
 * ## Why a parity matrix
 *
 * ship.js runs in a sandbox with no imports, so the decision exists twice —
 * `lib/scope-denylist.ts` and a marked block in the workflow. The #169 /
 * #244 / #171 pattern applies: extract the inlined copy by marker, run both
 * over one shared matrix, and make drift red. `computeACHash`'s extracted
 * function had never matched its inlined copy, because nothing compared them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  deniedFiles,
  denylistViolations,
  matchesDenied,
  normalisePath,
  pathsNamedIn,
  prohibitions,
  scopeContradiction,
  unresolvedProhibitions,
  withoutDenied,
} from "../lib/scope-denylist";

const REPO = join(import.meta.dir, "..");
const SHIP = join(REPO, "workflows", "ship.js");
const shipSource = readFileSync(SHIP, "utf-8");

const BLOCK_START = "// ──── SCOPE-DENYLIST-START ────";
const BLOCK_END = "// ──── SCOPE-DENYLIST-END ────";

/**
 * Module scope on purpose. If the markers are gone, this throws and every
 * test in the file fails to load — rather than skipping, which would turn
 * "ship.js lost its deny-list" into a quiet green.
 */
const inlined = (() => {
  const start = shipSource.indexOf(BLOCK_START);
  const end = shipSource.indexOf(BLOCK_END);
  if (start === -1 || end === -1) {
    throw new Error(`ship.js is missing the ${BLOCK_START} / ${BLOCK_END} markers`);
  }
  const body = shipSource.slice(start + BLOCK_START.length, end);
  const fns = new Function(
    `${body}\nreturn { pathsNamedIn, prohibitions, deniedFiles, unresolvedProhibitions, normalisePath, matchesDenied, scopeContradiction, denylistViolations, withoutDenied }`,
  )();
  for (const name of Object.keys(fns)) {
    if (typeof fns[name] !== "function") {
      throw new Error(`ship.js's deny-list block does not define ${name} — the matrix would compare nothing`);
    }
  }
  return fns as {
    pathsNamedIn: typeof pathsNamedIn;
    prohibitions: typeof prohibitions;
    deniedFiles: typeof deniedFiles;
    unresolvedProhibitions: typeof unresolvedProhibitions;
    normalisePath: typeof normalisePath;
    matchesDenied: typeof matchesDenied;
    scopeContradiction: typeof scopeContradiction;
    denylistViolations: typeof denylistViolations;
    withoutDenied: typeof withoutDenied;
  };
})();

/** #274's prohibition, verbatim from the goal that produced the defect. */
const GOAL_274 = `Fix the pre-validation reading so the scope gate refuses a run whose AC evidence cannot succeed.

**ALSO DO NOT FIX, ALREADY FILED:** #295 (\`prevalidationViolations\` reads a top-level \`reading.broken\` that no writer produces; schema records broken ACs at \`acs[].status\`). A fix for it already exists on branch \`worktree-wf_536df065-969-10\` — leave it there.

Read specs/HARNESS-STANDARD.md before starting.`;

/** The same prohibition, written the way #306's option (3) recommends. */
const GOAL_274_WITH_FILES = GOAL_274.replace(
  "leave it there.",
  "leave it there. Do not touch gates/schema.ts, lib/evidence-prevalidator.ts or gates/SCHEMA-GUIDE.md.",
);

describe("SC-1423: a prohibition that names no file is reported, not counted as clean", () => {
  test("#274's real goal denies nothing - and says so", () => {
    // The whole correction, in one case. The issue's premise was that this
    // goal named the files; it named an issue and three code symbols.
    expect(deniedFiles(GOAL_274), "a path was conjured out of prose").toEqual([]);

    const unresolved = unresolvedProhibitions(GOAL_274);
    expect(unresolved, "the unenforceable prohibition was silently dropped").toHaveLength(1);
    expect(unresolved[0].issues).toEqual(["#295"]);
    expect(unresolved[0].text).toContain("ALSO DO NOT FIX");
  });

  test("code expressions in the prohibition are not read as paths", () => {
    // `reading.broken` and `acs[].status` are dotted and look path-ish. A
    // detector that read them as files would deny files nobody named, and a
    // guard that fails correct work gets deleted within a week.
    //
    // MEASURED: it is the EXTENSION that excludes these, not the separator.
    // The first draft of the detector required a `/` and said so in a
    // comment; mutating that `+` to `*` scored ZERO red against this case,
    // because `.broken`, `.status` and `.0` are not extensions and never
    // reached the separator. The `/` is optional now — see the root-level
    // case below for what requiring it was quietly costing.
    expect(pathsNamedIn("`reading.broken` and `acs[].status` and `0.3.0`")).toEqual([]);
    expect(pathsNamedIn("branch `worktree-wf_536df065-969-10`")).toEqual([]);
    expect(pathsNamedIn("bump to 1.2.3 and see PR #408")).toEqual([]);
  });

  test("a root-level file named with no directory is still a path", () => {
    // What requiring the separator cost, and the reason the mutation above
    // could score zero while the rule was still wrong: a goal saying "do not
    // touch package.json" named a real file and the detector saw nothing.
    expect(pathsNamedIn("do not touch package.json")).toEqual(["package.json"]);
    expect(deniedFiles("DO NOT TOUCH AGENTS.md or CODE-MAP.md").sort())
      .toEqual(["AGENTS.md", "CODE-MAP.md"]);
  });

  test("a bare denied filename reaches the file wherever the plan puts it", () => {
    // The other half of the same decision. An exact-match-only rule would
    // make the common phrasing above parse correctly and then match nothing,
    // which is this issue's defect one level down.
    expect(matchesDenied("specs/HARNESS-STANDARD.md", "HARNESS-STANDARD.md")).toBe(true);
    expect(matchesDenied("package.json", "package.json")).toBe(true);
    expect(withoutDenied(["a/package.json", "lib/x.ts"], ["package.json"])).toEqual(["lib/x.ts"]);
  });

  test("a denied PATH still matches only itself", () => {
    // The positive control for the rule above. Basename matching applied to a
    // full path would read `test/gates/schema.ts` as `gates/schema.ts`.
    expect(matchesDenied("test/gates/schema.ts", "gates/schema.ts")).toBe(false);
    expect(matchesDenied("gates/schema.ts", "gates/schema.ts")).toBe(true);
    // And a bare name must not match a longer name that merely ends the same.
    expect(matchesDenied("lib/my-package.json", "package.json")).toBe(false);
  });

  test("a goal with no prohibition at all yields no unresolved note", () => {
    // The positive control. A function that reported every goal unenforceable
    // would satisfy the first case and make the log useless.
    expect(unresolvedProhibitions("Fix the thing. Read the spec.")).toEqual([]);
    expect(prohibitions("Fix the thing. Read the spec.")).toEqual([]);
  });

  test("a prohibition that DOES name files is enforceable, not unresolved", () => {
    // The other positive control, and the pair that makes the first case mean
    // something: same goal, same marker, files added, outcome flips.
    expect(deniedFiles(GOAL_274_WITH_FILES).sort()).toEqual([
      "gates/SCHEMA-GUIDE.md",
      "gates/schema.ts",
      "lib/evidence-prevalidator.ts",
    ]);
    expect(unresolvedProhibitions(GOAL_274_WITH_FILES)).toEqual([]);
  });
});

describe("SC-1424: the marked region is a paragraph - not a line and not the rest", () => {
  test("content after the marker line is still inside the prohibition", () => {
    // #274's prohibition is a bolded lead-in followed by two sentences. A
    // line-scoped reader sees the marker and stops before the content.
    const goal = "**DO NOT FIX:** the following.\nIt lives in lib/a.ts\nand also lib/b.ts";
    expect(deniedFiles(goal).sort()).toEqual(["lib/a.ts", "lib/b.ts"]);
  });

  test("a later paragraph is NOT swallowed by an earlier marker", () => {
    // Without the paragraph bound a marker near the top denies the whole goal,
    // including every file the run actually needs.
    const goal = "**DO NOT FIX:** lib/denied.ts\n\nNow implement the change in lib/wanted.ts";
    expect(deniedFiles(goal)).toEqual(["lib/denied.ts"]);
    expect(deniedFiles(goal), "the in-scope file was denied too").not.toContain("lib/wanted.ts");
  });

  test("scopeOut entries count in full, with no marker needed", () => {
    // The field exists to say what is out of scope. Until #306 nothing read
    // it: required by the discovery schema, appended to in one place,
    // consulted nowhere — its own small version of this bug.
    expect(deniedFiles("", ["the rewrite of lib/scanner.ts", "AC-3 — already satisfied"]))
      .toEqual(["lib/scanner.ts"]);
  });
});

describe("SC-1425: a plan claiming a denied file is refused - and in-scope work is not", () => {
  const SUBS = [
    { title: "Wire the reading", filesToModify: ["gates/workflow.test.ts", "lib/sc-cover.ts"] },
    { title: "Produce the field", filesToModify: ["gates/schema.ts", "lib/evidence-prevalidator.ts"] },
  ];
  const DENIED = ["gates/schema.ts", "lib/evidence-prevalidator.ts", "gates/SCHEMA-GUIDE.md"];

  test("the #274 plan is refused, naming the sub-issue and the file", () => {
    const out = denylistViolations(SUBS, DENIED);
    expect(out).toHaveLength(2);
    expect(out.join("\n")).toContain("Produce the field");
    expect(out.join("\n")).toContain("gates/schema.ts");
  });

  test("the in-scope sub-issue is untouched, so the refusal is not vacuous", () => {
    // #306's SC-2 by name: a decomposer that emitted empty file lists would
    // pass the case above trivially. The first sub-issue's files survive.
    expect(withoutDenied(SUBS[0].filesToModify, DENIED)).toEqual(SUBS[0].filesToModify);
    expect(denylistViolations([SUBS[0]], DENIED)).toEqual([]);
  });

  test("an empty deny-list refuses nothing", () => {
    expect(denylistViolations(SUBS, [])).toEqual([]);
  });

  test("a denied path matches only itself, so a same-tailed file is allowed", () => {
    // A suffix match would read `test/gates/schema.ts` as `gates/schema.ts`
    // and deny a file the prohibition never mentioned.
    expect(denylistViolations([{ filesToModify: ["test/gates/schema.ts"] }], DENIED)).toEqual([]);
  });

  test("a plan item with no title is still named by position", () => {
    const out = denylistViolations([{ filesToModify: ["gates/schema.ts"] }], DENIED);
    expect(out[0]).toContain("plan item 1");
  });
});

describe("#306 security review: the comparison cannot be stepped around", () => {
  // Three findings on this change, all about the same thing from different
  // angles: a guard whose entire value is a string comparison is only as
  // good as its normalisation and only as safe as its direction.

  test("four spellings of one file all match the same deny entry", () => {
    // guard-bypass-path-normalization. Without normalising, `===` reads these
    // as four different files and three of them walk straight past.
    for (const spelling of [
      "gates/schema.ts",
      "./gates/schema.ts",
      "gates//schema.ts",
      "gates/./schema.ts",
      "gates/sub/../schema.ts",
    ]) {
      expect(matchesDenied(spelling, "gates/schema.ts"), `bypass via ${spelling}`).toBe(true);
    }
  });

  test("a path that escapes the repo root keeps its escape", () => {
    // `..` is kept rather than resolved when there is nothing above it, so
    // `../a/secrets.ts` stays distinct from `a/secrets.ts` under an exact
    // PATH deny entry. An implementation that dropped the `..` would let a
    // plan outside the repo answer to a deny entry meant for one inside it.
    expect(normalisePath("../a/secrets.ts")).toBe("../a/secrets.ts");
    expect(matchesDenied("../a/secrets.ts", "a/secrets.ts")).toBe(false);
    expect(matchesDenied("a/secrets.ts", "a/secrets.ts")).toBe(true);

    // Under a BARE deny entry it still matches, and that is deliberate: the
    // bare rule means "this file, wherever it lives", and for a deny-list
    // matching too much refuses work while matching too little permits it.
    // This is the direction to be wrong in.
    expect(matchesDenied("../a/secrets.ts", "secrets.ts")).toBe(true);
  });

  test("an empty or whitespace entry matches nothing - including another one", () => {
    // MEASURED: the first four of these are already decided by the basename
    // comparison — `"a.ts" === ""` is false either way — so removing the
    // explicit empty guard scored ZERO against them. The case that actually
    // needs the guard is the last one: without it, `normalisePath` reduces
    // both sides to `""`, `"" === ""` is true, and a junk plan entry answers
    // to a junk deny entry.
    expect(matchesDenied("lib/a.ts", "")).toBe(false);
    expect(matchesDenied("lib/a.ts", "   ")).toBe(false);
    expect(matchesDenied("", "lib/a.ts")).toBe(false);
    expect(denylistViolations([{ filesToModify: ["lib/a.ts"] }], ["", "  "])).toEqual([]);
    expect(matchesDenied("", ""), "two empty strings matched each other").toBe(false);
    expect(matchesDenied("./", "  /  "), "two paths that normalise to nothing matched").toBe(false);
  });

  test("a goal that denies every planned file is reported, not silently emptied", () => {
    // fail-open-detection and untrusted-input-control-manipulation meet here.
    // The goal text is attacker-influenceable and nothing validates it; what
    // limits the damage is direction — a deny-list only narrows, so a hostile
    // goal can deny progress but cannot grant access. The unsafe outcome is
    // SILENCE: an empty plan is indistinguishable from a run with nothing to
    // do, which is work refused reported as work completed.
    const files = ["lib/a.ts", "lib/b.ts"];
    const said = scopeContradiction(files, ["lib/a.ts", "lib/b.ts"]);
    expect(said, "the plan was emptied without a word").not.toBeNull();
    expect(said).toContain("every file the run planned to touch");
  });

  test("a partial strip is NOT a contradiction", () => {
    // The positive control. A function that cried contradiction on every
    // deny-list would satisfy the case above and be ignored within a day.
    expect(scopeContradiction(["lib/a.ts", "lib/b.ts"], ["lib/a.ts"])).toBeNull();
    expect(scopeContradiction(["lib/a.ts"], [])).toBeNull();
    expect(scopeContradiction([], ["lib/a.ts"])).toBeNull();
  });

  test("the workflow reports the contradiction rather than proceeding quietly", () => {
    expect(shipSource).toContain("scopeContradiction(beforeStrip, denied)");
    expect(shipSource).toContain("CONTRADICTION");
  });

  test("contextFiles is filtered too, not just filesToModify", () => {
    // incomplete-guard-field-mismatch, and it was a complete bypass: an AC's
    // contextFiles reach the to-issues prompt (every AC's list is
    // interpolated into it) and the implementer's context excerpts
    // (`acContextFiles` reads them off disk). Filtering only `filesToModify`
    // struck a file off the list and then handed the agent its contents.
    const strip = shipSource.indexOf("ac.contextFiles = ac.contextFiles.filter(cf => {");
    expect(strip, "contextFiles are not filtered by the deny-list").toBeGreaterThan(-1);
    const prompt = shipSource.indexOf("You are the to-issues decomposition skill");
    const excerpts = shipSource.indexOf("const acContextFiles");
    expect(strip, "the strip runs after the decomposer prompt reads contextFiles")
      .toBeLessThan(prompt);
    expect(strip, "the strip runs after the excerpt reader").toBeLessThan(excerpts);
  });

  test("the contextFiles filter handles both shapes the field takes", () => {
    // The field holds either a bare string or {path, reason}; the two live
    // readers above each normalise it themselves, so a filter that understood
    // only one shape would silently pass the other straight through.
    const shaped = [{ path: "gates/schema.ts", reason: "x" }, "lib/ok.ts", { reason: "no path" }];
    const denied = ["gates/schema.ts"];
    const kept = shaped.filter(cf => {
      const p = typeof cf === "string" ? cf : (cf as { path?: string })?.path;
      return !p || !denied.some(d => matchesDenied(p, d));
    });
    expect(kept).toEqual(["lib/ok.ts", { reason: "no path" }]);
  });
});

describe("SC-1426: ship.js's inlined copy and the library agree", () => {
  /** Inputs chosen so each row can disagree for a different reason. */
  const MATRIX: Array<[string, string, string[]]> = [
    ["#274's real goal", GOAL_274, []],
    ["#274's goal with files named", GOAL_274_WITH_FILES, []],
    ["marker with a later paragraph", "DO NOT TOUCH lib/a.ts\n\nedit lib/b.ts", []],
    ["out of scope phrasing", "The rewrite is out of scope — not specs/X.md", []],
    ["not in scope phrasing", "workflows/ship.js is not in scope here", []],
    ["no prohibition", "Just fix lib/a.ts please", []],
    ["scopeOut only", "", ["skip lib/scanner.ts", "nothing here"]],
    ["root-level file, no directory", "DO NOT TOUCH package.json", []],
    ["dotted code expressions", "out of scope: `reading.broken`, `acs[].status`", []],
    ["empty everything", "", []],
  ];

  for (const [label, goal, scopeOut] of MATRIX) {
    test(`deniedFiles agrees on ${label}`, () => {
      expect(inlined.deniedFiles(goal, scopeOut), `drift at ${label}`).toEqual(
        deniedFiles(goal, scopeOut),
      );
    });

    test(`unresolvedProhibitions agrees on ${label}`, () => {
      expect(inlined.unresolvedProhibitions(goal), `drift at ${label}`).toEqual(
        unresolvedProhibitions(goal),
      );
    });
  }

  test("the refusal text agrees word for word, not just the count", () => {
    // A copy that refuses the same plans with a different explanation is
    // still drift, and it is the kind that reaches an operator not a test.
    const subs = [{ title: "T", filesToModify: ["gates/schema.ts", "lib/ok.ts"] }];
    const denied = ["gates/schema.ts"];
    expect(inlined.denylistViolations(subs, denied)).toEqual(denylistViolations(subs, denied));
  });

  test("withoutDenied agrees", () => {
    const files = ["a/b.ts", "c/d.ts", "deep/package.json"];
    for (const denied of [["a/b.ts"], ["package.json"], ["b.ts"], []]) {
      expect(inlined.withoutDenied(files, denied), `drift at ${denied.join()}`)
        .toEqual(withoutDenied(files, denied));
    }
  });

  test("normalisePath and scopeContradiction agree", () => {
    for (const p of ["./a/b.ts", "a//b.ts", "a/./b.ts", "a/c/../b.ts", "../x.ts", "", "  a.ts "]) {
      expect(inlined.normalisePath(p), `drift at ${JSON.stringify(p)}`).toBe(normalisePath(p));
    }
    const files = ["lib/a.ts", "lib/b.ts"];
    for (const denied of [["lib/a.ts", "lib/b.ts"], ["lib/a.ts"], []]) {
      expect(inlined.scopeContradiction(files, denied), `drift at ${denied.join()}`)
        .toEqual(scopeContradiction(files, denied));
    }
  });

  test("matchesDenied agrees on the path-vs-basename boundary", () => {
    // The rule that carries the correction above. The two copies disagreeing
    // here would mean the workflow denies a different set than the library,
    // and the library is what every test in this file measures.
    const CASES: Array<[string, string]> = [
      ["gates/schema.ts", "gates/schema.ts"],
      ["test/gates/schema.ts", "gates/schema.ts"],
      ["specs/HARNESS-STANDARD.md", "HARNESS-STANDARD.md"],
      ["package.json", "package.json"],
      ["lib/my-package.json", "package.json"],
    ];
    for (const [plan, denied] of CASES) {
      expect(inlined.matchesDenied(plan, denied), `drift at ${plan} vs ${denied}`)
        .toBe(matchesDenied(plan, denied));
    }
    // And the matrix is not two always-false functions agreeing.
    expect(CASES.some(([p, d]) => matchesDenied(p, d))).toBe(true);
    expect(CASES.some(([p, d]) => !matchesDenied(p, d))).toBe(true);
  });

  test("the matrix is not comparing two no-ops", () => {
    // Every row above would agree if both sides returned []. At least one row
    // must produce a non-empty answer from each function, or the whole
    // describe block is 18 vacuous assertions.
    expect(MATRIX.some(([, g, s]) => deniedFiles(g, s).length > 0)).toBe(true);
    expect(MATRIX.some(([, g]) => unresolvedProhibitions(g).length > 0)).toBe(true);
  });

  test("the library exports each helper exactly once", () => {
    // Two declarations of the same name would let the parity matrix pass
    // against a copy the workflow does not run.
    const lib = readFileSync(join(REPO, "lib", "scope-denylist.ts"), "utf-8");
    for (const name of ["deniedFiles", "unresolvedProhibitions", "denylistViolations", "withoutDenied"]) {
      expect((lib.match(new RegExp(`export function ${name}\\b`, "g")) || []).length, name).toBe(1);
    }
  });
});

describe("#306: the workflow actually consults the deny-list", () => {
  // A library nothing calls is the same defect one step removed. These greps
  // are deliberately on the CALL, not on the block's presence.
  test("the goal text is read off an object that actually carries it", () => {
    // THE ONE THAT MADE THE WHOLE GUARD DEAD. The first version read
    // `discovery.issueGoal`. DISCOVERY_SCHEMA has no such key — `issueGoal`
    // is on `goalData` — so `deniedFiles('')` returned [] on every run and
    // nothing was ever denied. A dead control, shipped as the fix for a class
    // of dead controls, and copied from ship.js:2145 which had the same bug
    // already and had been falling back to 'see ACs below' forever.
    //
    // Asserted against the SCHEMA rather than by grepping for the right
    // spelling, because the wrong spelling is also a valid-looking string.
    const schema = shipSource.slice(
      shipSource.indexOf("const DISCOVERY_SCHEMA"),
      shipSource.indexOf("const GATE_RESULT_SCHEMA"),
    );
    expect(schema.length, "DISCOVERY_SCHEMA could not be located").toBeGreaterThan(200);
    expect(schema, "the schema gained issueGoal — this case is now moot and should be deleted")
      .not.toContain("issueGoal");
    expect(
      shipSource,
      "something still reads issueGoal off `discovery`, where the schema says it is not",
    ).not.toContain("discovery.issueGoal");

    // And the positive control: the goal text reaches the helper from the
    // object that does carry it. A guard reading nothing passes every case
    // above.
    expect(shipSource).toContain("applyScopeDenylist(discovery, log, goalData?.issueGoal)");
    const goalSchema = shipSource.slice(
      shipSource.indexOf("const GOAL_SCHEMA"),
      shipSource.indexOf("const DISCOVERY_SCHEMA"),
    );
    expect(goalSchema, "goalData does not carry issueGoal either").toContain("issueGoal");
  });

  test("no field is read off `discovery` that DISCOVERY_SCHEMA does not declare", () => {
    // The general form of the case above, and a better guard than it: rather
    // than naming `issueGoal`, reconcile every `discovery.x` read in the file
    // against the schema's declared keys. `issueGoal` was one instance; the
    // next one will have a different name and this is what catches it.
    //
    // The schema is what the structured-output layer validates against, so a
    // key absent from it is `undefined` at run time — always, silently, and
    // indistinguishable from an empty value.
    const ds = shipSource.slice(
      shipSource.indexOf("const DISCOVERY_SCHEMA"),
      shipSource.indexOf("const GATE_RESULT_SCHEMA"),
    );
    const declared = new Set([...ds.matchAll(/^ {4}(\w+):/gm)].map(m => m[1]));
    expect(declared.size, "no keys were parsed out, so this compares nothing")
      .toBeGreaterThan(5);
    expect(declared, "the parse missed a key it should have found").toContain("filesToModify");

    const read = [...new Set([...shipSource.matchAll(/\bdiscovery\??\.(\w+)/g)].map(m => m[1]))];
    expect(read.length, "no reads were found, so this compares nothing").toBeGreaterThan(3);
    const undeclared = read.filter(k => !declared.has(k)).sort();
    expect(
      undeclared,
      "read off `discovery` but absent from DISCOVERY_SCHEMA, so always undefined",
    ).toEqual([]);
  });

  test("the filter runs BEFORE the ACs are persisted", () => {
    // guard-runs-after-the-data-is-persisted. `writeACs` serialises
    // discovery.acs into workflow-state.json, which is the copy every gate
    // reads. A filter after that point cleaned the in-memory object and left
    // the persisted one carrying denied contextFiles.
    //
    // #614 moved the serialisation: the payload no longer sits inline in the
    // `writeACs` call, it is built by `acPayloadShellArgument(discovery.acs)`
    // and handed to the program as an argument. That builder IS the moment
    // discovery.acs becomes bytes, so it is what this orders against.
    const apply = shipSource.indexOf("applyScopeDenylist(discovery, log, goalData?.issueGoal)");
    const persist = shipSource.indexOf("${acPayloadShellArgument(discovery.acs)}");
    expect(apply, "nothing applies the deny-list").toBeGreaterThan(-1);
    expect(persist, "the AC serialisation this orders against is gone").toBeGreaterThan(-1);
    expect(apply, "the deny-list runs after workflow-state.json is written")
      .toBeLessThan(persist);
  });

  test("a goal that denies every planned file REFUSES the discovery", () => {
    // fail-open-on-contradiction. Logging it and carrying on produces an
    // empty implementation, which reads downstream as a run with nothing to
    // do. The refusal travels through runDiscovery's existing `return false`.
    expect(shipSource).toContain("if (scopeGuard.refusal) {");
    expect(shipSource).toContain("DISCOVERY REFUSED:");

    // The BRANCH, by brace matching — not a fixed character window. The
    // window was 220 characters, and #524 added two lines of comment and one
    // assignment inside this block, which pushed `return false` out of view
    // and turned the row red over code that does exactly what it says. A
    // detector whose view of the input can silently shrink is the second
    // shape in `.claude/rules/checks-must-be-able-to-fail.md`, and here it
    // shrank in the direction that cries wolf rather than the one that goes
    // quiet — but a check that fires on a comment is a check that gets its
    // assertion loosened by whoever is in a hurry.
    const open = shipSource.indexOf("if (scopeGuard.refusal) {");
    let depth = 0;
    let close = -1;
    for (let i = shipSource.indexOf("{", open); i < shipSource.length; i++) {
      if (shipSource[i] === "{") depth++;
      else if (shipSource[i] === "}" && --depth === 0) { close = i + 1; break; }
    }
    expect(close, "the refusal branch has unbalanced braces").toBeGreaterThan(open);
    const branch = shipSource.slice(open, close);
    expect(branch, "the contradiction is logged but the run continues").toContain("return false");
    // The slice is the branch and not the rest of the file: a brace walk that
    // ran away would contain `return false` from anywhere downstream.
    expect(branch.length, "the branch slice swallowed the file").toBeLessThan(600);
  });

  test("the filter runs inside runDiscovery, so re-discovery is covered", () => {
    // guard-not-reapplied-on-rediscovery. The verify gate calls
    // `runDiscovery('Verify gate found ACs were wrong: …')`, which replaces
    // filesToModify and acs wholesale. Applying the deny-list once after the
    // first call held for one pass and lapsed on the second — and the re-run
    // is the path a FAILING run takes, which is the worst one to leave open.
    const decl = shipSource.indexOf("async function runDiscovery(context) {");
    const call = shipSource.indexOf("applyScopeDenylist(discovery, log, goalData?.issueGoal)");
    const ret = shipSource.indexOf("return true\n}", decl);
    expect(decl, "runDiscovery is gone").toBeGreaterThan(-1);
    expect(call, "nothing applies the deny-list").toBeGreaterThan(-1);
    expect(call, "the filter is outside runDiscovery, so a re-run bypasses it")
      .toBeGreaterThan(decl);
    expect(call, "the filter runs after runDiscovery returns").toBeLessThan(ret);

    // And the re-discovery call site exists, so the case above is not about
    // a path nothing takes.
    expect(shipSource).toContain("runDiscovery('Verify gate found ACs were wrong: ");
  });

  test("the deny-list is applied exactly once, in one place", () => {
    // Two application sites would survive a mutation of either, and the
    // parity matrix would still pass. The LIST is computed twice — once in
    // the helper, once for the prompt — but that is pure and cannot drift.
    expect((shipSource.match(/applyScopeDenylist\(/g) || []).length).toBe(2); // decl + call
    expect(
      (shipSource.match(/discovery\.filesToModify = withoutDenied/g) || []).length,
      "filesToModify is stripped outside the one helper",
    ).toBe(0);
  });

  test("the decomposer's own output is checked, not just its input", () => {
    // Filtering discovery is not enough: a decomposer can name a file
    // discovery never listed, which is the half an input filter cannot see.
    expect(shipSource).toContain("denylistViolations(decompResult.subIssues, scopeDenied)");
    expect(shipSource, "a violating plan is used anyway").toContain(
      "falling back to single-agent implement.",
    );
  });

  test("the unenforceable case is logged rather than swallowed", () => {
    expect(shipSource).toContain("unresolvedProhibitions(goalData?.issueGoal");
    expect(shipSource).toContain("UNENFORCEABLE");
  });
});
