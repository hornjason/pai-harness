/**
 * Covers SC-1787..SC-1796 (HARNESS-STANDARD.md), #42.
 *
 * Re-scaffold audited conformity gaps and reported them without closing the
 * mechanical ones, so a consumer had to fix by hand what the scaffold could
 * have fixed itself.
 *
 * Two of the issue's criteria needed changing, and the tests are organised
 * around the reasons.
 *
 * **SC-1 was mostly already done**, and the part that was not is the part the
 * issue was filed from: the fixer keyed on whether `doc-type:` was PRESENT
 * while `HYGIENE-10` keys on whether its VALUE is `adr`. An ADR carrying
 * `doc-type: guide` satisfied the fixer and failed the checker, forever —
 * re-scaffold ran, changed nothing, and the warning came back every time. Two
 * readers of one field disagreeing about what it means.
 *
 * **SC-2 is opt-IN here, against the issue's SC-4**, which asks for auto-fix
 * to be opt-out. Removing a config entry on the strength of "a source scan
 * did not find it" is not the same risk as adding a frontmatter line, and the
 * worst case is a scanner that returns nothing making every declared consumer
 * look stale at once.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { addFrontmatterToAdrs } from "../lib/validators/spec-validators";
import { pruneStaleConsumers, reportScaffoldActions } from "../lib/scaffold/steps";

const withTemp = <T>(fn: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "rungate-autofix-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** An ADR directory holding the named files, and its path. */
const adrDir = (dir: string, files: Record<string, string>): string => {
  const path = join(dir, "docs", "adr");
  mkdirSync(path, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(path, name), content);
  return path;
};

const docTypeOf = (path: string): string | null =>
  readFileSync(path, "utf-8").match(/^\s*doc-type:\s*(\S+)/m)?.[1] ?? null;

// ── SC-1: the case the issue was filed from ──────────────────

describe("#42: the ADR fixer agrees with the checker about what doc-type means", () => {
  test("SC-1787: an ADR whose doc-type is present but wrong is corrected to adr", () => {
    withTemp(dir => {
      const path = adrDir(dir, {
        "wrong.md": "---\ndoc-type: guide\nstatus: draft\ncreated: 2026-01-01\n---\n\n# ADR 1\n\nbody\n",
      });
      const actions: string[] = [];
      addFrontmatterToAdrs(path, actions);

      expect(docTypeOf(join(path, "wrong.md"))).toBe("adr");
      expect(actions.join("\n")).toContain("AUTO-FIXED");
      // The old value is named, because a silent rewrite of someone's
      // frontmatter is worse than the warning it replaced.
      expect(actions.join("\n")).toContain('doc-type was "guide"');
    });
  });

  test("SC-1788: the correction replaces the field - it does not add a second one", () => {
    withTemp(dir => {
      const path = adrDir(dir, { "wrong.md": "---\ndoc-type: spec\ncreated: 2026-01-01\n---\n\n# ADR\n" });
      addFrontmatterToAdrs(path, []);
      const text = readFileSync(join(path, "wrong.md"), "utf-8");

      // Appending would leave a document with two `doc-type:` lines, and a
      // parser taking the first would keep the wrong one forever — the bug
      // would survive its own fix.
      expect(text.match(/doc-type:/g)).toHaveLength(1);
      expect(text).not.toContain("spec");
      // The rest of the frontmatter survives: this corrects one field, it
      // does not regenerate the block.
      expect(text).toContain("created: 2026-01-01");
      expect(text).toContain("# ADR");
    });
  });

  test("SC-1789: an ADR that is already correct is not rewritten", () => {
    withTemp(dir => {
      const original = "---\ndoc-type: adr\nstatus: accepted\ncreated: 2026-01-01\n---\n\n# ADR\n";
      const path = adrDir(dir, { "right.md": original });
      const actions: string[] = [];
      addFrontmatterToAdrs(path, actions);

      // Byte-identical. A fixer that rewrote every file would report a change
      // on every run and make the auto-fix count meaningless.
      expect(readFileSync(join(path, "right.md"), "utf-8")).toBe(original);
      expect(actions).toEqual([]);
    });
  });

  test("SC-1790: the three shapes are handled and distinguished in one pass", () => {
    withTemp(dir => {
      const path = adrDir(dir, {
        "a-none.md": "# ADR\n\nbody\n",
        "b-nokey.md": "---\nstatus: draft\n---\n\n# ADR\n",
        "c-wrong.md": "---\ndoc-type: guide\ncreated: 2026-01-01\n---\n\n# ADR\n",
        "d-right.md": "---\ndoc-type: adr\ncreated: 2026-01-01\n---\n\n# ADR\n",
      });
      const actions: string[] = [];
      addFrontmatterToAdrs(path, actions);

      for (const f of ["a-none.md", "b-nokey.md", "c-wrong.md", "d-right.md"]) {
        expect(docTypeOf(join(path, f)), `${f} did not end up as an adr`).toBe("adr");
      }
      // Three fixed, one untouched — the count is the assertion, because
      // "they all say adr now" is also true of a fixer that rewrites
      // everything unconditionally.
      expect(actions).toHaveLength(3);
      expect(actions.join("\n")).not.toContain("d-right.md");
    });
  });
});

