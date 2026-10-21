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
 * ## Why the whole monolith is NOT deleted here, measured
 *
 * ADR-001's Step E is *"Delete `.claude/rungate.json` from rungate; repo runs
 * directory-only"*, precondition *"B green — not before"*. The precondition
 * is met for the readers ADR-001 counted: `scanConfigAccess` is down from 89
 * across 25 production files to **9**, all in `lib/scaffold/steps.ts`, all
 * taking a consumer `root` and checking `.claude/rungate/config.json` first.
 *
 * **It is not met for two populations that count was never over**, and both
 * were found by doing it and reading the failures rather than by reasoning:
 *
 * | population | state |
 * |---|---|
 * | test files reading the monolith by path | **7 files, 8 failures** — `agent-brief-template`, `audit-specs`, `briefed-agent-model`, `config-trackable`, `sc-id-namespace`, `test-brief-roles`, `unit/bash-tool-guard` |
 * | agent PROMPTS naming it | `workflows/ship.js`, `prove.js`, `ship-and-heal.js` — already violations of ADR-002's *"no agent prompt may instruct an agent to read those paths"* |
 *
 * Deleting the file is correct and is a migration of its own, with a rule
 * already written for the second half. Doing it inside a hook-cluster ticket
 * would bury it. Filed separately with these measurements; SC-5 is closed by
 * the narrower change, which is what SC-5 actually asks for.
 *
 * Issue: #910 SC-5. Refs ADR-001, ADR-002, #214, #992.
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

  test("AC-2: the legacy monolith declares NO hooks", () => {
    // SC-5's actual ask. The file may still exist — ADR-001 Step E is a
    // separate migration — but it must not carry a second hook list for a
    // census to find, count and believe.
    if (!existsSync(MONOLITH)) return; // Step E landed; nothing to declare.
    const monolith = JSON.parse(readFileSync(MONOLITH, "utf-8"));
    expect(
      "hooks" in monolith,
      "`.claude/rungate.json` declares hooks again. resolveConfig prefers the directory layout, " +
        "so nothing reads this copy and nothing keeps it current — it went four entries behind " +
        "while #910 was open. Hooks are declared in .claude/rungate/hooks.json (#910 SC-5).",
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
