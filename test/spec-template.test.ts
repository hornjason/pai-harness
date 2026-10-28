/**
 * Covers SC-2570..SC-2574 (SPEC-AUTHORING-SPEC.md).
 *
 * `lib/spec-evidence.ts` can only check a document that opted in, so the
 * generator is the half that decides whether the rule ever reaches anything.
 * A template emitting the frame and NOT the `evidence: required` key would
 * leave every new spec looking compliant and gated by nothing — the same
 * silent pass one level up, which is the defect this whole change is about.
 *
 * Two of the cases below are controls rather than assertions about output:
 *
 * - **A freshly generated spec must produce ZERO violations.** It is bound,
 *   and it is full of placeholders. If `SC-TODO` parsed as a criterion, every
 *   spec would be born red and the first thing anybody did would be to delete
 *   the frontmatter key.
 * - **`scripts/create-spec.ts` must not emit a second template.** Two
 *   emitters are behaviourally one emitter under any test that calls only one
 *   of them, and the stale one would drift silently
 *   (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 *
 * The generated document is produced by SPAWNING the real script into a
 * temporary project root, not by calling the renderer — the claim is about
 * what `bun bin/rungate.ts create-spec` writes to disk, and a renderer the
 * script had stopped calling would satisfy every assertion about the string.
 */

// SPEC-REF: SPEC-AUTHORING-SPEC.md § Success Criteria (SC-2570..SC-2574)

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { CLI_COMMANDS } from "../lib/cli-commands.ts";
import { evidenceViolations, parseCriteria } from "../lib/spec-evidence.ts";
import { EVIDENCE_FRONTMATTER_KEY, renderSpecTemplate } from "../lib/spec-template.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const CREATE_SPEC = join(REPO_ROOT, "scripts", "create-spec.ts");
const TODAY = "2026-10-28";

