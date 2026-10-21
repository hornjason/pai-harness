/**
 * #839 — a CI fix RunGate makes could not reach a repo RunGate had already
 * scaffolded.
 *
 * `mergeManagedWorkflow` kept EVERY non-`jobs` top-level key the consumer
 * already had, whichever side the merge was walking:
 *
 *     if (section.key !== "" && beforeByKey.has(section.key)) return beforeByKey.get(...)!.lines;
 *
 * Correct for a one-time default — the generated `on:` really is a default for
 * a file that does not exist yet — and wrong for a fleet. Ownership of `on:`
 * and `permissions:` was decided by whether the consumer had been scaffolded
 * yet, silently, with no way to opt back in. The consequence is not a
 * cosmetic one: a repo scaffolded before the generator learned `merge_group:`
 * can never be given it, and enabling a merge queue there hangs every entry on
 * a required check that will never report, with no error anywhere saying why.
 *
 * ## What replaces it, and what it deliberately does NOT change
 *
 * Sub-key by sub-key. A sub-key the consumer does not have at all is added; a
 * sub-key both sides declare keeps the consumer's value, because a branch list
 * and a runner label are local knobs and the structure around them is not.
 * Top-level ORDER is still untouched — #482 is an incident about a key that
 * moved away from the comment introducing it, and nothing here moves one.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Return the generated section whenever the generator emits one.** It makes
 * AC-1's `merge_group` land, AC-2's `contents: read` land and AC-4 pass, and
 * it silently overwrites every branch list, every runner label and every
 * permission a consumer has widened — the data loss #216 exists to prevent,
 * reintroduced one key up. The second assertion in each of AC-1 and AC-2 is
 * the arm that refuses it, and AC-3's control is the arm that refuses
 * "override everything and let config opt out".
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { mergeManagedWorkflow, WORKFLOW_OVERRIDE_COMMENT } from "../lib/scaffold/managed-workflow";
import { createCiWorkflows, workflowOverrides } from "../lib/scaffold/steps";

/** The generator's shape: a structural trigger the consumer has never seen. */
const GENERATED = `# Managed by rungate — do not edit.
name: CI

on:
  # merge_group carries NO branches: filter, deliberately.
  merge_group:
  push:
    branches:
      - "main"
  pull_request:
    branches:
      - "main"

permissions:
  contents: read

jobs:
  test:
    runs-on: "ubuntu-latest"
    steps:
      - run: bun test
`;

/**
 * An already-scaffolded consumer: no `merge_group:`, a trigger of its own, a
 * branch list of its own, and a permission the generator does not grant.
 */
const CONSUMER = `# Managed by rungate — do not edit.
name: CI

on:
  # Nightly, because the integration suite needs a live token.
  workflow_dispatch:
  push:
    branches:
      - "release"
  pull_request:
    branches:
      - "release"

permissions:
  pull-requests: write

jobs:
  test:
    runs-on: "ubuntu-latest"
    steps:
      - run: bun test
`;

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
 * Delete a sub-key and the comments introducing it — what an older generator
 * that had not learned the key would have emitted.
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

interface Repo { root: string; cleanup: () => void }

