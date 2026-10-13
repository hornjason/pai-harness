/**
 * The prove gate recorded liveness and nothing read it (#346).
 *
 * #304 relaxed a refusal, correctly. The gate used to `process.exit(1)` when
 * `dev.apiBase` was set and the server did not answer — but the health route
 * is now read from config and no consumer sets `dev.healthPath`, so
 * reporting DOWN for a server whose route cannot be looked up is a false
 * FAIL on a healthy server. #345 then made the reading durable: `UP` /
 * `DOWN` / `UNMEASURED` per tier, written to `workflow-state.json` and
 * `prove-input.json`.
 *
 * And nothing read it. **A control replaced by an unread field is still a
 * control removed** — #213's shape exactly: recorded, never consumed.
 *
 * ## The refusal has to be the right one
 *
 * Not "FAIL if liveness is UNMEASURED": that reinstates the false FAIL and
 * fires on every consumer on their next run. The honest refusal is the
 * contradiction — a run claiming it collected server-dependent OUTCOME
 * evidence while reporting that liveness was never measured. One of those
 * two statements is untrue, and the check does not need to know which.
 *
 * So the controls in this file are not decoration. Three of them exist
 * specifically to prove the relaxation survived:
 *
 * - UNMEASURED with no server-dependent AC must pass.
 * - UNMEASURED with an AC that *declares* a server method but collected
 *   nothing must pass — planning to use a server you have not found is not
 *   a contradiction.
 * - UP with the same claimed evidence must pass.
 *
 * Covers SC-780..782 of GATE-CONTRACTS-SPEC.md.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  claimsServerEvidence,
  healthPathIn,
  livenessEvidenceContradictions,
  SERVER_DEPENDENT_METHODS,
} from "../lib/liveness-contradiction";

const REPO = join(import.meta.dir, "..");

function outcomeAc(over: Record<string, unknown> = {}) {
  return {
    id: "AC-1",
    type: "OUTCOME",
    evidenceMethod: { type: "PLAYWRIGHT" },
    evidence: { type: "screenshot", content: "shot.png" },
    ...over,
  };
}

describe("#346: evidence claimed from a server the run never found", () => {
  test("UNMEASURED liveness plus collected server evidence refuses", () => {
    const v = livenessEvidenceContradictions(
      [outcomeAc()],
      [{ tier: "dev", status: "UNMEASURED", detail: "no healthPath" }],
    );
    expect(v.length).toBe(1);
    expect(v[0]).toContain("AC-1");
    expect(v[0]).toContain("UNMEASURED");
    // The message has to say what to do, or it is an alarm with no action.
    expect(v[0]).toContain("health path");
  });

  test("UP liveness with the same evidence passes", () => {
    // Paired control. A check that refuses on everything satisfies the case
    // above on its own and tells you nothing.
    expect(
      livenessEvidenceContradictions([outcomeAc()], [{ tier: "dev", status: "UP", detail: "ok" }]),
    ).toEqual([]);
  });

  test("UP on one tier excuses UNMEASURED on the other", () => {
    // A server WAS found, so the evidence has somewhere it could have come
    // from. Refusing here would fire on every project with a configured dev
    // server and no prod health path, which is most of them.
    expect(
      livenessEvidenceContradictions(
        [outcomeAc()],
        [{ tier: "dev", status: "UP", detail: "ok" }, { tier: "prod", status: "UNMEASURED", detail: "x" }],
      ),
    ).toEqual([]);
  });

  test("UNMEASURED with no server-dependent AC passes — the relaxation survives", () => {
    // #304's whole point. This must stay green or the issue has been
    // "fixed" by undoing the fix before it.
    const codeAc = { id: "AC-2", type: "CODE", evidenceMethod: { type: "GREP_CHECK" }, evidence: { type: "grep-output" } };
    expect(
      livenessEvidenceContradictions([codeAc], [{ tier: "dev", status: "UNMEASURED", detail: "x" }]),
    ).toEqual([]);
  });

  test("an AC that declares a server method but collected nothing passes", () => {
    // A plan is not a claim. Refusing here would stop every run that
    // intends to use playwright before it has run anything.
    expect(
      livenessEvidenceContradictions(
        [outcomeAc({ evidence: null })],
        [{ tier: "dev", status: "UNMEASURED", detail: "x" }],
      ),
    ).toEqual([]);
  });

  test("DOWN is a measurement and does not fire this check", () => {
    // Deliberately narrow, and asserted so the narrowness is a decision
    // rather than an oversight. DOWN means the route was configured and the
    // probe ran; widening to it is a bigger behaviour change than #346
    // asked for.
    expect(
      livenessEvidenceContradictions([outcomeAc()], [{ tier: "prod", status: "DOWN", detail: "x" }]),
    ).toEqual([]);
  });

  test("no liveness readings at all does not fire it either", () => {
    // A project that declares no server is a different situation from one
    // that tried to look and could not.
    expect(livenessEvidenceContradictions([outcomeAc()], [])).toEqual([]);
  });

  test("every server-dependent method is recognised, and a CODE AC never is", () => {
    for (const m of SERVER_DEPENDENT_METHODS) {
      expect(claimsServerEvidence(outcomeAc({ evidenceMethod: { type: m } })), m).toBe(true);
    }
    expect(claimsServerEvidence(outcomeAc({ type: "CODE" }))).toBe(false);
    expect(claimsServerEvidence(outcomeAc({ evidenceMethod: { type: "GREP_CHECK" }, evidence: { type: "grep-output" } }))).toBe(false);
  });

  test("every contradicting AC is named, not just the first", () => {
    const v = livenessEvidenceContradictions(
      [outcomeAc(), outcomeAc({ id: "AC-9" })],
      [{ tier: "dev", status: "UNMEASURED", detail: "x" }],
    );
    expect(v.length).toBe(2);
    expect(v.join("\n")).toContain("AC-9");
  });
});

describe("#346: the gate consumes the reading it records", () => {
  test("the refusal is wired into gate-executor, after the artefacts are written", () => {
    // #194's lesson and #168's: a correct library the caller never consults
    // is a control that is still removed. The order matters too — a run
    // that refuses should leave behind the state that explains why.
    const src = readFileSync(join(REPO, "gates", "gate-executor.ts"), "utf-8");
    const writeAt = src.indexOf("writeFileSync(proveInputPath");
    const checkAt = src.indexOf("livenessEvidenceContradictions(");
    expect(writeAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(writeAt);
    expect(src).toContain("process.exit(1)");
    // And the comment that said it was deliberately unconsumed is gone.
    expect(src).not.toContain("It is RECORDED, not yet CONSUMED");
  });
});

/**
 * Order is not prevention — the same measurement #354 produced, one gate
 * over. The case above asserts the check runs after the artefacts are
 * written; making its refusal branch unreachable scored **0 red**, because
 * the check still ran and the gate carried on. So the real block is sliced
 * out of gate-executor.ts and executed.
 */
