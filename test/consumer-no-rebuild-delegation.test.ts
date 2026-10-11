/**
 * #274 AC-6 — nothing this issue adds delegates a container rebuild.
 *
 * SC-6 is a prohibition, verbatim: "No part of this delegates the DDB rebuild
 * to an agent — DDB's CLAUDE.md forbids it and the Makefile has a worktree
 * guard that exits 1." This issue builds a FIXTURE of a consumer that HAS a
 * container, which is exactly the situation in which that delegation is one
 * careless line away: the fixture's `container.rebuildCommand` is a real DDB
 * command, carried as an inert string so ship.js's container block has
 * something to interpolate.
 *
 * ## Why this scans by EXECUTION CONSTRUCT and not by the command's name
 *
 * A check for the literal command string would be both a false positive and a
 * check that cannot fail. False positive, because the string already appears
 * as inert text in `test/directive-extractor.test.ts` and
 * `test/spec-compliance-auto.test.ts`, and because the fixture is REQUIRED to
 * carry it. Cannot fail, because the dangerous thing was never the string — it
 * is a child process. An agent prompt telling an agent to rebuild with no
 * command in it is just as much a delegation, and a `spawnSync` of a shell
 * script that rebuilds would not contain the words at all.
 *
 * So the scan finds every EXECUTION construct in the added files, extracts the
 * text of the call, and asserts none of them names a rebuild, podman or
 * docker. Both halves are measured: that the scanner finds constructs at all
 * (this issue does spawn `bun test`), and that it SEES a planted violation.
 *
 * ## The self-reference trap, and how it is closed
 *
 * This file is in its own scan list, and a detector that names what it detects
 * is evidence for nothing — `.claude/rules/checks-must-be-able-to-fail.md`
 * records the same trap in #171, where a spec phrase survived inside the SC
 * line demanding it and a whole-section search went green over a spec that no
 * longer explained itself.
 *
 * So the detector's own vocabulary and its planted controls live inside ONE
 * marked region, and that region is REMOVED from this file before this file is
 * scanned. The removal is bounded and asserted: the region must exist exactly
 * once, removing it must change the source, and what is left must still be
 * most of the file, or the exemption would have swallowed the subject.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");

/** Every file #274 adds. A path that is not here is not scanned. */
const ADDED_FILES = [
  "test/fixtures/consumer-ui-project/.claude/rungate.json",
  "test/fixtures/consumer-ui-project/workflow-state.json",
  "test/helpers/consumer-ship-sites.ts",
  "test/consumer-ceremony-fixture.test.ts",
  "test/consumer-tier-gated-subsystems.test.ts",
  "test/consumer-tier-downgrade-mutation.test.ts",
  "test/consumer-scope-gate-prevalidation.test.ts",
  "test/consumer-no-rebuild-delegation.test.ts",
];

const SELF = "test/consumer-no-rebuild-delegation.test.ts";

// ──── DETECTOR-START ────

/**
 * Anything that starts a child process. Named constructs rather than a single
 * catch-all, because a bare `exec` would also match `execute`, and a detector
 * that matches prose is the shape this repo keeps getting wrong.
 */
