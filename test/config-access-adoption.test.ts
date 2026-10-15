/**
 * ADR-001 D1, the adoption half (#214).
 *
 * Covers SC-1449, SC-1450, SC-1451, SC-1452 (CONFIG-DIRECTORY-STRUCTURE-SPEC.md).
 *
 * #309 built the two conformity checks ADR-001 specified and never got, with a
 * known-violations ratchet banking the 61 sites that existed on the day. A
 * ratchet is only worth having if someone lowers it; this file is the evidence
 * for the first decrement, and the shape of the evidence is the point.
 *
 * ## Why these are behavioural and not "the file imports the loader"
 *
 * ADR-001 diagnosed its own failure precisely:
 *
 *   > SC-478 and SC-479 are both existence assertions over source text. A
 *   > loader that is written correctly and called by nothing satisfies them
 *   > perfectly. The spec verified that the solution was authored; it never
 *   > verified that it was adopted.
 *
 * So every case below runs the migrated function against a project root on the
 * DIRECTORY layout and asserts it returns the configured value. That assertion
 * is false on `main`: all six sites read `.claude/rungate.json` and nothing
 * else, so a directory-layout consumer got `{}`, `"project"` and the built-in
 * defaults from them — silently, with no error and no warning. A re-import of
 * the old reader would turn every one of these red.
 *
 * ## The control
 *
 * A fixture that only proves "directory works" is satisfied by a reader that
 * ignores the monolith, which would be a new bug wearing the fix's clothes.
 * Each accessor is therefore run against BOTH layouts over the same authored
 * values, and the two results are compared to each other rather than to a
 * literal.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { loadRoleConfig, readProjectSlug, readRemoteHosts } from "../lib/config-readers";
import { loadRegistry } from "../lib/create-sc";
import { loadValidRoles, loadRoleBriefPaths } from "../scripts/grade-deterministic";
import { getProjectSlug } from "../scripts/parallel-ship";

// ── fixtures ────────────────────────────────────────────────────────────────

/** The authored values every case below reads back. Shared so the two layouts
 *  cannot drift apart and quietly make the parity assertion vacuous. */
const AUTHORED = {
  project: "adoption-fixture",
  roles: {
    marcus: { brief: "prompts/marcus.md", standardTask: "implement" },
    quinn: { brief: "prompts/quinn.md", standardTask: "verify" },
  },
  remoteHosts: { db: { host: "db.invalid", preFlightCmd: "true" } },
  customMatchers: [{ name: "adoption-only-matcher", description: "fixture", kind: "contains" }],
};

const scratch: string[] = [];

function makeRoot(layout: "directory" | "monolith" | "neither" | "malformed"): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-214-"));
  scratch.push(root);
  const claude = join(root, ".claude");
  mkdirSync(claude, { recursive: true });

  if (layout === "neither") return root;

  if (layout === "malformed") {
    mkdirSync(join(claude, "rungate"), { recursive: true });
    writeFileSync(join(claude, "rungate", "config.json"), "{ this is not json");
    return root;
  }

  const { roles, ...rest } = AUTHORED;
  if (layout === "monolith") {
    writeFileSync(join(claude, "rungate.json"), JSON.stringify({ ...rest, roles }, null, 2));
    return root;
  }

  // Directory layout: roles live in their own file, which is the merge the
  // monolith readers never performed.
  const dir = join(claude, "rungate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(rest, null, 2));
  writeFileSync(join(dir, "roles.json"), JSON.stringify(roles, null, 2));
  return root;
}

function cleanup() {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
}

// ── SC-1449 ─────────────────────────────────────────────────────────────────

