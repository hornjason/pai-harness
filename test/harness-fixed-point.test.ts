/**
 * #827: the harness is a fixed point of its own generator.
 *
 * The property, stated once: run `scaffold . --fix` on a clean checkout of
 * this repository and NO tracked file changes. Run it a second time and
 * nothing changes either. Those are two different claims and this file
 * asserts them separately — a generator that converges in one application
 * satisfies the second and fails the first, which is exactly the state main
 * was in when #827 was filed, and a single assertion cannot tell them apart.
 *
 * ## Why this is not a per-file assertion
 *
 * #827 named five drifting files. Four of them were main being one
 * application stale and one was a generator that could never converge. A
 * suite with five per-file cases goes green the moment somebody commits the
 * generator's output, and says nothing about the sixth file that drifts next
 * month. The property is `git status --porcelain` being empty, over the whole
 * tree, with no file list anywhere in this file for a fix to be written
 * against.
 *
 * ## Why the fixture has an origin remote
 *
 * #827's own reproduction recipe was `git archive origin/main` into an empty
 * directory followed by `git init`, which produces a repository with NO
 * `origin` remote. `scan.repoUrl` is `git remote get-url origin`, so the
 * export answered `""`, and AGENTS.md's repo line became the TODO comment
 * that the issue reported as its headline defect — "the only destructive
 * one". It was the recipe. Measured both ways one command apart: with a
 * remote the repo URL is preserved and only `updated:` moves.
 *
 * So the remote is read off the real repository and set on the export, and
 * a repository with no remote to copy is UNMEASURED rather than a tree that
 * quietly reproduces the confound. A fixture that manufactures the defect it
 * reports is worse than no fixture.
 *
 * Related: `.claude/rules/checks-must-be-able-to-fail.md`.
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, cpSync, existsSync, readFileSync, writeFileSync, symlinkSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { generateAgentsMd } from "../lib/generators/agents-md";
import { mockProjectScan } from "../lib/generators/types";

const ROOT = join(import.meta.dir, "..");

/** `git -C cwd <args>`, as text. `null` means the command failed. */
function git(cwd: string, args: string[]): string | null {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { timeout: 60_000 });
  if (r.exitCode !== 0) return null;
  return r.stdout.toString();
}

export interface FixedPointReading {
  /**
   * Whether the comparison happened at all. An instrument that could not run
   * reports UNMEASURED and the caller FAILS on it — `0`, `[]` and silence are
   * indistinguishable from a clean tree, and the whole subject of #827 is a
   * run whose output nothing was reading.
   */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  /** Tracked files copied into the export. A floor, read before any drift. */
  examined: number;
  /** Paths `git status --porcelain` reported after the FIRST application. */
  run1: string[];
  /** …and after the second, with the first's output committed in between. */
  run2: string[];
  /**
   * Files whose committed frontmatter declares `scanned-at-sha:` — a value
   * derived from the repository's own HEAD, which a copy under a different
   * HEAD cannot reproduce. Excluded from `run1`/`run2` and reported by name
   * with the witness asserted, so the exclusion is a measured property of the
   * file rather than a list somebody maintains.
   */
  incomparable: string[];
  /** Steps the scaffold reported as deferred because its output looked fresh. */
  deferred: string[];
  /** The scaffold's own action log, for the deferral reading and for failures. */
  log: string;
  /** The bytes that differ, so a reader can classify the drift rather than guess. */
  diff: string;
}

const UNREADABLE: Omit<FixedPointReading, "unmeasuredReasons"> = {
  reading: "UNMEASURED",
  examined: 0,
  run1: [],
  run2: [],
  incomparable: [],
  deferred: [],
  log: "",
  diff: "",
};

/** The frontmatter block of `content`, or `""` when it has none. */
function frontmatterOf(content: string): string {
  return content.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
}

/** Paths in `git status --porcelain` output. */
function porcelainPaths(out: string): string[] {
  return out
    .split("\n")
    .filter(l => l.trim().length > 0)
    .map(l => l.slice(3).trim())
    .sort();
}

/**
 * Export this repository's tracked WORKING TREE into `work`, give it the real
 * repository's origin remote, and apply the generator twice.
 *
 * The working tree rather than `HEAD` on purpose: the claim is about the tree
 * you are standing in, so an uncommitted change to a generator is measured by
 * the same run that would catch a stale committed file.
 */
