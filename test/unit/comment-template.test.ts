/**
 * `hooks/lib/comment-template.ts` — the issue-comment template rules.
 *
 * These rules shipped inside IssueCloseGuard with no coverage. Extracting
 * them (SC-371, 150-line hook cap) made that visible: two mutations against
 * the moved code — neutering the whole validator, and deleting the
 * ACs-in-comments rule — both ran green against the existing 26
 * IssueCloseGuard tests. Nothing was testing any of it.
 *
 * Tested as functions. The hook's own tests drive a subprocess, which is
 * right for the block/permit decision and needlessly slow for a set of
 * string rules.
 */

import { describe, test, expect } from "bun:test";
import { commentTemplateViolation, extractCommentBody, TEMPLATE_RULES } from "../../hooks/lib/comment-template";

const comment = (body: string) => `gh issue comment 23 --body "${body}"`;

describe("extractCommentBody", () => {
  test("reads a quoted --body", () => {
    expect(extractCommentBody(`gh issue comment 1 --body "hello"`)).toBe("hello");
  });

  test("reads the -b short form", () => {
    expect(extractCommentBody(`gh issue comment 1 -b 'hello'`)).toBe("hello");
  });

  test("reads a heredoc body", () => {
    const cmd = `gh issue comment 1 --body "$(cat <<'EOF'\nline one\nline two\nEOF\n)"`;
    expect(extractCommentBody(cmd)).toBe("line one\nline two");
  });

  test("returns empty when there is no body, so the rules stay out of the way", () => {
    expect(extractCommentBody(`gh issue comment 1`)).toBe("");
  });
});

describe("commentTemplateViolation", () => {
  test("a comment with no body is allowed", () => {
    expect(commentTemplateViolation(`gh issue comment 1`)).toBeNull();
  });

  test("ordinary prose is allowed", () => {
    expect(commentTemplateViolation(comment("Looks good, merging."))).toBeNull();
  });

  test("ACs belong in the issue body, not a comment", () => {
    const v = commentTemplateViolation(`gh issue comment 1 --body "$(cat <<'EOF'\n## AC-1 something\nEOF\n)"`);
    expect(v).toContain("gh issue edit --body");
  });

  test("prose merely mentioning an AC is still caught, by the field rule", () => {
    // Pinning actual behaviour, which surprised me when I asserted the
    // opposite. The dedicated AC rule is line-anchored (`/^## AC-\d+/m`), so
    // mid-line prose escapes it — but the TEMPLATE_RULES loop below matches
    // with a plain `includes('## AC-')`, which is not anchored, so the
    // comment is refused for missing fields instead.
    //
    // Over-strict: "fixed the ## AC-1 threshold" is a sentence, not a posted
    // AC. Left as-is because changing it is a behaviour decision outside
    // #139/#140, and recorded here so the next person sees it is known
    // rather than rediscovering it as a bug.
    const v = commentTemplateViolation(comment("fixed the ## AC-1 threshold"));
    expect(v).toContain("missing fields");
  });

  test.each([
    ["### Docs read without the DISCOVERY heading", "### Docs read", "DISCOVERY"],
    ["### Evidence per AC without the Completion Report heading", "### Evidence per AC", "Completion Report"],
    ["an unfilled placeholder", "REPLACE: your text", "REPLACE:"],
  ])("%s is refused", (_label, body, expected) => {
    expect(commentTemplateViolation(comment(body))).toContain(expected);
  });

  test("a fragment inside its own section is allowed", () => {
    const body = "## DISCOVERY\\n### Docs read\\n- x\\n### Issue context\\n- y";
    expect(commentTemplateViolation(comment(body))).toBeNull();
  });

  describe("every template's required fields are enforced", () => {
    // Table-driven off TEMPLATE_RULES itself so a rule added later cannot
    // quietly ship unchecked — the loop grows with the list.
    test.each(TEMPLATE_RULES.map(r => [r.marker, r] as const))(
      "%s reports each missing field",
      (_marker, rule) => {
        const v = commentTemplateViolation(comment(rule.marker));
        expect(v, `"${rule.marker}" with no fields was allowed`).not.toBeNull();
        for (const field of rule.required) {
          expect(v, `"${field}" was not reported missing`).toContain(field);
        }
      },
    );

    test.each(TEMPLATE_RULES.map(r => [r.marker, r] as const))(
      "%s is allowed once every field is present",
      (_marker, rule) => {
        // Skip the two markers that trip an earlier, unconditional rule —
        // those are covered above and cannot reach the field check.
        if (rule.marker === "## AC-" || rule.marker === "## Completion Report") return;
        const body = [rule.marker, ...rule.required].join(" ");
        expect(commentTemplateViolation(comment(body))).toBeNull();
      },
    );
  });

  test("a marker that is absent is not checked for fields", () => {
    expect(commentTemplateViolation(comment("## ATTEMPT Approach: a Files Changed: b Result: c Evidence: d Why It Failed: e"))).toBeNull();
    expect(commentTemplateViolation(comment("nothing to do with templates"))).toBeNull();
  });
});
