/**
 * #767 — the provenance marker was invisible to the generator and visible to
 * the merge, so a stamped workflow with a preserved job could never be
 * regenerated and was permanently misreported.
 *
 * #722 gave every generated workflow a `# generated-sha:` first line so that
 * ownership travels with the bytes. `createCiWorkflows` stamped the GENERATED
 * content and handed it to `writeManagedFile`, which merges the consumer's
 * jobs back in and writes something else. Three consequences, all measured on
 * a fixture before this file existed:
 *
 * 1. **The written bytes never match their own stamp.** The marker is
 *    computed over the generated body; the merged body is what lands. A
 *    workflow with one preserved job is classified
 *    `generated-and-hand-edited` for ever, about bytes the harness itself
 *    had just written, and the digests do not move on any later run.
 *
 * 2. **A generator change cannot land.** `resolveManagedWrite` treats every
 *    line outside a job as consumer-owned, and the OLD marker differs from
 *    the new one, so the old stamp line reads as content about to be
 *    dropped — `1 line(s) the harness did not author would be dropped from
 *    content outside any job: "# generated-sha: deadbeefdeadbeef"`. The
 *    write is refused, and a top-level change (`on: merge_group:`) never
 *    reaches the file. This is the half that blocks real work: the
 *    generator is correct and the workflow cannot be regenerated.
 *
 * 3. **The run says the opposite.** `UPDATED: … (+1 lines)` is printed one
 *    line above a census entry saying the file was not rewritten. An
 *    operator reads the first, ships, and the consumers do not carry the
 *    change.
 *
 * ## The fix is an ordering, not a new rule
 *
 * The marker is harness bookkeeping, so the merge must not see it on either
 * side: strip it from the existing file before comparing, and apply it to
 * the bytes that are actually written, last. Then the stamp describes the
 * file it is attached to, which is the only thing it ever claimed to do.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Teach the merge to ignore any line matching `^# generated-sha:`.** It
 * clears the refusal, the generator change lands, and it leaves consequence
 * 1 untouched — the written bytes still disagree with their own stamp, so
 * every stamped-and-merged workflow stays `generated-and-hand-edited` and
 * the census keeps reporting a hand-edit nobody made. `AC-1` is the case
 * that survives it, because it asserts the digests AGREE after a write
 * rather than asserting that the write happened.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createCiWorkflows, writeManagedFile } from "../lib/scaffold/steps";
import { stampWorkflow, workflowBody, workflowBodySha, workflowMarker } from "../lib/scaffold/workflow-census";

/** A consumer's own job, which the harness must carry forward. */
const DEPLOY_JOB = `  deploy:
    runs-on: "ubuntu-latest"
    steps:
      - run: echo deploy
`;

interface Fixture { root: string; ci: string; cleanup: () => void }

