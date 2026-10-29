/**
 * A freshness stamp alone never justifies a rewrite (#1647).
 *
 * `carryUpdatedStamp` is the single binding for "may `updated:` move", and it
 * lives at the write site because that is the first point holding the FINAL
 * bytes of an owned file. The fix it replaces made the same decision one
 * stage too early and was therefore always wrong — see the function's
 * docblock.
 *
 * ## What was broken to prove these can fail
 *
 * Two mutations, measured on 2026-10-29 against an 11-pass baseline:
 *
 *   `return generated`  (the carry never happens)        5 red
 *   `return existing`   (the plausible WRONG fix)        3 red
 *   restored                                             0 red
 *
 * The second row is the one worth having. A function that always returned
 * `existing` satisfies every case under *the stamp is carried* and is still
 * wrong — it would discard a genuine regeneration. The cases under *the
 * stamp is NOT carried* exist to refuse it, and they do.
 */
import { describe, expect, test } from "bun:test";
import { carryUpdatedStamp } from "../lib/scaffold/owned-files";

const doc = (stamp: string, body = "# T\n\nprose\n") =>
  `---\ndoc-type: reference\nstatus: active\nupdated: ${stamp}\n---\n\n${body}`;

describe("#1647: carryUpdatedStamp — a stamp alone never justifies a rewrite", () => {
  describe("the stamp IS carried, because nothing else moved", () => {
    test("identical bodies, different stamps: the committed stamp wins", () => {
      expect(carryUpdatedStamp(doc("2026-10-20"), doc("2026-10-29"))).toBe(doc("2026-10-20"));
    });

    test("and the result is then byte-identical, which is what makes it `unchanged`", () => {
      const existing = doc("2026-10-20");
      expect(carryUpdatedStamp(existing, doc("2026-10-29"))).toBe(existing);
    });

    test("a stamp moving BACKWARDS is carried too — the rule is about change, not recency", () => {
      expect(carryUpdatedStamp(doc("2026-10-29"), doc("2026-10-20"))).toBe(doc("2026-10-29"));
    });

    test("the real shape: a preserved section the generator never emits", () => {
      // AGENTS.md is written `section-preserving`, so the final bytes carry
      // `## Hard Constraints` and the generator's body does not. This is the
      // document the old comparison could not see, and the reason it never
      // fired. Measured 3,357 bytes against 1,352 on `aa7bc0c0`.
      const body = "# rungate\n\n## Hard Constraints\n\nSeven rules.\n\n## Workflow\n\n- Test\n";
      expect(carryUpdatedStamp(doc("2026-10-28", body), doc("2026-10-29", body))).toBe(
        doc("2026-10-28", body),
      );
    });
  });

  describe("the stamp is NOT carried, because the content genuinely changed", () => {
    test("a body difference keeps the generator's today", () => {
      const generated = doc("2026-10-29", "# T\n\nprose, revised\n");
      expect(carryUpdatedStamp(doc("2026-10-20"), generated)).toBe(generated);
    });

    test("a one-character body difference is still a difference", () => {
      const generated = doc("2026-10-29", "# T\n\nprose.\n");
      expect(carryUpdatedStamp(doc("2026-10-20"), generated)).toBe(generated);
    });

    test("another frontmatter key changing keeps today, even with the body equal", () => {
      const existing = `---\nstatus: draft\nupdated: 2026-10-20\n---\n\n# T\n`;
      const generated = `---\nstatus: active\nupdated: 2026-10-29\n---\n\n# T\n`;
      expect(carryUpdatedStamp(existing, generated)).toBe(generated);
    });
  });

  describe("the readings that are not a carry at all", () => {
    test("no existing file: nothing to carry", () => {
      const generated = doc("2026-10-29");
      expect(carryUpdatedStamp(null, generated)).toBe(generated);
    });

    test("existing declares no stamp: a missing stamp is not evidence of freshness", () => {
      const existing = `---\nstatus: active\n---\n\n# T\n\nprose\n`;
      const generated = doc("2026-10-29");
      expect(carryUpdatedStamp(existing, generated)).toBe(generated);
    });

    test("generated declares no stamp: there is nothing to substitute into", () => {
      const generated = `---\nstatus: active\n---\n\n# T\n\nprose\n`;
      expect(carryUpdatedStamp(doc("2026-10-20"), generated)).toBe(generated);
    });

    test("only the FIRST stamp line is treated as the stamp, so a body mentioning one is safe", () => {
      // A document whose prose contains `updated: …` at the start of a line
      // must not have that line rewritten. `String.replace` with a non-global
      // regex touches the first match only, which is the frontmatter's.
      const body = "# T\n\nupdated: 2026-01-01 is a date in the prose\n";
      expect(carryUpdatedStamp(doc("2026-10-20", body), doc("2026-10-29", body))).toBe(
        doc("2026-10-20", body),
      );
    });
  });
});
