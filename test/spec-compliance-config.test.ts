/**
 * Config-driven behaviour in the workflows — hand-written, not generated.
 *
 * These four assertions lived in `test/spec-compliance-auto.test.ts` under
 * `AUTO-CONFIG-*` ids, in a file whose first line says "AUTO-GENERATED ... do
 * not edit manually". They were never generated: `scripts/sync-spec-tests.ts`
 * only emits AUTO-MAKE, AUTO-GATE, AUTO-PORT and AUTO-QUINN claims, and it has
 * no notion of a CONFIG one. Someone hand-edited the output, and the edit
 * survived because the generator was writing to `~/.claude/test/` the whole
 * time (#141) and never came back to overwrite it.
 *
 * Fixing the generator's path would have silently deleted them. They are real
 * checks — "no hardcoding" is a standing rule and these are what enforce it
 * for ship.js and prove.js — so they move here, where nothing regenerates
 * over them and their provenance is honest.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { harnessRoot } from "../lib/paths";

const HR = harnessRoot();
const SHIP_JS = readFileSync(join(HR, "workflows/ship.js"), "utf-8");
const PROVE_JS = readFileSync(join(HR, "workflows/prove.js"), "utf-8");

describe("workflow URLs and commands come from project config, not literals", () => {
  test("ship.js reads API and UI URLs from project config", () => {
    expect(SHIP_JS).toContain("projectConfig");
    expect(SHIP_JS).toContain("apiUrl");
    expect(SHIP_JS).toContain("uiUrl");
  });

  test("ship.js reads the container rebuild command from config", () => {
    expect(SHIP_JS).toContain("containerConfig");
    expect(SHIP_JS).toContain("rebuildCommand");
  });

  test("ship.js reads container hosts and port from config", () => {
    expect(SHIP_JS).toContain("containerConfig");
    expect(SHIP_JS).toContain("containerPort");
    expect(SHIP_JS).toContain("containerHosts");
  });

  test("prove.js reads its container startup command from config", () => {
    // Was a hardcoded `make prove-up`.
    expect(PROVE_JS).toContain("containerConfig");
    expect(PROVE_JS).toContain("proveUpCommand");
  });
});