function repo(config?: Record<string, unknown>): Repo {
  const root = mkdtempSync(join(tmpdir(), "rungate-839-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  if (config) {
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(join(root, ".claude", "rungate", "config.json"), JSON.stringify(config, null, 2));
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const wf = (r: Repo, name: string) => join(r.root, ".github", "workflows", name);

describe("#839 AC-1: a generated trigger reaches a consumer that lacks it", () => {
  test("merge_group lands and the consumer's own trigger survives", () => {
    const merged = mergeManagedWorkflow(CONSUMER, GENERATED);

    expect(merged, "the generated trigger never reached the consumer's file").toContain("merge_group:");
    // The arm that refuses "just return the generated section". Both of these
    // are the consumer's and both are inside the very key being merged.
    expect(merged, "the consumer's hand-added trigger was overwritten").toContain("workflow_dispatch:");
    expect(merged, "the consumer's branch list was overwritten").toContain(`- "release"`);
    expect(merged, "the generator's branch list replaced the consumer's").not.toContain(`- "main"`);
  });

  test("the trigger arrives with no branches: filter and with its reason", () => {
    // `merge_group` deliberately carries no filter (lib/scaffold/steps.ts): a
    // merge queue builds a `gh-readonly-queue/...` ref no branch list matches,
    // so a filter here is the same as not handling the event. A merge that
    // synthesised one from the neighbouring triggers would pass the case
    // above and still hang the queue.
    const merged = mergeManagedWorkflow(CONSUMER, GENERATED);
    expect(subKeyBlock(merged, "on", "merge_group"), "merge_group arrived with a body").toEqual([]);

    // And the comment explaining that travels with the key. A structural key
    // carried without its reason is a key the next reader deletes.
    const lines = merged.split("\n");
    const key = lines.findIndex(l => l.trim() === "merge_group:");
    expect(lines[key - 1], "the comment introducing merge_group did not travel").toContain("deliberately");
  });

  test("the consumer's top-level order is still the consumer's", () => {
    // #482's contract, re-asserted here because this change is the one most
    // able to break it. `resolveManagedWrite` REFUSES on movement, so a
    // regression is a consumer whose scaffold stops working.
    const merged = mergeManagedWorkflow(CONSUMER, GENERATED);
    const order = merged.split("\n").filter(l => /^[a-z_]+:/.test(l)).map(l => l.replace(/:.*$/, ""));
    expect(order).toEqual(["name", "on", "permissions", "jobs"]);
  });
});

describe("#839 AC-2: the same merge applies to permissions", () => {
  test("a generated least-privilege sub-key lands and a consumer-only one survives", () => {
    const merged = mergeManagedWorkflow(CONSUMER, GENERATED);
    expect(merged, "the generated least-privilege grant never reached the file").toContain("contents: read");
    expect(merged, "the consumer's own permission was dropped").toContain("pull-requests: write");
  });

  test("a sub-key both sides declare keeps the CONSUMER's value", () => {
    // The knob/structure boundary, stated as a case rather than as prose. A
    // consumer who widened `contents` did it for a reason the generator
    // cannot see, and narrowing it on their behalf breaks their build.
    const widened = CONSUMER.replace("  pull-requests: write", "  contents: write");
    const merged = mergeManagedWorkflow(widened, GENERATED);
    expect(merged, "the generator narrowed a permission the consumer widened").toContain("contents: write");
    expect(merged, "the generated value was merged in alongside the consumer's").not.toContain("contents: read");
  });

  test("a scalar on the consumer's side is left alone, not turned into broken YAML", () => {
    // `permissions: read-all` has nowhere to put a sub-key. Appending one
    // produces a file GitHub Actions refuses to parse, which is strictly
    // worse than not updating it.
    const scalar = CONSUMER.replace("permissions:\n  pull-requests: write", "permissions: read-all");
    const merged = mergeManagedWorkflow(scalar, GENERATED);
    expect(merged).toContain("permissions: read-all");
    expect(merged, "a sub-key was appended under a scalar key").not.toContain("contents: read");
  });
});

describe("#839 AC-3: a consumer can decline a generated key, and the file says so", () => {
  test("ci.workflowOverrides keeps the key out, and the control proves it is the config doing it", () => {
    const declined = mergeManagedWorkflow(CONSUMER, GENERATED, ["on"]);
    expect(declined, "the declined key was merged anyway").not.toContain("merge_group:");
    expect(declined, "the written file does not name the config key that caused this").toContain(
      "ci.workflowOverrides",
    );
    expect(declined, "the notice does not name the key it is about").toContain("`on:`");

    // The control, in the same case so it cannot drift away: without the
    // override the SAME inputs take the key. Otherwise this passes on a merge
    // that never adds anything.
    expect(mergeManagedWorkflow(CONSUMER, GENERATED)).toContain("merge_group:");
    // ...and declining `on` must not decline everything.
    expect(declined, "declining on: also declined permissions:").toContain("contents: read");
  });

  test("the notice is replaced, not accumulated, and disappears when the entry does", () => {
    const once = mergeManagedWorkflow(CONSUMER, GENERATED, ["on"]);
    const twice = mergeManagedWorkflow(once, GENERATED, ["on"]);
    expect(twice, "re-merging a declined file is not idempotent").toBe(once);
    expect(
      twice.split("\n").filter(l => l.includes(WORKFLOW_OVERRIDE_COMMENT)).length,
      "the notice accumulated one copy per run",
    ).toBe(1);

    const reversed = mergeManagedWorkflow(once, GENERATED);
    expect(reversed, "the notice outlived the config entry that justified it").not.toContain(
      WORKFLOW_OVERRIDE_COMMENT,
    );
    expect(reversed, "opting back in did not take the generated key").toContain("merge_group:");
  });

  test("declining a key the consumer does not have means not writing it", () => {
    const without = CONSUMER.replace("permissions:\n  pull-requests: write\n\n", "");
    expect(without, "the fixture still declares permissions").not.toContain("permissions:");

    expect(mergeManagedWorkflow(without, GENERATED), "the control: the key is added when not declined")
      .toContain("contents: read");
    const declined = mergeManagedWorkflow(without, GENERATED, ["permissions"]);
    expect(declined, "a declined key the consumer lacked was written anyway").not.toContain("contents: read");
    expect(declined, "the omission is recorded nowhere").toContain("ci.workflowOverrides");
  });

  test("the config reader takes a list of key names and refuses the rest", () => {
    expect(workflowOverrides({ workflowOverrides: ["on", "permissions"] })).toEqual(["on", "permissions"]);
    expect(workflowOverrides({})).toEqual([]);
    expect(workflowOverrides(null)).toEqual([]);
    expect(workflowOverrides({ workflowOverrides: "on" })).toEqual([]);
    expect(workflowOverrides({ workflowOverrides: [1, null, {}, "on"] })).toEqual(["on"]);
    // `jobs` is refused rather than honoured: job ownership already has a
    // mechanism, and a second one that freezes `test` and `gates` leaves a
    // consumer with a required check nothing regenerates.
    expect(workflowOverrides({ workflowOverrides: ["jobs", "on"] })).toEqual(["on"]);
  });
});

describe("#839 AC-4: re-scaffolding an older consumer converges, end to end", () => {
  /** Every generated workflow, rewound to the shape #839 recorded. */
  const REWOUND = ["ci.yml", "gates.yml", "ai-review.yml"];

  /**
   * The TRIGGER, as a line, not the word anywhere in the file.
   *
   * `ai-review.yml` names the event inside its report step too, because since
   * #867 that script branches on it — so a whole-file `toContain` reads the
   * prose as the trigger and the rewind looks like it failed.
   */
  const hasQueueTrigger = (text: string) =>
    text.split("\n").some(l => l.trim() === "merge_group:");

  /** Scaffold, then rewind the files to the shape #839 recorded. */
  function rewound(config?: Record<string, unknown>): Repo {
    const r = repo(config);
    createCiWorkflows(r.root, []);
    for (const name of REWOUND) {
      writeFileSync(wf(r, name), withoutSubKey(readFileSync(wf(r, name), "utf-8"), "merge_group"));
    }
    return r;
  }

  // #867 extended this from two files to all three. `ai-review.yml` was the
  // exception here, on the reasoning that a queue re-run reviews a diff
  // already reviewed — which is true, and is why the job does not review on
  // the event. It still has to REPORT, because a consumer makes `ai-review`
  // required and a required context that never reports hangs the queue
  // silently. This case is the one that proves an ALREADY-SCAFFOLDED consumer
  // inherits the trigger, which is the whole point of #839's machinery.
  test("every generated workflow gains merge_group on re-scaffold", () => {
    const r = rewound();
    try {
      // Establish the subject: the rewind really removed the trigger, or
      // everything below passes for the boring reason.
      for (const name of REWOUND) {
        expect(hasQueueTrigger(readFileSync(wf(r, name), "utf-8")), `${name} was not rewound`).toBe(false);
      }

      const actions: string[] = [];
      createCiWorkflows(r.root, actions);
      expect(actions.join("\n"), `the re-scaffold refused:\n${actions.join("\n")}`).not.toContain("REFUSED");

      for (const name of REWOUND) {
        const text = readFileSync(wf(r, name), "utf-8");
        expect(hasQueueTrigger(text), `${name} did not gain merge_group on re-scaffold`).toBe(true);
        expect(subKeyBlock(text, "on", "merge_group"), `${name}'s merge_group grew a branches: filter`).toEqual([]);
        expect(text, `${name} still has its own jobs`).toContain("runs-on:");
      }
    } finally { r.cleanup(); }
  });

  test("a consumer's own job and trigger survive the same re-scaffold", () => {
    // The control for AC-4. A re-scaffold that simply overwrote both files
    // would satisfy every assertion above.
    const r = rewound();
    try {
      const before = readFileSync(wf(r, "ci.yml"), "utf-8");
      writeFileSync(
        wf(r, "ci.yml"),
        before
          .replace("\non:\n", "\non:\n  workflow_dispatch:\n")
          .replace(/\njobs:\n/, "\njobs:\n  deploy:\n    runs-on: \"ubuntu-latest\"\n    steps:\n      - run: ./deploy.sh\n"),
      );

      const actions: string[] = [];
      createCiWorkflows(r.root, actions);
      const after = readFileSync(wf(r, "ci.yml"), "utf-8");

      expect(actions.join("\n"), `the re-scaffold refused:\n${actions.join("\n")}`).not.toContain("REFUSED");
      expect(after, "the consumer's trigger was destroyed by the convergence").toContain("workflow_dispatch:");
      expect(after, "the consumer's job was destroyed by the convergence").toContain("./deploy.sh");
      expect(after, "and the generated trigger still landed").toContain("merge_group:");
    } finally { r.cleanup(); }
  });

  test("ci.workflowOverrides reaches the merge through the real config file", () => {
    // The end-to-end half of AC-3: the config key is read off disk by the
    // scaffold rather than handed to the merge by the test.
    const r = rewound({ ci: { workflowOverrides: ["on"] } });
    try {
      createCiWorkflows(r.root, []);
      const text = readFileSync(wf(r, "ci.yml"), "utf-8");
      expect(text, "the config did not reach the merge").not.toContain("merge_group:");
      expect(text, "the file does not name the config key that declined it").toContain("ci.workflowOverrides");
    } finally { r.cleanup(); }
  });

  test("re-scaffolding twice changes nothing the second time", () => {
    // Convergence means arriving, not oscillating. Without this a merge that
    // appended the generated sub-key on every run would pass AC-4 and grow
    // the file forever.
    const r = rewound();
    try {
      createCiWorkflows(r.root, []);
      const first = ["ci.yml", "gates.yml"].map(n => readFileSync(wf(r, n), "utf-8"));
      const actions: string[] = [];
      createCiWorkflows(r.root, actions);
      const second = ["ci.yml", "gates.yml"].map(n => readFileSync(wf(r, n), "utf-8"));
      expect(second, `the second re-scaffold changed the files:\n${actions.join("\n")}`).toEqual(first);
    } finally { r.cleanup(); }
  });
});
