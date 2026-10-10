/**
 * scaffold-ci-preservation-mutation.test.ts — #216 AC-6.
 *
 * .claude/rules/checks-must-be-able-to-fail.md: a guard is worth what it fails
 * on. "Re-scaffold preserves the consumer's job" is exactly the shape that
 * rule warns about — it passes for as long as nothing overwrites the file, and
 * an unconditional `writeFileSync` creeping back in is invisible to a test
 * that only ever reads a preserved file.
 *
 * So the preservation is removed, and the removal is performed and observed:
 * a MUTANT COPY of the CI generator (lib/scaffold/steps.ts) has
 * `writeManagedWorkflow` short-circuited to the unconditional overwrite this
 * issue is about, and both the real source and the mutant are run over the
 * SAME planted consumer file. Real preserves, mutant destroys.
 *
 * The mutant lives in a temp directory with its relative imports rewritten to
 * absolute ones. A mutant that died on module resolution would throw, and a
 * throw must not be mistaken for "the mutation was rejected on the merits" —
 * so the mutant is observed WRITING the file before any claim is made about
 * what it wrote.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCiWorkflows } from "../lib/scaffold/steps";

const REPO_ROOT = join(import.meta.dir, "..");
const SCAFFOLD_DIR = join(REPO_ROOT, "lib", "scaffold");
const STEPS = join(SCAFFOLD_DIR, "steps.ts");

/**
 * The one line the mutation removes. Declared as a literal rather than
 * regex-built, so renaming the binding aborts this file instead of quietly
 * mutating nothing.
 */
const BINDING_SIGNATURE =
  "export function writeManagedWorkflow(filePath: string, generated: string, label: string, actions: string[], opts: ManagedWriteOptions = {}): void {";

/** The consumer job rungate cannot generate. Identical to AC-1's fixture. */
const DEPLOY_JOB = [
  "  deploy:",
  "    needs: test",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: ./scripts/publish.sh --tag release",
];

let SCRATCH = "";
let REAL_ROOT = "";
let MUTANT_ROOT = "";

