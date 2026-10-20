/**
 * Covers #813: the Tier 1 conformity checks route to the document that
 * explains them, and the pointer is absent where the document is.
 *
 * ## What was broken to prove these can fail
 *
 * | Mutation | Result |
 * |---|---|
 * | `ruleDocPointer` returns its sentence unconditionally | 1 fail — the absent-root case |
 * | `ruleDocPointer` returns `""` unconditionally | 2 fail — the present-root case and the composition case |
 * | one `remedyMessage` in `lib/conformity.ts` reverted to a bare `.toEqual([])` | 1 fail — the population guard, naming the check |
 * | the population constant emptied | 1 fail — the non-vacuity floor |
 *
 * The third row is the one that matters. The population guard is the only
 * assertion here that notices a check LOSING its remedy, and a guard over an
 * empty population would pass over nothing at all — which is why the floor is
 * asserted rather than assumed.
 *
 * ## The scan reads code, not prose
 *
 * The guard greps for `remedyMessage(` call sites in three real files, and
 * this very docblock names that symbol. A raw scan would count this file's
 * own commentary and the paragraph above as call sites — a checker that greps
 * for a string cannot tell a use from a mention of one, the trap recorded in
 * the rule document under discussion. `stripJsComments` blanks comments and
 * preserves offsets, so what remains is code.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { SELF_REFERENTIAL_RULES, remedyMessage, ruleDocPointer } from "../lib/check-remedy";
import { stripJsComments } from "../lib/strip-js-comments";

const REPO = join(import.meta.dir, "..");

/** A root that carries the rule document, and one that does not. */
function plant(opts: { withRuleDoc: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "rg-813-"));
  if (opts.withRuleDoc) {
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    writeFileSync(join(root, SELF_REFERENTIAL_RULES), "# planted\n");
  }
  return root;
}

describe("#813: the pointer is derived from the tree, not configured", () => {
  test("a root carrying the document gets a sentence naming it", () => {
    const root = plant({ withRuleDoc: true });
    try {
      const pointer = ruleDocPointer(root);
      expect(pointer, "a project that HAS the document was routed nowhere").not.toBe("");
      expect(pointer).toContain(SELF_REFERENTIAL_RULES);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a root without it is routed nowhere, rather than at a file it lacks", () => {
    // The direction that makes this safe to publish. `lib/conformity.ts` ships
    // to consumers and the rule document does not, so a pointer that fired
    // unconditionally would send every consumer to a path that does not
    // resolve in their repo — and no test of theirs or ours would catch it.
    const root = plant({ withRuleDoc: false });
    try {
      expect(ruleDocPointer(root), "a consumer was pointed at a file it does not have").toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("this repo is a root that carries it, so the case above is not the only live one", () => {
    // Non-vacuity against the real tree. Both planted cases could pass with a
    // broken existence probe if nothing ever asked it about a real checkout.
    expect(ruleDocPointer(REPO)).toContain(SELF_REFERENTIAL_RULES);
  });
});

describe("#813: a remedy message says what is wrong, what to do, and where the family is", () => {
  test("all three parts are present when the document is", () => {
    const root = plant({ withRuleDoc: true });
    try {
      const msg = remedyMessage({
        root,
        check: "HYGIENE-99",
        violations: ["specs/NEW-SPEC.md"],
        fix: "add a row to the routing table",
      });
      expect(msg, "the check is not named").toContain("HYGIENE-99");
      expect(msg, "the violation is not named").toContain("specs/NEW-SPEC.md");
      expect(msg, "the remedy is not stated").toContain("add a row to the routing table");
      expect(msg, "the family is not routed to").toContain(SELF_REFERENTIAL_RULES);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the same call without the document keeps the remedy and drops only the pointer", () => {
    // One input, one difference. The remedy is the part a consumer needs and
    // must survive; the pointer is the part that must not.
    const root = plant({ withRuleDoc: false });
    try {
      const msg = remedyMessage({
        root,
        check: "HYGIENE-99",
        violations: ["specs/NEW-SPEC.md"],
        fix: "add a row to the routing table",
      });
      expect(msg, "the consumer lost the remedy too").toContain("add a row to the routing table");
      expect(msg, "a consumer was routed at a file it does not have").not.toContain(
        SELF_REFERENTIAL_RULES,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The checks the rule document's Tier 1 names, and the file each is asserted
 * in. Banked here so that REMOVING a remedy is a failure, not a silence.
 *
 * Adding a row without wiring the check fails this file, which is the
 * intended order: the row is the claim, the wiring is what makes it true.
 */
const TIER_1 = [
  { file: "lib/conformity.ts", check: "DRIFT-2" },
  { file: "lib/conformity.ts", check: "DRIFT-2 (stale exemption)" },
  { file: "lib/conformity.ts", check: "HYGIENE-3" },
  { file: "lib/conformity.ts", check: "HYGIENE-3 (stale exemption)" },
  { file: "lib/conformity.ts", check: "HYGIENE-4" },
  { file: "test/package-closure.test.ts", check: "CLOSURE-1" },
  { file: "test/package-closure.test.ts", check: "CLOSURE-8" },
  { file: "test/agents-md-spec-listing.test.ts", check: "SC-1891" },
];

/**
 * The `check:` value of every `remedyMessage(...)` call site in a file.
 *
 * A call site is counted only when an `expect(` opens within the 200
 * characters before it. Composing a message and never asserting it would
 * otherwise satisfy this guard while the check still failed with nothing —
 * the cheapest wrong way to go green here, and the one worth closing.
 */
function routedChecks(relPath: string): string[] {
  const src = stripJsComments(readFileSync(join(REPO, relPath), "utf-8"));
  const found: string[] = [];
  const CALL = "remedyMessage(";
  for (let i = src.indexOf(CALL); i !== -1; i = src.indexOf(CALL, i + 1)) {
    if (!src.slice(Math.max(0, i - 200), i).includes("expect(")) continue;
    const field = /check:\s*"([^"]+)"/.exec(src.slice(i, i + 600));
    if (field) found.push(field[1]!);
  }
  return found;
}

describe("#813: every Tier 1 check carries a remedy, and losing one is red", () => {
  test("the scan finds call sites at all, or every row below passes over nothing", () => {
    const total = [...new Set(TIER_1.map(r => r.file))]
      .flatMap(f => routedChecks(f))
      .length;
    expect(total, "no remedyMessage call site was found in any file — the scan is broken").toBe(
      TIER_1.length,
    );
  });

  for (const { file, check } of TIER_1) {
    test(`${check} in ${file} routes to the rule document`, () => {
      expect(
        routedChecks(file),
        `${check} asserts with no remedy, so its failure tells the next agent nothing`,
      ).toContain(check);
    });
  }

  test("the population is not empty", () => {
    // A `for` loop over an empty array declares zero tests and reports green.
    expect(TIER_1.length).toBeGreaterThan(5);
  });
});