const GATE_EXECUTOR = join(REPO, "gates", "gate-executor.ts");
const REFUSAL_ANCHOR = "const contradictions = livenessEvidenceContradictions(";

function sliceRefusalBlock(): string {
  const src = readFileSync(GATE_EXECUTOR, "utf-8");
  const at = src.indexOf(REFUSAL_ANCHOR);
  if (at === -1) throw new Error("could not slice the refusal: the anchor appears 0 times");
  if (src.indexOf(REFUSAL_ANCHOR, at + 1) !== -1) {
    throw new Error("could not slice the refusal: the anchor appears more than once");
  }
  // From the anchor to the end of the `if` that follows it.
  const ifAt = src.indexOf("if (contradictions.length", at);
  if (ifAt === -1) throw new Error("could not slice the refusal: no contradictions branch follows the anchor");
  const open = src.indexOf("{", ifAt);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  throw new Error("could not slice the refusal: unbalanced braces");
}

function runRefusalBlock(state: { acs: unknown[]; liveness: unknown[] }) {
  const errs: string[] = [];
  // Written only from inside the injected `process.exit`, which TypeScript
  // cannot see through the Proxy — hence the explicit type rather than the
  // `null` it would otherwise infer and then refuse to widen.
  let exited: number | null = null as number | null;
  const scope = {
    state,
    livenessEvidenceContradictions,
    console: { error: (m: string) => errs.push(String(m)), log: () => {} },
    process: {
      exit: (c: number) => {
        exited = c;
        // The real one does not return. Throwing models that, so anything
        // after the exit cannot run and be mistaken for the happy path.
        throw new Error("__EXIT__");
      },
    },
  };
  const proxy = new Proxy(scope as Record<string, unknown>, {
    has: () => true,
    get: (t, k) => (k === Symbol.unscopables ? undefined : t[k as string]),
  });
  try {
    new Function("__scope__", `with (__scope__) { ${sliceRefusalBlock()} }`)(proxy);
  } catch (e) {
    if ((e as Error).message !== "__EXIT__") throw e;
  }
  return { errs, exited };
}

