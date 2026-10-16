/**
 * Covers SC-1641..SC-1646 (SCAFFOLD-DECOMPOSITION-SPEC.md), #442.
 *
 * The feature for adopting documents that live in another project was built
 * and has never fired for any project, for four independent reasons, each
 * alone sufficient:
 *
 *   1. `organizeProject` had one caller and it was a human running a CLI.
 *      Nothing in scaffold, ship or any hook invoked it.
 *   2. Scaffold wrote `externalSources: []` in two places and nothing
 *      prompted anyone to fill it.
 *   3. Both match modes keyed on the literal project DIRECTORY NAME.
 *      Measured against a real sibling document: 0 hits for the directory
 *      name, 2 for the abbreviation the docs actually use.
 *   4. Three fail-opens in one loop — a missing declared path, an unreadable
 *      file, and a bare `catch` around the whole walk — each turning "I
 *      could not look" into "no match".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { organizeProjectReport, expandHome } from "../lib/organize";
import { MIN_ALIAS_LENGTH, matchesAnyAlias, projectAliases, remoteSlug } from "../lib/project-aliases";
import { reportExternalAdoptionStep } from "../lib/scaffold/steps";

let root: string;
let outside: string;

function compliance(organize: Record<string, unknown>): void {
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "rungate", "compliance.json"),
    JSON.stringify({
      rules: {},
      defaults: { consecutiveFailThreshold: 3, tierPromotionThreshold: 5 },
      organize: { fileTypes: [".md"], artifactClassification: {}, externalSources: [], ...organize },
    }, null, 2),
  );
}

function externalDoc(name: string, body: string): string {
  const path = join(outside, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function report() {
  return organizeProjectReport(root, { dryRun: true, harnessRoot: root });
}

beforeEach(() => {
  // A directory name the sibling documents will deliberately never use.
  root = join(mkdtempSync(join(tmpdir(), "rg-442-")), "DailyBriefDashboard");
  mkdirSync(root, { recursive: true });
  outside = mkdtempSync(join(tmpdir(), "rg-442-ext-"));
});
afterEach(() => {
  for (const d of [join(root, ".."), outside]) {
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("SC-1641: a project is matched by the names its documents actually use", () => {
  test("a doc naming the project only by alias is proposed", () => {
    // The measured case. The sibling spec says DDB throughout and never
    // spells the directory name, so neither old matcher fired.
    compliance({
      aliases: ["ddb"],
      externalSources: [{ path: outside, type: "spec", target: "specs", method: "copy", matchBy: "content-reference" }],
    });
    externalDoc("POV-SPEC.md", "# POV\n\nThe DDB pipeline consumes this feed.\n");

    const proposals = report().proposals.filter(p => p.source.startsWith("/"));
    expect(proposals.map(p => p.target)).toContain(join("specs", "POV-SPEC.md"));
  });

  test("the same doc is NOT proposed when the alias is not declared", () => {
    // One input, one difference. Without this the case above would pass for
    // a matcher that proposes everything.
    compliance({
      externalSources: [{ path: outside, type: "spec", target: "specs", method: "copy", matchBy: "content-reference" }],
    });
    externalDoc("POV-SPEC.md", "# POV\n\nThe DDB pipeline consumes this feed.\n");

    expect(report().proposals.filter(p => p.source.startsWith("/"))).toEqual([]);
  });

  test("SC-1641: the filename mode consults aliases too, not just the directory name", () => {
    compliance({
      aliases: ["ddb"],
      externalSources: [{ path: outside, type: "spec", target: "specs", method: "copy", matchBy: "project-name" }],
    });
    externalDoc("DDB-SPEC.md", "# spec\n");

    const proposals = report().proposals.filter(p => p.source.startsWith("/"));
    expect(proposals.map(p => p.target)).toContain(join("specs", "DDB-SPEC.md"));
  });

  test("the repo name and slug are derived, not typed", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(
      join(root, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/anowner/daily-brief.git\n',
    );
    const aliases = projectAliases(root);
    expect(aliases).toContain("daily-brief");
    expect(aliases).toContain("anowner/daily-brief");
    expect(aliases).toContain("dailybriefdashboard");
  });

  test("both git remote URL forms parse, and a non-GitHub remote contributes nothing", () => {
    expect(remoteSlug("git@github.com:anowner/daily-brief.git")).toBe("anowner/daily-brief");
    expect(remoteSlug("https://github.com/anowner/daily-brief")).toBe("anowner/daily-brief");
    expect(remoteSlug("https://gitlab.example.com/anowner/daily-brief.git")).toBeNull();
  });
});

describe("SC-1642: a matcher that would propose everything is refused", () => {
  test("an alias shorter than the floor is dropped", () => {
    // #437's shape: a one-character prefix made `isScratchEntry` accept
    // `.claude`. A one-letter alias proposes adopting most of a directory.
    expect(projectAliases(join(root, ".."), ["d", "x"])).not.toContain("d");
    expect(MIN_ALIAS_LENGTH).toBeGreaterThanOrEqual(2);
  });

  test("an alias matches as a WORD, not as a substring", () => {
    // `ddb` inside `oddball` is the case that makes a short alias dangerous,
    // and substring matching is what the old code did.
    expect(matchesAnyAlias("the ddb pipeline", ["ddb"])).toBe(true);
    expect(matchesAnyAlias("an oddball case", ["ddb"]), "a substring was read as a match").toBe(false);
    expect(matchesAnyAlias("DDB-SPEC.md", ["ddb"]), "a filename boundary was missed").toBe(true);
    expect(matchesAnyAlias("see anowner/daily-brief", ["anowner/daily-brief"])).toBe(true);
  });

  test("SC-1642: a doc that matches nothing produces no proposal", () => {
    // The positive control the issue asks for by name. Without it, widening
    // the matcher into proposing everything is invisible.
    compliance({
      aliases: ["ddb"],
      externalSources: [{ path: outside, type: "spec", target: "specs", method: "copy", matchBy: "content-reference" }],
    });
    externalDoc("UNRELATED.md", "# Something else\n\nNothing to do with anything here.\n");
    externalDoc("MATCHES.md", "# Yes\n\nThe DDB pipeline.\n");

    const proposals = report().proposals.filter(p => p.source.startsWith("/"));
    expect(proposals.map(p => p.target)).toEqual([join("specs", "MATCHES.md")]);
  });
});

describe("SC-1643: a declared path that is not on disk is UNMEASURED", () => {
  test("the report names the path rather than skipping it", () => {
    const missing = join(outside, "no-such-directory");
    compliance({
      aliases: ["ddb"],
      externalSources: [{ path: missing, type: "spec", target: "specs", method: "copy", matchBy: "content-reference" }],
    });

    const r = report();
    expect(r.unmeasured, "a declared source vanished in silence").toContain(missing);
    expect(r.proposals.filter(p => p.source.startsWith("/"))).toEqual([]);
  });

  test("nothing is reported unmeasured when the path is there", () => {
    compliance({
      aliases: ["ddb"],
      externalSources: [{ path: outside, type: "spec", target: "specs", method: "copy", matchBy: "content-reference" }],
    });
    externalDoc("X.md", "# x\n");
    expect(report().unmeasured).toEqual([]);
  });

  test("SC-1643: `~` expands only when it leads", () => {
    const home = process.env.HOME || "";
    expect(expandHome("~/Projects/x")).toBe(join(home, "Projects", "x"));
    expect(expandHome("~")).toBe(home);
    // The old `replace("~", HOME)` rewrote this one in the middle.
    expect(expandHome("/srv/backup~old/docs"), "a mid-path tilde was expanded")
      .toBe("/srv/backup~old/docs");
  });
});

describe("SC-1644: a file that cannot be read is reported, not called a non-match", () => {
  test("an unreadable candidate lands in the report", () => {
    compliance({
      aliases: ["ddb"],
      externalSources: [{ path: outside, type: "spec", target: "specs", method: "copy", matchBy: "content-reference" }],
    });
    const locked = externalDoc("LOCKED.md", "# locked\n\nThe DDB pipeline.\n");
    chmodSync(locked, 0o000);
    try {
      const r = report();
      // Root can read a 000 file, so the assertion is conditional on the
      // read having actually failed — stated rather than assumed, because a
      // test that passes when the read succeeds proves nothing either way.
      if (r.proposals.some(p => p.source === locked)) {
        expect(r.unreadable, "the file was readable here, so nothing was measured").toEqual([]);
      } else {
        expect(r.unreadable).toContain(locked);
      }
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  test("SC-1644: a dangling symlink is unreadable for everyone, including root", () => {
    // The chmod case above escapes when the suite runs as root, which is
    // honest but means CI could pass over an untested branch. A symlink to
    // nothing throws ENOENT on read for every user, so this half of the
    // criterion is measured unconditionally.
    compliance({
      aliases: ["ddb"],
      externalSources: [{ path: outside, type: "spec", target: "specs", method: "copy", matchBy: "content-reference" }],
    });
    const dangling = join(outside, "GONE.md");
    symlinkSync(join(outside, "never-existed.md"), dangling);

    const r = report();
    expect(r.unreadable, "an unreadable entry was read as a non-match").toContain(dangling);
    expect(r.proposals.filter(x => x.source.startsWith("/"))).toEqual([]);
  });

  test("an unlistable declared directory is reported, not swallowed", () => {
    // Was a bare `catch {}` around the whole walk, so a source the process
    // cannot list produced the same output as a source with nothing in it.
    const locked = join(outside, "locked-dir");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "A.md"), "# a\n\nThe DDB pipeline.\n");
    compliance({
      aliases: ["ddb"],
      externalSources: [{ path: locked, type: "spec", target: "specs", method: "copy", matchBy: "content-reference" }],
    });
    chmodSync(locked, 0o000);
    try {
      const r = report();
      if (r.proposals.length === 0 && r.unreadable.length === 0) {
        throw new Error("the directory was neither listed nor reported unreadable");
      }
      expect(r.unreadable.length + r.proposals.length).toBeGreaterThan(0);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe("SC-1645: scaffold reports proposals without applying them", () => {
  test("an adoptable sibling doc appears in the scaffold actions", () => {
    compliance({
      aliases: ["ddb"],
      externalSources: [{ path: outside, type: "spec", target: "specs", method: "copy", matchBy: "content-reference" }],
    });
    externalDoc("POV-SPEC.md", "# POV\n\nThe DDB pipeline consumes this feed.\n");

    const actions: string[] = [];
    reportExternalAdoptionStep(root, actions);

    expect(actions.join("\n")).toContain("PROPOSED: adopt");
    expect(actions.join("\n")).toContain("POV-SPEC.md");
  });

  test("the step writes nothing — adoption stays opt-in", () => {
    compliance({
      aliases: ["ddb"],
      externalSources: [{ path: outside, type: "spec", target: "specs", method: "copy", matchBy: "content-reference" }],
    });
    externalDoc("POV-SPEC.md", "# POV\n\nThe DDB pipeline consumes this feed.\n");

    reportExternalAdoptionStep(root, []);
    expect(
      require("fs").existsSync(join(root, "specs", "POV-SPEC.md")),
      "the scaffold step adopted a document instead of proposing it",
    ).toBe(false);
  });

  test("SC-1645: an unmeasured source reaches the scaffold report too", () => {
    const missing = join(outside, "gone");
    compliance({
      externalSources: [{ path: missing, type: "spec", target: "specs", method: "copy", matchBy: "content-reference" }],
    });
    const actions: string[] = [];
    reportExternalAdoptionStep(root, actions);
    expect(actions.join("\n")).toContain("UNMEASURED");
    expect(actions.join("\n")).toContain(missing);
  });

  test("the step is wired into the scaffold run, not merely exported", () => {
    // A step nothing calls is this issue's defect number one, reintroduced.
    const src = require("fs").readFileSync(
      join(import.meta.dir, "..", "lib", "scaffold", "write-steps.ts"), "utf-8",
    );
    expect(src, "the step is exported and never invoked").toContain("reportExternalAdoptionStep(projectPath, actions)");
  });
});

describe("SC-1646: an empty externalSources list is a recorded decision", () => {
  test("scaffold says it deliberately wrote nothing, rather than staying silent", () => {
    // SC-5. "Nobody configured this" and "this ran and found nothing" are
    // different facts and used to produce the same output: none.
    compliance({});
    const actions: string[] = [];
    reportExternalAdoptionStep(root, actions);

    const line = actions.find(a => a.includes("external adoption"));
    expect(line, "the empty list produced no line at all").toBeDefined();
    expect(line).toContain("deliberately empty");
    expect(line, "the reason is not stated, so the decision is not recorded")
      .toContain("machine-specific");
  });

  test("a configured source that finds nothing says which names it tried", () => {
    // The other half of the same distinction — a scan that ran and matched
    // nothing must be distinguishable from one that never ran.
    compliance({
      aliases: ["ddb"],
      externalSources: [{ path: outside, type: "spec", target: "specs", method: "copy", matchBy: "content-reference" }],
    });
    externalDoc("UNRELATED.md", "# nothing relevant\n");

    const actions: string[] = [];
    reportExternalAdoptionStep(root, actions);
    const line = actions.find(a => a.startsWith("OK: external adoption"));
    expect(line).toBeDefined();
    expect(line, "a miss that does not name the aliases cannot be diagnosed").toContain("ddb");
  });
});
