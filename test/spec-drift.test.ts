import { resolve } from "path";
import { describe, test, expect } from "bun:test";
import { runSpecDrift } from "../lib/conformity";
import { checkAutoTestStaleness } from "../lib/spec-change-conformity";

const ROOT = resolve(import.meta.dir, "..");
runSpecDrift(ROOT);

// AC-3: Staleness detection for auto-generated spec-compliance tests
describe("auto-generated test staleness", () => {
  test("spec-compliance-auto.test.ts is not stale relative to source specs", () => {
    const result = checkAutoTestStaleness(ROOT);
    if (result.stale) {
      throw new Error(
        `spec-compliance-auto.test.ts is stale: ${result.reason}. ` +
        `Regenerate with: bun scripts/sync-spec-tests.ts`
      );
    }
    expect(result.stale).toBe(false);
  });
});