// ── SC-2: the deletion, and the refusals around it ───────────

describe("#42: removing a consumer is opt-in and refuses when the scan is suspect", () => {
  const configured = (dir: string, consumers: string[]) => {
    const rungateDir = join(dir, ".claude", "rungate");
    mkdirSync(rungateDir, { recursive: true });
    writeFileSync(join(rungateDir, "config.json"), JSON.stringify({ slug: "x", consumers, pages: { home: "/" } }, null, 2));
    return rungateDir;
  };
  const consumersOf = (rungateDir: string) => JSON.parse(readFileSync(join(rungateDir, "config.json"), "utf-8")).consumers;

  test("SC-1791: nothing is removed unless pruning was asked for", () => {
    withTemp(dir => {
      const rungateDir = configured(dir, ["alpha", "beta", "gone"]);
      const actions: string[] = [];
      const pruned = pruneStaleConsumers({ consumers: ["alpha", "beta", "gone"] }, ["alpha", "beta"], ["gone"], actions, rungateDir, false);

      expect(pruned).toBe(false);
      expect(consumersOf(rungateDir)).toEqual(["alpha", "beta", "gone"]);
      // Silent: the caller reports the stale entry as a finding instead, and
      // a run must never both remove something and complain it is there.
      expect(actions).toEqual([]);
    });
  });

  test("SC-1792: with the flag it removes only the stale ones and names every one", () => {
    withTemp(dir => {
      const rungateDir = configured(dir, ["alpha", "beta", "gone", "also-gone"]);
      const existing: any = { consumers: ["alpha", "beta", "gone", "also-gone"] };
      const actions: string[] = [];
      const pruned = pruneStaleConsumers(existing, ["alpha", "beta"], ["gone", "also-gone"], actions, rungateDir, true);

      expect(pruned).toBe(true);
      expect(consumersOf(rungateDir)).toEqual(["alpha", "beta"]);
      // The in-memory copy moves too, or the audit that runs next reports a
      // state that is no longer on disk.
      expect(existing.consumers).toEqual(["alpha", "beta"]);

      // Every name, not a count. A removal summarised as a number is one
      // nobody can audit or put back.
      expect(actions.join("\n")).toContain("gone");
      expect(actions.join("\n")).toContain("also-gone");
      expect(actions.join("\n")).toContain("AUTO-FIXED");

      // Other keys survive. Rewriting the file from the consumer list alone
      // would silently discard every setting this function does not know.
      const config = JSON.parse(readFileSync(join(rungateDir, "config.json"), "utf-8"));
      expect(config.slug).toBe("x");
      expect(config.pages).toEqual({ home: "/" });
    });
  });

  test("SC-1793: a scan that found no consumers at all removes nothing", () => {
    // The worst case, and the one nothing in #42 asked for: a scanner that
    // returns nothing makes EVERY declared consumer look stale, so a single
    // broken scan would empty the list in one pass with the flag on.
    withTemp(dir => {
      const rungateDir = configured(dir, ["alpha", "beta", "gamma"]);
      const actions: string[] = [];
      const pruned = pruneStaleConsumers({ consumers: ["alpha", "beta", "gamma"] }, [], ["alpha", "beta", "gamma"], actions, rungateDir, true);

      expect(pruned).toBe(false);
      expect(consumersOf(rungateDir)).toEqual(["alpha", "beta", "gamma"]);
      // REFUSED, not SKIP: the report's exit code counts refusals, so this
      // is visible to a CI that reads nothing but the status.
      expect(actions.join("\n")).toContain("REFUSED");
      expect(actions.join("\n")).toContain("broken scan, not an empty project");
    });
  });

  test("SC-1794: an unreadable or absent config is refused - never rewritten from memory", () => {
    withTemp(dir => {
      // Corrupt. Rewriting it from the in-memory `existing` would discard
      // every key this function does not know about, which is a bigger loss
      // than the stale entry it was asked to remove.
      const rungateDir = join(dir, ".claude", "rungate");
      mkdirSync(rungateDir, { recursive: true });
      writeFileSync(join(rungateDir, "config.json"), "{ not json");
      const actions: string[] = [];
      expect(pruneStaleConsumers({ consumers: ["a"] }, ["b"], ["a"], actions, rungateDir, true)).toBe(false);
      expect(actions.join("\n")).toContain("unreadable");
      expect(readFileSync(join(rungateDir, "config.json"), "utf-8")).toBe("{ not json");
    });

    // Absent, and the monolith layout where there is no directory to write.
    const actions: string[] = [];
    expect(pruneStaleConsumers({ consumers: ["a"] }, ["b"], ["a"], actions, undefined, true)).toBe(false);
    expect(actions.join("\n")).toContain("REFUSED");
  });
});