const scratch = mkdtempSync(join(tmpdir(), "rungate-spec-template-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Run the real generator into a throwaway project root and read what it wrote.
 *
 * `--project-root` keeps the write out of `specs/`; `writeSpec` is create-only
 * and a leftover file in the repo would make a later run refuse by name.
 */
function generate(title: string, slug: string): string {
  const root = join(scratch, slug);
  mkdirSync(join(root, "specs"), { recursive: true });
  const run = spawnSync(
    "bun",
    [CREATE_SPEC, title, "Fixture — what this governs", "--project-root", root],
    { encoding: "utf-8", cwd: REPO_ROOT, timeout: 30_000 },
  );
  if (run.status !== 0) {
    throw new Error(
      `create-spec exited ${run.status}. A generator that cannot run makes every ` +
        `assertion below vacuous.\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
    );
  }
  const file = `${title.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-SPEC.md`;
  return readFileSync(join(root, "specs", file), "utf-8");
}

const generated = generate("Template Fixture", "bound");

describe("the generated spec is born inside the rule", () => {
  test("SC-2570: a generated spec is bound by the evidence rule", () => {
    expect(
      generated.split("\n---")[0],
      `the generated frontmatter does not carry \`${EVIDENCE_FRONTMATTER_KEY}\`, so ` +
        `lib/spec-evidence.ts will never look at this document. Every other assertion ` +
        `in this file is about a template that is checked by nothing.`,
    ).toContain(EVIDENCE_FRONTMATTER_KEY);
  });

  test("SC-2571: the generated frame carries every section the rule depends on", () => {
    // Each of these was retrofitted by hand onto an existing spec at least
    // once, which is the only reason it is here. Asserted by NAME rather than
    // by count: "nine headings" is satisfied by any nine.
    for (const section of [
      "## Why this exists",
      "## Outcomes",
      "Baseline today",
      "Command that produced the baseline",
      "## Increment 1",
      "**Appetite:**",
      "cancelled and\nre-scoped, not extended",
      "**Exit criteria",
      "Pre-specified decision criteria",
      "the futility row",
      "**Deviations record",
      "## Success Criteria",
    ]) {
      expect(generated, `the generated template is missing: ${section}`).toContain(section);
    }
  });

  test("SC-2571: a criterion is emitted with its evidence cells already present", () => {
    expect(generated).toContain("      needs: test\n      proved-by:\n");
  });

  test("SC-2572: the placeholder criterion is not parsed as a criterion", () => {
    expect(
      parseCriteria(generated),
      "`SC-TODO` must not parse as a criterion id. If it did, every spec would be " +
        "born red and the frontmatter key would be the first thing deleted.",
    ).toEqual([]);
    expect(
      evidenceViolations(generated, TODAY),
      "a freshly generated spec is bound and must still be clean.",
    ).toEqual([]);
  });

  test("SC-2572: it goes red the moment a real id is ticked with nothing behind it", () => {
    // The control for the case above. Clean-on-generation would also be the
    // reading if the module never looked at the document at all, so the same
    // bytes plus one real tick must redden — that is the one variable that
    // separates "compliant" from "not measured".
    const ticked = generated.replace(
      "- [ ] SC-TODO: [first criterion — atomic, verifiable, 8-12 words]\n      needs: test\n      proved-by:\n",
      "- [x] SC-9001: a real criterion.\n      needs: test\n      proved-by:\n",
    );
    expect(ticked).not.toBe(generated);
    expect(evidenceViolations(ticked, TODAY).map(v => v.code)).toEqual(["EVIDENCE_BLANK"]);
  });
});

/**
 * A generated spec is read in the project it was generated FOR.
 *
 * The required reviewer raised this on #1639 at rounds 1, 2, 3, 4 and 5 and
 * it was answered on none of them, because its finding anchors
 * `package.json` — a file outside that pull request's diff — so
 * `ai-review-threads` could not create a thread for it (422, "path could not
 * be resolved") and the job failed with a message naming the POSTING failure
 * rather than the finding. Five rounds of a high-severity finding were
 * invisible to anyone reading review threads. It is in the ledger comment.
 *
 * The defect itself: the template stamped `evidence: required` into every
 * generated spec and told the reader to run `bun
 * scripts/audit-spec-evidence.ts`, which resolves against the READER's
 * `scripts/` directory, where no such file exists — and the script was in
 * neither `package.json`'s `files[]` nor `CLI_COMMANDS`, so there was no
 * second route either. Every consumer got a document declaring a gate
 * nothing could run.
 *
 * `CLOSURE-14` cannot see this and is right not to: it requires a harness
 * anchor (`$HARNESS_ROOT`, `<harness>`), and an unanchored `bun scripts/…`
 * is deliberately read as the consumer's own path — `lib/typescript-project.ts`
 * emits exactly that shape legitimately. So the binding is asserted here,
 * where the population is one document and the right answer is knowable: a
 * generated spec names CLI COMMANDS, and every command it names must be
 * registered AND shipped.
 */
describe("SC-2577: a generated spec only tells the reader to run things the reader has", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
    files: string[];
  };

  test("it names no `bun scripts/…` path, which would resolve in the reader's own tree", () => {
    const paths = [...generated.matchAll(/bun\s+(scripts\/[A-Za-z0-9._/-]+)/g)].map(m => m[1]);
    expect(
      paths,
      "A generated spec is read in the consumer's project, so `bun scripts/x.ts` names " +
        "THEIR scripts/ directory. Name a registered CLI command instead — the consumer " +
        "has `rungate`, and does not have this repository's scripts/.",
    ).toEqual([]);
  });

  test("every `rungate <command>` it names is registered and ships in the tarball", () => {
    const named = [...new Set([...generated.matchAll(/\brungate\s+([a-z][a-z0-9-]*)/g)].map(m => m[1]))];
    // Anti-vacuity, and it is the half that matters: a template that stopped
    // naming any command would satisfy both assertions in this describe while
    // leaving the reader with no way to run the gate its frontmatter declares.
    expect(
      named.length,
      "the generated spec names no `rungate <command>` at all, so it declares " +
        "`evidence: required` and tells the reader nothing about how to check it.",
    ).toBeGreaterThan(0);

    const broken = named.flatMap(name => {
      const entry = CLI_COMMANDS[name];
      if (!entry) return [`rungate ${name} — not in CLI_COMMANDS, so the command does not exist`];
      const shipped = pkg.files.some(f => entry.script === f || entry.script.startsWith(f));
      return shipped ? [] : [`rungate ${name} — ${entry.script} is not in package.json files[]`];
    });
    expect(
      broken,
      "The generated spec instructs the reader to run a command the published package " +
        "cannot provide. Register it in lib/cli-commands.ts AND add its script to " +
        "package.json files[] — a generator that ships without its checker emits " +
        "documents that declare a gate nobody can run.",
    ).toEqual([]);
  });
});

describe("one emitter", () => {
  test("SC-2573: create-spec.ts does not emit a second template", () => {
    const script = readFileSync(CREATE_SPEC, "utf-8");
    expect(
      script.includes("renderSpecTemplate("),
      "scripts/create-spec.ts must render through lib/spec-template.ts.",
    ).toBe(true);
    // A second template would be a second `doc-type: spec` frontmatter block
    // built inside the script. One emitter, or the stale one drifts unseen.
    expect(
      (script.match(/doc-type: spec/g) ?? []).length,
      "scripts/create-spec.ts builds its own frontmatter again. Delete it and render " +
        "through renderSpecTemplate — two emitters are one emitter under any test that " +
        "calls only one of them.",
    ).toBe(0);
  });

  test("the renderer is pure in its date, so a fixture is not a hostage to the clock", () => {
    const a = renderSpecTemplate({ title: "T", governs: "g", criteria: [], today: "2020-01-02" });
    expect(a).toContain("created: 2020-01-02");
    expect(a).toContain("updated: 2020-01-02");
  });

  test("supplied criteria each get their own evidence cells", () => {
    const rendered = renderSpecTemplate({
      title: "T",
      governs: "g",
      criteria: ["the loader throws on malformed JSON", "the gate refuses an unsigned payload"],
      today: TODAY,
    });
    expect(rendered).toContain("- [ ] SC-TODO-1: the loader throws on malformed JSON\n      needs: test\n      proved-by:\n");
    expect(rendered).toContain("- [ ] SC-TODO-2: the gate refuses an unsigned payload\n      needs: test\n      proved-by:\n");
  });
});
