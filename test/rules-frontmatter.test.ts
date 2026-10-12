/**
 * #299 — a doc formatter was silently deleting the field rules are surfaced by.
 *
 * `DocHygiene.hook.ts` rebuilt every `.md`'s frontmatter from its four
 * required keys and discarded the rest. Editing `.claude/rules/key-files.md`
 * dropped its `description:` — the field Claude Code's rule loading reads —
 * and all eight rules files carried it. The damage was one file per edit,
 * only to files somebody had touched, and nothing went red: a rules file that
 * has stopped being surfaced to agents is indistinguishable from one that is
 * surfaced and ignored.
 *
 * Underneath it, a second failure. The parser was `line.split(":")`, which
 * cannot see a YAML block value, so `harness-managed.md`'s `paths:` list —
 * the list that declares which files the scaffold owns — would have been
 * flattened even by a merge written over it.
 *
 * ## Three layers, because the subject spans two repos
 *
 * 1. **The library** (`lib/frontmatter.ts`) is rungate's, tested exhaustively,
 *    and runs everywhere including CI.
 * 2. **Convention parity** over the real `.claude/rules/*.md` is the check
 *    that would have gone red the moment the hook shipped. It needs nothing
 *    but this repo, so it always runs.
 * 3. **The hook itself** lives in `~/.pai/hooks/`, outside this repo and
 *    outside CI. Those cases are driven against the real file when it is
 *    present and report an explicit, named skip when it is not — a consumer
 *    who has never installed PAI must not be refused for a file they do not
 *    have. Where it IS present it is executed, not read.
 *
 * Covers SC-729, SC-730, SC-731, SC-732 of DOC-HYGIENE-ARCHITECTURE-SPEC.md.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  parseFrontmatter,
  serialiseFrontmatter,
  stampFrontmatter,
  frontmatterKeys,
} from "../lib/frontmatter";

const ROOT = join(import.meta.dir, "..");
const RULES_DIR = join(ROOT, ".claude", "rules");
const STAMP = { "doc-type": "reference", status: "active", owner: "jason", updated: "2026-01-01" };

describe("#299: stamping adds fields and never removes one", () => {
  const WITH_BLOCK = [
    "---",
    "description: Files managed by rungate scaffold — do not edit directly",
    "paths:",
    '  - ".github/workflows/**"',
    '  - "CODE-MAP.md"',
    "---",
    "",
    "## Body",
    "",
  ].join("\n");

  test("an existing scalar field survives the stamp", () => {
    const out = stampFrontmatter("---\ndescription: hello\n---\n\nbody\n", STAMP);
    expect(out.refused).toBeNull();
    expect(frontmatterKeys(out.content)).toEqual([
      "description", "doc-type", "status", "owner", "updated",
    ]);
    expect(out.content).toContain("description: hello");
  });

  test("a YAML block value survives the stamp, lines and order intact", () => {
    // The second-order case the issue flagged: `harness-managed.md`'s paths
    // list defines which files the scaffold owns. The old `split(':')` parser
    // read it as `paths: ""` plus two lines it could not place.
    const out = stampFrontmatter(WITH_BLOCK, STAMP);
    expect(out.refused).toBeNull();
    expect(out.content).toContain('  - ".github/workflows/**"');
    expect(out.content).toContain('  - "CODE-MAP.md"');
    expect(frontmatterKeys(out.content)).toEqual([
      "description", "paths", "doc-type", "status", "owner", "updated",
    ]);
  });

  test("new keys land AFTER existing ones, so a diff is additions", () => {
    const out = stampFrontmatter(WITH_BLOCK, STAMP);
    const keys = frontmatterKeys(out.content);
    expect(keys.indexOf("description")).toBeLessThan(keys.indexOf("doc-type"));
    expect(keys.indexOf("paths")).toBeLessThan(keys.indexOf("doc-type"));
  });

  test("no blank line is left inside the block", () => {
    // The trailing newline before the closing fence is a separator, not a
    // blank line. Absorbing it into the last entry parks an empty line in the
    // MIDDLE of the block as soon as a key is appended after it — which is
    // what the first version of this fix did.
    const out = stampFrontmatter(WITH_BLOCK, STAMP);
    // The fences contribute the first and last newline; the interior is what
    // must have no gaps in it.
    const interior = out.content.split("---")[1].split("\n").slice(1, -1);
    expect(interior.filter(l => l.trim() === "")).toEqual([]);
    expect(interior.length, "the block is empty, so the assertion proves nothing").toBeGreaterThan(4);
  });

  test("an existing value is never overwritten", () => {
    const out = stampFrontmatter("---\nowner: someone-else\n---\n\nbody\n", STAMP);
    expect(out.content).toContain("owner: someone-else");
    expect(out.content).not.toContain("owner: jason");
    expect(out.stamped).not.toContain("owner: jason");
  });

  test("a fully stamped document is left byte-identical", () => {
    const once = stampFrontmatter(WITH_BLOCK, STAMP);
    const twice = stampFrontmatter(once.content, STAMP);
    expect(twice.stamped).toEqual([]);
    expect(twice.content).toBe(once.content);
  });

  test("a document with no frontmatter gets one, body untouched", () => {
    const out = stampFrontmatter("# Title\n\ntext\n", STAMP);
    expect(frontmatterKeys(out.content)).toEqual(["doc-type", "status", "owner", "updated"]);
    expect(out.content).toContain("# Title\n\ntext\n");
  });

  test("parse and serialise round-trip every real rules file byte-for-byte", () => {
    // The strongest form of "nothing is lost": the inputs are the eight files
    // the bug damaged, not invented ones.
    const files = readdirSync(RULES_DIR).filter(f => f.endsWith(".md"));
    expect(files.length, "no rules files found — the sweep is measuring nothing").toBeGreaterThan(5);
    for (const f of files) {
      const content = readFileSync(join(RULES_DIR, f), "utf-8");
      const parsed = parseFrontmatter(content);
      expect(parsed, `${f} has no parseable frontmatter`).not.toBeNull();
      expect(serialiseFrontmatter(parsed!), `${f} does not round-trip`).toBe(content);
    }
  });
});

describe("#299: an unreadable block is left alone, not rewritten", () => {
  // "Rewriting a block you cannot read" IS the bug. A parser that guesses is
  // strictly worse than one that refuses.
  test("an unterminated block refuses", () => {
    const src = "---\ndescription: no closing fence\n\n## Body\n";
    expect(parseFrontmatter(src)).toBeNull();
    const out = stampFrontmatter(src, STAMP);
    expect(out.content).toBe(src);
    expect(out.refused).toContain("could not be parsed");
    expect(out.stamped).toEqual([]);
  });

  test("an unindented non-key line refuses rather than being dropped", () => {
    const src = "---\ndescription: x\nthis is not a key line\n---\n\nbody\n";
    expect(parseFrontmatter(src)).toBeNull();
    expect(stampFrontmatter(src, STAMP).content).toBe(src);
  });

  test("a leading line before any key refuses", () => {
    const src = "---\n  - orphan\ndescription: x\n---\n\nbody\n";
    expect(parseFrontmatter(src)).toBeNull();
  });

  test("the refusal is not the catch-all — a well-formed block still parses", () => {
    // Positive control. A parser that returned null for everything would
    // satisfy all three cases above and stamp nothing, ever.
    expect(parseFrontmatter("---\na: 1\nb:\n  - x\n---\nbody\n")).not.toBeNull();
  });
});

describe("#299: the rules files agree on a convention", () => {
  const files = readdirSync(RULES_DIR).filter(f => f.endsWith(".md"));

  test("every rules file declares a description", () => {
    // This is the check that would have gone red the moment the hook
    // shipped, and it is the one that stays green without PAI installed.
    const missing = files.filter(f => !frontmatterKeys(readFileSync(join(RULES_DIR, f), "utf-8")).includes("description"));
    expect(
      missing,
      `.claude/rules file(s) with no description: ${missing.join(", ")}. The field is what ` +
        `Claude Code's rule loading surfaces a rule by; a rule without one is loaded less ` +
        `reliably and nothing goes red when it stops being loaded (#299).`,
    ).toEqual([]);
  });

  test("no description is empty or a placeholder", () => {
    for (const f of files) {
      const parsed = parseFrontmatter(readFileSync(join(RULES_DIR, f), "utf-8"));
      const d = parsed?.entries.find(e => e.key === "description")?.inline ?? "";
      expect(d.length, `${f}'s description is too short to describe anything`).toBeGreaterThan(20);
    }
  });

  test("harness-managed.md still carries its paths list", () => {
    // Named explicitly because it is the file whose loss would be worst and
    // least visible: the list declares which files the scaffold owns.
    const parsed = parseFrontmatter(readFileSync(join(RULES_DIR, "harness-managed.md"), "utf-8"));
    const paths = parsed?.entries.find(e => e.key === "paths");
    expect(paths, "harness-managed.md has lost its paths list").toBeDefined();
    expect(paths!.block.filter(l => l.trim().startsWith("-")).length).toBeGreaterThan(2);
  });

  test("key-files.md's description is back — the file the bug was found on", () => {
    const keys = frontmatterKeys(readFileSync(join(RULES_DIR, "key-files.md"), "utf-8"));
    expect(keys).toContain("description");
  });
});

// ── The hook itself, executed where it exists ─────────────────────────────

const HOOK = join(homedir(), ".pai", "hooks", "DocHygiene.hook.ts");
const HOOK_PRESENT = existsSync(HOOK);

let TMP = "";
afterAll(() => { if (TMP) rmSync(TMP, { recursive: true, force: true }); });

/**
 * Run the real hook over a file and return what it left behind.
 *
 * NOT under /tmp: the hook skips that path on purpose, because markdown on
 * its way to `gh --body-file` is a payload rather than a document. A fixture
 * placed there would be skipped and the test would read the skip as the hook
 * preserving everything — a check passing because of what it never looked at,
 * in the test for a bug of exactly that shape.
 */