// ── SC-3 and SC-4: the report and the opt-out ────────────────

describe("#42: the report says what changed, separately from what was noticed", () => {
  test("SC-1795: auto-fixes are counted apart from audit findings", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      reportScaffoldActions([
        "CREATED: specs/",
        "AUTO-FIXED: docs/adr/one.md (added frontmatter)",
        "AUTO-FIXED: docs/adr/two.md (doc-type was \"guide\", set to adr)",
        "AUDIT: CONSUMERS: 3 stale consumers in rungate.json not found in source: x, y, z",
        "AUDITED: rungate.json (1 gaps)",
      ], { rehearsed: false });
    } finally {
      console.log = log;
    }
    const total = lines.find(l => l.startsWith("\nTotal:")) ?? lines.join("\n");
    expect(total).toContain("2 auto-fixed");

    // The distinction is the point: a reader who cannot tell a closed gap
    // from a reported one has to diff the tree to find out which of the
    // findings are still findings.
    expect(total).toContain("1 created");
    expect(total).not.toContain("3 auto-fixed");
  });

  test("SC-1796: the write steps opt OUT of auto-fix and opt IN to pruning", () => {
    // Asserted on the source, because running the whole scaffold here would
    // be a different test. What matters is the polarity of each default: a
    // single flag governing both would make the safe pair impossible to
    // express, which is why the issue's SC-4 is followed for one and not the
    // other.
    const writeSteps = readFileSync(join(import.meta.dir, "..", "lib", "scaffold", "write-steps.ts"), "utf-8");
    expect(writeSteps).toMatch(/autoFix = true/);
    expect(writeSteps).toMatch(/pruneConsumers = false/);
    expect(writeSteps).toMatch(/if \(autoFix\) \{/);
    // Declining to fix is named in the report, not silent — a run that
    // quietly did nothing is indistinguishable from one with nothing to do.
    expect(writeSteps).toContain("SKIP: auto-fix of spec and ADR frontmatter (--no-auto-fix)");

    const cli = readFileSync(join(import.meta.dir, "..", "scripts", "scaffold-project.ts"), "utf-8");
    expect(cli).toContain("const autoFix = !args.includes('--no-auto-fix')");
    expect(cli).toContain("const pruneConsumers = args.includes('--prune-consumers')");
    // The rehearsal gets the same flags, or an audit reports what --fix would
    // do under settings nobody passed (#398).
    const rehearsalCall = cli.slice(cli.indexOf("rehearsal.dir"));
    expect(rehearsalCall).toContain("autoFix");
    expect(rehearsalCall).toContain("pruneConsumers");
  });
});
