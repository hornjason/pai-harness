/**
 * #840 (Phase 2 of #839) — AC-6: a workflow emitted by an OLDER generator
 * converges to the structure the current generator emits.
 *
 * #839 proved the key-wise top-level merge against the two shapes that
 * existed when it was written: a consumer workflow with a hand-added trigger,
 * and the ci/gates pair that predates `merge_group:`. Both are specific,
 * currently-observable files. The general claim underneath them — that any
 * workflow an older generator wrote converges for WHATEVER key the generator
 * has learned since — was still unproven, because nothing in the repo
 * exercised a key other than `merge_group`.
 *
 * So the skew is manufactured rather than observed, and manufactured from the
 * generator's own output rather than from a literal: scaffold with the
 * current generator, delete one structural sub-key to produce the file an
 * older generator would have written, re-scaffold, and require it back. Every
 * non-`jobs` sub-key the generator emits today gets its own rewind. A key
 * added to `lib/scaffold/steps.ts` tomorrow is covered the day it lands,
 * without this file being edited — which is the difference between proving a
 * mechanism and pinning one example of it.
 *
 * Because the fixture is produced by the change it tests, it cannot falsify
 * #839; it generalises it. That is why it is sequenced after.
 *
 * ## The projection trap, named
 *
 * The cases are DERIVED from the generator, so a mutation that empties the
 * derivation deletes the cases instead of reddening them, and a file that
 * ran zero cases reports the same green as one that ran eight. The loop
 * therefore counts what it ran and asserts the count, and the case below it
 * names two triples it must contain by hand.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createCiWorkflows } from "../lib/scaffold/steps";

/** The files this generator writes whose top-level structure it owns. */
const MANAGED = ["ci.yml", "gates.yml"] as const;

interface Skew {
  file: string;
  key: string;
  sub: string;
}

/** Sub-keys of every non-`jobs` top-level mapping, read out of real output. */
function structuralSubKeys(text: string): { key: string; sub: string }[] {
  const out: { key: string; sub: string }[] = [];
  let key: string | null = null;
  for (const line of text.split("\n")) {
    const top = /^([A-Za-z_][A-Za-z0-9_.\-]*):(?:\s|$)/.exec(line);
    if (top) {
      key = top[1] === "jobs" ? null : top[1];
      continue;
    }
    if (key === null) continue;
    const sub = /^ {2}([A-Za-z0-9_.\-]+):(?:\s|$)/.exec(line);
    if (sub) out.push({ key, sub: sub[1] });
  }
  return out;
}

/**
 * Delete a sub-key, its body and the comments introducing it — the file an
 * older generator, which had not learned the key, would have written.
 */
function rewind(text: string, sub: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex(l => new RegExp(`^ {2}${sub}:(\\s|$)`).test(l));
  if (at < 0) throw new Error(`cannot rewind: no \`  ${sub}:\` in the generated workflow`);
  let from = at;
  while (from > 0 && lines[from - 1].trimStart().startsWith("#")) from--;
  let to = at + 1;
  while (to < lines.length && lines[to].trim() !== "" && lines[to].startsWith("    ")) to++;
  return [...lines.slice(0, from), ...lines.slice(to)].join("\n");
}

interface Repo { root: string; cleanup: () => void }

function scaffolded(): Repo {
  const root = mkdtempSync(join(tmpdir(), "rungate-840-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  createCiWorkflows(root, []);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const wf = (r: Repo, name: string) => join(r.root, ".github", "workflows", name);

/** Every version skew the current generator makes possible. */
function enumerateSkews(): Skew[] {
  const r = scaffolded();
  try {
    return MANAGED.flatMap(file =>
      structuralSubKeys(readFileSync(wf(r, file), "utf-8")).map(s => ({ file, ...s })),
    );
  } finally { r.cleanup(); }
}

describe("#840 AC-6: an older generator's workflow converges on re-scaffold", () => {
  test("the skew set is real, non-empty, and names the keys it should", () => {
    // The guard against the projection trap. The loop below derives its cases
    // from the generator; if that derivation ever returns nothing, the loop
    // runs zero cases and reports green. This case is what notices.
    const skews = enumerateSkews();
    const ids = skews.map(s => `${s.file}:${s.key}.${s.sub}`);
    expect(ids, `the generator yielded no structural sub-keys at all: ${JSON.stringify(ids)}`).toContain(
      "ci.yml:on.merge_group",
    );
    expect(ids).toContain("ci.yml:permissions.contents");
    expect(ids).toContain("gates.yml:on.merge_group");
    expect(ids).toContain("gates.yml:on.pull_request");
    expect(skews.length, `only ${skews.length} skews enumerated: ${ids.join(", ")}`).toBeGreaterThanOrEqual(8);
  });

  test("every structural sub-key the generator emits comes back after being removed", () => {
    const skews = enumerateSkews();
    let checked = 0;
    for (const skew of skews) {
      const r = scaffolded();
      try {
        const current = readFileSync(wf(r, skew.file), "utf-8");
        const older = rewind(current, skew.sub);
        // The subject, established per case rather than assumed: the rewind
        // really removed the key from this file.
        expect(older, `the rewind of ${skew.file}:${skew.sub} removed nothing`).not.toBe(current);
        expect(
          new RegExp(`^ {2}${skew.sub}:`, "m").test(older),
          `${skew.file} still declares ${skew.sub} after the rewind`,
        ).toBe(false);
        writeFileSync(wf(r, skew.file), older);

        const actions: string[] = [];
        createCiWorkflows(r.root, actions);
        expect(
          actions.join("\n"),
          `re-scaffolding ${skew.file} after removing ${skew.key}.${skew.sub} refused:\n${actions.join("\n")}`,
        ).not.toContain("REFUSED");

        const after = readFileSync(wf(r, skew.file), "utf-8");
        expect(
          new RegExp(`^ {2}${skew.sub}:`, "m").test(after),
          `${skew.file} did not converge: ${skew.key}.${skew.sub} is still missing after a re-scaffold`,
        ).toBe(true);
        checked++;
      } finally { r.cleanup(); }
    }
    // Not vacuous. A derivation that returned [] would assert nothing at all.
    expect(checked, "the loop ran no cases").toBe(skews.length);
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  test("convergence is arrival, not oscillation, and it is not an overwrite", () => {
    // Two failure modes a per-key assertion cannot see. A merge that appends
    // the generated sub-key unconditionally converges AND grows the file on
    // every run; a merge that replaces the whole section converges AND
    // destroys the consumer's own content, which is #216.
    const r = scaffolded();
    try {
      const current = readFileSync(wf(r, "ci.yml"), "utf-8");
      writeFileSync(
        wf(r, "ci.yml"),
        rewind(current, "merge_group")
          .replace("\non:\n", "\non:\n  workflow_dispatch:\n")
          .replace(/\njobs:\n/, '\njobs:\n  deploy:\n    runs-on: "ubuntu-latest"\n    steps:\n      - run: ./deploy.sh\n'),
      );

      createCiWorkflows(r.root, []);
      const first = readFileSync(wf(r, "ci.yml"), "utf-8");
      createCiWorkflows(r.root, []);
      const second = readFileSync(wf(r, "ci.yml"), "utf-8");

      expect(second, "the second re-scaffold changed the file again").toBe(first);
      expect(first, "the generated key did not arrive").toContain("merge_group:");
      expect(first, "the consumer's trigger was overwritten by the convergence").toContain("workflow_dispatch:");
      expect(first, "the consumer's job was overwritten by the convergence").toContain("./deploy.sh");
    } finally { r.cleanup(); }
  });
});
