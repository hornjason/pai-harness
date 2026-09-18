import { z } from "zod";

const BEHAVIORAL_PATTERN = /\b(DA should|remember to|make sure to|don't forget)\b/i;

const GARBAGE_PATTERNS = [
  /^file exists?$/i,
  /^it works?$/i,
  /^code is (?:correct|good|done|working)$/i,
  /^(?:the )?(?:feature|function|code|system) (?:works?|exists?|is (?:done|complete))$/i,
  /^no errors?$/i,
  /^tests? pass(?:es)?$/i,
  /^changes? (?:are )?(?:made|applied|done)$/i,
];

export const THRESHOLD_OPS = ["==", ">=", "<=", ">", "<", "!=", "contains", "exists"] as const;
export const EVIDENCE_METHOD_TYPES = ["GREP_CHECK", "FILE_EXISTS", "CURL_CHECK", "BUN_TEST", "SCREENSHOT", "PLAYWRIGHT", "COMMAND", "MANUAL", "grep", "command", "api", "screenshot", "manual"] as const;

export const ThresholdSchema = z.object({
  op: z.enum(THRESHOLD_OPS),
  value: z.union([z.string(), z.number()]),
  unit: z.string().optional(),
});

export const EvidenceMethodSchema = z.object({
  type: z.enum(EVIDENCE_METHOD_TYPES),
  command: z.string().optional(),
});

export const EvidenceSchema = z.object({
  type: z.enum(["file-citation", "grep-output", "api-response", "screenshot", "test-output", "command-output", "manual-attestation"]),
  content: z.string().optional(),
  value: z.number().nullable().optional(),
  url: z.string().nullable().optional(),
}).nullable().optional();

export const ContextFileSchema = z.object({
  path: z.string(),
  lines: z.string().optional(),
  reason: z.string().optional(),
});

export const ACSchema = z.object({
  id: z.string(),
  type: z.enum(["CODE", "OUTCOME"]).optional(),
  statement: z.string(),
  specElement: z.string().optional(),
  threshold: ThresholdSchema.optional(),
  evidenceMethod: EvidenceMethodSchema.optional(),
  contextFiles: z.array(ContextFileSchema).optional(),
  evidence: EvidenceSchema,
  verdict: z.enum(["PENDING", "PASS", "FAIL", "SKIP"]).optional(),
}).superRefine((ac, ctx) => {
  if (!ac.threshold) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${ac.id}: missing threshold`, path: ["threshold"] });
  }
  if (BEHAVIORAL_PATTERN.test(ac.statement)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${ac.id}: behavioral language "${ac.statement.match(BEHAVIORAL_PATTERN)?.[0]}"`, path: ["statement"] });
  }
  // Heuristic: minimum statement length (5 words)
  const words = ac.statement.split(/\s+/).filter(Boolean);
  if (words.length < 5) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${ac.id}: statement too short (${words.length} words, min 5)`,
      path: ["statement"],
    });
  }
  // Heuristic: garbage/tautological statement detection
  for (const pattern of GARBAGE_PATTERNS) {
    if (pattern.test(ac.statement.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${ac.id}: tautological/garbage statement "${ac.statement}"`,
        path: ["statement"],
      });
      break;
    }
  }
  // Heuristic: weak threshold detection
  if (ac.threshold) {
    const numVal = Number(ac.threshold.value);
    if (ac.threshold.op === ">=" && !isNaN(numVal) && numVal <= 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${ac.id}: threshold too weak (${ac.threshold.op} ${ac.threshold.value}) — effectively always passes`,
        path: ["threshold"],
      });
    }
  }
});

export const SourceSpecSchema = z.object({
  path: z.string(),
  citedInDiscovery: z.boolean(),
  specElements: z.array(z.string()).optional(),
});

export const AgentSchema = z.object({
  spawned: z.boolean().optional(),
  verdict: z.enum(["PASS", "FAIL", "SKIP"]).nullable().optional(),
  branch: z.string().optional(),
  iterations: z.number().optional(),
  comparedToSpec: z.boolean().optional(),
  screenshots: z.array(z.string()).optional(),
  findings: z.string().nullable().optional(),
  testedSha: z.string().optional(),
  testedPaths: z.array(z.string()).optional(),
  port: z.number().optional(),
}).optional();

export const EnvironmentLocalSchema = z.object({
  api: z.enum(["PASS", "FAIL", "SKIP"]).nullable().optional(),
  apiSkipReason: z.string().optional(),
  ui: z.enum(["PASS", "FAIL", "SKIP"]).nullable().optional(),
  uiSkipReason: z.string().optional(),
  tests: z.enum(["PASS", "FAIL", "SKIP"]).nullable().optional(),
  quinn: z.object({
    port: z.number().optional(),
  }).optional(),
}).optional();

export const EnvironmentProdSchema = z.object({
  rebuild: z.enum(["PASS", "FAIL", "SKIP"]).nullable().optional(),
  rebuildSkipReason: z.string().nullable().optional(),
  smoke: z.enum(["PASS", "FAIL", "SKIP"]).nullable().optional(),
  smokeSkipReason: z.string().nullable().optional(),
  quinn: z.enum(["PASS", "FAIL", "SKIP"]).nullable().optional(),
  quinnSkipReason: z.string().nullable().optional(),
  quinnSpot: z.enum(["PASS", "FAIL", "SKIP"]).nullable().optional(),
  quinnSpotSkipReason: z.string().optional(),
}).optional();

export const GateResultSchema = z.object({
  result: z.enum(["PASS", "FAIL"]).nullable().optional(),
  attempt: z.number().optional(),
  failures: z.array(z.any()).optional(),
  ts: z.string().optional(),
  commitSha: z.string().optional(),
}).optional();

export const PhaseTimingEntry = z.object({
  enteredTs: z.string(),
  exitedTs: z.string().optional(),
  iteration: z.number().optional(),
  source: z.enum(["gate-runner", "DA"]),
});

export const ChangelogEntry = z.object({
  ts: z.string(),
  event: z.string(),
  detail: z.string().optional(),
  phase: z.string().optional(),
  actor: z.enum(["da", "marcus", "quinn", "rook", "gate-runner", "ship-workflow"]).optional(),
});

export const WorkflowStateSchema = z.object({
  schemaVersion: z.literal(2),
  issue: z.number(),
  repo: z.string().optional(),
  issueRepo: z.string().optional(),
  projectRoot: z.string().optional(),
  slug: z.string(),
  phase: z.enum(["GOAL", "DISCOVERY", "SCOPE", "BUILD", "VERIFY", "SHIP", "DONE", "CIRCUIT_BREAK"]),
  issueGoal: z.string().min(1, "issueGoal cannot be empty"),

  sourceSpecs: z.array(SourceSpecSchema).optional(),

  sizing: z.object({
    predicted: z.enum(["XS", "S", "M", "L"]).optional(),
    ceremonyTier: z.enum(["LIGHT", "STANDARD", "THOROUGH"]).optional(),
    actualFiles: z.number().optional(),
    actualMinutes: z.number().optional(),
  }).optional(),

  acs: z.array(ACSchema),

  governingSpec: z.object({
    path: z.string(),
    detectedFrom: z.string().optional(),
  }).optional(),

  agents: z.object({
    marcus: AgentSchema,
    quinn: AgentSchema,
    rook: AgentSchema,
  }).optional(),

  environments: z.object({
    local: EnvironmentLocalSchema,
    prod: EnvironmentProdSchema,
  }).optional(),

  gates: z.object({
    scope: GateResultSchema,
    verify: GateResultSchema,
    ship: GateResultSchema,
  }).optional(),

  daDirectEdits: z.number().optional(),
  iterationCount: z.number().optional(),
  startTs: z.string().optional(),
  updatedTs: z.string().optional(),

  phaseTimings: z.record(z.string(), z.array(PhaseTimingEntry)).optional(),

  gateContract: z.object({
    environments: z.any().optional(),
    verdicts: z.any().optional(),
    evidence: z.any().optional(),
    baselines: z.object({
      testBaseline: z.number().optional(),
      tscBaseline: z.number().optional(),
    }).optional(),
  }).optional(),

  changelog: z.array(ChangelogEntry).optional(),

  verifyBlockers: z.array(z.object({
    id: z.string(),
    description: z.string(),
    fixCommit: z.string().optional(),
    quinnReverified: z.boolean().default(false),
  })).optional(),

  bootstrappedFrom: z.string().optional(),
  beforeState: z.object({
    type: z.enum(["text", "screenshot", "api", "data", "none"]),
    path: z.string().nullable(),
    capturedAt: z.string(),
    description: z.string().optional(),
  }).optional(),
});

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

// ── AFK batch plan schema (#468) ────────────────────────────

const REJECTED_SKIP_REASONS = [
  "needs investigation",
  "needs browser testing",
  "can't do from here",
];

export const AfkBatchPlanSchema = z.object({
  approvedAt: z.string(),
  planned: z.array(z.number()),
  shipped: z.array(z.number()),
  skipped: z.array(z.object({
    issue: z.number(),
    reason: z.string(),
    delegationAction: z.string().optional(),
  })),
  inProgress: z.number().nullable(),
});

export type AfkBatchPlan = z.infer<typeof AfkBatchPlanSchema>;

export { REJECTED_SKIP_REASONS };

// ── Adversary report schema (ADR-009 B1) ──────────────────────

export const AdversaryReportSchema = z.object({
  gameable: z.number(),
  approved: z.boolean(),
  exploits: z.array(z.object({
    acId: z.string(),
    exploit: z.string(),
    recommendation: z.string(),
  })),
});

// ── Chain artifact schemas ──────────────────────────────────

export const GoalRecordSchema = z.object({
  contractVersion: z.string(),
  id: z.string(),
  goalStatement: z.string().min(1),
  governingSpec: z.object({
    path: z.string(),
    detectedFrom: z.string().optional(),
  }).optional(),
  successCriteria: z.array(z.object({
    id: z.string(),
    assertion: z.string(),
    evidenceType: z.string(),
    threshold: z.object({ op: z.string(), value: z.string(), unit: z.string().optional() }),
  })),
  scopeBoundary: z.object({ in: z.array(z.string()), out: z.array(z.string()) }).optional(),
  artifactRef: z.object({ type: z.string(), locator: z.string() }).optional(),
});

export const ShipEvidenceSchema = z.object({
  contractVersion: z.string(),
  issueNumber: z.number(),
  gateOut: z.object({
    status: z.enum(["PASS", "FAIL"]),
    evidence: z.array(z.object({
      criterion: z.string(),
      result: z.enum(["PASS", "FAIL", "SKIP"]),
      detail: z.any().optional(),
    })),
  }),
  mergeCommitSha: z.string().optional(),
  capturedAt: z.string(),
  iterationCount: z.number().optional(),
  sizing: z.object({ predicted: z.string().optional(), actual: z.string().optional() }).optional(),
});

export const ProveEvidenceSchema = z.object({
  issueNumber: z.number(),
  verdict: z.enum(["PROVEN", "UNPROVEN", "INCONCLUSIVE"]),
  commitSHA: z.string(),
  capturedAt: z.string(),
  beforeEvidence: z.object({
    type: z.enum(["text", "screenshot", "api", "data", "none"]),
    path: z.string().nullable(),
    capturedAt: z.string(),
    description: z.string(),
  }),
  afterEvidence: z.object({
    type: z.enum(["text", "screenshot", "api", "data", "none"]),
    path: z.string().nullable(),
    capturedAt: z.string(),
    environment: z.enum(["local", "prod"]),
    description: z.string(),
  }),
  comparisonSummary: z.string(),
  quinnVerdict: z.enum(["PASS", "FAIL", "SKIP"]).optional(),
  reproduced: z.boolean(),
  gaps: z.array(z.object({ ac: z.string(), status: z.string(), detail: z.string() })).optional(),
});
