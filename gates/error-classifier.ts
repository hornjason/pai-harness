export type FailureCategory = "STATE" | "CODE" | "DISCOVERY" | "ENVIRONMENT" | "NON_RETRYABLE";

export interface Classification {
  category: FailureCategory;
  regressionTarget?: "BUILD" | "DISCOVERY";
  retryable: boolean;
  failures: Array<{ check: string; result: string; detail: string }>;
}

const PRIORITY: FailureCategory[] = ["NON_RETRYABLE", "DISCOVERY", "CODE", "STATE", "ENVIRONMENT"];

const STATE_CHECKS = new Set([
  "workflow-state.json validates",
  "sourceSpecs-required",
  "discovery-evidence",
  "spec-elements-in-acs",
  "no 'DA should'",
]);

const CODE_CHECKS = new Set([
  "tests-pass",
  "tsc-pass",
  "code-committed",
  "brief-ac-alignment",
]);

const DISCOVERY_CHECKS = new Set([
  "ac-issue-alignment",
  "issue-goal-captured",
  "sizing-declared",
]);

const ENVIRONMENT_CHECKS = new Set([
  "container-has-fix",
  "local-api-validated",
  "local-ui-validated",
  "prod-rebuild-pass",
  "prod-smoke-pass",
  "prod-quinn-pass",
  "code-pushed",
  "branch-merged",
]);

const STATE_KEYWORDS = ["threshold", "statement", "schema"];
const NON_RETRYABLE_KEYWORDS = ["auth", "credential", "permission", "timeout"];

function categorizeCheck(check: string): FailureCategory {
  const lower = check.toLowerCase();

  if (NON_RETRYABLE_KEYWORDS.some((kw) => lower.includes(kw))) return "NON_RETRYABLE";
  if (STATE_CHECKS.has(check)) return "STATE";
  if (CODE_CHECKS.has(check)) return "CODE";
  if (DISCOVERY_CHECKS.has(check)) return "DISCOVERY";
  if (ENVIRONMENT_CHECKS.has(check)) return "ENVIRONMENT";
  if (STATE_KEYWORDS.some((kw) => lower.includes(kw))) return "STATE";

  return "NON_RETRYABLE";
}

const CATEGORY_META: Record<FailureCategory, { retryable: boolean; regressionTarget?: "BUILD" | "DISCOVERY" }> = {
  STATE: { retryable: true },
  CODE: { retryable: true, regressionTarget: "BUILD" },
  DISCOVERY: { retryable: true, regressionTarget: "DISCOVERY" },
  ENVIRONMENT: { retryable: true },
  NON_RETRYABLE: { retryable: false },
};

export function classifyFailures(
  failures: Array<{ check: string; result: string; detail: string }>,
): Classification {
  if (failures.length === 0) {
    return { category: "NON_RETRYABLE", retryable: false, failures: [] };
  }

  const categories = new Set<FailureCategory>();
  for (const f of failures) {
    categories.add(categorizeCheck(f.check));
  }

  const winner = PRIORITY.find((p) => categories.has(p)) ?? "NON_RETRYABLE";
  const meta = CATEGORY_META[winner];

  return {
    category: winner,
    retryable: meta.retryable,
    regressionTarget: meta.regressionTarget,
    failures,
  };
}
