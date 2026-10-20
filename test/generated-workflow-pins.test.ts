/**
 * #377 — the generated workflows referenced actions by movable tag, and
 * every scaffolded consumer inherited them verbatim.
 *
 * `createCiWorkflows` writes `ci.yml` and `gates.yml` into every project
 * rungate scaffolds. `actions/checkout@v4` and `oven-sh/setup-bun@v2` are
 * tags, and a tag is the publisher's to repoint at any time — so this is a
 * generator question, not a file edit, and the answer reaches every
 * consumer. SUCCESS.md claim 5: *the harness works on a repo that is not
 * this one.*
 *
 * ## The decision, and where it lives
 *
 * **Option 2 of the three #377 named: third-party pinned to a full SHA,
 * first-party `actions/*` left on a major tag.** The argument and the
 * counter-argument are both in `lib/workflow-actions.ts`, which is where
 * someone will come to reverse it. This file holds it to the generator.
 *
 * ## The shape #377 warned about, and how it is closed
 *
 * > A test naming the three actions currently used goes green the day a
 * > fourth arrives unpinned.
 *
 * That is the third shape — a detector narrower than what it detects — and
 * writing the property over a hand-listed set of actions is the natural way
 * to produce it. So nothing here enumerates actions. `AC-2` asserts that
 * every `uses:` the generator EMITS is declared, and an undeclared action
 * makes `actionRef` throw at generation time rather than producing an
 * unpinned reference quietly.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Replace the two literals in the three templates with pinned strings and
 * stop there.** The generated workflows are correct the same day, the
 * symptom is gone, and there is no declaration — so the next template to
 * reference an action writes whatever its author types, the three templates
 * can drift from each other again (which is #689 exactly, one directory
 * away), and nothing says which tag a SHA was.
 *
 * `AC-2` and `AC-4` survive it: one requires every emitted reference to be
 * declared, and the other requires the three call sites to agree by
 * CONSTRUCTION rather than by inspection, which a literal cannot do.
 *
 * ## What is NOT claimed
 *
 * Nothing here fails when a pin goes stale, and the suite cannot make it.
 * Staleness is a network fact — nothing readable from this tree
 * distinguishes a current SHA from one three releases behind — and a
 * refusal keyed to a date is a test that goes red on a day nobody changed
 * anything. `scripts/check-action-pins.ts` is the network check, run
 * deliberately; `AC-5` asserts it exists and resolves what it claims to.
 *
 * ## What was broken to prove these can fail
 *
 * Over this file + `test/action-pin-parity.test.ts` +
 * `test/scaffold-ownership.test.ts` (61 tests). Counts predicted before the
 * run, **baseline read first.**
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 61 pass, 0 fail | **61 pass, 0 fail** | — |
 * | M1 **the defect restored**: the templates spell `oven-sh/setup-bun@v2` again | 4 | **4 of 61** | the generated `ci.yml`: the original emits the SHA, the mutant the tag |
 * | M2 **the cheapest wrong fix**: pinned literals in the templates, no declaration | 3 | **2 of 61** | the same tree — see below |
 * | M3 `actionRef` ignores the `sha` style | 4 | **3 of 61** | `actionRef("oven-sh/setup-bun")` |
 * | M4 the undeclared-action throw removed | 2 | **1 of 61** | `actionRef("some-org/some-action")` |
 * | M5 `FULL_SHA` widened to `{7,40}` and the declared sha shortened to 7 | 2 | **2 of 61** | the 7-character sha |
 * | M6 `usesReferences` admits a `#`-prefixed line | 0, then 1 | **1 of 61** | `"#      - uses: evil-org/pwn@v1"` |
 * | M7 `pinViolations` short-circuited to `return []` | 3 | **1 of 61** | a planted workflow pinning `oven-sh/setup-bun@v2` |
 * | M8 the `resolvedOn` requirement dropped | 1 | **1 of 61** | `PINNING` with the date deleted |
 *
 * **Three rows measured weaker than predicted on the first pass, and two of
 * them were defects in these cases rather than in the counts.**
 *
 * - **M7 first measured 0.** Every case asserted `pinViolations(...)` was
 *   `[]`, which a function that always returns `[]` satisfies perfectly —
 *   the third shape, an assertion that holds vacuously, in the file whose
 *   subject is unpinned references going unnoticed. `AC-2c` now drives the
 *   scan over input it must refuse before any case reads an empty result as
 *   clean. The row is 1.
 * - **M5 first measured 1.** The short-sha case asked `FULL_SHA` whether the
 *   declared sha was a full sha — the same binding it was checking, so it
 *   moved with the mutation and stayed green. It now asserts the literal
 *   40-hex shape and pins `FULL_SHA`'s own answers separately. The row is 2.
 * - **M6 was predicted 0** and recorded as no-information rather than as a
 *   gap, because the module CLAIMED in a comment that prose is not a
 *   position and nothing tested it. The input is nameable, so `AC-2d` now
 *   names it. The row is 1.
 *
 * **M2 is low for a reason worth keeping.** The cheapest wrong fix produces
 * byte-correct output today — the literals are the right strings — so the
 * output cases stay green and only the two structural `AC-4` cases catch it.
 * That is the shape working as intended: what is wrong with that repair is
 * not its output, it is that nothing holds the three templates together
 * tomorrow.
 *
 * None of the eight mutations is left in the tree; `lib/workflow-actions.ts`
 * and `lib/scaffold/steps.ts` were confirmed byte-identical by sha256.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  FULL_SHA,
  PINNING,
  actionPin,
  actionRef,
  pinViolations,
  usesReferences,
} from "../lib/workflow-actions";
import { createCiWorkflows } from "../lib/scaffold/steps";

const ROOT = join(import.meta.dir, "..");

/** Scaffold the workflows into a scratch tree and read them back. */
function generated(): { name: string; text: string }[] {
  const root = mkdtempSync(join(tmpdir(), "rungate-377-"));
  try {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    createCiWorkflows(root, []);
    const dir = join(root, ".github", "workflows");
    return readdirSync(dir)
      .filter(n => /\.ya?ml$/.test(n))
      .map(n => ({ name: n, text: readFileSync(join(dir, n), "utf-8") }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("#377 AC-1: the generated workflows follow the declaration", () => {
  test("every emitted uses: matches what the declaration renders", () => {
    const files = generated();
    expect(files.length, "the generator wrote no workflows, so this reads nothing").toBeGreaterThan(0);

    const refs = files.flatMap(f => usesReferences(f.text));
    expect(
      refs.length,
      "no generated workflow references any action — a scan of nothing agrees with everything",
    ).toBeGreaterThan(0);

    const violations = files.flatMap(f => pinViolations(f.text, f.name));
    expect(violations, violations.join("\n")).toEqual([]);
  });

  test("the third-party action is a full SHA, not a tag", () => {
    // The property, over whatever the declaration says is third-party —
    // never over a named action, so a fourth one is covered the day it
    // arrives rather than the day somebody remembers to add it here.
    const files = generated();
    const shaStyle = PINNING.filter(p => p.style === "sha").map(p => p.action);
    expect(shaStyle.length, "no action is declared SHA-pinned, so this case asserts nothing").toBeGreaterThan(0);

    for (const f of files) {
      for (const u of usesReferences(f.text)) {
        if (!shaStyle.includes(u.action)) continue;
        expect(
          FULL_SHA.test(u.ref),
          `${f.name}:${u.line} references ${u.action}@${u.ref}, which a publisher can repoint`,
        ).toBe(true);
      }
    }
  });

  test("a SHA pin carries the tag it is, as a trailing comment", () => {
    // #689's defect was a comment that could disagree with the pin it
    // annotated. Here the comment and the pin are one rendering, so the
    // assertion is that the rendering reached the file.
    const files = generated();
    for (const p of PINNING.filter(x => x.style === "sha")) {
      const line = files
        .flatMap(f => f.text.split("\n"))
        .find(l => l.includes(`uses: ${p.action}@`));
      expect(line, `${p.action} is declared but no generated workflow uses it`).toBeDefined();
      expect(line!).toContain(`# ${p.version}`);
      expect(line!).toContain(p.sha!);
    }
  });
});

describe("#377 AC-2: an undeclared action cannot be emitted quietly", () => {
  test("actionRef refuses an action the declaration does not carry", () => {
    // The case that closes "a test naming the three actions goes green when
    // a fourth arrives". The refusal is at GENERATION time, so an
    // undeclared action cannot reach a consumer at all.
    let threw: Error | null = null;
    try { actionRef("some-org/some-action"); } catch (e) { threw = e as Error; }
    expect(threw, "an undeclared action rendered a reference").not.toBeNull();
    expect(threw!.message).toContain("not declared");
    expect(threw!.message, "the refusal does not say where to declare it").toContain("lib/workflow-actions.ts");
  });

  test("every action the generator emits is declared", () => {
    const emitted = [...new Set(generated().flatMap(f => usesReferences(f.text)).map(u => u.action))];
    expect(emitted.length, "nothing was emitted, so nothing is being checked").toBeGreaterThan(0);
    for (const a of emitted) {
      expect(actionPin(a), `${a} is emitted by the generator and declared nowhere`).not.toBeNull();
    }
  });

  test("a SHA style with a short sha is refused, not rendered", () => {
    // A short sha reads like a pin and is repointable, which is the one
    // way to satisfy the style while losing the property it exists for.
    //
    // Asserted against the LITERAL shape, not against `FULL_SHA` — found by
    // a battery row that widened the regex to `{7,40}` and shortened the
    // declared sha to match: this case moved with it and stayed green,
    // because it was asking the same binding it was checking. Two deciders
    // that agree (`.claude/rules/checks-must-be-able-to-fail.md`).
    for (const p of PINNING.filter(x => x.style === "sha")) {
      expect(
        p.sha,
        `${p.action} is SHA-pinned with a reference that is not 40 hex characters`,
      ).toMatch(/^[0-9a-f]{40}$/);
      expect(p.sha!.length, `${p.action}'s pin is ${p.sha!.length} characters, not 40`).toBe(40);
    }

    // And the regex the rest of the module uses agrees with that shape, so
    // widening it is caught here rather than silently relaxing every other
    // case in this file.
    expect(FULL_SHA.test("0c5077e"), "FULL_SHA accepts a short sha").toBe(false);
    expect(FULL_SHA.test("0c5077e51419868618aeaa5fe8019c62421857d6")).toBe(true);
  });
});

describe("#377 AC-2c: the violation scan can actually report", () => {
  test("a workflow that disagrees with the declaration is named, with its line", () => {
    // Found by a battery row: short-circuiting `pinViolations` to `return []`
    // measured **0 red**. Every case asserted `toEqual([])`, which a
    // function that always returns empty satisfies perfectly — the third
    // shape, an assertion that holds vacuously, in the file whose subject is
    // unpinned references going unnoticed.
    //
    // So the scan is driven over input it MUST refuse, before any case is
    // allowed to read an empty result as clean.
    const wrongPin = "jobs:\n  t:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n";
    const v = pinViolations(wrongPin, "planted.yml");
    expect(v.length, "a tag where the declaration demands a sha was not reported").toBe(1);
    expect(v[0], `the violation does not name the position: ${v[0]}`).toContain("planted.yml:4");
    expect(v[0]).toContain("oven-sh/setup-bun");

    const undeclared = "jobs:\n  t:\n    steps:\n      - uses: evil-org/pwn@v1\n";
    const u = pinViolations(undeclared, "planted.yml");
    expect(u.length, "an action nothing declares was not reported").toBe(1);
    expect(u[0]).toContain("does not declare");

    const correct = `jobs:\n  t:\n    steps:\n      - uses: ${actionRef("oven-sh/setup-bun")}\n`;
    expect(pinViolations(correct, "planted.yml"), "the scan refuses a correct pin").toEqual([]);
  });
});

describe("#377 AC-2d: prose is not a position", () => {
  test("a commented-out step and a sentence are not read as references", () => {
    // `usesReferences` is anchored on `uses:` at the start of a line so a
    // header comment explaining the policy is not reported as a violation
    // of it — #235's defect, where a detector could not tell a prose
    // mention from an instruction, and a sentence of documentation turned
    // two tests red.
    //
    // The module claimed this in a comment and nothing tested it: a
    // battery row widening the pattern to admit `#`-prefixed lines
    // measured 0 red. Named input, so the row is a gap rather than no
    // information.
    const doc = [
      "# This workflow used to run actions/checkout@v3; see #377 for why it moved.",
      "#      - uses: evil-org/pwn@v1",
      "jobs:",
      "  t:",
      "    steps:",
      `      - uses: ${actionRef("actions/checkout")}`,
    ].join("\n");

    const refs = usesReferences(doc);
    expect(
      refs.map(r => r.action),
      "a commented-out step or a sentence was read as a live reference",
    ).toEqual(["actions/checkout"]);
    expect(pinViolations(doc, "doc.yml"), "prose was reported as a pin violation").toEqual([]);
  });
});

describe("#377 AC-3: this repository follows its own declaration", () => {
  test("the committed ci.yml and gates.yml agree with the generator", () => {
    // The checked-in workflows are not what a consumer gets — the
    // generator is (#622c) — but a tree that does not follow its own rule
    // is the one place a reader looks first.
    const dir = join(ROOT, ".github", "workflows");
    for (const name of ["ci.yml", "gates.yml"]) {
      const text = readFileSync(join(dir, name), "utf-8");
      const v = pinViolations(text, name);
      expect(v, v.join("\n")).toEqual([]);
    }
  });
});

describe("#377 AC-4: the three templates agree by construction", () => {
  test("no generator template spells an action reference as a literal", () => {
    // What makes the agreement structural rather than observed. Three
    // templates each carrying their own string is exactly #689, one
    // directory away, and it is invisible while the strings happen to
    // match.
    const src = readFileSync(join(ROOT, "lib", "scaffold", "steps.ts"), "utf-8");
    const literals = src
      .split("\n")
      .map((l, i) => ({ l, i: i + 1 }))
      .filter(({ l }) => /uses:\s*[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@/.test(l))
      .map(({ l, i }) => `lib/scaffold/steps.ts:${i}: ${l.trim()}`);

    expect(
      literals,
      `these templates spell an action reference directly instead of calling actionRef():\n` +
        literals.join("\n"),
    ).toEqual([]);

    // Positive control: the scan can see a literal when there is one, so
    // the empty result above means absence rather than a broken regex.
    const probe = '      - uses: actions/checkout@v4';
    expect(
      /uses:\s*[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@/.test(probe),
      "the detector cannot see a literal it is meant to catch",
    ).toBe(true);
  });

  test("the call sites all route through one function", () => {
    const src = readFileSync(join(ROOT, "lib", "scaffold", "steps.ts"), "utf-8");
    const calls = [...src.matchAll(/actionRef\(/g)].length;
    expect(calls, "the generator does not call actionRef at all").toBeGreaterThanOrEqual(3);
  });
});

describe("#377 AC-5: staleness is checkable, and the suite says it is not checking it", () => {
  test("every SHA pin carries the date it was read", () => {
    for (const p of PINNING.filter(x => x.style === "sha")) {
      expect(p.resolvedOn, `${p.action} is SHA-pinned with no date, so the reading cannot be aged`)
        .toMatch(/^20\d\d-\d\d-\d\d$/);
    }
  });

  test("every pin records why it is pinned that way", () => {
    for (const p of PINNING) {
      expect(p.why.length, `${p.action} declares a style and no reason`).toBeGreaterThan(20);
    }
  });

  test("the network check exists and names every declared pin", () => {
    // A script nobody can run is the same as no script. This asserts it is
    // there and that it reads the declaration rather than its own copy of
    // the action list — a second list would drift from PINNING silently.
    const script = readFileSync(join(ROOT, "scripts", "check-action-pins.ts"), "utf-8");
    expect(script, "the checker carries its own action list instead of reading the declaration")
      .toContain("PINNING");
    expect(script).toContain("workflow-actions");
  });
});