beforeEach(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ci-preservation-mutation-"));
  REAL_ROOT = join(SCRATCH, "real");
  MUTANT_ROOT = join(SCRATCH, "mutant-project");
  mkdirSync(REAL_ROOT, { recursive: true });
  mkdirSync(MUTANT_ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

/**
 * Short-circuit the binding to the unconditional overwrite #216 removed, and
 * relocate the copy so it can run from a temp directory.
 *
 * Throws rather than returning an unmutated copy when the signature moves. A
 * mutation harness that silently no-ops when its target is renamed is the
 * decorative check this whole exercise exists to rule out.
 */
export function buildMutantSource(src: string, signature = BINDING_SIGNATURE): string {
  const occurrences = src.split(signature).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the binding signature appears ${occurrences} times, expected exactly 1. ` +
        `Either it was renamed, or a second write path exists and removing one would leave the other preserving.`,
    );
  }
  const shortCircuited = src.replace(
    signature,
    `${signature}\n` +
      `  // MUTANT: preservation removed — the unconditional overwrite #216 fixed.\n` +
      `  mkdirSync(dirname(filePath), { recursive: true });\n` +
      `  writeFileSync(filePath, generated);\n` +
      `  actions.push(\`CREATED: \${label}\`);\n` +
      `  return;`,
  );

  // The WHOLE specifier is captured and joined, leading `../` included. Keeping
  // only the tail and joining it to the module's own directory silently
  // resolves `../../scripts/x` to `lib/scripts/x` — a module-resolution death
  // that reads as the mutation having been rejected on the merits.
  const relocated = shortCircuited.replace(
    /from "(\.\.?\/[A-Za-z0-9._\-/]+)"/g,
    (_m, spec: string) => `from "${join(SCAFFOLD_DIR, spec)}"`,
  );
  const leftover = relocated.match(/from "\.\.?\//g) || [];
  if (leftover.length > 0) {
    throw new Error(
      `could not build the mutant: ${leftover.length} relative import(s) were not rewritten; ` +
        `the mutant would die on module resolution and that throw reads as a refusal it never made`,
    );
  }
  return relocated;
}

/** Plant a harness-written ci.yml with one consumer job appended. */
function plantConsumerCi(root: string): string {
  createCiWorkflows(root, []);
  const path = join(root, ".github", "workflows", "ci.yml");
  writeFileSync(path, readFileSync(path, "utf-8") + DEPLOY_JOB.join("\n") + "\n");
  return readFileSync(path, "utf-8");
}

async function loadMutant(): Promise<(root: string, actions: string[]) => void> {
  const mutantPath = join(SCRATCH, "steps.mutant.ts");
  writeFileSync(mutantPath, buildMutantSource(readFileSync(STEPS, "utf-8")));
  const mod = (await import(mutantPath)) as { createCiWorkflows: (r: string, a: string[]) => void };
  return mod.createCiWorkflows;
}

describe("AC-6: the preservation is removed, and the removal is observed", () => {
  test("the binding appears exactly once in the real source", () => {
    const src = readFileSync(STEPS, "utf-8");
    expect(src.split(BINDING_SIGNATURE).length - 1).toBe(1);
  });

  test("real source preserves the consumer job; the mutant destroys it", async () => {
    const planted = plantConsumerCi(REAL_ROOT);
    const mutantCreateCiWorkflows = await loadMutant();
    const plantedMutant = plantConsumerCi(MUTANT_ROOT);
    // Same input on both sides — otherwise the comparison is between fixtures,
    // not between the real source and the mutation.
    expect(plantedMutant).toBe(planted);

    createCiWorkflows(REAL_ROOT, []);
    mutantCreateCiWorkflows(MUTANT_ROOT, []);

    const realAfter = readFileSync(join(REAL_ROOT, ".github", "workflows", "ci.yml"), "utf-8");
    const mutantAfter = readFileSync(join(MUTANT_ROOT, ".github", "workflows", "ci.yml"), "utf-8");

    // 1. the mutant ran at all — it wrote a file, and the file is a workflow
    expect(mutantAfter).toContain("jobs:");
    expect(() => Bun.YAML.parse(mutantAfter)).not.toThrow();

    // 2. the real source preserved every consumer-authored line
    expect(DEPLOY_JOB.filter(l => !realAfter.split("\n").includes(l))).toEqual([]);

    // 3. the mutant preserved none of the lines only the consumer could have
    //    written — `steps:` and a checkout step also occur in the harness job,
    //    so comparing against those would report a preserved job that is gone.
    const consumerOnly = ["  deploy:", "    needs: test", "      - run: ./scripts/publish.sh --tag release"];
    expect(consumerOnly.every(l => realAfter.split("\n").includes(l))).toBe(true);
    expect(consumerOnly.filter(l => mutantAfter.split("\n").includes(l))).toEqual([]);
    expect((Bun.YAML.parse(mutantAfter) as any).jobs.deploy).toBeUndefined();
    expect((Bun.YAML.parse(realAfter) as any).jobs.deploy).toBeDefined();
  }, 60_000);

  test("the mutant also loses the refusal, so an edited harness job is overwritten", async () => {
    const path = (root: string) => join(root, ".github", "workflows", "ci.yml");
    const edit = (root: string) => {
      const lines = readFileSync(path(root), "utf-8").split("\n");
      const at = lines.findIndex(l => l.trim() === "- run: bun test");
      lines.splice(at + 1, 0, "      - run: ./scripts/smoke.sh");
      writeFileSync(path(root), lines.join("\n"));
    };

    createCiWorkflows(REAL_ROOT, []);
    createCiWorkflows(MUTANT_ROOT, []);
    edit(REAL_ROOT);
    edit(MUTANT_ROOT);

    const mutantCreateCiWorkflows = await loadMutant();
    const realActions: string[] = [];
    const mutantActions: string[] = [];
    createCiWorkflows(REAL_ROOT, realActions);
    mutantCreateCiWorkflows(MUTANT_ROOT, mutantActions);

    expect(realActions.some(a => a.startsWith("REFUSED:"))).toBe(true);
    expect(readFileSync(path(REAL_ROOT), "utf-8")).toContain("./scripts/smoke.sh");

    expect(mutantActions.some(a => a.startsWith("REFUSED:"))).toBe(false);
    expect(readFileSync(path(MUTANT_ROOT), "utf-8")).not.toContain("./scripts/smoke.sh");
  }, 60_000);

  test("a renamed binding aborts the harness rather than mutating nothing", () => {
    const src = readFileSync(STEPS, "utf-8").replace(BINDING_SIGNATURE, "export function somethingElse(): void {");
    expect(() => buildMutantSource(src)).toThrow(/appears 0 times/);
  });

  test("an unrewritten relative import aborts the harness", () => {
    const src = readFileSync(STEPS, "utf-8") + '\nimport { nope } from "../does-not-exist";\n';
    // The rewriter sees that one, so smuggle in a specifier it cannot match.
    const sneaky = src + '\nimport { nope2 } from "../bad name/x";\n';
    expect(() => buildMutantSource(sneaky)).toThrow(/relative import/);
    expect(existsSync(STEPS)).toBe(true);
  });
});
