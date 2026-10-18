import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * #274 AC-6 — nothing this issue adds executes a container rebuild.
 *
 * The prohibition is verbatim from the issue: *"No part of this delegates a
 * container rebuild to an agent — DailyBriefDashboard's CLAUDE.md forbids it
 * and the Makefile has a worktree guard that exits 1."* #274 builds a FIXTURE
 * that makes the container path OBSERVABLE; it must not make it REAL.
 *
 * ## Why this scans for execution constructs and not for a string
 *
 * A string-presence check would be both a false positive and a check that
 * cannot fail. The rebuild phrase already appears as inert text in
 * `test/directive-extractor.test.ts` and `test/spec-compliance-auto.test.ts`,
 * and it appears here BY DESIGN: the consumer fixture's
 * `container.rebuildCommand` carries DailyBriefDashboard's real value so the
 * fixture is a faithful stand-in. Banning the characters would ban the
 * fixture. What must be banned is the thing that turns characters into a
 * process.
 *
 * So the scan locates every EXECUTION CONSTRUCT — `spawn`, `spawnSync`,
 * `exec`, `execSync`, `execFileSync`, `child_process`, `Bun.spawn`, `Bun.$`,
 * and a tagged shell template — extracts the text each one is handed, and
 * refuses a rebuild token inside it. `test/consumer-tier-downgrade-mutation.test.ts`
 * legitimately spawns `bun test`, so "no execution constructs" would be the
 * wrong rule; "no execution construct is handed a rebuild" is the right one,
 * and the file's real `spawnSync` is what proves the scanner is looking.
 *
 * Every control below is assembled from fragments (`"make" + " rebuild"`), so
 * this file can be included in its own scanned set rather than carved out of
 * it. A prohibition that exempts the file enforcing it is the self-reference
 * trap `.claude/rules/checks-must-be-able-to-fail.md` records.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const FIXTURE_ROOT = join(REPO_ROOT, "test", "fixtures", "consumer-ui-project");

// ── The files this issue adds ────────────────────────────────────────────

/**
 * Every file #274 adds, listed and then CHECKED against the directory so the
 * list cannot quietly fall behind the issue.
 */
/**
 * Every file this scan covers.
 *
 * It began as exactly the set #274 adds, and the constant was called
 * `ADDED_FILES` to say so. It is no longer that: `consumer-fixture-gates.test.ts`
 * arrived from #44 while this branch sat unmerged, and the on-disk check below
 * caught it — which is the check doing its job, not a stale list.
 *
 * Renamed rather than extended quietly, because the two names make different
 * promises. "What this issue adds" is a fact about one commit and goes stale.
 * "What this scan covers" is the property the scan is for, and it is the one
 * the on-disk check actually enforces.
 */
const SCANNED_FILES = [
  "test/consumer-ceremony-fixture.test.ts",
  "test/consumer-tier-gated-subsystems.test.ts",
  "test/consumer-tier-downgrade-mutation.test.ts",
  "test/consumer-scope-gate-prevalidation.test.ts",
  "test/consumer-no-rebuild-delegation.test.ts",
  // Not #274's. Added by #44 and swept in by the on-disk check below.
  "test/consumer-fixture-gates.test.ts",
  "test/helpers/consumer-ship-sites.ts",
  "test/fixtures/consumer-ui-project/.claude/rungate.json",
  "test/fixtures/consumer-ui-project/workflow-state.json",
];

/** Every `test/consumer-*` file on disk, so a new one cannot escape the scan. */
function consumerFilesOnDisk(): string[] {
  return readdirSync(join(REPO_ROOT, "test"))
    .filter((f) => f.startsWith("consumer-"))
    .map((f) => `test/${f}`)
    .sort();
}

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf-8");

// ── Comment stripping ────────────────────────────────────────────────────

// Moved to test/helpers/strip-comments.ts in #627, which needed it in the
// dispatch loader too. Re-exported because this file's own cases import it
// by this name, and because an exported binding with two homes is the pair
// .claude/rules/checks-must-be-able-to-fail.md warns about.
export { stripComments } from "./helpers/strip-comments";
import { stripComments } from "./helpers/strip-comments";

