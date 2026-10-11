import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { stripJsComments } from "../lib/strip-js-comments";

/**
 * #272 — a workflow prompt told three agents to read a file that does not
 * exist.
 *
 * `ARCHITECTURE.md` is not in this repo and never has been, yet
 * `workflows/ship.js`, `workflows/verify.js` and `workflows/batch-ship.js`
 * each instructed an agent to "Read ${PROJECT_ROOT}/ARCHITECTURE.md" with no
 * qualifier. Two other sites in the same codebase — `batch-ship.js:181` and
 * `gates/brief-assembler.ts:143` — already said "(if exists)" and "(ONLY if
 * MODEL.md doesn't exist)", so the correct form was present the whole time;
 * three sites simply did not use it.
 *
 * An agent handed a read instruction for a missing file either burns a turn
 * discovering that, or — worse, and the reason this is a defect rather than
 * untidiness — writes its review as though it had the context the instruction
 * promised.
 *
 * CHECK-1 of ADR-002 cannot see this: these are prompt bodies, not source
 * expressions. The guard therefore reads the prompt text, which is also why
 * it strips comments first — a docblock naming the file would otherwise be
 * reported as an instruction to read it.
 */

const ROOT = join(import.meta.dir, "..");

/** Prompt-bearing source: the workflows, plus the brief assembler. */
function promptFiles(): string[] {
  const out = readdirSync(join(ROOT, "workflows"))
    .filter(f => f.endsWith(".js"))
    .map(f => join(ROOT, "workflows", f));
  out.push(join(ROOT, "gates", "brief-assembler.ts"));
  return out;
}

/**
 * Root-level docs a prompt may name. Derived from what the repo actually
 * ships, not listed: a hand-maintained list of "docs that exist" is a second
 * place to forget, and forgetting there reads as the file existing.
 */
function rootDocs(): Set<string> {
  return new Set(readdirSync(ROOT).filter(f => f.endsWith(".md")));
}

describe("#272: a prompt never tells an agent to read a doc this repo does not ship", () => {
  test("every ${PROJECT_ROOT}/<doc>.md read is either present or qualified", () => {
    const present = rootDocs();
    const violations: string[] = [];

    for (const file of promptFiles()) {
      const src = stripJsComments(readFileSync(file, "utf-8"));
      src.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(/\$\{(?:PROJECT_ROOT|projectRoot)\}\/([A-Z][A-Za-z0-9_-]*\.md)/g)) {
          const doc = m[1];
          if (present.has(doc)) continue;
          // The qualifier has to be on the same line as the instruction. A
          // caveat three paragraphs later is not something an agent reliably
          // connects to the imperative it is reading.
          if (/\bif it exists\b|\bif exists\b|\bONLY if\b|\bwhen present\b/i.test(line)) continue;
          violations.push(`${file.replace(`${ROOT}/`, "")}:${i + 1} — reads ${doc}, which this repo does not ship, with no qualifier`);
        }
      });
    }

    expect(
      violations,
      `a prompt instructs an agent to read a file that is not there:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  test("the guard is reading real prompts, and would catch the defect it was written for", () => {
    // Two vacuity guards. The first: an extractor that silently stops matching
    // turns the test above green over anything.
    const files = promptFiles();
    expect(files.length, "no prompt files found").toBeGreaterThan(2);
    const anyRootRead = files.some(f =>
      /\$\{(?:PROJECT_ROOT|projectRoot)\}\/[A-Z][A-Za-z0-9_-]*\.md/.test(readFileSync(f, "utf-8")),
    );
    expect(anyRootRead, "no ${PROJECT_ROOT}/<doc>.md reads found at all").toBe(true);

    // The second: the detector must still fire on #272's exact text, and must
    // NOT fire on the qualified form the fix uses — otherwise it is either
    // blind or permanently red.
    const detector = (line: string) => {
      const hit = /\$\{PROJECT_ROOT\}\/([A-Z][A-Za-z0-9_-]*\.md)/.exec(line);
      if (!hit || rootDocs().has(hit[1])) return false;
      return !/\bif it exists\b|\bif exists\b|\bONLY if\b|\bwhen present\b/i.test(line);
    };
    expect(detector("Read ${PROJECT_ROOT}/ARCHITECTURE.md first."), "the guard misses #272's own text").toBe(true);
    expect(
      detector("Read ${PROJECT_ROOT}/ARCHITECTURE.md first (if it exists; no such file here)."),
      "the guard is red on the corrected form",
    ).toBe(false);
  });

  test("ARCHITECTURE.md is in fact absent — the premise this guard rests on", () => {
    // If someone adds the file, these reads become legitimate and the guard
    // stops firing on its own. That is correct, and this states it out loud so
    // a future reader is not left wondering why the rule exists.
    expect(existsSync(join(ROOT, "ARCHITECTURE.md"))).toBe(false);
  });
});