function scaffolded(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rungate-767-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  createCiWorkflows(root, []);
  return {
    root,
    ci: join(root, ".github", "workflows", "ci.yml"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Add a job the generator did not author, the way a consumer would. */
function addConsumerJob(path: string): void {
  const text = readFileSync(path, "utf-8");
  const next = text.replace(/\njobs:\n/, `\njobs:\n${DEPLOY_JOB}`);
  if (next === text) throw new Error("the fixture's ci.yml has no `jobs:` line to extend");
  writeFileSync(path, next);
}

describe("#767 AC-1: a file the harness wrote matches its own stamp", () => {
  test("after a merge that preserves a consumer job, declared === body", () => {
    const f = scaffolded();
    try {
      addConsumerJob(f.ci);
      const actions: string[] = [];
      createCiWorkflows(f.root, actions);

      const written = readFileSync(f.ci, "utf-8");
      // Establish the subject: the preservation really ran, or the digests
      // below agree for the boring reason that nothing was merged.
      expect(written, "the consumer job was not carried forward").toContain("echo deploy");

      const declared = workflowMarker(written);
      expect(declared, "the written workflow carries no provenance marker at all").not.toBeNull();
      expect(
        declared,
        `the stamp describes bytes that were never written: declared ${declared}, ` +
          `body ${workflowBodySha(written)}. Every later run will call this ` +
          `file hand-edited.`,
      ).toBe(workflowBodySha(written));
    } finally { f.cleanup(); }
  });

  test("the census stops calling the harness's own write a hand-edit", () => {
    const f = scaffolded();
    try {
      addConsumerJob(f.ci);
      createCiWorkflows(f.root, []); // the write that merges

      const actions: string[] = [];
      createCiWorkflows(f.root, actions); // the run that reports on it
      const ci = actions.filter(a => a.includes("ci.yml"));
      expect(ci.length, "no line mentions ci.yml — the report read nothing").toBeGreaterThan(0);
      expect(
        ci.join("\n"),
        `the run reports a hand-edit of bytes it wrote itself:\n${ci.join("\n")}`,
      ).not.toContain("hand-edited");
    } finally { f.cleanup(); }
  });
});

describe("#767 AC-2: a generator change lands on a file with a preserved job", () => {
  test("the old marker is not read as consumer content about to be dropped", () => {
    // Driven through `writeManagedFile`, which is the seam that owns the
    // marker. `resolveManagedWrite` is deliberately a pure merge over
    // BODIES and knows nothing about provenance — teaching it the marker
    // too would be a second decider for one question, and a mutation of
    // either would leave the other holding this case up.
    //
    // The two stamps differ, which is exactly what a generator change
    // produces, and is the input on which the old code refused.
    const existing = `# generated-sha: deadbeefdeadbeef
name: CI
on:
  push:
    branches: ["main"]
jobs:
${DEPLOY_JOB}  test:
    runs-on: "ubuntu-latest"
    steps:
      - run: bun test
`;
    const generated = `name: CI
on:
  push:
    branches: ["main"]
  merge_group:
jobs:
  test:
    runs-on: "ubuntu-latest"
    steps:
      - run: bun test
`;
    const root = mkdtempSync(join(tmpdir(), "rungate-767-merge-"));
    try {
      const path = join(root, "ci.yml");
      writeFileSync(path, existing);
      const actions: string[] = [];
      writeManagedFile(path, generated, "ci.yml", actions, {}, {
        body: workflowBody,
        stamp: stampWorkflow,
      });

      const written = readFileSync(path, "utf-8");
      expect(
        actions.join("\n"),
        `the write was refused over the harness's own bookkeeping line:\n${actions.join("\n")}`,
      ).not.toContain("REFUSED");
      expect(written, "the consumer job was not carried forward").toContain("echo deploy");
      // Asserted since #839: `merge_group` reaches the file. It used not to —
      // `mergeManagedWorkflow` treated every non-jobs top-level key the
      // consumer already had as the consumer's — which meant no CI
      // improvement could reach a repo already scaffolded. The merge is now
      // sub-key by sub-key, so the structural trigger lands and the
      // consumer's own `push:` block, with its branch list, does not move.
      expect(written, "the generated trigger did not reach the file").toContain("merge_group");
      expect(
        written,
        "the consumer's own top-level block was not preserved",
      ).toContain("branches:");
      // And the file describes itself, which is AC-1's property on the path
      // a generator change actually takes.
      expect(workflowMarker(written)).toBe(workflowBodySha(written));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("end to end: a changed generator reaches a workflow holding a consumer job", () => {
    // The same property without a hand-written `existing`, so it cannot pass
    // because the fixture happened to be shaped conveniently. The generator
    // change is simulated by editing the harness-owned job's own content on
    // disk and re-running: the regeneration must restore it.
    const f = scaffolded();
    try {
      addConsumerJob(f.ci);
      createCiWorkflows(f.root, []);

      // Damage a line inside the harness-owned job. A re-scaffold owns that
      // job and must put it back, consumer job intact.
      const before = readFileSync(f.ci, "utf-8");
      writeFileSync(f.ci, before.replace("runs-on:", "runs-on-BROKEN:"));

      const actions: string[] = [];
      createCiWorkflows(f.root, actions);
      const after = readFileSync(f.ci, "utf-8");

      expect(
        actions.join("\n"),
        `the re-scaffold refused instead of regenerating:\n${actions.join("\n")}`,
      ).not.toContain("REFUSED");
      expect(after, "the consumer's job was lost").toContain("echo deploy");
      expect(after, "the harness-owned job was not restored").not.toContain("runs-on-BROKEN:");
    } finally { f.cleanup(); }
  });
});

describe("#767 AC-3: the two reports cannot contradict each other", () => {
  test("no run reports UPDATED for a file the same run calls hand-edited", () => {
    const f = scaffolded();
    try {
      addConsumerJob(f.ci);
      for (let run = 0; run < 3; run++) {
        const actions: string[] = [];
        createCiWorkflows(f.root, actions);
        const text = actions.join("\n");
        const claimsWrite = /^(UPDATED|REPLACED|CREATED): \.github\/workflows\/ci\.yml/m.test(text);
        const claimsHandEdit = /generated-and-hand-edited: ci\.yml/.test(text);
        expect(
          claimsWrite && claimsHandEdit,
          `run ${run + 1} says both that it wrote ci.yml and that ci.yml is hand-edited:\n${text}`,
        ).toBe(false);
      }
    } finally { f.cleanup(); }
  });
});

describe("#767 AC-4: where the ownership boundary ended up (moved by #839)", () => {
  test("a VALUE under a non-jobs key stays the consumer's; the key's structure does not", () => {
    // This case used to assert the opposite of its second half — that a
    // generated top-level key is refused entry into a file that already has
    // one — and it said so as the current contract rather than as a wish,
    // with "if that ownership should change, it changes here, visibly, with
    // this case updated in the same commit". #839 is that change, and this
    // is that update.
    //
    // What moved: the merge is now sub-key by sub-key, so a structural
    // sub-key the consumer does not have arrives. What did NOT move, and is
    // the reason #482's incident does not recur: the consumer's value for a
    // sub-key both sides declare still wins, and no top-level key is
    // relocated. The branch list below is the half that must not change.
    const existing = `# generated-sha: deadbeefdeadbeef
name: CI
on:
  push:
    branches: ["release"]
jobs:
${DEPLOY_JOB}  test:
    runs-on: "ubuntu-latest"
    steps:
      - run: bun test
`;
    const generated = `name: CI
on:
  push:
    branches: ["main"]
  merge_group:
jobs:
  test:
    runs-on: "ubuntu-latest"
    steps:
      - run: bun test
`;
    const root = mkdtempSync(join(tmpdir(), "rungate-767-own-"));
    try {
      const path = join(root, "ci.yml");
      writeFileSync(path, existing);
      writeManagedFile(path, generated, "ci.yml", [], {}, { body: workflowBody, stamp: stampWorkflow });
      const written = readFileSync(path, "utf-8");
      expect(written, "the consumer's trigger was overwritten").toContain(`"release"`);
      expect(written, "the generator's branch list replaced the consumer's").not.toContain(`"main"`);
      expect(written, "the generated structural sub-key did not reach the file").toContain("merge_group");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("#767 AC-5: an unmarked file the harness already owns gets its marker", () => {
  test("a body-identical file with no marker is stamped, not skipped", () => {
    // The migration path for every consumer scaffolded before #722, and the
    // case that makes the byte comparison load-bearing.
    //
    // `resolveManagedWrite` compares BODIES, so a file whose body already
    // matches the generated one is `SKIP`. Its marker can still be absent —
    // which is exactly the state a pre-#722 consumer is in — and skipping it
    // leaves the file unstamped for ever, so the census reports NOT-OWNED
    // for a workflow the harness wrote and manages.
    //
    // Found by a mutation row that came back 0: reverting the byte
    // comparison to `resolved.verb === "SKIP"` turned nothing red, and this
    // is the input on which the two differ.
    const root = mkdtempSync(join(tmpdir(), "rungate-767-mig-"));
    try {
      const path = join(root, "ci.yml");
      const generated = `name: CI
on:
  push:
    branches: ["main"]
jobs:
  test:
    runs-on: "ubuntu-latest"
    steps:
      - run: bun test
`;
      // The same bytes, with no provenance line — a pre-#722 scaffold.
      writeFileSync(path, generated);
      expect(workflowMarker(readFileSync(path, "utf-8"))).toBeNull();

      const actions: string[] = [];
      writeManagedFile(path, generated, "ci.yml", actions, {}, { body: workflowBody, stamp: stampWorkflow });

      const written = readFileSync(path, "utf-8");
      expect(
        workflowMarker(written),
        `the file was skipped and left unstamped, so the census will call it NOT-OWNED: ${actions.join(", ")}`,
      ).not.toBeNull();
      expect(workflowMarker(written)).toBe(workflowBodySha(written));
      expect(actions.join("\n"), "the run said nothing about stamping the file").not.toContain("SKIP");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
