/**
 * #906 (#892 Phase 2): the content-comparison cases bite, proven by a mutant
 * builder that lives in the tree rather than by a battery somebody ran once.
 *
 * #892 shipped `overlapReadings()` and twenty-one cases over it. #991
 * measured a five-row battery against those cases by hand, found one case
 * that was green under every row including a real size-comparing mutant, and
 * fixed it. Both of those are measurements: a number in a PR body, true of
 * one tree on one evening. Neither is a guard. AC-6 asks for mutants "built
 * from the real source and aborting loudly if its anchor moves", which is a
 * description of a standing harness, so this is that harness.
 *
 * ## What a row here asserts, and why it is three assertions and not one
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`: *before recording a 0, name
 * an input on which the mutant and the original differ. If you cannot, you
 * have not run a mutation — you have run the code twice.* The rule is stated
 * for a human running a battery. Written down as a case it becomes:
 *
 * 1. **the anchor is in the source exactly once** — a mutation that silently
 *    finds nothing reads as "the mutant was rejected on the merits", and a
 *    mutation that finds two sites changes something the row does not name.
 *    `buildMutant` throws rather than no-opping, and this assertion is what
 *    makes the throw a named red instead of an error inside another case.
 * 2. **the ORIGINAL's answer on the distinguishing input**, pinned by value.
 *    Without it, "they differ" is satisfied by two wrong answers.
 * 3. **the MUTANT's answer on the same input**, pinned by value, and
 *    different. `not.toBe` alone would stay green if the mutant started
 *    throwing — a crashing mutant is not a mutant.
 *
 * ## Why this is not a second decider for `preserve-overlap-reading.test.ts`
 *
 * That file asserts what `overlapReadings` ANSWERS. This one asserts that
 * each of the six arms is individually load-bearing — that deleting it
 * changes an answer. Those are different questions over the same subject: a
 * verdict case stays green when a redundant arm is removed, and a row here
 * stays green when a verdict is wrong in both directions at once. Neither
 * can be derived from the other, so mutating one does not leave the other
 * holding the case up.
 *
 * ## The cheapest wrong fix is a ROW, not a footnote
 *
 * M4 is `git cat-file -s` in place of `git rev-parse <sha>:<path>` — the 5pm
 * repair for "tell me whether these two copies are the same": compare the
 * SIZES. It is one argument different, it needs no new concept, and it is
 * right about almost every real input. It is in the battery as an executed
 * mutant with a distinguishing input, because a cheapest wrong fix named only
 * in prose is a claim about code nobody ran.
 *
 * Covers SC-2460, SC-2461, SC-2462 (PARALLEL-AGENT-COORDINATION-SPEC.md).
 */

// SPEC-REF: PARALLEL-AGENT-COORDINATION-SPEC.md § #906 — the comparison's arms are each load-bearing

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import {
  overlapReadings,
  type OverlapReading,
  type PreserveEntry,
} from "../scripts/preserve-worktree-work";

