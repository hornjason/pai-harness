/**
 * Covers SC-1778..SC-1784 (HARNESS-STANDARD.md), #44.
 *
 * `gates/test-fixtures/` held two JSON files when this issue was filed and
 * **nothing read either of them.** Every reference to the directory in the
 * whole tree is an exclusion — `test/anti.test.ts:137`,
 * `test/dev-liveness.test.ts:385`, `lib/transcript-checker.ts:144` and
 * `lib/test-census.ts:76` each skip it — plus a line in
 * `reference/migration-manifest.json` recording that both files were copied in
 * from `~/.claude/gates/test-fixtures/` when the harness moved into this repo.
 *
 * Four scanners told to look away, each for a good reason, composing into a
 * directory nobody measures. So #44 asked for a consumer fixture to be added
 * "in addition to the rungate fixture", and there was no rungate fixture in
 * any sense that matters — adding a second one would have produced a second
 * inert file that READS as consumer coverage.
 *
 * This file is what makes them load-bearing. It runs real gate code over both
 * shapes: the harness's, and a consumer's. The consumer fixture differs only
 * in ways that actually broke a gate on the first real consumer run, so a
 * change that works on the harness shape and fails on the consumer shape
 * turns a row red here instead of on somebody else's project.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { autoPopulateACs, proveEnvironment } from "../gates/gate-executor";
import { hashAcDefinitions } from "../gates/orchestrator";
import { WorkflowStateSchema } from "../gates/schema";

const FIXTURES = join(import.meta.dir, "..", "gates", "test-fixtures");
const HARNESS_SHAPE = "valid-standard.json";
const CONSUMER_SHAPE = "consumer-directory-layout.json";

/**
 * Read a fixture, refusing rather than skipping when it is not there.
 *
 * A `test.skipIf(!existsSync(...))` here would restore the exact condition
 * this file exists to end: the fixture could be deleted or renamed and the
 * suite would stay green while measuring nothing.
 */
