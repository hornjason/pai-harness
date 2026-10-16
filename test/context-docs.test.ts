/**
 * Covers SC-1613..SC-1620 (HARNESS-STANDARD.md), #439.
 *
 * `contextDocs` was reported from a consumer project's session as a dead
 * config key. It was not dead — `gates/brief-assembler.ts` consumes it — and
 * what was actually wrong is worse than inert, because the key looked like it
 * worked. Three defects stacked in one twenty-line region:
 *
 *   1. Every entry starting with `/` or containing `..` was filtered out with
 *      no warning. The use case that prompted the report was declaring docs in
 *      another project, which is an absolute path. Refusing was
 *      indistinguishable from there being nothing to refuse.
 *   2. The config was read straight from `.claude/rungate.json`, so a project
 *      on the directory layout got nothing regardless of the filter.
 *   3. `catch { return null }` turned a trailing comma into "no docs".
 *
 * A fourth surfaced on the way: the schema declared `contextDocs` as an
 * OBJECT only, while the consumer and its own tests supported the array form.
 * The contradiction was invisible because the consumer parsed the file itself
 * and never reached the validator.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { assembleBrief } from "../gates/brief-assembler";
import { classifyContextDoc, classifyContextDocs, contextDocNotes } from "../lib/context-docs";

let base: string;
let projectRoot: string;
let workDir: string;
const SLUG = "ctx-docs";

function writeState(): void {
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, "workflow-state.json"), JSON.stringify({
    schemaVersion: 2, issue: 439, repo: "t/r", issueRepo: "t/r",
    projectRoot, slug: SLUG, phase: "BUILD",
    issueGoal: "contextDocs must not drop what it was given",
    acs: [{ id: "AC-1", type: "CODE", statement: "s", threshold: { op: "contains", value: "x" },
            evidenceMethod: { type: "grep", command: "grep x f" }, evidence: null, verdict: "PENDING" }],
    gates: {}, changelog: [],
  }, null, 2));
}

/** The DIRECTORY layout — the one a monolith-only read cannot see. */
function writeDirectoryConfig(config: Record<string, unknown>): void {
  const dir = join(projectRoot, ".claude", "rungate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ project: "T", ...config }));
}

function writeMonolithConfig(raw: string): void {
  mkdirSync(join(projectRoot, ".claude"), { recursive: true });
  writeFileSync(join(projectRoot, ".claude", "rungate.json"), raw);
}

async function brief(): Promise<string> {
  writeState();
  const result = await assembleBrief({ slug: SLUG, workDir, projectRoot });
  return readFileSync(result.briefPath, "utf-8");
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "rg-439-"));
  projectRoot = join(base, "project");
  workDir = join(base, SLUG);
  mkdirSync(projectRoot, { recursive: true });
});
afterEach(() => { if (existsSync(base)) rmSync(base, { recursive: true, force: true }); });

describe("SC-1613: contextDocs is read through the one loader", () => {
  test("a project on the DIRECTORY layout gets its docs", async () => {
    // The defect, stated as an assertion. `loadProjectHarness` built
    // `.claude/rungate.json` by hand, so a consumer who followed the
    // documented migration silently got nothing — exactly what
    // `.claude/rules/config-access.md` says never to do.
    writeFileSync(join(projectRoot, "HARNESS.md"), "# harness\n");
    writeDirectoryConfig({ contextDocs: ["HARNESS.md"] });

    expect(existsSync(join(projectRoot, ".claude", "rungate.json")),
      "the fixture must have NO monolith, or this passes for the wrong reason").toBe(false);
    expect(await brief()).toContain("HARNESS.md");
  });

  test("SC-1619: both authored shapes survive the schema", async () => {
    // The schema said object-only while the consumer and its own tests used
    // the array form. Routing the read through the loader is what made them
    // meet, and it threw.
    writeFileSync(join(projectRoot, "A.md"), "a\n");
    writeFileSync(join(projectRoot, "B.md"), "b\n");
    writeDirectoryConfig({ contextDocs: ["A.md"] });
    expect(await brief()).toContain("A.md");

    rmSync(join(projectRoot, ".claude"), { recursive: true, force: true });
    writeDirectoryConfig({ contextDocs: { model: "B.md" } });
    expect(await brief()).toContain("B.md");
  });
});

describe("SC-1614: malformed config throws; absent config does not", () => {
  test("a trailing comma is not 'no docs declared'", async () => {
    writeMonolithConfig(`{ "project": "T", "contextDocs": ["A.md"], }`);
    writeState();
    expect(assembleBrief({ slug: SLUG, workDir, projectRoot }))
      .rejects.toThrow();
  });

  test("no config at all assembles a brief, and says nothing about contextDocs", async () => {
    // The other half, asserted separately: the point of #439 is that these
    // two stop being the same outcome, so a test that only covered one of
    // them would not have noticed them being conflated.
    const text = await brief();
    expect(text).toContain("## Context (read first, in order)");
    expect(text, "a project with no config is being told about contextDocs")
      .not.toContain("contextDocs:");
  });
});

