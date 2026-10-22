/**
 * Covers SC-823, SC-824 (HARNESS-STANDARD.md) — what the publish-window
 * tolerance is allowed to accept as evidence that a release was triggered.
 *
 * #1237 shipped `releaseTagTime` as the separator between *the registry does
 * not have it YET* and *somebody bumped the version and never published*.
 * Those two states are observationally identical at the instant you look, so
 * the whole tolerance rests on this one reading — and as first written the
 * reading was:
 *
 *     git -C <root> log -1 --format=%cI v<version>
 *
 * which is **a local ref read out of the checkout being measured**, by a
 * revision name that is not required to be a tag at all. Three separable
 * defects, each with its own case below:
 *
 *   1. `v<version>` is a revision-or-pathspec. A local BRANCH named `v1.2.3`
 *      resolves it, and so does a path.
 *   2. `%cI` is the committer date of the commit the tag points at — when the
 *      code was written, not when the release was cut.
 *   3. `release.yml` fires on **push**. An UNPUSHED local tag is not evidence
 *      that anything was triggered, and it bought a full `PUBLISH_WINDOW_MS`
 *      of tolerance. The party being measured could mint its own exemption.
 *
 * ## The fixture has a real remote, deliberately
 *
 * `git init` alone has no remote, and a `ls-remote` against a repository with
 * no origin fails for a reason that has nothing to do with the tag — which
 * would make every case below pass while witnessing nothing. So the fixture
 * builds a bare repository and pushes to it, and the PUSHED case asserts a
 * non-null reading: without that third row, an implementation that returned
 * `null` unconditionally would satisfy all the others.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PUBLISH_WINDOW_MS, publishState, releaseTagTime, type Packument } from "../lib/publish-window";

let scratch: string;
let work: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "rg-tag-evidence-"));
  const origin = join(scratch, "origin.git");
  work = join(scratch, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", work], { stdio: "ignore" });
  git(work, "config", "user.email", "fixture@example.invalid");
  git(work, "config", "user.name", "fixture");
  git(work, "commit", "--allow-empty", "-m", "base");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");

  // 1.0.0 — tagged locally and NEVER pushed.
  git(work, "tag", "v1.0.0");
  // 2.0.0 — a BRANCH with that name, no tag anywhere.
  git(work, "branch", "v2.0.0");
  // 3.0.0 — tagged and pushed. The real thing.
  git(work, "tag", "v3.0.0");
  git(work, "push", "-q", "origin", "v3.0.0");
  // A tag whose name is not a version at all, pushed, so the version guard
  // cannot pass merely because nothing was there to find.
  git(work, "tag", "vnot-a-version");
  git(work, "push", "-q", "origin", "vnot-a-version");
  // 4.0.0 — pushed, then the LOCAL ref is moved to a different commit. The
  // remote still serves the original. This is the shadowing case: without
  // pinning the date to the remote's object, a local ref could be repointed
  // at something fresher and extend its own window.
  git(work, "tag", "v4.0.0");
  git(work, "push", "-q", "origin", "v4.0.0");
  git(work, "commit", "--allow-empty", "-m", "later");
  git(work, "tag", "-f", "v4.0.0");
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("#1237 the evidence must come from the remote, not the measured checkout", () => {
  test("a local-only tag is NOT evidence a release was triggered", () => {
    // The defect this case exists for: `release.yml` triggers on a tag PUSH,
    // so an unpushed ref proves nothing — and it bought ninety minutes of
    // tolerance for exactly the state that must stay red.
    expect(
      releaseTagTime(work, "1.0.0"),
      "an unpushed local tag still buys the publish-window tolerance",
    ).toBeNull();
  });

  test("the local-only tag really is there — the case above is not vacuous", () => {
    // Without this the row above passes on a repository where nothing was
    // tagged at all, which is the "two empty collections" shape.
    expect(git(work, "tag", "--list", "v1.0.0").trim()).toBe("v1.0.0");
  });

  test("a BRANCH named v<version> is not a tag", () => {
    expect(releaseTagTime(work, "2.0.0")).toBeNull();
  });

  test("...and the old reading did resolve it, which is why the case is here", () => {
    // The positive control on defect 1. `git log -1 v2.0.0` is what shipped,
    // and it resolves a branch as readily as a tag. If this ever stops
    // resolving, the case above has stopped testing anything.
    const resolved = execFileSync("git", ["-C", work, "log", "-1", "--format=%cI", "v2.0.0"], {
      encoding: "utf-8",
    }).trim();
    expect(resolved, "a branch named v2.0.0 no longer resolves as a revision").toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  test("a tag that IS on the remote reads a date", () => {
    // The row people forget. An implementation that returns `null`
    // unconditionally satisfies every other case in this file.
    expect(releaseTagTime(work, "3.0.0"), "a genuinely pushed release tag read as absent").toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  test("a version string that is not a version is refused before any git runs", () => {
    // `vnot-a-version` is tagged AND pushed, so this can only be null because
    // the guard refused the input rather than because the ref was missing.
    expect(releaseTagTime(work, "not-a-version")).toBeNull();
    expect(git(work, "ls-remote", "--tags", "origin", "refs/tags/vnot-a-version")).toContain(
      "refs/tags/vnot-a-version",
    );
  });

  test("a ref name that would be a pathspec or an option is refused", () => {
    expect(releaseTagTime(work, "--all")).toBeNull();
    expect(releaseTagTime(work, "HEAD")).toBeNull();
    expect(releaseTagTime(work, "")).toBeNull();
  });

  test("a prerelease and a build-metadata version are still versions", () => {
    // The guard must not be so tight that a legitimate release cannot earn
    // the tolerance. These resolve to null here only because no such tag was
    // pushed — the point is that they reach the git read at all.
    expect(() => releaseTagTime(work, "1.2.3-rc.1")).not.toThrow();
    expect(() => releaseTagTime(work, "1.2.3+build.5")).not.toThrow();
  });

  test("a local tag repointed away from the pushed one reads as absent", () => {
    // Shadowing. `ls-remote` says v4.0.0 exists, so existence alone would
    // accept it — and the local ref now points at a later commit, which is
    // the fresher date an attacker-or-accident would want. The reading is
    // pinned to the remote's object id, so it refuses instead.
    expect(releaseTagTime(work, "4.0.0")).toBeNull();
  });

  test("...and v4.0.0 really is on the remote — that case is not vacuous", () => {
    expect(git(work, "ls-remote", "--tags", "origin", "refs/tags/v4.0.0")).toContain(
      "refs/tags/v4.0.0",
    );
    expect(git(work, "tag", "--list", "v4.0.0").trim()).toBe("v4.0.0");
  });

  test("an unreadable repository is null, which is the fail-CLOSED direction", () => {
    // `.claude/rules/config-access.md` bans the fail-OPEN version of a bare
    // catch around a read. This one falls the other way on purpose: an
    // unreadable repo yields NEVER_PUBLISHED, never the tolerance.
    expect(releaseTagTime(join(scratch, "no-such-repo"), "3.0.0")).toBeNull();
  });
});

describe("#1237 the reading feeds the classifier, and the window still bounds it", () => {
  const REGISTRY: Packument = {
    latest: "2.9.0",
    versions: ["2.8.0", "2.9.0"],
    time: {
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-10-22T19:04:38.113Z",
      "2.8.0": "2026-10-22T15:15:23.092Z",
      "2.9.0": "2026-10-22T19:04:37.788Z",
    },
  };

  test("pushed tag inside the window — PUBLISH_PENDING", () => {
    const tagged = releaseTagTime(work, "3.0.0")!;
    expect(tagged).not.toBeNull();
    expect(
      publishState({
        treeVersion: "3.0.0",
        packument: REGISTRY,
        releaseTagAt: tagged,
        now: new Date(Date.parse(tagged) + 60_000),
      }),
    ).toBe("PUBLISH_PENDING");
  });

  test("the same pushed tag outside the window — NEVER_PUBLISHED", () => {
    const tagged = releaseTagTime(work, "3.0.0")!;
    // Without this line the case passes vacuously against a reader that
    // returns `null` for everything: a null reading reaches NEVER_PUBLISHED
    // by the no-tag branch and the expectation below cannot tell the two
    // routes apart. Measured — mutating the reader to `return null` left
    // this row green until the assertion was added.
    expect(tagged, "the reading this case varies the clock on was never taken").not.toBeNull();
    expect(
      publishState({
        treeVersion: "3.0.0",
        packument: REGISTRY,
        releaseTagAt: tagged,
        now: new Date(Date.parse(tagged) + PUBLISH_WINDOW_MS + 1),
      }),
    ).toBe("NEVER_PUBLISHED");
  });

  test("the local-only tag cannot reach PUBLISH_PENDING at all", () => {
    // The two rows above differ only in the clock. This one differs in the
    // evidence, and it is the defect the review found: before the fix, 1.0.0
    // was indistinguishable from 3.0.0 here.
    expect(
      publishState({
        treeVersion: "1.0.0",
        packument: REGISTRY,
        releaseTagAt: releaseTagTime(work, "1.0.0"),
        now: new Date(),
      }),
    ).toBe("NEVER_PUBLISHED");
  });
});
