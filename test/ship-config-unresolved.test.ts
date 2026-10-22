/**
 * #1065 — an unresolvable config became `{}`, and `{}` resolves the LIGHT
 * ceremony tier floor.
 *
 * `workflows/ship.js` read the setup agent's reply as
 * `setupResult?.config || {}`, twenty lines below a comment in its own
 * Discovery prompt arguing that no such fallback existed. The empty object
 * then fed `hasUI` and `hasContainer`, the tier fell to the LIGHT floor, and
 * the scope gate, Quinn local, container verify and prove did not run — with
 * the run still reporting DONE.
 *
 * ## What this file does NOT assert, deliberately
 *
 * Nothing here reads `ceremonyTier`. #274 measured this binding and the
 * lesson it recorded is that asserting the resolved string is asserting the
 * value the test set up the inputs to produce; the harm is four tier-gated
 * STATEMENTS that stop executing. That measurement already exists and is not
 * re-done here. What #1065 adds is one layer up: whether the input those
 * statements are gated on is a reading at all.
 *
 * ## The input on which mutant and original differ
 *
 * Not `{}` against a populated config — `{}` is also what a project with no
 * pages and no container legitimately produces, so the defective source and
 * the fixed source agree on it. The distinguishing pair is **a reply with no
 * `config` key at all against one carrying `config: {}`**: before the fix
 * both reached the derivation identically, and after it the first refuses
 * and the second does not. `AC-1` is that pair and `AC-2` varies the one
 * field (#585).
 *
 * ## The cheapest wrong fix, named
 *
 * **Delete the `|| {}` and let it throw.** The silent downgrade stops, and a
 * run whose config did not resolve now dies with a `TypeError` naming
 * `pages` — a worse report than the one it replaces, telling a consumer
 * nothing about their config. A case asserting only "the run did not report
 * DONE" is GREEN under it. So `AC-7` asserts the READING: the derivation
 * site routes an unresolved config through
 * `terminalFailure('CONFIG_UNRESOLVED', …)` before `hasUI` exists. Under the
 * wrong fix that string is absent from the region and the case is red —
 * really, not vacuously, because the wrong fix produces a thrown TypeError
 * and no reading of any kind.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { structuralCut, structuralCutAround } from "../lib/source-slice";

const ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(ROOT, "workflows", "ship.js"), "utf-8");

const START = "// ──── CONFIG-RESOLUTION-REFUSAL-START ────";
const END = "// ──── CONFIG-RESOLUTION-REFUSAL-END ────";
const SIGNATURE = "function configResolutionRefusal(setupResult) {";

/** The project root the refusal interpolates — a fixture path, not this tree. */
const FIXTURE_ROOT = "/fixture/consumer";

/** The one call that ends a run on an unresolved config. */
const REFUSAL_CALL = "terminalFailure('CONFIG_UNRESOLVED'";

type Refusal = (setupResult: unknown) => string | null;

/**
 * ship.js's own binding, extracted from its markers and EXECUTED.
 *
 * A local reimplementation would make this file verify itself, which is the
 * trap `.claude/rules/checks-must-be-able-to-fail.md` names first. The one
 * free name the block reaches for is supplied explicitly, so a block that
 * grows a second one aborts here rather than resolving it off the global
 * object and reading as a pass.
 */
function loadRefusal(source: string = shipSource): Refusal {
  const block = structuralCutAround(source, SIGNATURE, {
    startAnchor: START,
    end: { endAnchor: END },
  });
  return new Function("PROJECT_ROOT", `${block}\nreturn configResolutionRefusal`)(
    FIXTURE_ROOT,
  ) as Refusal;
}

/**
 * The region the derivation lives in, cut structurally rather than by a
 * character count (#664). It starts at the refusal block and ends at the
 * last statement derived from the config, so a claim about "the refusal
 * comes first" is a claim about a region that contains both.
 */
function derivationRegion(source: string = shipSource): string {
  return structuralCutAround(source, "const projectConfig = setupResult.config", {
    startAnchor: START,
    end: { endAnchor: "const hasContainer = " },
  });
}

/** The setup agent's declared reply schema, cut from the prompt's spawn. */
function setupSchema(source: string = shipSource): string {
  return structuralCut(source, "schema: {\n    type: 'object',\n    properties: {\n      acCount:", {
    endAnchor: "  } })",
  });
}

