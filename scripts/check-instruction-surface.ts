#!/usr/bin/env bun
/**
 * Refuse when the auto-loaded instruction surface exceeds its declared budget (#1009).
 *
 * Every agent spawned against this repository loads `CLAUDE.md`, `AGENTS.md`
 * and every un-scoped `.claude/rules/*.md` in full before it reads a line of
 * the issue it was spawned for. On 2026-10-21 that came to 176,020 bytes —
 * roughly 44,000 tokens — and one file, `checks-must-be-able-to-fail.md`, was
 * 119,308 of it. #1009 moved the records out; this script is the part that
 * keeps them out. A number nobody enforces drifts back inside a week.
 *
 * Usage:
 *   bun scripts/check-instruction-surface.ts [--root <dir>] [--json]
 *
 * Exit 0 under budget, REFUSE_EXIT over it or on an unreadable population.
 *
 * ## What is measured, and why it is not the file size
 *
 * Two corrections to the naive reading, both verified against
 * `specs/RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md` and reproduced in this
 * repository:
 *
 *   1. A rule carrying `paths:` in its frontmatter loads ON DEMAND, when a
 *      Read/Write/Edit touches a matching file — not at launch. It is not part
 *      of the launch surface. `harness-managed.md` and `specs-routing.md` are
 *      path-scoped today and counting them overstates the surface by 13,728
 *      bytes.
 *   2. The frontmatter block is stripped before a rule enters context, so the
 *      bookkeeping keys cost nothing. The measurement is of the BODY.
 *
 * ## Three properties this file must keep, all asserted by
 * ## test/instruction-surface-budget.test.ts
 *
 *   1. Every refusal exits through `REFUSE_EXIT`, declared exactly once. The
 *      test builds a mutant copy with that constant set to 0 and runs every
 *      negative case twice — real refuses, mutant does not. See
 *      `.claude/rules/checks-must-be-able-to-fail.md`, "For a script whose job
 *      is to exit non-zero".
 *   2. No relative imports. The mutant runs from a temp directory and a
 *      relative import would make it die on module resolution — a non-zero
 *      exit that reads as the mutation having been rejected on the merits.
 *   3. The population is DERIVED from the tree, never spelled. A hardcoded
 *      list of eleven filenames goes stale the moment somebody adds a twelfth
 *      rule, and the check would then pass over exactly the growth it exists
 *      to catch.
 *
 * ## A reading that could not be taken is UNMEASURED, and UNMEASURED FAILS
 *
 * Zero rule files found is not a surface of zero bytes; it is a scan that did
 * not happen, and it is the single likeliest way this check becomes
 * decorative — the directory moves, the glob finds nothing, the total is 4,538
 * bytes and the budget is met forever. Same for a missing `CLAUDE.md`. Both
 * refuse rather than returning a number.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, resolve, sep } from "path";

/** The one exit code every refusal travels through. See note 1 above. */
export const REFUSE_EXIT = 1;

/**
 * The budget, in bytes of body text, and this is its ONE declaring position.
 *
 * 64,000 bytes is roughly 16,000 tokens. #1009 landed the surface at 55,764,
 * so the headroom is 8,236 bytes — about two more rules of ordinary size, or
 * one substantial addition to an existing one. That slack is deliberate: a
 * budget set flush against the current reading turns every legitimate rule
 * edit into a red run and gets raised rather than respected.
 *
 * Raising this number is a decision, not a repair. The fix for a red run here
 * is almost always to move a record into `reference/` and route to it from
 * `.claude/rules/docs-routing.md`, which is what #1009 did.
 */
export const SURFACE_BUDGET_BYTES = 64_000;

/** Loaded at launch regardless of what is touched. */
const ALWAYS_LOADED = ["CLAUDE.md", "AGENTS.md"] as const;

/** Where the rules live. Walked recursively — Claude Code discovers nested. */
const RULES_DIR = join(".claude", "rules");

export class SurfaceUnmeasured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfaceUnmeasured";
  }
}

export interface SurfaceEntry {
  file: string;
  bytes: number;
  /** Non-null when the file exists but does not load at launch. */
  excluded: string | null;
}

export interface SurfaceReading {
  entries: SurfaceEntry[];
  totalBytes: number;
  budgetBytes: number;
}

/**
 * The frontmatter block, stripped exactly as Claude Code strips it.
 *
 * The blank line that separated the block from the body goes with it — a file
 * with 2 KB of frontmatter and one whose frontmatter is absent must measure
 * the same, and leaving the separator behind makes them differ by one byte.
 */
export function ruleBody(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 3);
  if (end < 0) return text;
  const body = text.slice(end + 5);
  return body.startsWith("\n") ? body.slice(1) : body;
}

/** The raw frontmatter block, or "" when there is none. */
function frontmatter(text: string): string {
  if (!text.startsWith("---\n")) return "";
  const end = text.indexOf("\n---\n", 3);
  return end < 0 ? "" : text.slice(4, end + 1);
}