const ROOT = mkdtempSync(join(tmpdir(), "rg906-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

// ── the fixture: one object store, three linked worktrees ──────────────────

const REPO = join(ROOT, "origin");
mkdirSync(REPO);
git(REPO, "init", "-q", "-b", "main");
git(REPO, "config", "user.email", "t@example.com");
git(REPO, "config", "user.name", "t");
writeFileSync(join(REPO, "seed.txt"), "seed\n");
git(REPO, "add", "-A");
git(REPO, "commit", "-q", "-m", "seed");

function worktree(name: string, files: Record<string, string>): PreserveEntry {
  const dir = join(ROOT, name);
  git(REPO, "worktree", "add", "-q", "-b", name, dir, "main");
  for (const [rel, body] of Object.entries(files)) {
    writeFileSync(join(dir, rel), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `work in ${name}`);
  return { worktreePath: dir, branch: name, sha: git(dir, "rev-parse", "HEAD"), status: "committed" };
}

/** Same length, different content — the input M4 exists to be wrong about. */
const SAME_LEN_A = "export const rate = 100\n";
const SAME_LEN_B = "export const rate = 200\n";

const alpha = worktree("alpha", {
  "shared.ts": "export const x = 1\n",
  "edited.ts": SAME_LEN_A,
  "only-alpha.ts": "a\n",
});
const beta = worktree("beta", { "shared.ts": "export const x = 1\n", "edited.ts": SAME_LEN_B });
const gamma = worktree("gamma", { "shared.ts": "export const x = 1\n" });

// ── the builder ────────────────────────────────────────────────────────────

const SOURCE_PATH = join(import.meta.dir, "..", "scripts", "preserve-worktree-work.ts");
const SOURCE = readFileSync(SOURCE_PATH, "utf-8");

const MUTANTS = mkdtempSync(join(tmpdir(), "rg906-mutants-"));
afterAll(() => rmSync(MUTANTS, { recursive: true, force: true }));

type Subject = { overlapReadings: typeof overlapReadings };

let serial = 0;

/**
 * The real source with one anchor replaced, loaded as a module.
 *
 * Every refusal here is LOUD and names what it could not do. A builder that
 * returns the unmutated module when its anchor has moved produces a row of
 * zeros that looks exactly like a row of findings, which is the failure this
 * whole file is about.
 */
async function buildMutant(anchor: string, replacement: string): Promise<Subject> {
  const hits = SOURCE.split(anchor).length - 1;
  if (hits !== 1) {
    throw new Error(
      `could not build the mutant: the anchor appears ${hits} times in ` +
        `scripts/preserve-worktree-work.ts, expected exactly 1 — ${JSON.stringify(anchor.slice(0, 90))}`,
    );
  }
  const mutated = SOURCE.replace(anchor, replacement);
  if (mutated === SOURCE) {
    throw new Error("could not build the mutant: the replacement left the source byte-identical");
  }
  // Its OWN directory, not a serial filename in a shared one. bun caches the
  // directory listing on first resolution, so a second file written into an
  // already-imported directory fails with `Cannot find module … from ''` —
  // which arrives looking like a broken mutant and is a property of the
  // loader. Measured: first import succeeds, a sibling written afterwards
  // does not, a file in a fresh mkdtemp does.
  const dir = mkdtempSync(join(MUTANTS, `m${serial++}-`));
  const file = join(dir, "subject.ts");
  writeFileSync(file, mutated);
  const mod = (await import(pathToFileURL(file).href)) as Partial<Subject>;
  if (typeof mod.overlapReadings !== "function") {
    throw new Error("the mutant module does not export overlapReadings — the harness lost its subject");
  }
  return mod as Subject;
}

/** `${verdict} read ${read}/${of}`, the whole answer for one path, as a string. */
function answer(readings: OverlapReading[]): string {
  return readings.map(o => `${o.path}: ${o.reading} read ${o.read}/${o.of}`).join(" | ");
}

// ── the builder's own controls ─────────────────────────────────────────────

describe("#906 AC-6 control: the builder refuses rather than no-opping", () => {
  test("an anchor that is not in the source aborts, and names it", async () => {
    // The property the whole battery rests on. If this returned the real
    // module, every row below would measure 0 and read as a finding.
    const absent = "const thisTextIsNotInTheSubject = true;";
    expect(SOURCE.includes(absent)).toBe(false);
    await expect(buildMutant(absent, "x")).rejects.toThrow(/appears 0 times/);
  });

  test("an anchor with two sites aborts rather than mutating one of them", async () => {
    const twice = "const ";
    expect(SOURCE.split(twice).length - 1).toBeGreaterThan(1);
    await expect(buildMutant(twice, "let ")).rejects.toThrow(/appears \d+ times/);
  });

  test("a replacement identical to the anchor aborts", async () => {
    // Otherwise a row whose replacement was mis-typed as the original reads
    // as "the mutation changed nothing and nothing caught it".
    const anchor = "const blobs = readings.map(r => r.blob).filter((b): b is string => Boolean(b));";
    expect(SOURCE.split(anchor).length - 1).toBe(1);
    await expect(buildMutant(anchor, anchor)).rejects.toThrow(/byte-identical/);
  });

  test("a mutant is a different module, not the subject under another name", async () => {
    const m = await buildMutant("read: blobs.length", "read: readings.length");
    expect(m.overlapReadings).not.toBe(overlapReadings);
  });
});

// ── the rows ───────────────────────────────────────────────────────────────

/**
 * One row per arm of `overlapReadings`. `anchor` must be exactly one site;
 * `real` and `mutant` are the two answers to `input`, pinned by value.
 */
interface Row {
  id: string;
  what: string;
  anchor: string;
  replacement: string;
  entries: PreserveEntry[];
  paths: string[];
  real: string;
  mutant: string;
}

const ROWS: Row[] = [
  {
    id: "M1",
    what: "the reading produces nothing at all",
    anchor:
      '  const wanted = [...new Set((Array.isArray(paths) ? paths : []).map(p => String(p || "").trim()).filter(Boolean))];',
    replacement: "  const wanted: string[] = [];",
    entries: [alpha, beta],
    paths: ["shared.ts"],
    real: "shared.ts: IDENTICAL read 2/2",
    mutant: "",
  },
  {
    id: "M2",
    what: 'the naive `new Set(blobs).size <= 1`, under which zero and one blob are "agreement"',
    anchor:
      '      blobs.length < 2 ? "UNMEASURED" : new Set(blobs).size === 1 ? "IDENTICAL" : "DIFFERS";',
    replacement: '      new Set(blobs).size <= 1 ? "IDENTICAL" : "DIFFERS";',
    entries: [alpha, beta],
    paths: ["only-alpha.ts"],
    real: "only-alpha.ts: UNMEASURED read 1/2",
    mutant: "only-alpha.ts: IDENTICAL read 1/2",
  },
  {
    id: "M3",
    what: "the measured verdict is always IDENTICAL, with the UNMEASURED arm left intact",
    // Deliberately NOT the whole conditional: replacing all of it deletes the
    // UNMEASURED arm too and subsumes M2, which is the mis-cut #991 recorded
    // (predicted 3, measured 8). A prose description of a mutant is not a
    // mutant; this is the re-cut one, and M2's anchor containing this one is
    // why M2 must be a separate row rather than a wider replacement.
    anchor: "new Set(blobs).size === 1",
    replacement: "true",
    entries: [alpha, beta],
    paths: ["edited.ts"],
    real: "edited.ts: DIFFERS read 2/2",
    mutant: "edited.ts: IDENTICAL read 2/2",
  },
  {
    id: "M4",
    what: "THE CHEAPEST WRONG FIX — compare the file SIZE instead of the content digest",
    anchor: "const blob = git(e.worktreePath, [\"rev-parse\", `${e.sha}:${path}`]);",
    replacement: "const blob = git(e.worktreePath, [\"cat-file\", \"-s\", `${e.sha}:${path}`]);",
    entries: [alpha, beta],
    paths: ["edited.ts"],
    real: "edited.ts: DIFFERS read 2/2",
    mutant: "edited.ts: IDENTICAL read 2/2",
  },
  {
    id: "M5",
    what: "coverage stops travelling with the verdict — `read` counts positions, not answers",
    anchor: "return { path, readings, read: blobs.length, of: readings.length, reading };",
    replacement: "return { path, readings, read: readings.length, of: readings.length, reading };",
    entries: [alpha, beta, gamma],
    paths: ["edited.ts"],
    real: "edited.ts: DIFFERS read 2/3",
    mutant: "edited.ts: DIFFERS read 3/3",
  },
];

for (const row of ROWS) {
  describe(`#906 AC-6 ${row.id}: ${row.what}`, () => {
    test("the anchor is in the real source exactly once", () => {
      expect(
        SOURCE.split(row.anchor).length - 1,
        `${row.id}'s anchor has moved — the row cannot be built, and a battery that silently ` +
          `builds nothing reports zeros that read as findings`,
      ).toBe(1);
    });

    test("the ORIGINAL answers the distinguishing input the way this row claims", () => {
      // Pinned by value. "They differ" is satisfied by two wrong answers.
      expect(answer(overlapReadings(row.entries, row.paths))).toBe(row.real);
    });

    test("the MUTANT answers it differently, and the difference is the named one", async () => {
      const m = await buildMutant(row.anchor, row.replacement);
      const got = answer(m.overlapReadings(row.entries, row.paths));
      expect(got, `${row.id} produced the original's answer — this is not a mutation`).not.toBe(
        row.real,
      );
      // By value too: `not.toBe` alone stays green when the mutant throws on
      // the way to an empty answer, and a crashing mutant is not a mutant.
      expect(got).toBe(row.mutant);
    });
  });
}

// ── M6: the failure classification, which has no verdict to compare ────────

describe("#906 AC-6 M6: an absent path and an unreadable repository collapse into one reason", () => {
  // Kept out of ROWS because the thing it destroys is not the verdict — both
  // original and mutant say UNMEASURED here. The answer that changes is the
  // REASON, which is what an operator reads, so comparing verdicts would
  // record this arm as uncovered.
  const ANCHOR =
    '          reason: /does not exist|unknown revision|not in the working tree/i.test(msg)\n' +
    '            ? "the path is not in that commit"\n' +
    "            : msg,";
  const REPLACEMENT = "          reason: msg,";

  const reasonsFor = (subject: Subject) =>
    subject
      .overlapReadings([alpha, beta], ["only-alpha.ts"])[0]!
      .readings.filter(r => r.blob === null)
      .map(r => r.reason);

  test("the anchor is in the real source exactly once", () => {
    expect(SOURCE.split(ANCHOR).length - 1, "M6's anchor has moved").toBe(1);
  });

  test("the ORIGINAL classifies an absent path as absent", () => {
    expect(reasonsFor({ overlapReadings })).toEqual(["the path is not in that commit"]);
  });

  test("the MUTANT reports git's own sentence, which does not say the path was absent", async () => {
    const m = await buildMutant(ANCHOR, REPLACEMENT);
    const got = reasonsFor(m);
    expect(got).not.toEqual(["the path is not in that commit"]);
    expect(got).toHaveLength(1);
    expect(got[0]!.length, "the mutant produced an empty reason — it crashed rather than mutated").toBeGreaterThan(0);
  });

  test("the verdict is the SAME under M6, which is why this row is not in ROWS", () => {
    // Stated as a case rather than a comment: if a future change made the
    // verdict differ here, M6 would belong in ROWS and the table above would
    // be wrong about which arm each row reaches.
    expect(answer(overlapReadings([alpha, beta], ["only-alpha.ts"]))).toBe(
      "only-alpha.ts: UNMEASURED read 1/2",
    );
  });
});

// ── the fixture's own preconditions ────────────────────────────────────────

describe("#906 AC-6: the distinguishing inputs still distinguish", () => {
  test("M4's two files are the same SIZE, or M4 measures nothing", () => {
    // `.claude/rules/checks-must-be-able-to-fail.md`: the most common way to
    // record a false 0 is a fixture the pre-fix code also catches. A size
    // comparison catches two files of different lengths, so M4's whole claim
    // rests on this and it is asserted against the committed blobs rather
    // than the local constants.
    const sizes = [alpha, beta].map(e => git(e.worktreePath, "cat-file", "-s", `${e.sha}:edited.ts`));
    expect(new Set(sizes).size, "edited.ts is no longer the same length in alpha and beta").toBe(1);
    expect(SAME_LEN_A).not.toBe(SAME_LEN_B);
  });

  test("M2's input really has exactly one readable blob", () => {
    const [o] = overlapReadings([alpha, beta], ["only-alpha.ts"]);
    expect(o!.read).toBe(1);
    expect(o!.of).toBe(2);
  });

  test("M5's input really is readable in two of three positions", () => {
    const [o] = overlapReadings([alpha, beta, gamma], ["edited.ts"]);
    expect(`${o!.read}/${o!.of}`).toBe("2/3");
  });

  test("every row's anchors are distinct sites, except the one documented to nest", () => {
    // M3's anchor is a substring of M2's on purpose — they cut the same
    // conditional at two widths, and that is the whole reason both exist.
    // Any OTHER pair sharing text would mean two rows mutating one site and
    // reporting it as two independent findings.
    const nested: Array<[string, string]> = [];
    for (const a of ROWS) {
      for (const b of ROWS) {
        if (a.id !== b.id && a.anchor.includes(b.anchor)) nested.push([a.id, b.id]);
      }
    }
    expect(nested).toEqual([["M2", "M3"]]);
  });
});
