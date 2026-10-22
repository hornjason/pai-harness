/**
 * #910 SC-5 — `.claude/rungate.json` is no longer a second position
 * declaring where hooks live.
 *
 * ## What SC-5 asked, and what the counts actually were
 *
 * SC-5: *"`.claude/rungate.json`'s `hooks` array is three entries behind the
 * directory layout. Either it is kept in agreement by something, or it is
 * removed as a second declaring position — a legacy copy nobody updates is
 * how this file came to be read instead of the live one."*
 *
 * Measured on `origin/main` before this change:
 *
 * ```
 * 20  hooks/*.hook.ts on disk
 * 19  .claude/rungate/hooks.json      TopLevelCdGuard absent, deliberately (#992)
 * 16  .claude/rungate.json "hooks"    FOUR behind, not three
 * ```
 *
 * The fourth is `HookCurrency`, which appears in neither the issue's four
 * counts nor any comment on it. **The gap grew while the issue was open** —
 * a better argument for SC-5 than the gap itself, because it shows the drift
 * is monotonic and silent rather than a one-off.
 *
 * The `hooks` key is removed. `resolveConfig` prefers the directory layout,
 * so the monolith's copy was never read here by anything; it existed only to
 * be counted by a census and believed. AC-2 keeps it gone.
 *
 * ## Step E landed in #1035, and the populations it had to clear first
 *
 * ADR-001's Step E is *"Delete `.claude/rungate.json` from rungate; repo runs
 * directory-only"*, precondition *"B green — not before"*. The precondition
 * was met for the readers ADR-001 counted: `scanConfigAccess` is down from 89
 * across 25 production files to **9**, all in `lib/scaffold/steps.ts`, all
 * taking a consumer `root` and checking `.claude/rungate/config.json` first.
 *
 * **It was not met for two populations that count was never over**, and both
 * were found by doing it and reading the failures rather than by reasoning.
 * #910 recorded them; #1035 re-measured them on a tree ten days further on
 * and cleared them. Both numbers are kept, because the drift between them is
 * the point:
 *
 * | population | #910, 2026-10-21 00:00 | #1035, re-measured |
 * |---|---|---|
 * | test files reading the monolith by path | 7 files, 8 failures | **5 files, 6 failures** — `config-trackable` and `unit/bash-tool-guard` had stopped needing it |
 * | agent PROMPTS naming it | 11, across `ship.js`, `prove.js`, `ship-and-heal.js` | 11, all repointed at the run's `resolved-config.json` |
 *
 * The five test files now go through `lib/config-loader.ts` and
 * `lib/config-readers.ts`, which is what ADR-001's D1 asked for in the first
 * place — the deletion did not create those violations, it made them visible.
 *
 * Issue: #910 SC-5, #1035. Refs ADR-001, ADR-002, #214, #992.
 */

import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadRungateConfig } from "../lib/config-loader";

const ROOT = join(import.meta.dir, "..");
const MONOLITH = join(ROOT, ".claude", "rungate.json");
const REGISTRY = join(ROOT, ".claude", "rungate", "hooks.json");

