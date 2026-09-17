import { test, expect, describe } from "bun:test";
import { classifyFailures, type FailureCategory, type Classification } from "./error-classifier";

function fail(check: string, detail = ""): { check: string; result: string; detail: string } {
  return { check, result: "FAIL", detail };
}

describe("error-classifier", () => {
  describe("STATE category", () => {
    test("workflow-state.json validates", () => {
      const c = classifyFailures([fail("workflow-state.json validates", "schema error")]);
      expect(c.category).toBe("STATE");
      expect(c.retryable).toBe(true);
      expect(c.regressionTarget).toBeUndefined();
    });

    test("sourceSpecs-required", () => {
      const c = classifyFailures([fail("sourceSpecs-required")]);
      expect(c.category).toBe("STATE");
    });

    test("discovery-evidence", () => {
      const c = classifyFailures([fail("discovery-evidence")]);
      expect(c.category).toBe("STATE");
    });

    test("spec-elements-in-acs", () => {
      const c = classifyFailures([fail("spec-elements-in-acs")]);
      expect(c.category).toBe("STATE");
    });

    test("no 'DA should'", () => {
      const c = classifyFailures([fail("no 'DA should'")]);
      expect(c.category).toBe("STATE");
    });

    test("checks containing threshold", () => {
      const c = classifyFailures([fail("weak-threshold-check")]);
      expect(c.category).toBe("STATE");
    });

    test("checks containing statement", () => {
      const c = classifyFailures([fail("statement-length-check")]);
      expect(c.category).toBe("STATE");
    });

    test("checks containing schema", () => {
      const c = classifyFailures([fail("schema-version-check")]);
      expect(c.category).toBe("STATE");
    });
  });

  describe("CODE category", () => {
    test("tests-pass", () => {
      const c = classifyFailures([fail("tests-pass", "3 tests failed")]);
      expect(c.category).toBe("CODE");
      expect(c.retryable).toBe(true);
      expect(c.regressionTarget).toBe("BUILD");
    });

    test("tsc-pass", () => {
      const c = classifyFailures([fail("tsc-pass", "type errors")]);
      expect(c.category).toBe("CODE");
      expect(c.regressionTarget).toBe("BUILD");
    });

    test("code-committed", () => {
      const c = classifyFailures([fail("code-committed")]);
      expect(c.category).toBe("CODE");
      expect(c.regressionTarget).toBe("BUILD");
    });

    test("brief-ac-alignment", () => {
      const c = classifyFailures([fail("brief-ac-alignment")]);
      expect(c.category).toBe("CODE");
      expect(c.regressionTarget).toBe("BUILD");
    });
  });

  describe("DISCOVERY category", () => {
    test("ac-issue-alignment", () => {
      const c = classifyFailures([fail("ac-issue-alignment")]);
      expect(c.category).toBe("DISCOVERY");
      expect(c.retryable).toBe(true);
      expect(c.regressionTarget).toBe("DISCOVERY");
    });

    test("issue-goal-captured", () => {
      const c = classifyFailures([fail("issue-goal-captured")]);
      expect(c.category).toBe("DISCOVERY");
      expect(c.regressionTarget).toBe("DISCOVERY");
    });

    test("sizing-declared", () => {
      const c = classifyFailures([fail("sizing-declared")]);
      expect(c.category).toBe("DISCOVERY");
      expect(c.regressionTarget).toBe("DISCOVERY");
    });
  });

  describe("ENVIRONMENT category", () => {
    test("container-has-fix", () => {
      const c = classifyFailures([fail("container-has-fix")]);
      expect(c.category).toBe("ENVIRONMENT");
      expect(c.retryable).toBe(true);
      expect(c.regressionTarget).toBeUndefined();
    });

    test("local-api-validated", () => {
      const c = classifyFailures([fail("local-api-validated")]);
      expect(c.category).toBe("ENVIRONMENT");
    });

    test("local-ui-validated", () => {
      const c = classifyFailures([fail("local-ui-validated")]);
      expect(c.category).toBe("ENVIRONMENT");
    });

    test("prod-rebuild-pass", () => {
      const c = classifyFailures([fail("prod-rebuild-pass")]);
      expect(c.category).toBe("ENVIRONMENT");
    });

    test("prod-smoke-pass", () => {
      const c = classifyFailures([fail("prod-smoke-pass")]);
      expect(c.category).toBe("ENVIRONMENT");
    });

    test("prod-quinn-pass", () => {
      const c = classifyFailures([fail("prod-quinn-pass")]);
      expect(c.category).toBe("ENVIRONMENT");
    });

    test("code-pushed", () => {
      const c = classifyFailures([fail("code-pushed")]);
      expect(c.category).toBe("ENVIRONMENT");
    });

    test("branch-merged", () => {
      const c = classifyFailures([fail("branch-merged")]);
      expect(c.category).toBe("ENVIRONMENT");
    });
  });

  describe("NON_RETRYABLE category", () => {
    test("failure containing auth", () => {
      const c = classifyFailures([fail("github-auth-check", "auth token expired")]);
      expect(c.category).toBe("NON_RETRYABLE");
      expect(c.retryable).toBe(false);
      expect(c.regressionTarget).toBeUndefined();
    });

    test("failure containing credential", () => {
      const c = classifyFailures([fail("credential-check", "no credentials")]);
      expect(c.category).toBe("NON_RETRYABLE");
    });

    test("failure containing permission", () => {
      const c = classifyFailures([fail("permission-denied", "insufficient")]);
      expect(c.category).toBe("NON_RETRYABLE");
    });

    test("failure containing timeout", () => {
      const c = classifyFailures([fail("api-timeout", "30s exceeded")]);
      expect(c.category).toBe("NON_RETRYABLE");
    });

    test("unknown check defaults to NON_RETRYABLE", () => {
      const c = classifyFailures([fail("totally-unknown-check-xyz")]);
      expect(c.category).toBe("NON_RETRYABLE");
      expect(c.retryable).toBe(false);
    });
  });

  describe("priority ordering", () => {
    test("NON_RETRYABLE beats everything", () => {
      const c = classifyFailures([
        fail("tests-pass"),             // CODE
        fail("api-timeout"),            // NON_RETRYABLE
        fail("container-has-fix"),      // ENVIRONMENT
      ]);
      expect(c.category).toBe("NON_RETRYABLE");
      expect(c.retryable).toBe(false);
      expect(c.failures).toHaveLength(3);
    });

    test("DISCOVERY beats CODE", () => {
      const c = classifyFailures([
        fail("tests-pass"),             // CODE
        fail("ac-issue-alignment"),     // DISCOVERY
      ]);
      expect(c.category).toBe("DISCOVERY");
      expect(c.regressionTarget).toBe("DISCOVERY");
    });

    test("CODE beats STATE", () => {
      const c = classifyFailures([
        fail("workflow-state.json validates"),  // STATE
        fail("tsc-pass"),                       // CODE
      ]);
      expect(c.category).toBe("CODE");
      expect(c.regressionTarget).toBe("BUILD");
    });

    test("STATE beats ENVIRONMENT", () => {
      const c = classifyFailures([
        fail("container-has-fix"),              // ENVIRONMENT
        fail("sourceSpecs-required"),           // STATE
      ]);
      expect(c.category).toBe("STATE");
    });

    test("all categories mixed picks NON_RETRYABLE", () => {
      const c = classifyFailures([
        fail("container-has-fix"),              // ENVIRONMENT
        fail("sourceSpecs-required"),           // STATE
        fail("tests-pass"),                     // CODE
        fail("ac-issue-alignment"),             // DISCOVERY
        fail("permission-check"),               // NON_RETRYABLE
      ]);
      expect(c.category).toBe("NON_RETRYABLE");
      expect(c.failures).toHaveLength(5);
    });
  });

  describe("edge cases", () => {
    test("empty failures array", () => {
      const c = classifyFailures([]);
      expect(c.category).toBe("NON_RETRYABLE");
      expect(c.retryable).toBe(false);
      expect(c.failures).toHaveLength(0);
    });

    test("single failure preserves detail", () => {
      const c = classifyFailures([fail("tests-pass", "AssertionError in foo.test.ts")]);
      expect(c.failures[0].detail).toBe("AssertionError in foo.test.ts");
    });

    test("NON_RETRYABLE keyword in detail field does not trigger", () => {
      const c = classifyFailures([fail("tests-pass", "auth module test failed")]);
      expect(c.category).toBe("CODE");
    });

    test("case-insensitive NON_RETRYABLE check matching", () => {
      const c = classifyFailures([fail("AUTH-TOKEN-EXPIRED")]);
      expect(c.category).toBe("NON_RETRYABLE");
    });
  });
});
