/**
 * Covers SC-1698..SC-1704 (CONFIG-DIRECTORY-STRUCTURE-SPEC.md), #311 SC-A8
 * and SC-A9.
 *
 * Four readers in `gates/gate-executor.ts` and one in
 * `gates/ship-orchestrator.ts` built `.claude/rungate.json` by hand and
 * branched on `existsSync`. That collapses three facts into one answer:
 *
 *   - this project has no rungate config
 *   - this project is on the documented `.claude/rungate/` layout
 *   - this project has a config and it cannot be parsed
 *
 * and every caller treated the single answer as the first. The cost was
 * never a warning, and it is specific per site: a consumer on the directory
 * layout got its ceremony overrides switched off (#310), its type check
 * skipped, its dev-server liveness unprobed, its prove-gate environment
 * empty, and its container rebuild reported as `SKIP (prod.rebuild is
 * null)` — a sentence about a key the reader never looked at.
 *
 * ## Why every case here is authored twice
 *
 * The monolith arm passes against the broken code. Rungate is on both
 * layouts, and `captureTestBaseline` in #307 is the worked example of what
 * that does to a test suite: the only fixture anyone writes by reflex is the
 * one the defect cannot be seen in. So each reader is driven against a
 * monolith project AND a directory project, and the two answers are compared
 * to EACH OTHER rather than to a literal — a reader that handled neither
 * layout would satisfy a pair of literals written to match it.
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  livenessDev,
  loadAndValidateHarness,
  proveEnvironment,
  readGateConfig,
  typeCheckCommand,
} from "../gates/gate-executor";
import { shouldRebuildContainer } from "../gates/ship-orchestrator";

/** The config body both layouts carry, so the two can be compared directly. */
const BODY = {
  project: "consumer",
  repo: "x/y",
  issueRepo: "x/y",
  dev: {
    start: "npm run dev",
    apiBase: "http://localhost:7778",
    uiBase: "http://localhost:5173",
    typeCheck: "npm run tsc",
    healthPath: "/healthz",
  },
  prod: { rebuild: "make promote", apiBase: "https://example.test", healthPath: "/healthz" },
  ceremonyOverrides: { LIGHT: { maxIterations: 2 } },
};

function monolith(body: unknown = BODY): string {
  const root = mkdtempSync(join(tmpdir(), "rg-311-mono-"));
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "rungate.json"), JSON.stringify(body));
  return root;
}

function directory(body: unknown = BODY): string {
  const root = mkdtempSync(join(tmpdir(), "rg-311-dir-"));
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  writeFileSync(join(root, ".claude", "rungate", "config.json"), JSON.stringify(body));
  return root;
}

function bare(): string {
  return mkdtempSync(join(tmpdir(), "rg-311-bare-"));
}

/** A config that exists and cannot be parsed. */
function broken(): string {
  const root = mkdtempSync(join(tmpdir(), "rg-311-bad-"));
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "rungate.json"), "{ not json,");
  return root;
}