describe("SC-1615: a rejected entry is reported, not dropped", () => {
  test("the report names the path and the reason", async () => {
    writeFileSync(join(projectRoot, "GOOD.md"), "g\n");
    writeDirectoryConfig({ contextDocs: ["GOOD.md", "", 42] });

    const text = await brief();
    expect(text).toContain("GOOD.md");
    expect(text).toContain("REJECTED");
    expect(text).toContain("not a string");
    expect(text).toMatch(/contextDocs: 3 declared, 1 usable/);
  });

  test("declaring nothing and declaring nothing usable are different briefs", async () => {
    // The property the old filter did not have. An empty list and a list
    // whose entries were all rejected produced the same brief, which is
    // `.claude/rules/config-access.md`'s Silent Default Substitution.
    writeDirectoryConfig({});
    const silent = await brief();

    rmSync(join(projectRoot, ".claude"), { recursive: true, force: true });
    writeDirectoryConfig({ contextDocs: [42, null] });
    const loud = await brief();

    expect(silent).not.toContain("contextDocs:");
    expect(loud).toContain("contextDocs: 2 declared, 0 usable");
    expect(loud, "a config whose every entry was refused reads like one with none")
      .not.toBe(silent);
  });

  test("a contextDocs that is neither array nor object is one rejection, not silence", () => {
    const v = classifyContextDocs("/p", "docs/NOT-A-LIST.md");
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe("rejected");
    expect(v[0]!.kind === "rejected" && v[0]!.reason).toContain("must be an array or an object");
  });
});

describe("SC-1616: a path outside the project root is a recorded decision", () => {
  test("an absolute path reaches the brief, labelled external", async () => {
    // THE DECISION. A brief NAMES files; it does not read them, and the
    // config is written by the operator whose session the agent runs in. So
    // an external doc is included and labelled rather than filtered out
    // where nobody can see it. What is worth protecting is a reader's
    // ability to notice that a brief reaches outside the repository.
    const outside = join(base, "other-project");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "POV.md"), "pov\n");
    writeDirectoryConfig({ contextDocs: [join(outside, "POV.md")] });

    const text = await brief();
    expect(text, "the use case that prompted the report is still dropped").toContain("POV.md");
    expect(text).toContain("external to this project");
    expect(text).toContain("EXTERNAL");
  });

  test("SC-1620: a traversing path reaches the brief, labelled external", async () => {
    const outside = join(base, "sibling");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "NOTES.md"), "n\n");
    writeDirectoryConfig({ contextDocs: ["../sibling/NOTES.md"] });

    const text = await brief();
    expect(text).toContain("NOTES.md");
    expect(text).toContain("external to this project");
  });

  test("a sibling directory whose name EXTENDS the root is still external", () => {
    // `relative`, not `startsWith`: `/x/project-backup` starts with
    // `/x/project` and is a different directory. A prefix comparison would
    // call it internal and the label would be wrong in the dangerous
    // direction.
    const v = classifyContextDoc("/x/project", "/x/project-backup/SECRETS.md");
    expect(v.kind).toBe("included");
    expect(v.kind === "included" && v.external).toBe(true);
  });
});

describe("SC-1617: each arm of the classifier, with a positive control", () => {
  test("a valid relative path inside the root is plain — the positive control", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-439-ok-"));
    try {
      writeFileSync(join(root, "DOC.md"), "d\n");
      const v = classifyContextDoc(root, "DOC.md");
      expect(v.kind).toBe("included");
      expect(v.kind === "included" && v.external).toBe(false);
      expect(v.kind === "included" && v.missing).toBe(false);
      expect(v.kind === "included" && v.resolved).toBe(resolve(root, "DOC.md"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a non-string is rejected, naming what it was", () => {
    const v = classifyContextDoc("/p", 42);
    expect(v.kind).toBe("rejected");
    expect(v.kind === "rejected" && v.reason).toBe("not a string");
  });

  test("an empty or whitespace-only entry is rejected", () => {
    for (const e of ["", "   ", "\t\n"]) {
      const v = classifyContextDoc("/p", e);
      expect(v.kind, `${JSON.stringify(e)} was accepted`).toBe("rejected");
      expect(v.kind === "rejected" && v.reason).toBe("empty");
    }
  });

  test("SC-1618: a declared doc that is not on disk is INCLUDED and labelled", async () => {
    // Not rejected. The built-in entries above it already say "(if exists)",
    // and a brief is assembled before the agent may create anything. What
    // must not happen is the entry vanishing — so it is named, and so is the
    // fact that nothing is there.
    writeDirectoryConfig({ contextDocs: ["docs/NOT-YET.md"] });
    const text = await brief();
    expect(text).toContain("NOT-YET.md");
    expect(text).toContain("not present at assembly time");
    expect(text).toContain("MISSING");
  });

  test("nothing declared produces no notes at all", () => {
    expect(contextDocNotes([])).toEqual([]);
  });

  test("everything declared and usable produces no notes either", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-439-clean-"));
    try {
      writeFileSync(join(root, "D.md"), "d\n");
      expect(contextDocNotes(classifyContextDocs(root, ["D.md"]))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("SC-1617: the old filter cannot come back unnoticed", () => {
  test("the deleted readers are gone from the assembler", () => {
    // A source-position assertion, and the narrow kind: these two functions
    // were the monolith read and the silent filter. A re-introduction would
    // be a second decider beside `lib/context-docs.ts` and would survive
    // every mutation of it.
    const src = readFileSync(join(import.meta.dir, "..", "gates", "brief-assembler.ts"), "utf-8");
    expect(src).not.toContain("function loadProjectHarness");
    expect(src).not.toContain("function extractContextDocs");
    expect(src, "the assembler builds a config path by hand again")
      .not.toMatch(/join\([^)]*"\.claude",\s*"rungate\.json"\)/);
    expect(src).toContain("tryLoadRungateConfig(projectRoot)");
  });
});
