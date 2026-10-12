/**
 * #310 — a consumer could disable the ceremony tier by following the
 * documented config migration.
 *
 * The Discovery setup prompt used to read the config with
 *
 *     cat ${PROJECT_ROOT}/.claude/rungate.json 2>/dev/null || echo "{}"
 *
 * which sees only the MONOLITH. `specs/CONFIG-DIRECTORY-STRUCTURE-SPEC.md`
 * documents the `.claude/rungate/` directory layout as preferred, so a
 * consumer who complied with the spec got `cat` failing, `echo "{}"`, empty
 * `pages`, `hasUI === false`, a forced LIGHT tier, and five subsystems
 * skipped — scope gate, Quinn local, container verify, Quinn verify and
 * prove — with no error and no log line. Complying with the documentation
 * switched off the control that decides how much of the harness runs.
 *
 * That is shape 1 in .claude/rules/checks-must-be-able-to-fail.md — fail-open
 * error handling — attached to the tier control itself.
 *
 * The chain is tested end to end rather than in pieces, because every piece
 * of it was individually fine: the loader handled both layouts, the tier
 * floor computed correctly, and the defect lived entirely in which of them
 * the prompt called.
 *
 * Covers SC-708, SC-709, SC-710 of CONFIG-DIRECTORY-STRUCTURE-SPEC.md.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const RESOLVER = join(ROOT, "scripts", "resolve-config.ts");
const shipSource = readFileSync(join(ROOT, "workflows", "ship.js"), "utf-8");

const scratchDirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "rungate-310-"));
  scratchDirs.push(d);
  return d;
}
afterEach(() => {
  while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

/** 18 pages, the number in #310's criterion — a real UI project's worth. */
const EIGHTEEN_PAGES: Record<string, string> = Object.fromEntries(
  Array.from({ length: 18 }, (_, i) => [`page${i + 1}`, i === 0 ? "/" : `/page-${i + 1}`]),
);

function configBody(pages: Record<string, string>): Record<string, unknown> {
  return {
    project: "fixture-consumer",
    repo: "x/y",
    issueRepo: "x/y",
    dev: { testCmd: "bun test", typeCheck: "bunx tsc --noEmit" },
    pages,
  };
}

function directoryLayout(pages = EIGHTEEN_PAGES): string {
  const root = scratch();
  const dir = join(root, ".claude", "rungate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(configBody(pages)));
  return root;
}

function monolithLayout(pages = EIGHTEEN_PAGES): string {
  const root = scratch();
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "rungate.json"), JSON.stringify(configBody(pages)));
  return root;
}

/** Run the resolver exactly as the Discovery prompt does. */
function resolve(projectRoot: string): { code: number; stderr: string; out: unknown | null } {
  const outPath = join(scratch(), "resolved-config.json");
  const run = Bun.spawnSync(["bun", RESOLVER, "--project", projectRoot, "--out", outPath], {
    cwd: ROOT,
    env: { ...process.env },
  });
  return {
    code: run.exitCode,
    stderr: new TextDecoder().decode(run.stderr),
    out: existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf-8")) : null,
  };
}

/**
 * ship.js's own tier logic, extracted from its markers rather than restated.
 * A second copy here would be a second implementation, and this file would
 * then verify itself.
 */
const MARKER = "CEREMONY-TIER-FLOOR";
function loadFloor(): (tier: string, hasUI: boolean) => string {
  const a = shipSource.indexOf(`// ──── ${MARKER}-START ────`);
  const b = shipSource.indexOf(`// ──── ${MARKER}-END ────`);
  if (a < 0 || b <= a) throw new Error(`workflows/ship.js is missing the ${MARKER} markers`);
  return new Function(`${shipSource.slice(a, b)}\nreturn ceremonyTierFloor`)();
}

/** The `hasUI` rule, read off ship.js rather than assumed. */
const HAS_UI_RULE = /const hasUI = Object\.keys\(pagesConfig\)\.length > 0/;
const hasUI = (pages: Record<string, unknown>) => Object.keys(pages).length > 0;

/**
 * The DOWNGRADE, which is the statement #310 is actually about, and which is
 * not `ceremonyTierFloor`. The floor RAISES a tier; this forces it down to
 * LIGHT when a project looks UI-less. `floor('STANDARD', false)` returns
 * 'STANDARD', so a test written against the floor would have reported the
 * old fallback as harmless.
 *
 * Extracted and executed rather than restated — a local copy of the rule
 * would make this file verify itself.
 */
const DOWNGRADE_RE = /if \(!hasUI && discovery\.ceremonyTier !== 'LIGHT'\) \{[\s\S]*?\n\}/m;
function runDowngrade(tier: string, ui: boolean): string {
  const match = DOWNGRADE_RE.exec(shipSource);
  if (!match) throw new Error("workflows/ship.js no longer contains the hasUI downgrade statement");
  const discovery = { ceremonyTier: tier };
  new Function("discovery", "hasUI", "log", match[0])(discovery, ui, () => {});
  return discovery.ceremonyTier;
}