function cleanup(...roots: string[]): void {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

describe("#311: the gate's config read has three answers - not two", () => {
  test("SC-1698: absent - unreadable and resolved are distinct readings", () => {
    const m = monolith();
    const d = directory();
    const b = bare();
    const x = broken();
    try {
      expect(readGateConfig(m).status).toBe("resolved");
      expect(readGateConfig(d).status).toBe("resolved");
      expect(readGateConfig(b).status).toBe("absent");

      // The one that used to be indistinguishable from absence, in every
      // one of these readers — via `existsSync` in four of them and via a
      // bare `catch` in the fifth. `.claude/rules/config-access.md` names
      // the catch by file and line.
      const bad = readGateConfig(x);
      expect(bad.status, "a corrupt config still reads as an unconfigured project").toBe(
        "unreadable",
      );
      if (bad.status !== "unreadable") throw new Error("unreachable");
      expect(bad.reason.length, "the reading says nothing about why").toBeGreaterThan(0);

      // The layout is named, because "resolved" without a source cannot tell
      // an operator which of their two files the gate actually read.
      const dr = readGateConfig(d);
      if (dr.status !== "resolved") throw new Error("unreachable");
      expect(dr.source).toBe("directory");
      const mr = readGateConfig(m);
      if (mr.status !== "resolved") throw new Error("unreachable");
      expect(mr.source).toBe("monolith");
    } finally {
      cleanup(m, d, b, x);
    }
  });

  test("SC-1699: the prove gate's environment is the same on both layouts", () => {
    // Every field below was "" for every directory-layout consumer, and the
    // symptom was `if (apiBase)` being false — a liveness probe that
    // silently did not happen.
    const m = monolith();
    const d = directory();
    try {
      const fromMonolith = proveEnvironment(m);
      const fromDirectory = proveEnvironment(d);

      expect(fromDirectory, "the two layouts disagree").toEqual(fromMonolith);
      // Compared to each other AND pinned, because two readers that both
      // return empty also agree.
      expect(fromDirectory.apiBase).toBe("http://localhost:7778");
      expect(fromDirectory.uiBase).toBe("http://localhost:5173");
      expect(fromDirectory.devStart).toBe("npm run dev");
      expect(fromDirectory.devHealthPath).toBe("/healthz");
      expect(fromDirectory.prodCfg.healthPath).toBe("/healthz");
    } finally {
      cleanup(m, d);
    }
  });

  test("SC-1700: an authored null base URL stays absent - not the string null", () => {
    // ADR-002 D3 collapses an authored `null` — what a greenfield scaffold
    // writes for a base URL it could not detect — into the same absence an
    // omitted key gives. Reading `dev.apiBase` raw would put the second
    // spelling back in front of `if (apiBase)`, which is the branch that
    // decides whether a probe happens at all.
    const root = directory({ ...BODY, dev: { ...BODY.dev, apiBase: null, uiBase: null } });
    try {
      const env = proveEnvironment(root);
      expect(env.apiBase).toBe("");
      expect(env.uiBase).toBe("");
      // The other dev fields are untouched, so this is normalisation and not
      // a reader that gave up on the whole block.
      expect(env.devStart).toBe("npm run dev");
      expect(livenessDev(readGateConfig(root))?.apiBase).toBeUndefined();

      // And the arm that makes the two spellings distinguishable at all. A
      // reader doing `dev.apiBase || ""` produces exactly the same answers as
      // `apiUrl || ""` for every fixture above — `null || ""` is `""` either
      // way — so without a top-level `apiUrl`, every assertion in this test
      // holds just as well against the raw read it exists to forbid.
      const normalised = directory({
        ...BODY,
        apiUrl: "http://localhost:9999",
        dev: { ...BODY.dev, apiBase: undefined },
      });
      expect(proveEnvironment(normalised).apiBase).toBe("http://localhost:9999");
      cleanup(normalised);
    } finally {
      cleanup(root);
    }
  });

  test("SC-1701: the type check command is found on both layouts", () => {
    const m = monolith();
    const d = directory();
    const b = bare();
    try {
      expect(typeCheckCommand({ projectRoot: d })).toBe("npm run tsc");
      expect(typeCheckCommand({ projectRoot: m })).toBe(typeCheckCommand({ projectRoot: d }));

      // State still wins over config — unchanged, and asserted so the
      // migration cannot quietly reverse the precedence.
      expect(typeCheckCommand({ projectRoot: d, dev: { typeCheck: "tsc --noEmit" } })).toBe(
        "tsc --noEmit",
      );

      // `null` is an authored value (#87): "we looked and there is nothing
      // to type-check" is a different fact from nobody configuring it, and
      // both end in no command. The caller is not made to know which.
      const nulled = directory({ ...BODY, dev: { ...BODY.dev, typeCheck: null } });
      expect(typeCheckCommand({ projectRoot: nulled })).toBeNull();
      expect(typeCheckCommand({ projectRoot: b })).toBeNull();
      cleanup(nulled);
    } finally {
      cleanup(m, d, b);
    }
  });

  test("SC-1702: the liveness probe sees a dev block on both layouts", () => {
    const m = monolith();
    const d = directory();
    const b = bare();
    try {
      expect(livenessDev(readGateConfig(d))).toEqual(livenessDev(readGateConfig(m)));
      expect(livenessDev(readGateConfig(d))).toEqual({
        apiBase: "http://localhost:7778",
        healthPath: "/healthz",
        start: "npm run dev",
      });
      // Absent is `undefined`, which `livenessPlan` turns into UNMEASURED
      // rather than DOWN — the #304 asymmetry this must not cost.
      expect(livenessDev(readGateConfig(b))).toBeUndefined();
    } finally {
      cleanup(m, d, b);
    }
  });

  test("SC-1703: a configured rebuild is seen on both layouts", () => {
    // The scope gate printed `Container rebuild: SKIP (prod.rebuild is
    // null)` for a directory-layout consumer that had configured one — a
    // sentence about a key the reader never looked at.
    const m = monolith();
    const d = directory();
    const b = bare();
    // Omitted, not `null`: `ProdSchema.rebuild` is an optional STRING, so a
    // config authoring `null` is malformed and throws rather than meaning no.
    // That is the right behaviour and it is why this fixture omits the key —
    // but it also means the scope gate's `prod.rebuild is null` message
    // describes a JS value no consumer can write.
    const { rebuild, ...prodWithoutRebuild } = BODY.prod;
    const none = directory({ ...BODY, prod: prodWithoutRebuild });
    try {
      expect(shouldRebuildContainer(d)).toBe(true);
      expect(shouldRebuildContainer(d)).toBe(shouldRebuildContainer(m));
      // Both ways it can be false, so `true` above is a decision and not a
      // reader that says yes to everything.
      expect(shouldRebuildContainer(none), "an omitted rebuild still means no").toBe(false);
      expect(shouldRebuildContainer(b)).toBe(false);
    } finally {
      cleanup(m, d, b, none);
    }
  });

  test("SC-1704: a corrupt config is not silently treated as unconfigured", () => {
    // The fifth site's bare `catch` is gone, and the question is what each
    // reader does now. They do NOT throw — a gate that crashes on a corrupt
    // config is worse than one that reports — but none of them may answer
    // the same thing a well-formed empty project answers without saying so.
    const x = broken();
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      // The reading itself carries the distinction...
      expect(readGateConfig(x).status).toBe("unreadable");
      // ...and the throw is converted rather than propagated, which is the
      // shape SC-1453 established for a loader throw crossing into a gate.
      expect(() => proveEnvironment(x)).not.toThrow();
      expect(() => typeCheckCommand({ projectRoot: x })).not.toThrow();
      expect(() => loadAndValidateHarness(x)).not.toThrow();

      // Not throwing is only half of it. For these three the WARN is the
      // ENTIRE difference between `unreadable` and `absent` — each returns the
      // same empty answer either way — so a reading that distinguished them
      // and a reader that said nothing would be two names for one behaviour,
      // and no test of the return value could tell them apart.
      expect(errors.length, "a corrupt config passed three readers in silence").toBe(3);
      for (const where of ["prove gate environment", "type check", "ceremony overrides"]) {
        expect(errors.some(e => e.includes(where)), `no WARN named ${where}`).toBe(true);
      }
      expect(errors.every(e => e.includes("UNMEASURED"))).toBe(true);

      // `shouldRebuildContainer` is the exception and deliberately so: it
      // uses the loader directly, so a corrupt config reaches the scope gate
      // as a throw. ADR-001 D2 — a malformed config is never a missing
      // config — and the scope gate is the right place to find out.
      expect(() => shouldRebuildContainer(x)).toThrow();
    } finally {
      console.error = realError;
      cleanup(x);
    }
  });

  test("SC-1705: ceremony overrides survive the round trip on both layouts", () => {
    // #310 by name: the overrides were switched off for every directory
    // consumer, and a tier control that silently does nothing is the thing
    // `.claude/rules/config-access.md` calls Silent Default Substitution.
    const m = monolith();
    const d = directory();
    try {
      const fromDirectory = loadAndValidateHarness(d);
      expect(fromDirectory?.ceremonyOverrides?.LIGHT?.maxIterations).toBe(2);
      expect(fromDirectory?.ceremonyOverrides).toEqual(
        loadAndValidateHarness(m)?.ceremonyOverrides,
      );
    } finally {
      cleanup(m, d);
    }
  });
});