describe("#346: the gate's refusal actually stops the run", () => {
  test("a contradicting state exits non-zero and names the AC", () => {
    const r = runRefusalBlock({
      acs: [outcomeAc()],
      liveness: [{ tier: "dev", status: "UNMEASURED", detail: "no healthPath" }],
    });
    expect(r.exited).toBe(1);
    expect(r.errs.join("\n")).toContain("AC-1");
    expect(r.errs.join("\n")).toContain("healthPath");
  });

  test("a clean state does not exit — the control", () => {
    // Without this, an unconditional exit would satisfy the case above and
    // refuse every prove gate run in every consumer project.
    const r = runRefusalBlock({
      acs: [outcomeAc()],
      liveness: [{ tier: "dev", status: "UP", detail: "ok" }],
    });
    expect(r.exited).toBeNull();
    expect(r.errs).toEqual([]);
  });

  test("an UNMEASURED state with nothing claimed does not exit", () => {
    // #304's relaxation, asserted through the real gate code rather than
    // the library alone.
    const r = runRefusalBlock({
      acs: [{ id: "AC-2", type: "CODE", evidenceMethod: { type: "GREP_CHECK" }, evidence: { type: "grep-output" } }],
      liveness: [{ tier: "dev", status: "UNMEASURED", detail: "x" }],
    });
    expect(r.exited).toBeNull();
  });
});

describe("#346: healthPath is detected, never defaulted", () => {
  test("a declared health route is found in the shapes servers declare them", () => {
    expect(healthPathIn(`app.get("/api/health", (c) => c.json({ok:true}))`)).toBe("/api/health");
    expect(healthPathIn(`router.all('/healthz', handler)`)).toBe("/healthz");
    expect(healthPathIn(`{ path: "/api/admin/health", handler }`)).toBe("/api/admin/health");
  });

  test("a file with no health route returns null, which is the measurement", () => {
    // #346 suggested scaffolding a conventional default. That would
    // re-create #304's bug through a different door: DevSchema.healthPath
    // says "No default. A probe that guesses a path reports DOWN for a
    // server that is up", and a guess the scaffold writes into the
    // consumer's config is still a guess. Null is honest; a wrong path is a
    // DOWN verdict on a healthy server.
    expect(healthPathIn(`app.get("/api/users", h)`)).toBeNull();
    expect(healthPathIn("")).toBeNull();
  });

  test("the schema's no-default rule still says so, and nothing contradicts it", () => {
    const schema = readFileSync(join(REPO, "lib", "rungate-schema.ts"), "utf-8");
    expect(schema).toContain("No default");
    // The scaffold must not carry a literal fallback path next to the key.
    const steps = readFileSync(join(REPO, "lib", "scaffold", "steps.ts"), "utf-8");
    const block = steps.slice(steps.indexOf("healthPath:"), steps.indexOf("healthPath:") + 200);
    expect(block).not.toMatch(/healthPath:\s*["'`]\//);
  });

  test("the scaffold writes a detected route and null when there is none", () => {
    const dir = mkdtempSync(join(tmpdir(), "hp-detect-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "server.ts"), `app.get("/api/admin/health", ok)\n`);
      // Exercised through the exported matcher the scaffold uses, which is
      // the same code path; the scaffold's own file list is asserted by the
      // conformity suite rather than re-run here.
      expect(healthPathIn(readFileSync(join(dir, "src", "server.ts"), "utf-8"))).toBe("/api/admin/health");

      writeFileSync(join(dir, "src", "server.ts"), `app.get("/api/thing", ok)\n`);
      expect(healthPathIn(readFileSync(join(dir, "src", "server.ts"), "utf-8"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
