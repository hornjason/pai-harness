import { spawnSync } from "child_process";
import { readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * #1025 — telling a PLANTED artefact from a CHECKED-IN one.
 *
 * Mutation harnesses in this repository build a mutated copy of a real source
 * file and run it. The copy belongs in `tmpdir()`; a copy left inside the
 * repository would be collected by a later `bun test` run as if it were
 * source. The sweep that guards against that used to read the names in
 * `gates/` and `test/` and refuse anything matching `/mutant/i`.
 *
 * A filename is a PROXY for "an artefact was planted", and
 * `.claude/rules/checks-must-be-able-to-fail.md` names what goes wrong with a
 * refusal worded after the proxy rather than after the property: a proxy is a
 * thing people can satisfy directly. This one was satisfiable by renaming a
 * leftover to something without "mutant" in it — which the sweep then missed
 * entirely — and refusable by committing a harness that happened to be called
 * `test/preserve-overlap-mutants.test.ts`, which is what #906 hit on CI with
 * nothing planted and nothing left behind.
 *
 * The property underneath it needs no names. A planted file is UNTRACKED by
 * construction: nothing that writes a scratch file also stages it. A
 * checked-in harness is TRACKED by construction, whatever it is called. git
 * already holds that distinction, and unlike an exemption list it does not
 * grow by one line every time a legitimate file arrives — an allowlist naming
 * the files it exempts stops being a sweep and becomes the evidence that
 * those files are accounted for.
 */

/**
 * Nothing in this tree comes close: `gates/workflow.test.ts`, the largest
 * source a mutant is copied from, is 96 KB. The cap exists so an untracked
 * binary fixture is skipped rather than read into memory as UTF-8, and it is
 * on the file's SIZE rather than on its name or extension for the same reason
 * the sweep is not a name filter.
 */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

/**
 * Every path git does not track under `dirs`, relative to `root`, sorted.
 *
 * `--untracked-files=all` descends INTO an untracked directory instead of
 * reporting the directory as one entry, so a file planted inside a new folder
 * is listed rather than hidden behind its parent. Passing the flag explicitly
 * also survives a checkout configured with `status.showUntrackedFiles=no`,
 * where the default reading is empty and every sweep built on it is silently
 * total — the trap `test/ai-review-git-config-isolation.test.ts` records.
 *
 * `-z` because git C-quotes any path holding a byte outside ASCII in the
 * default porcelain format (`"test/caf\303\251.ts"`), and a sweep that
 * reports a quoted name has reported a path that does not exist.
 *
 * Throws rather than returning `[]` when git cannot answer. An empty list
 * means "nothing is planted"; a failed read means "I could not look", and the
 * whole point of this module is to stop a check from saying the first when it
 * means the second.
 */
export function untrackedUnder(root: string, dirs: string[]): string[] {
  const res = spawnSync(
    "git",
    ["-C", root, "status", "--porcelain", "-z", "--untracked-files=all", "--", ...dirs],
    { encoding: "utf-8" },
  );
  if (res.error || res.status !== 0) {
    throw new Error(
      `cannot read the untracked files under ${root}: git status exited ${res.status}\n` +
        `${res.error?.message ?? ""}${res.stderr ?? ""}`,
    );
  }
  return res.stdout
    .split("\0")
    .filter(entry => entry.startsWith("?? "))
    .map(entry => entry.slice(3))
    .filter(Boolean)
    .sort();
}

/**
 * The subset of `rels` whose CONTENT contains `marker`.
 *
 * Reading the content rather than matching the name is the same choice again,
 * one level down: a mutant is a file carrying the mutation, not a file with a
 * particular word in its path.
 *
 * A path that vanished between the listing and the read is not a finding —
 * the listing is a snapshot, and another process clearing its own scratch is
 * the system working.
 */
export function pathsContaining(root: string, rels: string[], marker: string): string[] {
  return rels.filter(rel => {
    const abs = join(root, rel);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      return false;
    }
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return false;
    try {
      return readFileSync(abs, "utf-8").includes(marker);
    } catch {
      return false;
    }
  });
}