// ── Execution-site extraction ────────────────────────────────────────────

/**
 * The constructs that turn text into a process. Matched on the call, not on
 * the identifier: `import { spawnSync } from "child_process"` is not an
 * execution, and a file that imports the symbol and never calls it must not be
 * reported.
 */
const EXECUTION_CONSTRUCTS =
  /\b(?:Bun\.\$|Bun\.spawnSync|Bun\.spawn|child_process\.\w+|execFileSync|execFile|execSync|spawnSync|spawn|exec)\s*[(`]/g;

export interface ExecutionSite {
  construct: string;
  /** The text handed to the construct — its balanced argument list. */
  args: string;
  line: number;
}

/** Index just past the balanced `(`…`)` or `` ` ``…`` ` `` opening at `i`. */
function closeOf(src: string, i: number): number {
  const opener = src[i];
  if (opener === "`") {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "`") return j + 1;
      else j++;
    }
    return src.length;
  }
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const ch = src[j];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      j++;
      while (j < src.length) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === quote) {
          j++;
          break;
        } else j++;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return src.length;
}

/** Every execution construct in `source`, with the text it is handed. */
export function executionSites(source: string): ExecutionSite[] {
  const code = stripComments(source);
  const sites: ExecutionSite[] = [];
  for (const m of code.matchAll(EXECUTION_CONSTRUCTS)) {
    const open = m.index! + m[0].length - 1;
    const end = closeOf(code, open);
    sites.push({
      construct: m[0].slice(0, -1).trim(),
      // Read from the ORIGINAL source: comment-blanking is only needed to find
      // the site, and blanking inside the argument would hide a rebuild sitting
      // in a `/* */` that the shell would still never see — but also a real one
      // written after an inline comment.
      args: source.slice(open, end),
      line: code.slice(0, m.index!).split("\n").length,
    });
  }
  return sites;
}

/** What a container rebuild looks like, however it is spelled. */
const REBUILD_TOKEN = /\bmake\s+(?:rebuild|build)\b|\bpodman\b|\bdocker\b|\bcompose\s+up\b/i;

/** Execution sites handed something that rebuilds or drives a container. */
export function rebuildExecutions(source: string): ExecutionSite[] {
  return executionSites(source).filter((s) => REBUILD_TOKEN.test(s.args));
}

/**
 * Lines that TELL someone to run a rebuild — the agent-prompt half of the
 * prohibition, which no execution scan can see because the process is started
 * by a reader rather than by this code.
 */
export function rebuildInstructions(source: string): string[] {
  const code = stripComments(source);
  return code
    .split("\n")
    .filter((line) => REBUILD_TOKEN.test(line) && /\b(?:run|execute|invoke)\b/i.test(line))
    .map((line) => line.trim());
}

// ── The scan ─────────────────────────────────────────────────────────────

describe("#274 AC-6: the scanned set is every consumer file on disk", () => {
  test("every listed file exists", () => {
    for (const rel of SCANNED_FILES) {
      expect(existsSync(join(REPO_ROOT, rel)), `${rel} is listed but missing`).toBe(true);
    }
  });

  test("no consumer-* file on disk escapes the list", () => {
    // Without this the list is a promise. With it, a consumer file added
    // later is scanned or turns this red — which is what it did: #44's
    // `consumer-fixture-gates.test.ts` landed on main while this branch was
    // unmerged, and this assertion is the only thing that noticed.
    for (const rel of consumerFilesOnDisk()) {
      expect(SCANNED_FILES, `${rel} is not in the scanned set`).toContain(rel);
    }
    expect(consumerFilesOnDisk().length).toBeGreaterThanOrEqual(5);
  });

  test("this file is inside its own scanned set", () => {
    expect(SCANNED_FILES).toContain("test/consumer-no-rebuild-delegation.test.ts");
  });
});

describe("#274 AC-6: no added file executes a rebuild", () => {
  for (const rel of SCANNED_FILES) {
    test(`${rel} hands no rebuild to an execution construct`, () => {
      const found = rebuildExecutions(read(rel));
      expect(
        found.map((f) => `${rel}:${f.line} ${f.construct}${f.args.slice(0, 80)}`),
        `${rel} executes a container rebuild`,
      ).toEqual([]);
    });

    test(`${rel} instructs nobody to run a rebuild`, () => {
      expect(rebuildInstructions(read(rel)), `${rel} tells a reader or agent to rebuild`).toEqual([]);
    });
  }
});

describe("#274 AC-6: the scanner is looking — vacuity guards", () => {
  test("it finds the real spawnSync in the mutation suite", () => {
    // The whole scan would report zero for every file if `executionSites`
    // matched nothing, and zero is the answer this file wants to hear.
    const sites = executionSites(read("test/consumer-tier-downgrade-mutation.test.ts"));
    expect(sites.map((s) => s.construct)).toContain("spawnSync");
    expect(sites.length).toBeGreaterThan(0);
  });

  test("the construct it found is handed a test run, not a rebuild", () => {
    const sites = executionSites(read("test/consumer-tier-downgrade-mutation.test.ts"));
    const spawns = sites.filter((s) => s.construct === "spawnSync");
    expect(spawns.length).toBe(1);
    expect(spawns[0].args).toContain('"bun"');
    expect(REBUILD_TOKEN.test(spawns[0].args)).toBe(false);
  });

  test("it sees a planted rebuild execution", () => {
    // Assembled from fragments so the literal never appears in this file and
    // the file can therefore be scanned alongside the others.
    const EXEC = "exec" + "Sync";
    const CMD = "make" + " rebuild";
    const planted = `${EXEC}("cd /app && ${CMD}", { cwd: root });`;
    const found = rebuildExecutions(planted);
    expect(found.length).toBe(1);
    expect(found[0].construct).toBe(EXEC);
  });

  test("it sees a planted container driver behind a shell template", () => {
    const planted = ["await Bun.", "$", "`", "pod" + "man ps -a", "`;"].join("");
    expect(rebuildExecutions(planted).length).toBe(1);
  });

  test("it does NOT flag the rebuild carried as inert config data", () => {
    // The fixture's own shape. If this went red the scan would be banning the
    // fixture rather than the behaviour.
    const inert = `{ "container": { "rebuildCommand": "${"make" + " rebuild"}" } }`;
    expect(rebuildExecutions(inert)).toEqual([]);
    expect(rebuildInstructions(inert)).toEqual([]);
  });

  test("it does NOT flag a comment describing the prohibition", () => {
    const commented = `// never run ${"make" + " rebuild"} from here\nconst x = 1;`;
    expect(rebuildExecutions(commented)).toEqual([]);
    expect(rebuildInstructions(commented)).toEqual([]);
  });

  test("it DOES flag a prompt instructing an agent to rebuild", () => {
    const prompt = `const p = "Run ${"make" + " rebuild"} and report the output";`;
    expect(rebuildInstructions(prompt).length).toBe(1);
  });

  test("an import of the symbol is not an execution", () => {
    const imported = `import { ${"spawn" + "Sync"} } from "child_process";\n`;
    expect(executionSites(imported)).toEqual([]);
  });
});

describe("#274 AC-6: the fixture's rebuild command is inert", () => {
  const fixture = JSON.parse(
    readFileSync(join(FIXTURE_ROOT, ".claude", "rungate.json"), "utf-8"),
  ) as { container?: { rebuildCommand?: string } };

  test("the fixture declares one, so the container path has something to carry", () => {
    expect(typeof fixture.container?.rebuildCommand).toBe("string");
    expect((fixture.container?.rebuildCommand ?? "").length).toBeGreaterThan(0);
  });

  test("that exact value is never handed to an execution construct", () => {
    const value = fixture.container?.rebuildCommand ?? "";
    for (const rel of SCANNED_FILES) {
      for (const site of executionSites(read(rel))) {
        expect(site.args.includes(value), `${rel}:${site.line} executes the fixture's rebuild`).toBe(
          false,
        );
      }
    }
  });

  test("the value is a rebuild — so the check above has something to catch", () => {
    // Vacuity guard: if the fixture's command were `echo hi`, "it is never
    // executed" would be a sentence about nothing.
    expect(REBUILD_TOKEN.test(fixture.container?.rebuildCommand ?? "")).toBe(true);
  });
});
