/**
 * The SC id namespace as it exists on this machine, not in this checkout (#503).
 *
 * `nextSCNumber` allocates "highest + 1", and #392 taught it to read the whole
 * registry rather than one spec's content. Both fixes are about the same
 * mistake at different widths, and the width was still wrong: the registry is
 * `specs/` **in the working tree the command happens to run in**.
 *
 * On 2026-10-16 two sessions allocated `SC-1706..1710` within minutes of each
 * other — one in `specs/HARNESS-STANDARD.md`, one in
 * `specs/CONFIG-DIRECTORY-STRUCTURE-SPEC.md`, in two worktrees of the same
 * repository. Both read the highest id they could see. Both were right about
 * their own tree. `test/spec-sc-ids-unique.test.ts` was green in each,
 * independently, until a rebase put them in one place.
 *
 * That is the second shape in `.claude/rules/checks-must-be-able-to-fail.md`
 * — a detector narrower than what it detects. The question is "is this number
 * free in the project"; the detector answered "is this number free in this
 * checkout". The two differ exactly when more than one session is working,
 * which here is the normal case: this repository has 110 worktrees on disk.
 *
 * ## Two sources, because the collision lives in the gap between them
 *
 * | Source | Catches | Misses |
 * |---|---|---|
 * | sibling worktrees' `specs/` | **uncommitted** ids in another session's tree | a branch whose worktree was removed |
 * | every local and remote-tracking ref | committed ids on any branch, pushed or not | work that exists only on another machine |
 *
 * Neither alone is enough. The #503 collision was an unpushed branch in
 * another worktree, which the ref scan sees only once it is committed —
 * and `.claude/rules/parallel-sessions.md` exists because that window is
 * real and people sit in it for an hour.
 *
 * ## This errs toward "taken", deliberately
 *
 * A stale worktree holding an abandoned branch contributes ids that nothing
 * will ever claim, and the allocator will skip them. That costs a gap in the
 * numbering, which costs nothing: SC ids are opaque join keys, not an
 * ordering anyone reads. The other direction costs a collision, which is two
 * spec lines a test can bind to and no way to see which one it bound to.
 *
 * ## What this is NOT
 *
 * It is not a guard that refuses on a cross-tree duplicate, and that is a
 * measurement rather than a shrug. Across the 110 worktrees on this machine,
 * 30 ids are declared in more than one spec FILE: `SC-A1`/`SC-A2`, which are
 * anti-criteria that several specs legitimately carry, and `SC-694..703`,
 * which is a REAL collision from months ago, resolved on main by renumbering
 * and preserved forever in the stale trees that still hold the losing side.
 * A guard over that population is permanently red for reasons nobody can act
 * on, which is the fastest way to build a refusal everyone learns to click
 * past. Fix the allocator that mints collisions; do not alarm on the fossils.
 */