export function fixedPointReading(root: string, work: string): FixedPointReading {
  const reasons: string[] = [];

  const listed = git(root, ["ls-files", "-z"]);
  if (listed === null) return { ...UNREADABLE, unmeasuredReasons: ["`git ls-files` failed — the export has no file list"] };
  const tracked = listed.split("\0").filter(p => p.length > 0);
  if (tracked.length === 0) return { ...UNREADABLE, unmeasuredReasons: ["`git ls-files` returned nothing — there is no tree to compare"] };

  const tree = join(work, "tree");
  mkdirSync(tree, { recursive: true });
  let examined = 0;
  for (const rel of tracked) {
    const from = join(root, rel);
    // A tracked file deleted in the working tree is not a copy failure; the
    // export is the working tree, and `git status` will not report it either.
    if (!existsSync(from)) continue;
    mkdirSync(dirname(join(tree, rel)), { recursive: true });
    cpSync(from, join(tree, rel));
    examined++;
  }

  // The generator imports from node_modules; a run that cannot resolve its
  // imports exits non-zero, which the refusal below reports rather than
  // letting an aborted run read as a tree with no drift.
  symlinkSync(join(root, "node_modules"), join(tree, "node_modules"));

  const remote = git(root, ["remote", "get-url", "origin"])?.trim();
  if (!remote) {
    return {
      ...UNREADABLE,
      examined,
      unmeasuredReasons: [
        "the repository under test has no `origin` remote, so the export cannot be given one — " +
        "and an export with no remote reproduces #827's recipe confound instead of measuring the generator",
      ],
    };
  }

  if (
    git(tree, ["init", "-q"]) === null ||
    git(tree, ["add", "-A"]) === null ||
    git(tree, ["-c", "user.email=fixed-point@test", "-c", "user.name=fixed-point", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "export"]) === null ||
    git(tree, ["remote", "add", "origin", remote]) === null
  ) {
    return { ...UNREADABLE, examined, unmeasuredReasons: ["the export could not be made into a git repository with a remote"] };
  }

  const incomparable = tracked
    .filter(rel => existsSync(join(root, rel)))
    .filter(rel => /^scanned-at-sha:/m.test(frontmatterOf(readFileSync(join(root, rel), "utf-8"))))
    .sort();

  const apply = (): { drift: string[] | null; diff: string; log: string } => {
    const r = Bun.spawnSync(["bun", join(tree, "bin", "rungate.ts"), "scaffold", ".", "--fix"], {
      cwd: tree,
      timeout: 300_000,
    });
    const log = r.stdout.toString() + r.stderr.toString();
    if (r.exitCode !== 0) return { drift: null, diff: "", log };
    const status = git(tree, ["status", "--porcelain"]);
    if (status === null) return { drift: null, diff: "", log };
    const drift = porcelainPaths(status).filter(p => !incomparable.includes(p));
    // The paths alone cannot tell a stale file from a non-deterministic one,
    // and those have different fixes. Carry the bytes that differ.
    const diff = drift.length === 0 ? "" : (git(tree, ["diff", "--", ...drift]) ?? "(the diff could not be read)");
    return { drift, diff, log };
  };

  const first = apply();
  if (first.drift === null) {
    return { ...UNREADABLE, examined, incomparable, unmeasuredReasons: ["the first `scaffold . --fix` did not complete"], log: first.log };
  }

  // Commit whatever the first run produced, so the second run measures
  // convergence rather than re-reporting the first run's own output.
  if (
    git(tree, ["add", "-A"]) === null ||
    (first.drift.length + porcelainPaths(git(tree, ["status", "--porcelain"]) ?? "").length > 0 &&
      git(tree, ["-c", "user.email=fixed-point@test", "-c", "user.name=fixed-point", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "run1"]) === null)
  ) {
    return { ...UNREADABLE, examined, incomparable, unmeasuredReasons: ["the first run's output could not be committed"], log: first.log };
  }

  const second = apply();
  if (second.drift === null) {
    return { ...UNREADABLE, examined, incomparable, unmeasuredReasons: ["the second `scaffold . --fix` did not complete"], log: first.log + second.log };
  }

  const deferred = [...first.log.matchAll(/^\s*SKIP: (\S+) \(.*still fresh\)/gm)].map(m => m[1]).sort();

  return {
    reading: "MEASURED",
    unmeasuredReasons: [],
    examined,
    run1: first.drift,
    run2: second.drift,
    incomparable,
    deferred,
    log: first.log + second.log,
    diff: first.diff + second.diff,
  };
}

