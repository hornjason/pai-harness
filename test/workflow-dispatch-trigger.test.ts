/**
 * #940 — a generated CI workflow could not be re-run on demand.
 *
 * Measured across the fleet on 2026-10-21: re-running CI on `main` succeeded
 * for 1 of 6 (repo, workflow) pairs. The other five came back
 *
 *     HTTP 422: Workflow does not have 'workflow_dispatch' trigger
 *
 * and the one that worked does so because a consumer hand-added the trigger
 * above its own `pull_request:`. The generator emits none, so on an untouched
 * consumer a flake cannot be told from a real failure without pushing an empty
 * commit, and a fix on `main` cannot be confirmed without waiting for
 * unrelated traffic. Same family as #839/#867: a trigger whose absence is not
 * an error anywhere, just a capability nobody has.
 *
 * ## The two directions, and why one of them alone proves nothing
 *
 * - A consumer that LACKS the trigger must gain it on re-scaffold. That is the
 *   whole point of #917's sub-key merge — without it the fix reaches new
 *   scaffolds only, and every repo in the 422 list stays broken.
 * - A consumer that ALREADY DECLARES it must not be disturbed. The hand-added
 *   one sits in the consumer's own position with no comment, and a merge that
 *   moved it, duplicated it, or overwrote the branch lists around it would
 *   satisfy the first direction completely.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Hand-add `workflow_dispatch:` to the consumers' checked-in workflows.** It
 * is what an operator does at 5pm: the 422 stops, every repo can be re-run,
 * and nothing in this harness has changed — so the next `bunx rungate
 * scaffold .` on a repo that has not been hand-edited produces the same file
 * it always did. AC-1 survives it, because it drives the real generator into
 * a temp directory and no edit to a consumer's checkout can be seen from
 * there.
 *
 * The second-cheapest is inside the merge rather than the generator: **return
 * the generated `on:` section whenever the generator emits one.** AC-1 goes
 * green and AC-2 goes red, which is #839's argument restated one key down.
 *
 * ## `ai-review.yml` is deliberately excluded
 *
 * It triggers on `pull_request` and `merge_group` and never on `push`, so the
 * "re-run it on main" case that motivates this issue does not exist for it. On
 * a `workflow_dispatch` there is no pull request to diff, so the job would
 * reach the review path with nothing to review — a run that either errors or
 * produces a vacuous review, which is worse than no button. #867 added
 * `merge_group` there because an absent trigger on a REQUIRED context hangs a
 * merge queue silently; `workflow_dispatch` carries no equivalent forcing
 * function, and a PR's existing run can already be re-run from the checks UI.
 * If it is wanted later it needs #867's treatment — an explicit vacuous-event
 * branch in the report step — not a bare trigger, and AC-3 is the case to
 * change when that is written.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createCiWorkflows } from "../lib/scaffold/steps";

/** The files the trigger belongs in. `ai-review.yml` is AC-3's subject. */
const DISPATCHABLE = ["ci.yml", "gates.yml"];

interface Repo { root: string; cleanup: () => void }