import { execFileSync, spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

import {
  isFixtureScId,
  scDeclarationPattern,
  scHeadingDeclarationPattern,
  TRACKED_ID_PREFIXES,
} from "./sc-ids";

/**
 * One place ids were looked for, and whether the look succeeded.
 *
 * `worktree` and `refs` are this module's own two sources. The other four
 * are the legs `allocateScNumber` composes on top of them (#593, #725) — the
 * spec's own content, the spec registry, the ids spelled in source, and the
 * reservation store. They live in the same shape because the question a
 * reader asks is one question: which widths produced this number, and did any
 * of them fail to run.
 *
 * `reservations` is the only leg that is not a reading of ids somebody has
 * already written down. It is a reading of ids somebody has DECLARED they are
 * about to write down, which is the half the other five structurally cannot
 * see (#725).
 */
export interface SourceReading {
  label: string;
  kind: "worktree" | "refs" | "spec-content" | "registry" | "source-mentions" | "reservations";
  /** `read` means the ids below came from here; `skipped` means they did not. */
  status: "read" | "skipped";
  /**
   * Why it was skipped — or, on a PARTIAL read, what it could not reach
   * (#606). A leg over four directories that opened three of them is `read`
   * for the three and still owes an account of the fourth; folding that into
   * `skipped` would make it indistinguishable from a leg that opened none.
   * Absent only on a read that reached everything it was pointed at.
   */
  reason?: string;
  /** How many distinct ids this source contributed. */
  found: number;
}

export interface ScNamespaceReading {
  /** id → the labels that declared it. */
  ids: Map<string, string[]>;
  sources: SourceReading[];
  /**
   * Why this reading is a floor rather than a fact. Never empty: a clone on
   * another machine is outside anything this process can see, and saying so
   * is the difference between an unmeasured half and a silent pass
   * (`.claude/rules/config-access.md`).
   */
  unmeasured: string[];
}

function git(root: string, args: string[]): string {
  // 64 MB, because the default is 1 MB and a grep over a thousand refs blows
  // through it. Measured: the first run of this module reported
  // `ENOBUFS (stdout or stderr buffer reached maxBuffer size limit)` as a
  // skipped source, which is the reading behaving correctly over a bug.
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    // Captured, not inherited. A failed `git` here is a source this reading
    // records as skipped, and letting its stderr through would put
    // "fatal: not a git repository" in the middle of a suite's output for a
    // case that is handling exactly that (#60: a test must not corrupt the
    // output stream of the suite containing it).
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Every worktree of this repository except `root` itself.
 *
 * `failure` is non-null when git could not be asked at all — which is a
 * different fact from "there are no siblings", and conflating the two is how
 * a reading of nothing reads as a reading of everything.
 */
export function siblingWorktrees(root: string): { paths: string[]; failure: string | null } {
  let out: string;
  try {
    out = git(root, ["worktree", "list", "--porcelain"]);
  } catch (err) {
    return { paths: [], failure: (err as Error).message.split("\n")[0] };
  }
  const paths: string[] = [];
  let current: string | null = null;
  let prunable = false;
  const flush = (): void => {
    if (current && !prunable && current !== root) paths.push(current);
    current = null;
    prunable = false;
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = line.slice("worktree ".length);
    } else if (line.startsWith("prunable")) {
      prunable = true;
    }
  }
  flush();
  return { paths, failure: null };
}

/** The ids a single `specs/` directory declares, by checkbox or by heading. */
function idsInSpecsDir(specsDir: string): string[] {
  const ids: string[] = [];
  for (const name of readdirSync(specsDir)) {
    if (!name.endsWith(".md")) continue;
    let content: string;
    try {
      content = readFileSync(join(specsDir, name), "utf-8");
    } catch {
      // A spec we cannot read contributes nothing, and the caller records the
      // tree as read regardless: one unreadable file is not an unmeasured
      // tree, and pretending otherwise would make every reading unmeasured.
      continue;
    }
    for (const m of content.matchAll(scDeclarationPattern())) ids.push(m[2]);
    for (const m of content.matchAll(scHeadingDeclarationPattern())) ids.push(m[1]);
  }
  return ids;
}

/**
 * One ref per distinct `specs/` tree, and `null` if that cannot be worked out.
 *
 * `git grep <ref>` searches that ref's tree from scratch. Two refs whose
 * `specs/` is the SAME tree object therefore do the same search twice and
 * return the same lines, because the ids are a pure function of the bytes
 * under `specs/` and a tree SHA is a hash of exactly those bytes. Dropping
 * the second is not a narrowing of what is read — it is the same reading with
 * the repeats removed, which is why it needs no judgement call about which
 * branches "matter". Measured on this repository: 1638 refs, 326 distinct
 * trees, identical id set of 1656 — 0 missing, 0 extra (#1132).
 *
 * 533 of those refs resolve to no `specs/` at all and are dropped outright. A
 * ref with no `specs/` directory cannot match `-- specs/*.md`, so grepping it
 * was always going to return nothing.
 *
 * `null` means the question could not be answered — a `git` that does not
 * support the batching, or output that does not line up with the input. The
 * caller then greps every ref, which is slow and correct. Guessing at a
 * partial mapping would be fast and wrong, and the wrongness is a reissued
 * id rather than an error anyone would see.
 */
function refsByDistinctSpecsTree(root: string, refs: string[]): string[] | null {
  const probe = spawnSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    cwd: root,
    input: refs.map(r => `${r}^{tree}:specs\n`).join(""),
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (probe.error || probe.status !== 0) return null;
  const lines = (probe.stdout ?? "").split("\n").filter(l => l !== "");
  // One line in, one line out. If that does not hold, the index below is
  // pairing a SHA with the wrong ref, and a representative chosen for the
  // wrong tree drops ids that are really there.
  if (lines.length !== refs.length) return null;

  const representative = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    // `<sha> tree` for a ref that has one; `<input> missing` for a ref that
    // does not. Only the first shape is a tree worth searching.
    const match = /^([0-9a-f]{40}) tree$/.exec(lines[i]);
    if (match === null) continue;
    if (!representative.has(match[1])) representative.set(match[1], refs[i]);
  }
  return [...representative.values()];
}