/**
 * True when the rule is path-scoped, so it loads on demand rather than at
 * launch. `paths` is the only frontmatter key Claude Code reads.
 */
export function isPathScoped(text: string): boolean {
  return /^paths:/m.test(frontmatter(text));
}

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
}

/**
 * Measure the surface an agent loads at launch.
 *
 * REFUSES rather than returning a small number when its own premise fails:
 * a tree with no rule files, or without `CLAUDE.md`, has not been measured.
 */
export function measureSurface(root: string): SurfaceReading {
  const abs = resolve(root);

  const ruleFiles: string[] = [];
  walk(join(abs, RULES_DIR), ruleFiles);
  if (ruleFiles.length === 0) {
    throw new SurfaceUnmeasured(
      `no .md files under ${join(abs, RULES_DIR)} — a surface of zero is a scan that did not ` +
        `happen, not a repository with no rules (#1009)`,
    );
  }

  const entries: SurfaceEntry[] = [];
  let total = 0;

  for (const name of ALWAYS_LOADED) {
    const p = join(abs, name);
    let text: string;
    try {
      statSync(p);
      text = readFileSync(p, "utf-8");
    } catch {
      throw new SurfaceUnmeasured(
        `${name} is missing from ${abs} — it is loaded at launch unconditionally, so a tree ` +
          `without it is UNMEASURED rather than lighter (#1009)`,
      );
    }
    const bytes = Buffer.byteLength(ruleBody(text), "utf-8");
    total += bytes;
    entries.push({ file: name, bytes, excluded: null });
  }

  for (const p of ruleFiles) {
    const text = readFileSync(p, "utf-8");
    const file = relative(abs, p).split(sep).join("/");
    if (isPathScoped(text)) {
      entries.push({ file, bytes: 0, excluded: "path-scoped: loads on demand, not at launch" });
      continue;
    }
    const bytes = Buffer.byteLength(ruleBody(text), "utf-8");
    total += bytes;
    entries.push({ file, bytes, excluded: null });
  }

  return { entries, totalBytes: total, budgetBytes: SURFACE_BUDGET_BYTES };
}

/** The failure message, carrying the measurement rather than only the verdict. */
export function overBudgetReport(reading: SurfaceReading): string {
  const loaded = reading.entries.filter(e => !e.excluded).sort((a, b) => b.bytes - a.bytes);
  const over = reading.totalBytes - reading.budgetBytes;
  const lines = [
    `The auto-loaded instruction surface is ${reading.totalBytes.toLocaleString()} bytes ` +
      `(~${Math.round(reading.totalBytes / 4).toLocaleString()} tokens), ` +
      `${over.toLocaleString()} over the ${reading.budgetBytes.toLocaleString()}-byte budget ` +
      `declared as SURFACE_BUDGET_BYTES in scripts/check-instruction-surface.ts.`,
    "",
    "Every agent spawned here pays this before it reads its issue. Largest first:",
    "",
  ];
  for (const e of loaded.slice(0, 8)) {
    const share = Math.round((e.bytes / reading.totalBytes) * 100);
    lines.push(`  ${String(e.bytes).padStart(8)}  ${String(share).padStart(3)}%  ${e.file}`);
  }
  lines.push(
    "",
    "The fix is almost never to delete a record. Move the worked examples and",
    "measurement tables into reference/, route to them from",
    ".claude/rules/docs-routing.md, and carry any byte-identity binding to the",
    "new path — #1009 did exactly that and took this from 176,020 to 55,764.",
  );
  return lines.join("\n");
}

function main(argv: string[]): number {
  const rootArg = argv.indexOf("--root");
  const root = rootArg >= 0 ? argv[rootArg + 1]! : process.cwd();
  const asJson = argv.includes("--json");

  let reading: SurfaceReading;
  try {
    reading = measureSurface(root);
  } catch (err) {
    if (!(err instanceof SurfaceUnmeasured)) throw err;
    console.error(`UNMEASURED: ${err.message}`);
    return REFUSE_EXIT;
  }

  if (asJson) {
    console.log(JSON.stringify(reading, null, 2));
  } else {
    for (const e of [...reading.entries].sort((a, b) => b.bytes - a.bytes)) {
      console.log(`${String(e.bytes).padStart(8)}  ${e.file}${e.excluded ? `  [${e.excluded}]` : ""}`);
    }
    console.log(
      `${String(reading.totalBytes).padStart(8)}  TOTAL (budget ${reading.budgetBytes}, ` +
        `~${Math.round(reading.totalBytes / 4)} tokens)`,
    );
  }

  if (reading.totalBytes > reading.budgetBytes) {
    console.error("");
    console.error(overBudgetReport(reading));
    return REFUSE_EXIT;
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