describe("SC-1449: the accessors read the directory layout, which is what the old readers could not", () => {
  test("roles resolve from roles.json, not only from the monolith", () => {
    const dir = makeRoot("directory");
    const mono = makeRoot("monolith");
    try {
      const fromDir = loadRoleConfig(dir);
      expect(Object.keys(fromDir).sort()).toEqual(["marcus", "quinn"]);
      expect(fromDir.marcus?.brief).toBe("prompts/marcus.md");
      // Parity, not a literal: a reader that handled only the directory form
      // would pass the assertion above and be a new instance of the same bug.
      expect(fromDir).toEqual(loadRoleConfig(mono));
    } finally {
      cleanup();
    }
  });

  test("the slug resolves from both layouts, and absence is null rather than a shared literal", () => {
    const dir = makeRoot("directory");
    const mono = makeRoot("monolith");
    const none = makeRoot("neither");
    try {
      expect(readProjectSlug(dir)).toBe(AUTHORED.project);
      expect(readProjectSlug(mono)).toBe(AUTHORED.project);
      // Null, not "project": two unconfigured repos sharing one default would
      // name the same worktree directory and collide.
      expect(readProjectSlug(none)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("remoteHosts survives the schema, which does not declare it", () => {
    const dir = makeRoot("directory");
    const mono = makeRoot("monolith");
    try {
      // `.passthrough()` is the whole reason this works. If the resolved
      // schema ever stops passing unknown keys through, pre-flight silently
      // stops running and nothing else notices.
      expect(readRemoteHosts(dir)).toEqual(AUTHORED.remoteHosts);
      expect(readRemoteHosts(dir)).toEqual(readRemoteHosts(mono));
    } finally {
      cleanup();
    }
  });
});

// ── SC-1450 ─────────────────────────────────────────────────────────────────

describe("SC-1450: absent is empty, malformed throws - the distinction ADR-001 D2 exists for", () => {
  test("an unscaffolded directory yields the empty value from every accessor", () => {
    const none = makeRoot("neither");
    try {
      expect(loadRoleConfig(none)).toEqual({});
      expect(readProjectSlug(none)).toBeNull();
      expect(readRemoteHosts(none)).toEqual({});
    } finally {
      cleanup();
    }
  });

  test("a corrupt config throws rather than reading as unconfigured", () => {
    const bad = makeRoot("malformed");
    try {
      // Four of the six migrated sites wrapped their read in a bare catch that
      // returned the default. That converts "configured wrong" into "not
      // configured", which is the silence #70 shipped in.
      expect(() => loadRoleConfig(bad)).toThrow();
      expect(() => readProjectSlug(bad)).toThrow();
      expect(() => readRemoteHosts(bad)).toThrow();
    } finally {
      cleanup();
    }
  });
});

// ── SC-1451 ─────────────────────────────────────────────────────────────────

describe("SC-1451: the migrated call sites are executed, not merely rewritten", () => {
  test("loadRegistry picks up customMatchers authored in the directory layout", () => {
    const dir = makeRoot("directory");
    try {
      const names = loadRegistry(dir).map(e => e.name);
      // #212/#90: a consumer on the directory layout could not supply custom
      // matchers at all, because this reader looked only at the monolith.
      expect(names, "the custom matcher did not survive the directory layout")
        .toContain("adoption-only-matcher");
    } finally {
      cleanup();
    }
  });

  test("the grader's role list comes from config rather than its built-in fallback", () => {
    const dir = makeRoot("directory");
    try {
      const roles = loadValidRoles(dir);
      expect([...roles].sort()).toEqual(["marcus", "quinn"]);
      // The fallback set is the tell: if the read failed, "serena" is present.
      expect(roles.has("serena"), "fell back to the built-in role list").toBe(false);
    } finally {
      cleanup();
    }
  });

  test("the grader resolves brief paths from the directory layout", () => {
    const dir = makeRoot("directory");
    try {
      expect(loadRoleBriefPaths(dir)).toEqual({
        marcus: join(dir, "prompts/marcus.md"),
        quinn: join(dir, "prompts/quinn.md"),
      });
    } finally {
      cleanup();
    }
  });

  test("the worktree slug comes from config, and from neither layout exclusively", () => {
    const dir = makeRoot("directory");
    const mono = makeRoot("monolith");
    const none = makeRoot("neither");
    try {
      expect(getProjectSlug(dir)).toBe(AUTHORED.project);
      expect(getProjectSlug(mono)).toBe(AUTHORED.project);
      // The literal default stays at this call site, where the collision is
      // visible, rather than inside the accessor.
      expect(getProjectSlug(none)).toBe("project");
    } finally {
      cleanup();
    }
  });
});

// ── SC-1452 ─────────────────────────────────────────────────────────────────

describe("SC-1452: no migrated file keeps a private reader beside the shared one", () => {
  const MIGRATED = [
    "lib/create-sc.ts",
    "lib/task-completion-checks.ts",
    "scripts/fresh-eyes-test.ts",
    "scripts/grade-deterministic.ts",
    "scripts/parallel-ship.ts",
    "scripts/precompute-goal.ts",
    "scripts/test-brief.ts",
  ];

  test("every migrated file is gone from the ratchet, and the ratchet still has entries", () => {
    // The both-ways ratchet in lib/conformity.ts refuses a banked file with no
    // violations left, so leaving an entry behind is itself a failure. This
    // says which files this change claims, so a later revert cannot quietly
    // put one back while the suite stays green.
    const { readConfigAccessRatchet } = require("../lib/conformity");
    const banked = readConfigAccessRatchet(join(import.meta.dir, ".."));
    for (const f of MIGRATED) {
      expect(banked[f], `${f} is still banked — the decrement did not land`).toBeUndefined();
    }
    expect(
      Object.keys(banked).length,
      "the ratchet emptied; the remaining sites belong to #307 and should still be banked",
    ).toBeGreaterThan(0);
  });
});