/**
 * Ids declared in `specs/` on any ref this repository holds — local branches
 * and remote-tracking branches both.
 *
 * One `git grep` over every ref at once rather than a checkout each: measured
 * at 0.17s over 1087 refs, against minutes for the obvious implementation.
 *
 * ## …and at 1638 refs that was 7.3s, on the hot path of allocating one id
 *
 * The comment above aged into a wrong number rather than a stale one (#1132).
 * `git grep` over N refs costs N tree searches, and this repository grew from
 * 1087 refs to 1638 while the work per ref stayed the same, so allocating a
 * single SC id came to 17.4s end to end — past the 15s its own caller allows
 * it. The cost is in the ref COUNT, and the ref count is a fact about how
 * many branches are in flight, not about the change being made.
 *
 * `refsByDistinctSpecsTree` removes the repeats rather than picking a
 * narrower population, so the id set is unchanged by construction. The
 * tempting fix is to read `origin/main` only; measured here that reads 1646
 * ids of 1656, and the ten it loses are the ids on unmerged branches, which
 * are precisely the ones this leg exists to see (#503). Its highest id
 * happened to match, so the allocated number was identical and the loss would
 * not have shown up as a wrong answer until the day it collided.
 *
 * `grepped` is reported next to `refs` so a test can bind the scoping without
 * binding a clock — a wall-clock assertion over this is flaky by
 * construction, and the thing that makes it slow is the count.
 */
export function idsInRefs(root: string): { ids: string[]; refs: number; grepped: number; failure: string | null } {
  let refList: string;
  try {
    refList = git(root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]);
  } catch (err) {
    return { ids: [], refs: 0, grepped: 0, failure: (err as Error).message.split("\n")[0] };
  }
  const allRefs = refList.split("\n").filter(r => r.trim() !== "");
  if (allRefs.length === 0) return { ids: [], refs: 0, grepped: 0, failure: null };
  const refs = refsByDistinctSpecsTree(root, allRefs) ?? allRefs;

  const ids: string[] = [];
  // Batched: a ref list this long overruns the argument limit in one call.
  for (let i = 0; i < refs.length; i += 100) {
    let out: string;
    try {
      out = git(root, [
        "grep",
        "-h",
        "-E",
        // Declaration-shaped lines only — a checkbox or a heading. Every
        // mention would be correct and is ~30x the output, which is how the
        // first version hit the buffer limit.
        //
        // The PREFIX comes from `TRACKED_ID_PREFIXES`, and the id's shape is
        // deliberately NOT restated here (#1298). This is a prefilter for the
        // two declaration patterns applied to its output below, so the only
        // error that costs anything is being NARROWER than they are — a
        // dropped line never reaches `matchAll` and reads as an id nobody
        // declared (`.claude/rules/checks-must-be-able-to-fail.md`, second
        // shape). Wider is free: `- [ ] SC-foo:` survives the grep and the
        // parsers reject it. Spelled as a POSIX ERE, which `git grep -E`
        // takes and which has neither `(?:` nor `\d`.
        `^(- \\[.\\] |#+ )(${TRACKED_ID_PREFIXES.join("|")})-`,
        ...refs.slice(i, i + 100),
        "--",
        "specs/*.md",
      ]);
    } catch (err) {
      // git grep exits 1 when nothing matched, which is a real answer and not
      // a failure. Anything else is a failure, and the caller must hear it.
      const status = (err as { status?: number }).status;
      if (status === 1) continue;
      return { ids, refs: allRefs.length, grepped: refs.length, failure: (err as Error).message.split("\n")[0] };
    }
    for (const m of out.matchAll(scDeclarationPattern())) ids.push(m[2]);
    for (const m of out.matchAll(scHeadingDeclarationPattern())) ids.push(m[1]);
  }
  return { ids, refs: allRefs.length, grepped: refs.length, failure: null };
}