describe("#1065: an unresolved config is a refusal, not an empty object", () => {
  test("AC-1: a reply with no config key refuses; a reply carrying config:{} does not", () => {
    const refuse = loadRefusal();

    // The defective run's shape: the resolver failed, so there is no config
    // to report and the reply says so.
    const unresolved = refuse({ acCount: 3, configResolved: false });
    expect(unresolved).toBeString();
    expect(unresolved).toContain("configResolved: false");

    // The legitimate empty: a CLI library with no pages and no container.
    // This is the input the defect and the fix AGREE on, and it must pass —
    // refusing it would make the fix a different bug.
    expect(refuse({ acCount: 3, configResolved: true, config: {} })).toBeNull();
  });

  test("AC-1b: the accepted empty config really does still read as a LIGHT project", () => {
    // Without this the pair above proves only that one reply is refused. The
    // point of accepting `config: {}` is that the downstream reading is
    // unchanged for a project that genuinely declares nothing, so the rule
    // ship.js applies is read off ship.js and run over the accepted config.
    expect(shipSource).toContain("const hasUI = Object.keys(pagesConfig).length > 0");
    const accepted: Record<string, unknown> = {};
    const pagesConfig = (accepted.pages as Record<string, unknown>) || {};
    expect(Object.keys(pagesConfig).length > 0).toBe(false);
  });

  test("AC-2: two replies differing in exactly one field get opposite verdicts", () => {
    const refuse = loadRefusal();
    // #585: a pair that varies two things at once measures neither. These two
    // carry the same `config`, so comparing them is a measurement of the
    // READING and of nothing else — which is the whole claim, since the
    // defect was that the reading did not exist.
    const resolved = { acCount: 3, configResolved: true, config: {} };
    const unresolved = { ...resolved, configResolved: false };
    expect(Object.keys(resolved).sort()).toEqual(Object.keys(unresolved).sort());

    expect(refuse(resolved)).toBeNull();
    expect(refuse(unresolved)).toBeString();
  });

  test("AC-3: the pre-#1065 reply shape — acCount and nothing else — is UNMEASURED", () => {
    const refuse = loadRefusal();
    // This validated against the old schema, whose `required` list named only
    // `acCount`, and reached the derivation as `{}`.
    const reason = refuse({ acCount: 3 });
    expect(reason).toBeString();
    expect(reason).toContain("UNMEASURED");
    // UNMEASURED must FAIL, never skip: silence and success are otherwise
    // the same reading (.claude/rules/config-access.md).
    expect(reason).toContain("no configResolved reading");
  });

  test("AC-4: configResolved true with the config object dropped is its own refusal", () => {
    const refuse = loadRefusal();
    const reason = refuse({ acCount: 3, configResolved: true });
    expect(reason).toBeString();
    expect(reason).toContain("#646");
  });

  test("AC-4b: the three refusals are three different sentences", () => {
    const refuse = loadRefusal();
    const reasons = [
      refuse({ acCount: 3 }),
      refuse({ acCount: 3, configResolved: false }),
      refuse({ acCount: 3, configResolved: true }),
    ];
    expect(reasons.every((r) => typeof r === "string" && r.length > 0)).toBe(true);
    // An unread reading, a resolver that refused, and a dropped relay field
    // are three facts. One sentence for all three is the conflation this
    // issue is about, one layer in.
    expect(new Set(reasons).size).toBe(3);
  });

  test("AC-5: an absent or non-object setup reply is UNMEASURED, not clean", () => {
    const refuse = loadRefusal();
    for (const reply of [null, undefined, "", 0, "RESOLVED", []]) {
      expect(refuse(reply)).toBeString();
    }
  });

  test("AC-6: configResolved is declared AND required, so the relay cannot drop it", () => {
    const schema = setupSchema();
    expect(schema).toContain("configResolved: { type: 'boolean' }");
    expect(schema).toContain("required: ['acCount', 'configResolved']");
    // `config` stays out of `required` on purpose: a run whose config did not
    // resolve has none to report, and demanding one would make the agent
    // invent the empty object this binding exists to refuse. Asserted rather
    // than left as prose, because the next reader's instinct is to add it.
    expect(schema).not.toContain("'acCount', 'config'");
    expect(schema).not.toContain("required: ['acCount', 'configResolved', 'config']");
  });

  test("AC-7: the derivation refuses by NAME before hasUI exists", () => {
    // The reading, not merely a stop. A fix that deletes the or-empty-object
    // and lets the dereference throw also stops the run — with a TypeError
    // naming `pages`, which tells a consumer nothing about their config.
    // Asserted over the whole file BEFORE the cut, so that fix fails here
    // with a sentence naming the missing reading rather than with an anchor
    // error about a marker it was never going to add. Thrown rather than
    // `expect(shipSource).toContain(...)`, which prints 400KB of ship.js as
    // the received value and buries the one fact the reader needs.
    if (!shipSource.includes(REFUSAL_CALL)) {
      throw new Error(
        `workflows/ship.js contains no ${REFUSAL_CALL} — an unresolved config ends the run ` +
          `with no reading of any kind. Deleting the or-empty-object and letting the ` +
          `dereference throw is the cheapest repair and produces exactly this state: a ` +
          `TypeError naming 'pages', which tells a consumer nothing about their config (#1065).`,
      );
    }

    const region = derivationRegion();
    expect(region).toContain(REFUSAL_CALL);

    const refusalAt = region.indexOf(REFUSAL_CALL);
    const deriveAt = region.indexOf("const projectConfig = setupResult.config");
    expect(refusalAt).toBeGreaterThan(-1);
    expect(deriveAt).toBeGreaterThan(-1);
    // Order, not presence (#652). A refusal below the derivation is a
    // refusal the TypeError beats to it.
    expect(refusalAt).toBeLessThan(deriveAt);
  });

  test("AC-7b: the fallback itself is gone from the derivation", () => {
    const region = derivationRegion();
    // Composed rather than written out, so this file does not become the
    // second position holding the expression it forbids — which is how the
    // first draft of ship.js's own docblock turned this case red.
    const fallback = `setupResult?.config ${"||"} {}`;
    expect(region).not.toContain(fallback);
    expect(region).toContain("const projectConfig = setupResult.config");
    // Any or-empty-object on the config read, not only the exact old one: a
    // repair that reinstates the substitution under a different spelling is
    // the same defect.
    expect(region).not.toMatch(/setupResult[?.]*\.config\s*\|\|/);
  });

  test("AC-8: the prompt asks for the exit status and forbids substituting {}", () => {
    // The agent is the only thing that can see resolve-config.ts's exit code
    // — ship.js cannot import across that boundary (#69) — so a field the
    // prompt never asks for is a field that arrives absent on every run.
    const prompt = structuralCut(shipSource, "2. Load config (ADR-002 D1", {
      endAnchor: "3. Prior branch detect:",
    });
    expect(prompt).toContain("configResolved");
    expect(prompt).toContain("Do NOT substitute");
    expect(prompt).toContain("UNMEASURED");
  });

  test("AC-9: the refusals are load-bearing — removing them collapses the AC-1 pair", () => {
    // Mutation evidence, in the file rather than in a sentence. Without it
    // every case above is satisfied by a binding that refuses correctly for
    // reasons unrelated to the three readings, and nothing says which.
    const neutered = shipSource.replace(
      SIGNATURE,
      `${SIGNATURE}\n  if (setupResult !== undefined || setupResult === undefined) return null`,
    );
    expect(neutered).not.toBe(shipSource);
    const mutant = loadRefusal(neutered);

    // The input on which mutant and original differ, named and run rather
    // than assumed: the AC-1 pair. The real binding separates them; the
    // mutant returns null for both, which is pre-#1065 behaviour exactly.
    const real = loadRefusal();
    expect(real({ acCount: 3, configResolved: false })).toBeString();
    expect(real({ acCount: 3, configResolved: true, config: {} })).toBeNull();

    expect(mutant({ acCount: 3, configResolved: false })).toBeNull();
    expect(mutant({ acCount: 3, configResolved: true, config: {} })).toBeNull();
  });

  test("AC-10: the binding and its markers appear exactly once", () => {
    // A second copy would survive any mutation of the first, and both would
    // read as covered (.claude/rules/checks-must-be-able-to-fail.md, fourth
    // shape). The extraction already refuses an ambiguous anchor; this says
    // so where a reader looks.
    const count = (needle: string) => shipSource.split(needle).length - 1;
    expect(count(SIGNATURE)).toBe(1);
    expect(count(START)).toBe(1);
    expect(count(END)).toBe(1);
    expect(count("configResolutionRefusal(setupResult)")).toBe(2); // the declaration and its one call
  });
});