describe("#310 — the documented directory layout reaches the tier control", () => {
  test("ship.js still computes hasUI the way this file models it", () => {
    // Without this, `hasUI` below is a local invention and the chain under
    // test stops being ship.js's chain.
    expect(shipSource).toMatch(HAS_UI_RULE);
  });

  test("a directory-layout project with 18 pages resolves to 18 pages", () => {
    const r = resolve(directoryLayout());
    expect(r.code, `resolver refused: ${r.stderr}`).toBe(0);
    expect(Object.keys((r.out as any).pages)).toHaveLength(18);
  });

  test("the directory layout and the monolith resolve to the same pages", () => {
    // The prompt claims the two layouts "produce a byte-identical result".
    const dir = resolve(directoryLayout());
    const mono = resolve(monolithLayout());
    expect(dir.code).toBe(0);
    expect(mono.code).toBe(0);
    expect((dir.out as any).pages).toEqual((mono.out as any).pages);
  });

  test("18 resolved pages produce a NON-LIGHT tier — the criterion that defines the fix", () => {
    const r = resolve(directoryLayout());
    expect(r.code).toBe(0);
    const pages = (r.out as any).pages as Record<string, unknown>;

    expect(hasUI(pages)).toBe(true);
    expect(runDowngrade("STANDARD", hasUI(pages))).toBe("STANDARD");
    // And the floor does not pull it back down either.
    expect(loadFloor()("STANDARD", hasUI(pages))).not.toBe("LIGHT");
  });

  test("the OLD fallback would have forced LIGHT on the same project — the harm, stated", () => {
    // `echo "{}"` modelled literally: this is what the prompt handed
    // downstream for a directory-layout consumer before #310. The point is
    // that the two branches DIFFER — without this, "resolves to non-LIGHT"
    // could be true of every input and would prove nothing.
    const pagesFromFallback = ((JSON.parse("{}") as any).pages ?? {}) as Record<string, unknown>;

    expect(hasUI(pagesFromFallback)).toBe(false);
    expect(runDowngrade("STANDARD", hasUI(pagesFromFallback))).toBe("LIGHT");

    const resolved = (resolve(directoryLayout()).out as any).pages;
    expect(runDowngrade("STANDARD", hasUI(resolved))).not.toBe(
      runDowngrade("STANDARD", hasUI(pagesFromFallback)),
    );
  });
});

describe("#310 — an unresolvable config refuses instead of becoming {}", () => {
  test("a project with no config at all exits non-zero and writes nothing", () => {
    const r = resolve(scratch());
    expect(r.code).not.toBe(0);
    expect(r.out, "an unresolvable config materialised as an object").toBeNull();
  });

  test("the refusal says what it could not find, rather than failing mutely", () => {
    const r = resolve(scratch());
    expect(r.stderr).toContain("resolve-config");
  });

  test("a malformed config refuses — it does not degrade to empty", () => {
    const root = scratch();
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "rungate.json"), "{ not json");
    const r = resolve(root);
    expect(r.code).not.toBe(0);
    expect(r.out).toBeNull();
  });

  test("an empty pages map still RESOLVES — a CLI project is not an error", () => {
    // The refusal must distinguish "could not read the config" from
    // "read it, and this project has no UI". Collapsing those would make
    // every library project fail setup.
    const r = resolve(directoryLayout({}));
    expect(r.code).toBe(0);
    expect(hasUI((r.out as any).pages ?? {})).toBe(false);
  });
});

describe("#310 — the Discovery prompt reads config through the loader only", () => {
  /** The config step of the Discovery setup prompt, up to the next step. */
  function configStep(source = shipSource): string {
    const start = source.indexOf("2. Load config");
    expect(start, "the Discovery config step is not where this test expects it").toBeGreaterThan(-1);
    const end = source.indexOf("3. Prior branch detect", start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  /**
   * The COMMAND lines of that step, with its prose dropped.
   *
   * The step explains, in prose, that there is "deliberately no `|| echo {}`
   * fallback" — so a detector reading the whole step reports the very defect
   * the text says was removed. Same trap as the SC line that names its own
   * tokens in checks-must-be-able-to-fail.md, met here in a prompt.
   *
   * The boundary is structural rather than a keyword blocklist: commands sit
   * at column 0, the parenthetical explanation is indented, and the step's
   * own heading starts with its number. Narrowing a detector is the change
   * most likely to buy green with blindness, so the planted control below
   * requires this slice to still catch the original line.
   */
  function commandLines(source = shipSource): string {
    return configStep(source)
      .split("\n")
      .filter((line) => /^[a-z]/.test(line))
      .join("\n");
  }

  test("the command slice is not empty — an empty slice satisfies every absence claim", () => {
    expect(commandLines().length).toBeGreaterThan(0);
  });

  test("it invokes the resolver", () => {
    expect(commandLines()).toContain("scripts/resolve-config.ts");
  });

  test("it does not cat the monolith directly", () => {
    expect(commandLines()).not.toMatch(/cat \$\{PROJECT_ROOT\}\/\.claude\/rungate\.json/);
  });

  test("it carries no empty-object fallback", () => {
    // The whole defect in one token. `|| echo "{}"` is what turned an
    // unreadable config into a configured-with-nothing project.
    expect(commandLines()).not.toMatch(/\|\|\s*echo\s*["']?\{\}/);
  });

  test("the prose explaining the absent fallback is NOT read as the fallback", () => {
    // Stated as its own case because this test file failed exactly here on
    // first run: the step's explanation quotes the token it is explaining.
    expect(configStep()).toMatch(/\|\| echo \{\}/);
    expect(commandLines()).not.toMatch(/\|\| echo \{\}/);
  });

  test("the step guard would catch the fallback coming back — planted control", () => {
    // The three assertions above are absence claims over a slice, and a slice
    // that failed to locate anything satisfies all of them. This plants the
    // original line and requires the same checks to reject it.
    const planted = shipSource.replace(
      "2. Load config",
      '2. Load config\ncat ${PROJECT_ROOT}/.claude/rungate.json 2>/dev/null || echo "{}"\n',
    );
    const commands = commandLines(planted);
    expect(commands).toMatch(/cat \$\{PROJECT_ROOT\}\/\.claude\/rungate\.json/);
    expect(commands).toMatch(/\|\|\s*echo\s*["']?\{\}/);
  });
});