function runHook(content: string, name: string): { out: string; stdout: string } {
  if (!TMP) TMP = mkdtempSync(join(homedir(), ".rungate-299-"));
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, "doc.md");
  writeFileSync(fp, content);
  const r = spawnSync("bun", [HOOK], {
    input: JSON.stringify({ tool_input: { file_path: fp } }),
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { out: readFileSync(fp, "utf-8"), stdout: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("#299: the hook preserves what it does not own", () => {
  test("the hook is where this expects it, or the reason is named", () => {
    // UNMEASURED, stated rather than hidden. The hook lives outside this repo
    // and outside CI, so its absence is normal there and a refusal would
    // break every consumer who has never installed PAI. It is NOT normal on a
    // machine that has one, which is why the path is printed.
    if (!HOOK_PRESENT) {
      console.warn(
        `WARN #299: ${HOOK} is absent, so the hook cases below did not run. The library ` +
          `and convention cases above still did, and they are what catch the regression ` +
          `inside this repo.`,
      );
    }
    expect(typeof HOOK_PRESENT).toBe("boolean");
  });

  test.skipIf(!HOOK_PRESENT)("it does not strip description", () => {
    const { out } = runHook("---\ndescription: a real description of this rule\n---\n\n## Body\n", "desc");
    expect(frontmatterKeys(out)).toContain("description");
    expect(out).toContain("description: a real description of this rule");
  });

  test.skipIf(!HOOK_PRESENT)("it does not flatten a paths list", () => {
    const src = [
      "---", "description: files the scaffold owns", "paths:",
      '  - ".github/workflows/**"', '  - "CODE-MAP.md"', "---", "", "## Body", "",
    ].join("\n");
    const { out } = runHook(src, "paths");
    expect(out).toContain('  - ".github/workflows/**"');
    expect(out).toContain('  - "CODE-MAP.md"');
    expect(frontmatterKeys(out)).toContain("paths");
  });

  test.skipIf(!HOOK_PRESENT)("it still does its job — the four fields are added", () => {
    // Paired with the cases above. A hook that had simply stopped writing
    // would satisfy both of them and do nothing useful.
    const { out, stdout } = runHook("---\ndescription: a real description here\n---\n\n## Body\n", "adds");
    expect(stdout, `the hook did not report stamping:\n${stdout}`).toContain("auto-stamped");
    for (const k of ["doc-type", "status", "owner", "updated"]) {
      expect(frontmatterKeys(out)).toContain(k);
    }
  });

  test.skipIf(!HOOK_PRESENT)("it agrees with lib/frontmatter.ts on the same input", () => {
    // The hook cannot import from this repo, so the logic is duplicated. This
    // is the only thing stopping the two drifting, which is how the fix
    // decays back into the bug.
    const src = [
      "---", "description: files the scaffold owns", "paths:",
      '  - ".github/workflows/**"', "---", "", "## Body", "",
    ].join("\n");
    const { out } = runHook(src, "parity");
    const today = out.match(/^updated: (\S+)$/m)?.[1] ?? "";
    expect(today, "the hook wrote no updated field to compare against").not.toBe("");
    const lib = stampFrontmatter(src, {
      "doc-type": "reference", status: "active", owner: "jason", updated: today,
    });
    expect(out).toBe(lib.content);
  });

  test.skipIf(!HOOK_PRESENT)("an unparseable block is left exactly as it was", () => {
    const src = "---\ndescription: x\nthis is not a key line\n---\n\n## Body\n";
    const { out, stdout } = runHook(src, "refuse");
    expect(out).toBe(src);
    expect(stdout).toContain("left unchanged");
  });
});