/**
 * Every SC id this machine can see, with an account of where it looked.
 *
 * Fixture ids — the reserved 9000s — are dropped. The reservation exists so a
 * fixture can spell an id without claiming it, and counting one as taken
 * would push every future criterion past 9000 and destroy the reservation it
 * was built on. That is `nextSCNumber`'s rule for `spelledInSource`, applied
 * at the same width.
 */
export function readScNamespace(root: string): ScNamespaceReading {
  const ids = new Map<string, string[]>();
  const sources: SourceReading[] = [];
  const unmeasured: string[] = [];

  const record = (id: string, label: string): void => {
    if (isFixtureScId(id)) return;
    const seen = ids.get(id) ?? [];
    if (!seen.includes(label)) seen.push(label);
    ids.set(id, seen);
  };

  const { paths, failure } = siblingWorktrees(root);
  if (failure !== null) {
    sources.push({ label: "git worktree list", kind: "worktree", status: "skipped", reason: failure, found: 0 });
    unmeasured.push(`sibling worktrees could not be enumerated: ${failure}`);
  }
  for (const path of paths) {
    const specsDir = join(path, "specs");
    let usable = false;
    try {
      usable = existsSync(specsDir) && statSync(specsDir).isDirectory();
    } catch {
      usable = false;
    }
    if (!usable) {
      // A worktree git lists but whose tree is gone, or which predates
      // specs/. Recorded rather than dropped: a skipped source is the thing
      // that makes the count below a floor.
      sources.push({ label: path, kind: "worktree", status: "skipped", reason: "no readable specs/ directory", found: 0 });
      unmeasured.push(`${path}: no readable specs/ directory`);
      continue;
    }
    let found: string[];
    try {
      found = idsInSpecsDir(specsDir);
    } catch (err) {
      sources.push({ label: path, kind: "worktree", status: "skipped", reason: (err as Error).message, found: 0 });
      unmeasured.push(`${path}: ${(err as Error).message}`);
      continue;
    }
    for (const id of found) record(id, path);
    sources.push({ label: path, kind: "worktree", status: "read", found: new Set(found).size });
  }

  const refs = idsInRefs(root);
  if (refs.failure !== null) {
    sources.push({ label: "refs", kind: "refs", status: "skipped", reason: refs.failure, found: 0 });
    unmeasured.push(`branch refs could not be read: ${refs.failure}`);
  } else {
    for (const id of refs.ids) record(id, "refs");
    sources.push({
      // Both numbers, because they are different facts. `refs` is how wide
      // the reading was; `grepped` is how many searches that cost. Printing
      // only the second would read as a narrower reading than it is, and
      // printing only the first hides the one number #1132 was about.
      label: refs.grepped === refs.refs
        ? `refs (${refs.refs} local and remote-tracking)`
        : `refs (${refs.refs} local and remote-tracking, ${refs.grepped} distinct specs/ trees searched)`,
      kind: "refs",
      status: "read",
      found: new Set(refs.ids).size,
    });
  }

  // Always present, and not boilerplate: it is the one half of the namespace
  // no process on this machine can reach, and an allocator that did not say
  // so would be claiming a guarantee it cannot give.
  unmeasured.push(
    "ids allocated in a clone on another machine, and not yet pushed or fetched here, are not visible to any of the above",
  );

  return { ids, sources, unmeasured };
}

/**
 * A one-line account of what a reading covered, for a CLI to print.
 *
 * It NAMES the legs rather than counting them (#593). A count says how many
 * sources answered; it cannot say which width went unasked, and a number
 * allocated without consulting the spec registry printed the same
 * "2 source(s)" as one that had. This is the single binding every caller
 * prints through, so there is no second renderer to drift from it.
 */
export function describeReading(reading: ScNamespaceReading): string {
  const read = reading.sources.filter(s => s.status === "read");
  const skipped = reading.sources.filter(s => s.status === "skipped");
  const legs = [...new Set(reading.sources.map(s => s.kind))];
  const parts = [
    `${reading.ids.size} ids across ${read.length} source(s)`,
    `legs: ${legs.join(", ")}`,
    skipped.length > 0 ? `${skipped.length} skipped` : null,
    `${reading.unmeasured.length} unmeasured`,
  ].filter(Boolean);
  return parts.join(", ");
}