function repo(config?: Record<string, unknown>): Repo {
  const root = mkdtempSync(join(tmpdir(), "rungate-940-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  if (config) {
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(join(root, ".claude", "rungate", "config.json"), JSON.stringify(config, null, 2));
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const wf = (r: Repo, name: string) => join(r.root, ".github", "workflows", name);
const read = (r: Repo, name: string) => readFileSync(wf(r, name), "utf-8");

/**
 * The TRIGGER as a line, counted, not the word anywhere in the file.
 *
 * Counted rather than tested for presence because the failure this is most
 * likely to meet is a SECOND copy appended beside a consumer's own, and a
 * `toContain` reads that as success.
 */
const dispatchLines = (text: string) =>
  text.split("\n").filter(l => l.trim() === "workflow_dispatch:").length;

/**
 * The authorship stamp `lineCommentProvenance` writes, and the file without
 * it. Sliced off rather than ignored, because it is a digest OF the body: it
 * changes whenever the bytes do, so a whole-file comparison can never say
 * whether the content was preserved (`.claude/rules/harness-managed.md`).
 */
const MARKER = /^# generated-sha: [0-9a-f]{16}\n/;
const markerOf = (text: string) => MARKER.exec(text)?.[0] ?? null;
const bodyOf = (text: string) => text.replace(MARKER, "");

/**
 * The sub-keys of `on:`, in order, read from that section ALONE.
 *
 * Sliced rather than grepped: `  test:` under `jobs:` has the same shape as a
 * trigger two indents in, so a whole-file scan answers a question about job
 * names (`.claude/rules/checks-must-be-able-to-fail.md`, "search the slice").
 * An empty result is a refusal, because a slice that missed its own section
 * contains nothing, which is indistinguishable from a clean reading.
 */
function onSubKeys(text: string): string[] {
  const lines = text.split("\n");
  const { start, end } = onRegion(lines);
  const out: string[] = [];
  for (let i = start + 1; i < end; i++) {
    const m = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):/.exec(lines[i]);
    if (m) out.push(m[1]);
  }
  if (out.length === 0) throw new Error("the on: slice found no sub-keys at all");
  return out;
}

/**
 * Append a bodyless sub-key at the END of `on:`.
 *
 * Located structurally — the first column-zero line after `on:` ends the
 * section — and NOT by anchoring on whichever top-level key happens to come
 * next. #942 inserted `concurrency:` between `on:` and `permissions:` while
 * this branch was open, and a `"\n\npermissions:\n"` anchor silently stopped
 * describing the end of `on:` (`.claude/rules/checks-must-be-able-to-fail.md`
 * — a fixture whose margin is set by something outside it). A section this
 * cannot find is a refusal, not an append at position zero.
 */
function appendOnSubKey(text: string, key: string): string {
  const lines = text.split("\n");
  const { end } = onRegion(lines);
  // After the last INDENTED line, which is the last thing belonging to a
  // sub-key — not after the region's final line, which may be a column-zero
  // comment block introducing the next top-level key.
  let lastContent = -1;
  for (let i = onRegion(lines).start + 1; i < end; i++) {
    if (/^\s/.test(lines[i]) && lines[i].trim() !== "") lastContent = i;
  }
  if (lastContent < 0) throw new Error("the on: section has no sub-keys to append after");
  return [...lines.slice(0, lastContent + 1), `  ${key}:`, ...lines.slice(lastContent + 1)].join("\n");
}

/**
 * The span of the `on:` block mapping, ended the way YAML ends it.
 *
 * A COMMENT does not close a block mapping, at any column. #942 emits a
 * column-zero comment block introducing `concurrency:`, and a reader that
 * stops at the first column-zero line reports that the sub-keys after it are
 * absent — they are not, and YAML puts them under `on:`. Terminating on a
 * column-zero line that is not a comment is what the parser this is checking
 * does, so the reading and the subject agree.
 */
function onRegion(lines: string[]): { start: number; end: number } {
  const start = lines.findIndex(l => l === "on:");
  if (start < 0) throw new Error("no top-level on: in the workflow");
  let end = start + 1;
  for (; end < lines.length; end++) {
    if (/^\S/.test(lines[end]) && !lines[end].startsWith("#")) break;
  }
  return { start, end };
}

/** The lines of one sub-key's block within a top-level section. */
function subKeyBlock(text: string, key: string, sub: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex(l => l === `${key}:`);
  if (start < 0) throw new Error(`no top-level ${key}: in the workflow`);
  const at = lines.findIndex((l, i) => i > start && l.trim() === `${sub}:`);
  if (at < 0) throw new Error(`no ${key}.${sub} in the workflow`);
  const indent = lines[at].length - lines[at].trimStart().length;
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") break;
    if (l.length - l.trimStart().length <= indent) break;
    out.push(l);
  }
  return out;
}

/**
 * Delete a sub-key and the comments introducing it — what the generator
 * emitted before it learned the key, which is what every repo in the 422 list
 * has on disk.
 */
function withoutSubKey(text: string, sub: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex(l => l.trim() === `${sub}:` && l.startsWith("  ") && !l.startsWith("   "));
  if (at < 0) throw new Error(`the fixture has no \`${sub}:\` sub-key to remove`);
  let from = at;
  while (from > 0 && lines[from - 1].trimStart().startsWith("#")) from--;
  let to = at + 1;
  const indent = lines[at].length - lines[at].trimStart().length;
  while (to < lines.length && lines[to].trim() !== "" && lines[to].length - lines[to].trimStart().length > indent) to++;
  return [...lines.slice(0, from), ...lines.slice(to)].join("\n");
}

/** Scaffold, then rewind the two files to the shape the fleet is in today. */
function rewound(config?: Record<string, unknown>): Repo {
  const r = repo(config);
  createCiWorkflows(r.root, []);
  for (const name of DISPATCHABLE) {
    writeFileSync(wf(r, name), withoutSubKey(read(r, name), "workflow_dispatch"));
  }
  return r;
}

describe("#940 AC-1: a consumer that lacks the trigger gains it on re-scaffold", () => {
  // Both bodies, and the sharded one is not a duplicate case. #765 added
  // `merge_group` to the unsharded body only, 91 tests passed, and the repo
  // that needed it was untouched — the sharded body is a separate template
  // literal and nothing in the unsharded one can speak for it.
  for (const [label, config] of [
    ["unsharded", undefined],
    ["sharded", { ci: { shards: 4 } }],
  ] as const) {
    test(`${label}: every dispatchable workflow gains workflow_dispatch`, () => {
      const r = rewound(config);
      try {
        // Establish the subject, or everything below passes for the boring
        // reason that the rewind did nothing.
        for (const name of DISPATCHABLE) {
          expect(dispatchLines(read(r, name)), `${name} was not rewound`).toBe(0);
        }

        const actions: string[] = [];
        createCiWorkflows(r.root, actions);
        expect(actions.join("\n"), `the re-scaffold refused:\n${actions.join("\n")}`).not.toContain("REFUSED");

        for (const name of DISPATCHABLE) {
          const text = read(r, name);
          expect(dispatchLines(text), `${name} did not gain exactly one workflow_dispatch`).toBe(1);
          // A trigger that arrived with a `branches:` filter under it would be
          // a trigger nobody can fire from the Actions tab on any ref.
          expect(subKeyBlock(text, "on", "workflow_dispatch"), `${name}'s workflow_dispatch grew a body`).toEqual([]);
          expect(text, `${name} lost its own jobs`).toContain("runs-on:");
        }
      } finally { r.cleanup(); }
    });
  }

  test("sharded: the aggregate job survives, so the required context is still generated", () => {
    // The control for the sharded row above. The sharded body is the one that
    // matters — the required context is the `test` aggregate, which only
    // exists there — so a re-scaffold that landed the trigger by rewriting the
    // file would satisfy every assertion above and take the context with it.
    const r = rewound({ ci: { shards: 4 } });
    try {
      createCiWorkflows(r.root, []);
      const text = read(r, "ci.yml");
      expect(text, "the sharded matrix job is gone").toContain("test-shard:");
      expect(text, "the aggregate job that holds the required context is gone")
        .toContain("needs: test-shard");
    } finally { r.cleanup(); }
  });

  test("a consumer's own trigger, branch list and job survive the same re-scaffold", () => {
    // The arm that refuses "return the generated on: section". Every one of
    // these is the consumer's, and two of them are inside the key being merged.
    const r = rewound();
    try {
      writeFileSync(
        wf(r, "ci.yml"),
        read(r, "ci.yml")
          .replace("\non:\n", "\non:\n  schedule:\n    - cron: \"17 3 * * *\"\n")
          .replace(/- "main"/g, '- "release"')
          .replace(/\njobs:\n/, "\njobs:\n  deploy:\n    runs-on: \"ubuntu-latest\"\n    steps:\n      - run: ./deploy.sh\n"),
      );

      const actions: string[] = [];
      createCiWorkflows(r.root, actions);
      const after = read(r, "ci.yml");

      expect(actions.join("\n"), `the re-scaffold refused:\n${actions.join("\n")}`).not.toContain("REFUSED");
      expect(after, "the consumer's own trigger was destroyed").toContain("cron:");
      expect(after, "the consumer's branch list was overwritten").toContain('- "release"');
      expect(after, "the generator's branch list replaced the consumer's").not.toContain('- "main"');
      expect(after, "the consumer's job was destroyed").toContain("./deploy.sh");
      expect(dispatchLines(after), "and the generated trigger still landed, exactly once").toBe(1);
    } finally { r.cleanup(); }
  });
});

describe("#940 AC-2: a consumer that already declares the trigger is not disturbed", () => {
  /**
   * The hand-added shape, modelled on the one consumer in the fleet that can
   * be re-run today: the trigger sits FIRST, above `pull_request:`, with no
   * comment, written by a person rather than by this generator.
   *
   * Reproduced by moving the generated key rather than by pasting a second
   * literal, so the fixture cannot drift away from what the generator emits
   * (#585) — and so that no consumer repository has to be named here, which
   * `test/anti.test.ts` would refuse.
   */
  function handAdded(text: string): string {
    const stripped = withoutSubKey(text, "workflow_dispatch");
    expect(dispatchLines(stripped), "the generated file did not carry the trigger to move").toBe(
      dispatchLines(text) - 1,
    );
    return stripped.replace("\non:\n", "\non:\n  workflow_dispatch:\n");
  }

  /**
   * The same hand-add, at the END of `on:` instead of the start.
   *
   * The position case below uses this one and not `handAdded`, and the reason
   * is the fifth shape in `.claude/rules/checks-must-be-able-to-fail.md`
   * rather than a preference. The generator emits the trigger FIRST, so a
   * fixture that also puts it first asserts a position the cheapest wrong fix
   * — "return the generated `on:` section whenever the generator emits one" —
   * produces by accident. Measured: with that fix in place and the fixture
   * placing the trigger first, this case is GREEN over a merge that has just
   * discarded the consumer's branch lists. Placing it last is the one
   * arrangement in which the assertion is about the consumer's choice.
   */
  function handAddedLast(text: string): string {
    const stripped = withoutSubKey(text, "workflow_dispatch");
    expect(dispatchLines(stripped), "the generated file did not carry the trigger to move").toBe(
      dispatchLines(text) - 1,
    );
    const moved = appendOnSubKey(stripped, "workflow_dispatch");
    expect(onSubKeys(moved).at(-1), "the fixture did not put the trigger last").toBe("workflow_dispatch");
    return moved;
  }

  test("an otherwise-converged consumer is left byte-identical below the provenance marker", () => {
    const r = repo();
    try {
      createCiWorkflows(r.root, []);
      const before = handAdded(read(r, "ci.yml"));
      writeFileSync(wf(r, "ci.yml"), before);
      expect(markerOf(before), "the fixture carries no provenance marker to slice off").not.toBeNull();

      const actions: string[] = [];
      createCiWorkflows(r.root, actions);
      const after = read(r, "ci.yml");

      expect(actions.join("\n"), `the re-scaffold refused:\n${actions.join("\n")}`).not.toContain("REFUSED");
      expect(bodyOf(after), "the consumer's hand-added trigger was rewritten").toBe(bodyOf(before));

      // One line moves, and it is the authorship marker: `lineCommentProvenance`
      // re-stamps the sha of whatever body is written, so a file whose bytes a
      // consumer has moved always gets a fresh one. That is pre-existing
      // behaviour and the control below is what says so rather than this
      // comment. Having re-stamped once, the file is then byte-identical
      // forever — asserted here so "only the marker" cannot quietly become
      // "the marker and something else next run".
      expect(markerOf(after), "the marker was not re-stamped over the moved bytes").not.toBe(markerOf(before));
      createCiWorkflows(r.root, []);
      expect(read(r, "ci.yml"), "the file is still not converged on the second run").toBe(after);
    } finally { r.cleanup(); }
  });

  test("the control: ANY hand edit re-stamps the marker, so the trigger is not what caused it", () => {
    // Vary one thing. This fixture moves `merge_group` and leaves
    // `workflow_dispatch` exactly where the generator put it — if the marker
    // still changes, the line above is a property of the provenance stamp and
    // not of anything #940 did.
    const r = repo();
    try {
      createCiWorkflows(r.root, []);
      const generated = read(r, "ci.yml");
      const before = withoutSubKey(generated, "merge_group").replace("\non:\n", "\non:\n  merge_group:\n");
      expect(before, "the fixture did not keep the generated trigger untouched").toContain("workflow_dispatch:");
      writeFileSync(wf(r, "ci.yml"), before);

      createCiWorkflows(r.root, []);
      const after = read(r, "ci.yml");

      expect(bodyOf(after), "the unrelated hand edit was not preserved").toBe(bodyOf(before));
      expect(markerOf(after), "the marker did NOT move for an edit unrelated to the trigger")
        .not.toBe(markerOf(before));
    } finally { r.cleanup(); }
  });

  test("a consumer missing an OTHER generated sub-key keeps its one trigger where it put it", () => {
    // The real fleet shape, and the one the byte-identity case cannot reach:
    // the consumer that hand-added the trigger predates `merge_group` too, so
    // its file MUST change. What must not change is the trigger — a merge that
    // appended the generator's copy beside the consumer's would leave a file
    // GitHub Actions refuses to parse, and `on:` is the key it would refuse in.
    const r = repo();
    try {
      createCiWorkflows(r.root, []);
      const before = withoutSubKey(handAddedLast(read(r, "ci.yml")), "merge_group");
      writeFileSync(wf(r, "ci.yml"), before);

      const actions: string[] = [];
      createCiWorkflows(r.root, actions);
      const after = read(r, "ci.yml");

      expect(actions.join("\n"), `the re-scaffold refused:\n${actions.join("\n")}`).not.toContain("REFUSED");
      expect(bodyOf(after), "the control: the file really did converge").not.toBe(bodyOf(before));
      expect(onSubKeys(after), "merge_group did not land").toContain("merge_group");
      expect(dispatchLines(after), "the generator's copy was appended beside the consumer's").toBe(1);

      // Position, not just count. The consumer put it where it wanted it, and
      // nothing here is entitled to move it — `merge_group` arriving must be
      // appended after it, not threaded in front of it.
      // Stated as "after `pull_request:`, where the consumer put it" rather
      // than as an index: the generator emits it BEFORE every other trigger,
      // so this is the one comparison a merge that rewrote the section cannot
      // satisfy, and it does not also encode how many sub-keys arrived.
      const order = onSubKeys(after);
      expect(order.indexOf("workflow_dispatch") > order.indexOf("pull_request"), `the consumer's trigger was moved: ${order.join(", ")}`).toBe(true);
    } finally { r.cleanup(); }
  });

  test("re-scaffolding twice changes nothing the second time", () => {
    // Convergence means arriving, not oscillating. Without this, a merge that
    // appended the generated sub-key on every run passes AC-1 and grows the
    // file forever.
    const r = rewound();
    try {
      createCiWorkflows(r.root, []);
      const first = DISPATCHABLE.map(n => read(r, n));
      const actions: string[] = [];
      createCiWorkflows(r.root, actions);
      expect(DISPATCHABLE.map(n => read(r, n)), `the second re-scaffold changed the files:\n${actions.join("\n")}`)
        .toEqual(first);
    } finally { r.cleanup(); }
  });
});

describe("#940 AC-3: ai-review.yml is deliberately left without the trigger", () => {
  test("the review workflow gains no manual trigger, and still has the queue one", () => {
    // The decision argued in this file's header, as a case rather than as
    // prose. The second assertion is what stops this reading as "ai-review.yml
    // was forgotten": #867's trigger is there, so the file is one the
    // generator maintains and this omission is a choice.
    const r = repo();
    try {
      createCiWorkflows(r.root, []);
      const text = read(r, "ai-review.yml");
      expect(dispatchLines(text), "ai-review.yml gained a trigger that has no diff to review").toBe(0);
      expect(text.split("\n").some(l => l.trim() === "merge_group:"), "#867's trigger is missing").toBe(true);
    } finally { r.cleanup(); }
  });
});
