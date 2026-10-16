/**
 * Covers SC-1678..SC-1680 (CONFIG-DIRECTORY-STRUCTURE-SPEC.md), #307 SC-A11.
 *
 * The scope gate's heal prompt told an agent:
 *
 *     For local-api-validated: read ${PROJECT_ROOT}/.claude/rungate.json for
 *     apiUrl. If no apiUrl configured, write environments.local.api = "SKIP".
 *
 * Two defects in one sentence, and they compound.
 *
 * The file is named. A consumer on the documented `.claude/rungate/` layout
 * does not have it, so the agent finds nothing — and the sentence tells it
 * what to do about finding nothing: write SKIP. A project serving a live API
 * records "this check does not apply", and a skip for "no server here" and a
 * skip for "I could not locate the config" are the same two letters in the
 * state file.
 *
 * And the decision is the AGENT's. The workflow already knows the answer: it
 * resolves the config through `scripts/resolve-config.ts` before any prompt is
 * written, and interpolates `${testCommand}` from it three lines above. The
 * URL was the one value left for the agent to go and find.
 *
 * So the clause is built by the workflow and the agent is handed a conclusion,
 * not a lookup. When a URL resolved, SKIP is not offered at all — an agent
 * that cannot complete the curl has found a FAIL, which is the asymmetry this
 * whole gate exists for.
 *
 * The clause is EXECUTED here, out of its marker block, rather than asserted
 * as source text: a prompt test that greps for a URL passes against a prompt
 * that mentions the URL and still says SKIP.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SHIP = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");

/** The text between a START/END marker pair. */
function markedBlock(name: string): string {
  const start = SHIP.indexOf(`// ──── ${name}-START ────`);
  const end = SHIP.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found in ship.js`);
  return SHIP.slice(start, end);
}

type Clause = (field: "api" | "ui", url: string | null, configKey: string) => string;

const localEnvClause: Clause = new Function(
  `${markedBlock("LOCAL-ENV-CLAUSE")}\nreturn localEnvClause`,
)() as Clause;

describe("#307: the heal prompt carries the URL, not a lookup", () => {
  test("SC-1678: a resolved URL reaches the prompt and no file is named", () => {
    const clause = localEnvClause("api", "http://localhost:7778", "dev.apiBase");

    expect(clause).toContain("http://localhost:7778");
    // The two things the old sentence did that this one must not. Naming the
    // monolith is the half that breaks a migrated consumer; naming any config
    // file at all is the half CONFIG-2 refuses.
    expect(clause, "the clause still names the config file").not.toContain("rungate.json");
    expect(clause, "the clause still sends the agent to the config").not.toContain(".claude");
  });

  test("SC-1679: SKIP is not offered when a URL resolved", () => {
    // The self-skip. An agent handed both a URL and the word SKIP has been
    // given a way out of the check, and the state file cannot tell a project
    // with no server from an agent that took it.
    const api = localEnvClause("api", "http://localhost:7778", "dev.apiBase");
    const ui = localEnvClause("ui", "http://localhost:5173", "dev.uiBase");

    for (const [name, clause] of [["api", api], ["ui", ui]] as const) {
      expect(clause, `${name}: SKIP is still on offer beside a resolved URL`).toContain(
        "SKIP is NOT available",
      );
      // ...and it says what to do instead, because "not SKIP" with no second
      // option is an instruction an agent resolves by picking one anyway.
      expect(clause, `${name}: the clause does not say what replaces SKIP`).toContain("FAIL");
    }
  });

  test("SC-1680: a project with no URL still skips - and says which key it looked for", () => {
    // The positive control for both cases above, and the branch that must
    // stay reachable: rungate itself sets no `dev.apiBase`, so a clause that
    // had stopped being able to skip would turn every self-run red.
    const clause = localEnvClause("api", null, "dev.apiBase");

    expect(clause).toContain('environments.local.api = "SKIP"');
    expect(clause).toContain("skipReason");
    // Named, because "no API configured" sends an operator looking for a key
    // they already did not set.
    expect(clause).toContain("dev.apiBase");
    // And the agent is told not to go hunting — the absence is the
    // workflow's finding, not an invitation to re-check it.
    expect(clause).toContain("Do not go looking");
  });

  test("the two fields produce different clauses - the field is not decorative", () => {
    // A clause that ignored its `field` argument would satisfy every
    // assertion above while writing the API verdict into both slots.
    const api = localEnvClause("api", null, "dev.apiBase");
    const ui = localEnvClause("ui", null, "dev.uiBase");

    expect(api).toContain("environments.local.api");
    expect(ui).toContain("environments.local.ui");
    expect(api).not.toContain("environments.local.ui");
    expect(ui).not.toContain("environments.local.api");
  });

  test("the shipped prompt uses the clause, and the old sentence is gone", () => {
    // The clause being right is worth nothing if the prompt still hardcodes
    // the old text beside it. This is the one source-text assertion here, and
    // it is about the CALL rather than about the content.
    expect(SHIP).toContain("For local-api-validated: ${localApiClause}");
    expect(SHIP).toContain("For local-ui-validated: ${localUiClause}");
    // Searched over the whole file but REPORTED as a line list, because the
    // failure message for a whole-file `toContain` is the whole file.
    const offenders = SHIP.split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => line.includes("rungate.json for apiUrl"))
      .map(([n, line]) => `${n}: ${line.trim()}`);
    expect(
      offenders,
      `the heal prompt still sends an agent to the config for a URL:\n${offenders.join("\n")}`,
    ).toEqual([]);
    // One block, so there is one binding to mutate.
    expect(SHIP.split("LOCAL-ENV-CLAUSE-START").length - 1).toBe(1);
  });
});