function fixture(name: string): Record<string, any> {
  const path = join(FIXTURES, name);
  if (!existsSync(path)) {
    throw new Error(
      `${name} is missing from gates/test-fixtures/. It is not optional — this file is the only ` +
        `thing that reads that directory, and a fixture nobody reads is what #44 was filed about.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

const withTemp = <T>(fn: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "rungate-fixture-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// ── both shapes, same gate code ──────────────────────────────

describe("#44: the fixtures are executed by real gate code, not merely present", () => {
  test("SC-1778: both fixtures validate against the real state schema", () => {
   for (const name of [HARNESS_SHAPE, CONSUMER_SHAPE]) {
    const state = fixture(name);
    const parsed = WorkflowStateSchema.safeParse(state);
    expect(
      parsed.success,
      parsed.success ? "" : `${name} no longer satisfies the state schema:\n${JSON.stringify((parsed as any).error?.issues, null, 2)}`,
    ).toBe(true);

    // Not a vacuous parse: a schema that accepted anything would pass the row
    // above over an empty object. The fixtures carry the fields the gates
    // actually read.
    expect(state.acs.length).toBeGreaterThan(0);
    expect(state.gates).toBeTruthy();
    expect(typeof state.projectRoot).toBe("string");
   }
  });

  test("SC-1779: both fixtures drive autoPopulateACs to a verdict on every criterion", () => {
   for (const name of [HARNESS_SHAPE, CONSUMER_SHAPE]) {
    const state = fixture(name);
    // Reset to PENDING first, and this is not cosmetic. The loop's first line
    // is `continue` for any AC already decided, so running it over the
    // harness fixture — whose ACs are all PASS on disk — would skip every
    // iteration and still satisfy "something has a verdict". That is the
    // vacuous pass this file exists to rule out, and it was in the first
    // draft of this very test.
    for (const ac of state.acs) {
      ac.verdict = "PENDING";
      delete ac.evidence;
    }

    withTemp(dir => {
      const sf = join(dir, "workflow-state.json");
      writeFileSync(sf, JSON.stringify(state));
      // Build the world each fixture's evidence commands describe. Without
      // it the harness fixture's `grep` hits a missing file, exits 2, and
      // falls to the WARN branch — the AC stays PENDING and the run looks
      // clean. Creating the file is the difference between driving the
      // verdict logic and driving the error handler.
      mkdirSync(join(dir, "test", "unit"), { recursive: true });
      writeFileSync(
        join(dir, "test", "unit", "canary.test.ts"),
        'import { test, expect } from "bun:test";\n// CANARY_MARKER\ntest("canary", () => expect(1).toBe(1));\n',
      );
      // The evidence cwd must exist or `execSync` cannot spawn a shell at
      // all, and every AC ends with a WARN and no verdict — a silent nothing
      // that looks like a clean run. `EVIDENCE_CWD` is the documented
      // override (#264) and is what the dry run follows.
      const previous = process.env.EVIDENCE_CWD;
      process.env.EVIDENCE_CWD = dir;
      try {
        // The real function: it normalises git refs, resolves remote refs and
        // executes each AC's evidence command. Every command in both fixtures
        // is `true` or a `grep` over a path that does not exist — the point is
        // to drive the loop, not to assert a verdict.
        expect(() => autoPopulateACs(state, sf)).not.toThrow();
      } finally {
        if (previous === undefined) delete process.env.EVIDENCE_CWD;
        else process.env.EVIDENCE_CWD = previous;
      }
    });

    // EVERY AC now carries a verdict, not merely one of them. A loop that
    // spawned nothing leaves them all PENDING and warns, which reads as a
    // clean run to anything that only counts failures.
    const undecided = state.acs.filter((ac: any) => !ac.verdict || ac.verdict === "PENDING");
    expect(
      undecided.map((ac: any) => ac.id),
      `${name}: autoPopulateACs left these undecided — the loop did not reach them`,
    ).toEqual([]);
   }
  });
});

// ── the consumer shape, failure by failure ───────────────────

describe("#44: the consumer shape differs where it actually broke a gate", () => {
  test("SC-1780: the consumer fixture has no environments.local - and the harness fixture does", () => {
    // Failure 1 of 8 on the first consumer run: `environments.local` was not
    // pre-populated, and code that assumed it was threw rather than reporting
    // an absence. The two fixtures differ on exactly this, which is what makes
    // the pair worth more than either alone.
    expect(fixture(CONSUMER_SHAPE).environments.local).toBeUndefined();
    expect(fixture(HARNESS_SHAPE).environments.local).toBeTruthy();

    // And reading it is a lookup, not a crash — the behaviour the gate needs.
    const state = fixture(CONSUMER_SHAPE);
    expect(state.environments?.local?.tests).toBeUndefined();
    expect(state.environments.prod).toBeTruthy();
  });

  test("SC-1781: a consumer's dev.* config resolves to the flat names the prove gate reads", () => {
    // Failures 2 and 3: `dev.apiBase` was not mapped to flat `apiUrl` and
    // `dev.testCmd` was not mapped to `test.command`, so every URL the prove
    // gate probes was empty and the liveness check silently did not happen.
    // `lib/config-loader.ts:144` does the mapping; this drives it through the
    // gate's own reader on the DIRECTORY layout, which is the layout a
    // migrated consumer is on.
    withTemp(dir => {
      const cfgDir = join(dir, ".claude", "rungate");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(join(cfgDir, "config.json"), JSON.stringify({
        dev: { apiBase: "http://127.0.0.1:7776", uiBase: "http://127.0.0.1:7775", testCmd: "echo 0 fail", start: "make dev", healthPath: "/api/health" },
        prod: { apiBase: "http://127.0.0.1:7777", healthPath: "/api/health" },
      }));

      const env = proveEnvironment(dir);
      expect(env.apiBase, "dev.apiBase did not reach the prove gate").toBe("http://127.0.0.1:7776");
      expect(env.uiBase, "dev.uiBase did not reach the prove gate").toBe("http://127.0.0.1:7775");
      expect(env.devStart).toBe("make dev");
      expect(env.devHealthPath).toBe("/api/health");
      expect(env.prodCfg.apiBase).toBe("http://127.0.0.1:7777");
    });
  });

  test("SC-1782: a base URL authored as null is absent - not the string null", () => {
    // The other half of the same mapping, and the one that is easy to get
    // wrong in a way that looks right: a greenfield scaffold writes `null` for
    // a base URL it could not detect, and two spellings of "not set" reaching
    // the prove gate is how this class of bug started. `if (apiBase)` must be
    // deciding about absence, not about a null that survived.
    withTemp(dir => {
      const cfgDir = join(dir, ".claude", "rungate");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ dev: { apiBase: null, uiBase: null } }));

      const env = proveEnvironment(dir);
      expect(env.apiBase).toBe("");
      expect(env.uiBase).toBe("");
      expect(env.apiBase).not.toBe("null");
    });

    // A project with no config at all is the same answer rather than a throw:
    // running unscaffolded is normal, and the prove gate has to say "nothing
    // to probe" instead of dying.
    withTemp(dir => {
      const env = proveEnvironment(dir);
      expect(env.apiBase).toBe("");
      expect(env.uiBase).toBe("");
      // An absent config and a config with null URLs give the same empty
      // strings at the top level, but NOT the same `prodCfg`: unresolved
      // returns the bare `empty` sentinel, where resolved-but-blank fills the
      // keys in. Worth pinning, because collapsing the two would be the
      // natural tidy-up and it is the distinction between "no config" and "a
      // config that says nothing".
      expect(env.prodCfg).toEqual({});
    });
  });

  test("SC-1783: the consumer fixture's acHash does not match its healed ACs", () => {
    // Failure 7: a heal agent rewrote AC definition fields between scope and
    // verify, so the hash scope stamped no longer described the ACs — and the
    // gate read that as tampering. `writeWorkflowState` recomputes on the
    // authorised path (ADR-009); the fixture carries the BEFORE state so the
    // recompute has something to do.
    const state = fixture(CONSUMER_SHAPE);
    const stamped = state.gates.scope.acHash;
    expect(typeof stamped).toBe("string");

    const actual = hashAcDefinitions(state.acs);
    expect(actual, "the fixture's stamped hash accidentally matches, so it is no longer a heal fixture")
      .not.toBe(stamped);

    // And the hash is over definition fields only: changing a verdict must
    // not move it, or every gate that records a result would look like a heal.
    const sameDefs = JSON.parse(JSON.stringify(state.acs));
    sameDefs[0].verdict = "PASS";
    sameDefs[0].evidence = { type: "command-output", content: "1" };
    expect(hashAcDefinitions(sameDefs)).toBe(actual);

    // Changing a definition field does move it, or the row above is satisfied
    // by a hash that ignores everything.
    const changedDefs = JSON.parse(JSON.stringify(state.acs));
    changedDefs[0].statement = "something else entirely";
    expect(hashAcDefinitions(changedDefs)).not.toBe(actual);
  });

  test("SC-1784: the consumer fixture's OUTCOME ACs need no running server", () => {
    // Failure 8: the dev-server liveness check ran for OUTCOME ACs whose
    // evidence had nothing to do with a server, so a consumer with no dev
    // server could not pass an outcome criterion at all.
    const outcomes = fixture(CONSUMER_SHAPE).acs.filter((ac: any) => ac.type === "OUTCOME");
    expect(outcomes.length, "the consumer fixture has no OUTCOME ACs left").toBeGreaterThan(0);

    for (const ac of outcomes) {
      const cmd = String(ac.evidenceMethod?.command ?? "");
      expect(cmd, `${ac.id} has no evidence command`).toBeTruthy();
      // No URL, no port, no curl: the evidence is readable without anything
      // listening. This is the property the gate must not assume away.
      expect(cmd, `${ac.id} reaches for a server`).not.toMatch(/https?:\/\/|localhost|127\.0\.0\.1|curl|:\d{4}\b/);
    }
  });
});

// ── fixture hygiene ──────────────────────────────────────────

describe("#44 SC-A1: the fixtures name no consumer and carry no credential", () => {
  const files = () => readdirSync(FIXTURES).filter(f => f.endsWith(".json"));

  test("SC-1785: no fixture names one of the harness's consumers", () => {
    // `test/anti.test.ts` enforces this for `gates/`, `scripts/` and `lib/`,
    // but its walk collects `.ts` files only AND skips `test-fixtures`
    // outright — so a JSON fixture is invisible to it twice over. It was:
    // `valid-standard.json` carried both consumer names, in the directory the
    // consumer-naming guard is configured to ignore, and the guard was green
    // the whole time. That is the exemption-list shape, and this row is the
    // one that can see it.
    const named: string[] = [];
    for (const f of files()) {
      const text = readFileSync(join(FIXTURES, f), "utf-8");
      for (const consumer of ["DailyBriefDashboard", "asaCommandCenter"]) {
        if (text.includes(consumer)) named.push(`${f} names ${consumer}`);
      }
    }
    expect(
      named,
      `the harness must not name one of its consumers (#304) — say "a consumer" and put the detail in the issue`,
    ).toEqual([]);

    // The walk reached something, or the row above is a pass over an empty
    // list — the vacuity this whole file is a response to.
    expect(files().length).toBeGreaterThanOrEqual(2);
    expect(files()).toContain(CONSUMER_SHAPE);
  });

  test("SC-1786: no fixture carries anything shaped like a credential", () => {
    // The same three patterns the pre-commit scanner matches on added lines,
    // applied to files it only sees on the commit that introduces them. A
    // fixture is exactly where a real token gets pasted "just to reproduce
    // it" and then committed.
    const SECRETS = [/AKIA[A-Z0-9]{16}/, /sk-[a-zA-Z0-9]{20,}/, /ghp_[a-zA-Z0-9]{36}/];
    const hits: string[] = [];
    for (const f of files()) {
      const text = readFileSync(join(FIXTURES, f), "utf-8");
      for (const pattern of SECRETS) {
        if (pattern.test(text)) hits.push(`${f} matches ${pattern}`);
      }
    }
    expect(hits).toEqual([]);

    // The patterns can fire, or the row above is three regexes that never
    // match anything and a fixture full of tokens would pass it.
    expect(SECRETS.some(p => p.test("ghp_" + "a".repeat(36)))).toBe(true);
    expect(SECRETS.some(p => p.test("AKIA" + "A1B2C3D4E5F6G7H8"))).toBe(true);
  });
});