describe("#827: the harness is a fixed point of its own generator", () => {
  const work = mkdtempSync(join(tmpdir(), "harness-fixed-point-"));
  let r: FixedPointReading;
  try {
    r = fixedPointReading(ROOT, work);
  } finally {
    // Nothing below reads the export again; the reading carries everything.
    rmSync(work, { recursive: true, force: true });
  }

  test("#827 / AC-0: the comparison ran — an instrument that stopped reporting is not a clean tree", () => {
    expect(
      r.unmeasuredReasons,
      `the fixed-point comparison could not be taken. This FAILS rather than skipping: an ` +
      `unmeasured run and a clean tree produce the same empty list, and #827 is an issue about ` +
      `a run nobody was reading.\n${r.log.slice(-4000)}`,
    ).toEqual([]);
    expect(r.reading).toBe("MEASURED");
  });

  test("#827 / AC-1: the export carried the tree — zero files compared is not agreement", () => {
    // A floor, not an equality: the count is a property of the repository and
    // not of this case, and an equality would red on somebody else's merge.
    expect(r.examined).toBeGreaterThan(500);
  });

  test("#827 / AC-2: a clean tree stays clean — `scaffold . --fix` rewrites no tracked file", () => {
    expect(
      r.run1,
      `\`bun bin/rungate.ts scaffold . --fix\` rewrote tracked files on a clean export of this ` +
      `tree, so the repository is not a fixed point of its own generator (#827).\n\n` +
      `For each file, say WHICH of these it is before fixing it — they have different fixes and ` +
      `conflating them empties the diff without making the harness a fixed point:\n` +
      `  1. the generator's output is genuinely newer — the committed file is stale, regenerate ` +
      `and commit it;\n` +
      `  2. the committed file is right and the generator is wrong — fix the generator;\n` +
      `  3. the file is not supposed to be generated here — narrow \`--fix\`;\n` +
      `  4. the difference is a date, a sha or an ordering — that is a determinism defect, and ` +
      `deriving the field from the content (as #827 did for AGENTS.md's \`updated:\`) is the fix, ` +
      `not exempting the file.\n\n${r.diff.slice(0, 20000)}`,
    ).toEqual([]);
  });

  test("#827 / AC-3: the second application is a no-op — the generator converges", () => {
    expect(
      r.run2,
      `a second \`scaffold . --fix\`, with the first run's output committed, rewrote tracked ` +
      `files again. This is a different defect from AC-2: the generator does not converge at ` +
      `all, so committing its output never clears the drift.`,
    ).toEqual([]);
  });

  test("#827 / AC-4: every file held outside the comparison carries its own witness", () => {
    // Not a list anybody maintains. A file is incomparable because its own
    // committed frontmatter declares `scanned-at-sha:` — a value derived from
    // this repository's HEAD, which a copy under a different HEAD cannot
    // reproduce. Delete the field and the file re-enters the comparison.
    for (const rel of r.incomparable) {
      const fm = frontmatterOf(readFileSync(join(ROOT, rel), "utf-8"));
      expect(fm, `${rel} is held outside the fixed-point comparison but declares no \`scanned-at-sha:\``)
        .toMatch(/^scanned-at-sha:/m);
    }
    // The witness has to be reachable, or this loop runs zero times and
    // asserts nothing while reading as a clean result.
    expect(
      r.incomparable,
      "no file in this tree declares `scanned-at-sha:` in its frontmatter any more. That is not " +
      "a failure — it means the exclusion has no subject and this case plus the filter in " +
      "`fixedPointReading` should be deleted rather than left asserting nothing.",
    ).not.toEqual([]);
  });

  test("#827 / AC-5: a step the run deferred is named, and a NEW deferral is a failure", () => {
    // A staleness heuristic that defers regeneration is a step that did not
    // run. It must not read as a step that ran and found nothing. CODE-MAP.md
    // is the one the tree has (14 days / 50 commits, `lib/scaffold/steps.ts`),
    // and it is also the file AC-4 holds outside the comparison, so a change
    // to the heuristic cannot quietly widen what AC-2 never looked at.
    expect(
      r.deferred,
      `the scaffold deferred a step on freshness grounds that this case does not know about. A ` +
      `deferred step is UNMEASURED, not clean: AC-2 cannot see drift in output that was never ` +
      `regenerated. Either make the step run, or record it here with the reason.`,
    ).toEqual(["CODE-MAP.md"]);
  });
});