const EXECUTION_CONSTRUCTS: Array<{ name: string; re: RegExp }> = [
  { name: "spawnSync", re: /\bspawnSync\s*\(/g },
  { name: "spawn", re: /(?<![.A-Za-z])spawn\s*\(/g },
  { name: "execSync", re: /\bexecSync\s*\(/g },
  { name: "execFileSync", re: /\bexecFileSync\s*\(/g },
  { name: "execFile", re: /\bexecFile\s*\(/g },
  { name: "exec", re: /(?<![A-Za-z.])exec\s*\(/g },
  { name: "Bun.$", re: /Bun\s*\.\s*\$\s*`/g },
  { name: "Bun.spawn", re: /Bun\s*\.\s*spawn(?:Sync)?\s*\(/g },
  { name: "child_process", re: /\bchild_process\b/g },
];

/** The container runtimes that must never be shelled out to directly. */
const CONTAINER_RUNNERS = new RegExp(
  [`\\b${["pod", "man"].join("")}\\b`, `\\b${["doc", "ker"].join("")}\\b`].join("|"),
  "i",
);

const MAKE = "make";
const REBUILD = "rebuild";

/**
 * Does this call text name a rebuild or a container runtime?
 *
 * `make` and `rebuild` are matched as a PAIR rather than as the adjacent
 * phrase, because an argv form splits them — handing `"make"` and `["rebuild"]`
 * to `spawnSync` is the same delegation with a comma in it, and a detector
 * that only knew the shell form would miss the one a TypeScript file is most
 * likely to use. The pairing is scoped to the text of a single child-process
 * call, which is narrow enough that both words appearing together means what
 * it looks like.
 */
function namesARebuild(text: string): boolean {
  if (CONTAINER_RUNNERS.test(text)) return true;
  return new RegExp(`\\b${MAKE}\\b`, "i").test(text) && new RegExp(`\\b${REBUILD}`, "i").test(text);
}

/**
 * A prompt that tells an agent to rebuild, with or without a command.
 *
 * ship.js's own container block carries one — that is the harness's text, not
 * this issue's — so the scan is scoped to the added files. The imperative is
 * the bare form an instruction takes; the descriptive forms ("the rebuild
 * command", "rebuildCommand") are what prose uses to point AT a rebuild, and a
 * detector that cannot tell them apart is the #235 mistake.
 */
const REBUILD_IMPERATIVE = new RegExp(
  `(?:\\brun\\b|\\bexecute\\b|\\binvoke\\b)[^.\\n]{0,80}\\b${MAKE}\\s+${REBUILD}\\b|` +
    `\\b${REBUILD}\\b\\s+the\\s+(?:test\\s+)?container\\b`,
  "i",
);

/** One planted delegation per construct the detector claims to cover. */
const PLANTED_DELEGATIONS: Array<[string, string]> = [
  ["spawnSync", `${["spawn", "Sync"].join("")}("${MAKE}", ["${REBUILD}"])`],
  ["execSync", `${["exec", "Sync"].join("")}("${MAKE} ${REBUILD}")`],
  ["Bun.$", "Bun.$`" + `${MAKE} ${REBUILD}` + "`"],
  ["exec", `${"exec"}("${["doc", "ker"].join("")} compose up")`],
  ["spawn", `${"spawn"}("${["pod", "man"].join("")}", ["build", "."])`],
];

/** Prompts the imperative detector must SEE. */
const PLANTED_IMPERATIVES = [
  `Run this EXACT command and report the output: cd /project && ${MAKE} ${REBUILD}`,
  `You have ONE task: ${REBUILD} the test container.`,
];

/** Prose the imperative detector must NOT fire on. */
const INNOCENT_PROSE = [
  `the fixture's container.${REBUILD}Command is carried as an inert string`,
  `DDB's CLAUDE.md forbids ${MAKE} ${REBUILD} and the Makefile has a worktree guard`,
  `ship.js interpolates the ${REBUILD} command into a prompt`,
];

/** The text of a call starting at the `(` that `open` points at, parens balanced. */
function callText(src: string, open: number): string {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") i += 2;
        else if (src[i] === quote) {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
    i++;
  }
  // Unbalanced: hand back a generous window rather than nothing, so a
  // violation cannot hide behind a parse failure.
  return src.slice(open, open + 1000);
}

interface Site {
  file: string;
  construct: string;
  text: string;
}

/** Every execution site in `source`, with the text of the call it starts. */
export function executionSites(file: string, source: string): Site[] {
  const sites: Site[] = [];
  for (const { name, re } of EXECUTION_CONSTRUCTS) {
    for (const m of source.matchAll(new RegExp(re.source, "g"))) {
      const at = m.index ?? 0;
      const paren = source.indexOf("(", at);
      const wholeWord = name === "child_process" || name === "Bun.$" || paren < 0;
      const text = wholeWord ? source.slice(at, at + 400) : callText(source, paren);
      sites.push({ file, construct: name, text });
    }
  }
  return sites;
}

/** The execution sites that name a rebuild, podman or docker. */
export function rebuildDelegations(file: string, source: string): Site[] {
  return executionSites(file, source).filter((s) => namesARebuild(s.text));
}

// ──── DETECTOR-END ────

// Assembled, not written: a literal here would be a second copy of the marker
// and the uniqueness assertion below would refuse the file it is checking.
const DETECTOR_START = `// ──── DETECTOR${"-START"} ────`;
const DETECTOR_END = `// ──── DETECTOR${"-END"} ────`;

const sourceOf = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf-8");

/**
 * The text of `rel` that this file is entitled to judge.
 *
 * For every file but this one, that is the whole file. For this one the
 * detector's own vocabulary is cut out first — it names every token it looks
 * for, so leaving it in would report the detector as the violation and leave
 * nothing distinguishing a clean tree from a dirty one.
 */
export function scannableSource(rel: string, source = sourceOf(rel)): string {
  if (rel !== SELF) return source;
  const a = source.indexOf(DETECTOR_START);
  const b = source.indexOf(DETECTOR_END);
  if (a < 0 || b <= a) {
    throw new Error(
      `${SELF} has no DETECTOR marker pair — the self-reference exemption cannot be bounded, ` +
        `so this scan proves nothing`,
    );
  }
  return source.slice(0, a) + source.slice(b + DETECTOR_END.length);
}

describe("#274 AC-6: every file this issue adds exists and is scanned", () => {
  test("each listed file is on disk", () => {
    for (const rel of ADDED_FILES) {
      expect(existsSync(join(REPO_ROOT, rel)), `${rel} is listed but missing`).toBe(true);
    }
    expect(ADDED_FILES.length).toBe(8);
    expect(new Set(ADDED_FILES).size).toBe(ADDED_FILES.length);
    expect(ADDED_FILES).toContain(SELF);
  });

  test("the self-reference exemption is bounded, and does not swallow the subject", () => {
    const whole = sourceOf(SELF);
    const scanned = scannableSource(SELF, whole);
    expect(whole.split(DETECTOR_START).length - 1).toBe(1);
    expect(whole.split(DETECTOR_END).length - 1).toBe(1);
    expect(scanned.length).toBeLessThan(whole.length);
    // What the file DOES is still judged — only the detector's vocabulary is
    // cut. An exemption that removed the test bodies would pass every
    // assertion below for the wrong reason, so each suite title is required to
    // survive the cut.
    for (const title of [
      "every file this issue adds exists and is scanned",
      "no added file executes a rebuild, podman or docker",
      "no agent prompt in the added files instructs a rebuild",
    ]) {
      expect(scanned, `the exemption swallowed the "${title}" suite`).toContain(title);
    }
    expect(scannableSource("test/helpers/consumer-ship-sites.ts")).toBe(
      sourceOf("test/helpers/consumer-ship-sites.ts"),
    );
  });

  test("an unmarked detector region is refused, not silently skipped", () => {
    const unmarked = sourceOf(SELF).replace(DETECTOR_START, "// nothing here");
    expect(() => scannableSource(SELF, unmarked)).toThrow(/no DETECTOR marker pair/);
  });
});

describe("#274 AC-6: no added file executes a rebuild, podman or docker", () => {
  test("the scan finds zero rebuild delegations", () => {
    const found = ADDED_FILES.flatMap((rel) => rebuildDelegations(rel, scannableSource(rel)));
    expect(
      found.map((s) => `${s.file}: ${s.construct} ${s.text.slice(0, 120)}`),
      "an added file starts a child process that names a rebuild",
    ).toEqual([]);
  });

  test("the scan has something to look at", () => {
    // Vacuity guard. A scanner that found no execution constructs at all would
    // report zero delegations forever. This issue genuinely spawns `bun test`
    // in test/consumer-tier-downgrade-mutation.test.ts.
    const sites = ADDED_FILES.flatMap((rel) => executionSites(rel, scannableSource(rel)));
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.some((s) => s.construct === "spawnSync")).toBe(true);
  });

  test("the scan SEES a planted delegation, in each construct it claims to cover", () => {
    // The mutation, performed and observed. Without it, a scanner whose
    // regexes matched nothing would be indistinguishable from a clean tree.
    expect(PLANTED_DELEGATIONS.length).toBe(5);
    for (const [construct, src] of PLANTED_DELEGATIONS) {
      const hits = rebuildDelegations("planted.ts", src);
      expect(hits.length, `the scanner missed a planted ${construct} delegation`).toBeGreaterThan(0);
      expect(hits.some((h) => h.construct === construct)).toBe(true);
    }
  });

  test("the scan does NOT flag the inert string the fixture is required to carry", () => {
    // The other direction. A string-presence check would refuse the fixture
    // itself, and a scanner that refuses the correct state is as useless as
    // one that accepts the wrong one.
    const fixture = "test/fixtures/consumer-ui-project/.claude/rungate.json";
    const src = sourceOf(fixture);
    expect(namesARebuild(src), "the fixture no longer carries the rebuild command").toBe(true);
    expect(rebuildDelegations(fixture, src)).toEqual([]);
    expect(executionSites(fixture, src)).toEqual([]);
  });

  test("the fixture's rebuildCommand is a string and nothing hands it to a process", () => {
    const fixture = JSON.parse(
      sourceOf("test/fixtures/consumer-ui-project/.claude/rungate.json"),
    ) as { container?: { rebuildCommand?: unknown } };
    expect(typeof fixture.container?.rebuildCommand).toBe("string");
    // The only consumer of it is ship.js's own container block, executed
    // through a recording stub. Mentioning the key in a comment or an
    // assertion is not a read; handing it to a child process is.
    const handedToAProcess = ADDED_FILES.flatMap((rel) =>
      executionSites(rel, scannableSource(rel)).filter((s) => s.text.includes("rebuildCommand")),
    );
    expect(handedToAProcess.map((s) => `${s.file}: ${s.construct}`)).toEqual([]);
  });
});

describe("#274 AC-6: no agent prompt in the added files instructs a rebuild", () => {
  test("no added file carries a rebuild imperative", () => {
    const offenders = ADDED_FILES.filter((rel) => REBUILD_IMPERATIVE.test(scannableSource(rel)));
    expect(offenders, "an added file instructs an agent to rebuild").toEqual([]);
  });

  test("the imperative detector SEES one when it is there", () => {
    expect(PLANTED_IMPERATIVES.length).toBe(2);
    for (const planted of PLANTED_IMPERATIVES) {
      expect(REBUILD_IMPERATIVE.test(planted), `the detector missed: ${planted}`).toBe(true);
    }
  });

  test("the imperative detector does NOT fire on prose that merely mentions one", () => {
    // The #235 boundary: an instruction that performs the thing, versus a
    // sentence that points at where it lives.
    expect(INNOCENT_PROSE.length).toBe(3);
    for (const prose of INNOCENT_PROSE) {
      expect(REBUILD_IMPERATIVE.test(prose), `the detector fired on prose: ${prose}`).toBe(false);
    }
  });
});
