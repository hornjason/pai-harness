/**
 * #654 — two scaffold action lines asked whether a file existed AFTER
 * writing it, and reported the answer as if it had been asked before.
 *
 * `existsSync(p)` taken after `writeFileSync(p, …)` is true on every path
 * that reaches it: the write either succeeded, in which case the file is
 * there, or threw, in which case the line never runs. So the `CREATED:` arm
 * was unreachable and a consumer scaffolding for the first time was told its
 * agent briefs had been **updated**.
 *
 * The CODE-MAP line is the same shape with one more arm, and it is wrong in
 * both directions: a successful generation reported `UPDATED:` whether or
 * not the file was new, and a generator that exits 0 WITHOUT writing
 * reported `CREATED:` for a file that is not there. The second is the one
 * that moves a claim — a generator that produced nothing reported as having
 * created something, in the log a consumer reads to find out what a scaffold
 * did.
 *
 * `lib/scaffold/rehearsal.ts:481` already records this defect in prose —
 * *"audit printed `CREATED: project-state.json` for a write that threw"*.
 * It survived at a second site because the note was attached to the site
 * that was fixed, not to the shape.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { generateAgentBriefsStep, generateCodeMapStep } from "../../lib/scaffold/steps";

let root: string;
let generators: string;

/** A generator that exits 0 and writes nothing. */
const SILENT_GENERATOR = "process.exit(0);\n";
/** A generator that exits 0 having written the file it was asked for. */
const WRITING_GENERATOR =
  'import { writeFileSync } from "fs";\n' +
  'import { join } from "path";\n' +
  'writeFileSync(join(process.argv[2], "CODE-MAP.md"), "# map\\n");\n';

function generator(name: string, body: string): string {
  const p = join(generators, `${name}.ts`);
  writeFileSync(p, body);
  return p;
}

const briefPath = () => join(root, ".claude", "agents", "marcus.md");

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "scaffold-probe-order-"));
  root = join(base, "project");
  generators = join(base, "generators");
  mkdirSync(root, { recursive: true });
  mkdirSync(generators, { recursive: true });
  // A minimal project the brief step can scan.
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
});

afterEach(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("#654 instance 1: a brief the scaffold just created says CREATED", () => {
  test("an empty directory reports CREATED for every brief it writes", () => {
    // Non-vacuous (criterion 4): the file really is absent first, so a
    // fixture that silently reused a populated directory cannot reach the
    // assertion below.
    expect(existsSync(briefPath()), "the fixture directory already carries marcus.md").toBe(false);

    const actions: string[] = [];
    generateAgentBriefsStep(root, actions);

    expect(existsSync(briefPath()), "the step wrote no brief, so there is nothing to report on")
      .toBe(true);
    expect(actions).toContain("CREATED: .claude/agents/marcus.md");
    expect(actions).not.toContain("UPDATED: .claude/agents/marcus.md");
  });

  test("re-scaffolding the same directory reports UPDATED", () => {
    // The control, and the reason the case above is about the PROBE and not
    // about inverting a dead arm. The cheapest wrong fix — hardcode
    // `CREATED:` because the agents directory was just made — passes the
    // case above and fails this one.
    generateAgentBriefsStep(root, []);
    expect(existsSync(briefPath())).toBe(true);

    const second: string[] = [];
    generateAgentBriefsStep(root, second);

    expect(second).toContain("UPDATED: .claude/agents/marcus.md");
    expect(second).not.toContain("CREATED: .claude/agents/marcus.md");
  });
});

describe("#654 instance 2: the CODE-MAP line answers both questions", () => {
  test("a generator that exits 0 and writes nothing is neither created nor updated", () => {
    expect(existsSync(join(root, "CODE-MAP.md"))).toBe(false);

    const actions: string[] = [];
    generateCodeMapStep(root, actions, { generatorPath: generator("silent", SILENT_GENERATOR) });

    // The absent output is named. `CREATED:` here is a write that did not
    // happen, reported as one that did.
    expect(actions.join("\n")).toContain("UNMEASURED: CODE-MAP.md");
    expect(actions.join("\n")).toContain("wrote no file");
    expect(actions).not.toContain("CREATED: CODE-MAP.md");
    expect(actions).not.toContain("UPDATED: CODE-MAP.md");
    expect(existsSync(join(root, "CODE-MAP.md")), "the stub generator wrote a file after all")
      .toBe(false);
  });

  test("a generator that writes a new file reports CREATED", () => {
    const actions: string[] = [];
    generateCodeMapStep(root, actions, { generatorPath: generator("writes", WRITING_GENERATOR) });

    expect(existsSync(join(root, "CODE-MAP.md"))).toBe(true);
    expect(actions).toContain("CREATED: CODE-MAP.md");
    expect(actions).not.toContain("UPDATED: CODE-MAP.md");
  });

  test("a generator that overwrites an existing file reports UPDATED", () => {
    // The third arm, so no fixture here can be satisfied by a line that
    // always says the same word.
    writeFileSync(join(root, "CODE-MAP.md"), "# stale\n");
    const actions: string[] = [];
    generateCodeMapStep(root, actions, { generatorPath: generator("writes2", WRITING_GENERATOR) });

    expect(actions).toContain("UPDATED: CODE-MAP.md");
    expect(actions).not.toContain("CREATED: CODE-MAP.md");
  });

  test("the three arms are three different words over one generator path", () => {
    // The premise behind the pair above: all three cases drive the same
    // branch of `generateCodeMapStep`, so what varies between them is the
    // state of the tree and not which code ran.
    const writing = generator("writes3", WRITING_GENERATOR);

    const created: string[] = [];
    generateCodeMapStep(root, created, { generatorPath: writing });
    const updated: string[] = [];
    generateCodeMapStep(root, updated, { generatorPath: writing });

    rmSync(join(root, "CODE-MAP.md"), { force: true });
    const unmeasured: string[] = [];
    generateCodeMapStep(root, unmeasured, { generatorPath: generator("silent2", SILENT_GENERATOR) });

    const words = [created, updated, unmeasured].map(
      a => (a.find(l => l.includes("CODE-MAP.md")) ?? "").split(":")[0],
    );
    expect(words).toEqual(["CREATED", "UPDATED", "UNMEASURED"]);
  });
});