describe("#827: AGENTS.md's `updated:` dates the content, not the run", () => {
  /**
   * The one field in the tree that could never converge. `buildFrontmatter`
   * forced `updated: localCalendarDay()` AFTER the spread that carries the
   * existing block forward, so the stamp could not survive a run: main's
   * committed value was `2026-10-17` and a run on 2026-10-20 produced
   * `2026-10-20` with nothing else in the file different. AGENTS.md was a
   * fixed point on the day it was written and stopped being one the next
   * morning, with no code or spec change in between.
   *
   * The pair below varies exactly ONE thing — whether the body changed — and
   * holds the clock fixed at a day neither file was written on. A pair that
   * also moved the date would be measuring the date.
   */
  const FUTURE = "2099-06-01";

  function fixture(frontmatter: string, bodyFrom: (root: string) => string): { root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "agents-md-updated-"));
    const scan = { ...mockProjectScan(), root };
    // The body is the generator's own output for this scan, obtained by
    // generating into an EMPTY directory first. It is not copied out of the
    // template or rebuilt from the same array the generator reads, because a
    // witness planted from the thing under test moves when the thing moves.
    const body = bodyFrom(root);
    writeFileSync(join(root, "AGENTS.md"), frontmatter + body);
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  /** The generator's body for a scan rooted at `root`, with no file present. */
  function generatedBody(root: string): string {
    const out = generateAgentsMd({ ...mockProjectScan(), root }, FUTURE);
    return out.slice(out.match(/^---\n[\s\S]*?\n---\n\n/)![0].length);
  }

  test("#827 / AC-6: an unchanged body keeps its stamp, on a later day", () => {
    const { root, cleanup } = fixture(
      `---\ndoc-type: reference\nstatus: active\nowner: jason\nupdated: 2026-10-17\n---\n\n`,
      generatedBody,
    );
    try {
      const out = generateAgentsMd({ ...mockProjectScan(), root }, FUTURE);
      expect(out).toContain("updated: 2026-10-17");
      expect(out).not.toContain(`updated: ${FUTURE}`);
      // And the whole file round-trips, which is the property AC-2 needs and
      // which `toContain` on one line does not establish.
      expect(generateAgentsMd({ ...mockProjectScan(), root }, FUTURE))
        .toBe(readFileSync(join(root, "AGENTS.md"), "utf-8"));
    } finally {
      cleanup();
    }
  });

  test("#827 / AC-7: a CHANGED body does move the stamp to today", () => {
    // The control, and the case that does not survive the cheapest wrong fix.
    // "Stop writing `updated:` at all" makes AGENTS.md a fixed point in one
    // line and makes this case red, which is the point of writing it: the
    // freshness signal doc-hygiene reads is not expendable, so the fix has to
    // be the one that gives both properties rather than the one that drops a
    // field.
    const { root, cleanup } = fixture(
      `---\ndoc-type: reference\nstatus: active\nowner: jason\nupdated: 2026-10-17\n---\n\n`,
      root => generatedBody(root) + "\n<!-- a hand edit the generator will not reproduce -->\n",
    );
    try {
      const out = generateAgentsMd({ ...mockProjectScan(), root }, FUTURE);
      expect(out).toContain(`updated: ${FUTURE}`);
      expect(out).not.toContain("updated: 2026-10-17");
    } finally {
      cleanup();
    }
  });

  test("#827 / AC-8: a file that was never there gets today's stamp, not a carried one", () => {
    // An absent file has no stamp to carry, and a missing `updated:` must not
    // read as freshness. Without this the carry-forward could be written as
    // "never write the field", which AC-7 catches, or as "write whatever was
    // there", which only this catches.
    const root = mkdtempSync(join(tmpdir(), "agents-md-absent-"));
    try {
      expect(generateAgentsMd({ ...mockProjectScan(), root }, FUTURE)).toContain(`updated: ${FUTURE}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#827 / AC-9: the carried stamp survives a hand-set owner and custom keys", () => {
    const { root, cleanup } = fixture(
      `---\ndoc-type: reference\nstatus: active\nowner: someone-else\nupdated: 2026-01-02\nteam: platform\n---\n\n`,
      generatedBody,
    );
    try {
      const out = generateAgentsMd({ ...mockProjectScan(), root }, FUTURE);
      expect(out).toContain("owner: someone-else");
      expect(out).toContain("updated: 2026-01-02");
    } finally {
      cleanup();
    }
  });
});