describe("#910 SC-5 — one position declares where hooks live", () => {
  test("AC-1 CONTROL: the directory layout is present and declares hooks", () => {
    // Without this, AC-2 passes just as well on a repo with no hook registry
    // at all — a far worse state, reported as success.
    expect(existsSync(REGISTRY), "the live registry is gone — AC-2 means nothing").toBe(true);
    expect(JSON.parse(readFileSync(REGISTRY, "utf-8")).length).toBeGreaterThan(0);
  });

  test("AC-2: the legacy monolith is GONE — ADR-001 Step E (#1035)", () => {
    // #910 SC-5 asked only that the monolith stop declaring hooks, and this
    // arm used to say so with `if (!existsSync(MONOLITH)) return` in front of
    // it. Step E landed, so that guard would now return on its first line and
    // the arm would certify nothing — the vacuous shape in
    // `.claude/rules/checks-must-be-able-to-fail.md`. It is replaced by the
    // stronger property the deletion established, which subsumes it: a file
    // that is not there declares no hooks, no models, no consumers and no
    // roles.
    //
    // This is the check SC-5 of #1035 asks for — *"a check refuses its
    // return"*. Step E is a property the repo executes on every run, not a
    // one-time deletion, which is the whole lesson of ADR-001's standing note
    // that *"this ADR was correct and had no effect, because the half that
    // was enforcement is the half that did not ship"*.
    //
    // It is scoped to THIS repository and lives in `test/`, deliberately. It
    // is not a conformity rule and must never become one: both layouts are
    // supported indefinitely and consumers in the wild are on both
    // (`.claude/rules/config-access.md`). What is forbidden is rungate — the
    // tool that generates the directory layout — carrying the layout it
    // migrates people off, *"a state its own scaffold cannot produce"*.
    expect(
      existsSync(MONOLITH),
      "`.claude/rungate.json` is back. ADR-001 Step E deleted it: this repo runs " +
        "directory-only, from `.claude/rungate/{config,roles,hooks,compliance}.json`. " +
        "A monolith beside a directory is not a fallback — `resolveConfig` prefers the " +
        "directory and never reads it, so the copy exists only to be found by a census, " +
        "counted and believed. If you need to add config, add it under `.claude/rungate/`. " +
        "If a consumer needs the monolith layout, that is still supported and is a " +
        "different repository (#1035, ADR-001 Step E).",
    ).toBe(false);
  });

  test("AC-3: with BOTH layouts present the loader takes the DIRECTORY", () => {
    // The mechanism that makes AC-2 a defect rather than untidiness: a
    // monolith beside a directory is not a fallback, it is invisible. Proved
    // on a fixture whose two layouts DISAGREE, which is the only way to
    // observe which one won.
    //
    // The first version of this arm compared `loadRungateConfig(ROOT).hooks`
    // against `.claude/rungate/hooks.json` — the same file on both sides.
    // Dropping a hook from the registry changed both readings identically
    // and reddened nothing (`.claude/rules/self-referential-tests.md`). AC-4
    // makes the independent comparison; this one asserts precedence.
    const fixture = mkdtempSync(join(tmpdir(), "layout-"));
    try {
      mkdirSync(join(fixture, ".claude", "rungate"), { recursive: true });
      writeFileSync(
        join(fixture, ".claude", "rungate", "config.json"),
        JSON.stringify({ project: "from-directory", repo: "o/r", issueRepo: "o/r" }),
      );
      writeFileSync(
        join(fixture, ".claude", "rungate", "hooks.json"),
        JSON.stringify([{ name: "FromDirectory", hookFor: "PreToolUse", command: "x", enabled: true }]),
      );
      writeFileSync(
        join(fixture, ".claude", "rungate.json"),
        JSON.stringify({
          project: "from-monolith",
          repo: "o/r",
          issueRepo: "o/r",
          hooks: [{ name: "FromMonolith", hookFor: "PreToolUse", command: "x", enabled: true }],
        }),
      );

      const c = loadRungateConfig(fixture) as unknown as { project: string; hooks: Array<{ name: string }> };
      expect(c.project, "the monolith won — a shadowed file would not be shadowed").toBe("from-directory");
      expect(c.hooks.map(h => h.name)).toEqual(["FromDirectory"]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("AC-4: every hook file is in the registry, or declares why it is not", () => {
    // SC-5's underlying question — "is the registry in agreement with the
    // thing it describes" — asked of the only pair that can actually drift
    // now. One hook is legitimately unregistered (`TopLevelCdGuard`, #992,
    // pending sign-off) and says so in its own header, which is the second
    // of the two ways #910 settled on. The header claim is checked, not
    // trusted.
    const hooksDir = join(ROOT, "hooks");
    const files = readdirSync(hooksDir).filter(f => f.endsWith(".hook.ts"));
    const registered = new Set(
      (JSON.parse(readFileSync(REGISTRY, "utf-8")) as Array<{ name: string }>).map(h => h.name),
    );
    expect(files.length, "no hook files found — the arm is pointed at the wrong directory").toBeGreaterThan(0);
    for (const f of files) {
      const name = f.replace(/\.hook\.ts$/, "");
      if (registered.has(name)) continue;
      const header = readFileSync(join(hooksDir, f), "utf-8").slice(0, 4000);
      expect(
        /NOT REGISTERED/.test(header),
        `${name} is in no registry and its header does not say why`,
      ).toBe(true);
    }
  });
});
