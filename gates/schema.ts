import { z } from "zod";

// ── Gate contract interfaces (SC-373) ─────────────────────────────────────

export interface SchemaValidateInput {
  state: Record<string, unknown>;
}

export interface SchemaValidateResult {
  valid: boolean;
  issues: Array<{ path: string; message: string }>;
}

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

const AgentShape = {
  spawned: z.boolean().optional(),
  verdict: z.enum(["PASS", "FAIL", "SKIP"]).nullable().optional(),
  branch: z.string().optional(),
  iterations: z.number().optional(),
  comparedToSpec: z.boolean().optional(),
  screenshots: z.array(z.string()).optional(),
  findings: z.string().nullable().optional(),
  // One entry per blocking problem the agent found. Declared explicitly because
  // Zod strips undeclared keys: without this line a rook FAIL round-trips through
  // the schema as a verdict with no reasons attached. A FAIL verdict must carry a
  // non-empty list (see gates/SCHEMA-GUIDE.md).
  failures: z.array(z.string()).optional(),
  testedSha: z.string().optional(),
  testedPaths: z.array(z.string()).optional(),
  port: z.number().optional(),
};

export const AgentSchema = z.object(AgentShape).optional();

// ── The security review's re-review cap (#171) ────────────────────────────
//
// A remediation committed after the security review leaves the run holding a
// verdict for code it no longer ships (#169). The answer is to re-review the
// new tip, and that loop — remediate, re-review, remediate — is capped.
//
// Spending the cap is its OWN outcome. The run ends with code nobody reviewed,
// which is the exact thing the #129 gate exists to stop, so it may not
// serialise to anything a reader can mistake for either of the other two: not
// "rook looked and found nothing" (a PASS), and not "rook found something" (a
// FAIL carrying findings). It gets its own verdict member and its own named
// refusal, and the superRefine below makes the three mutually exclusive at
// write time rather than by convention.
export const SECURITY_REREVIEW_EXHAUSTED = "SECURITY_REREVIEW_EXHAUSTED";

/** Rook's verdict vocabulary. EXHAUSTED is rook's alone — see above. */
export const ROOK_VERDICTS = ["PASS", "FAIL", "SKIP", "EXHAUSTED"] as const;

export const RookAgentSchema = z.object({
  ...AgentShape,
  verdict: z.enum(ROOK_VERDICTS).nullable().optional(),
  /** The named refusal. Present only on an EXHAUSTED record. */
  refusal: z.literal(SECURITY_REREVIEW_EXHAUSTED).optional(),
  /** How many remediate/re-review rounds were spent before the cap ran out. */
  rounds: z.number().int().positive().optional(),
}).superRefine((r, ctx) => {
  if (r.verdict === "EXHAUSTED") {
    if (r.refusal !== SECURITY_REREVIEW_EXHAUSTED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `agents.rook: an EXHAUSTED verdict must name its refusal — ` +
          `expected refusal "${SECURITY_REREVIEW_EXHAUSTED}"`,
        path: ["refusal"],
      });
    }
    if (r.rounds === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "agents.rook: an EXHAUSTED verdict must say how many rounds were spent — " +
          "a cap nobody can see the size of is not a bound",
        path: ["rounds"],
      });
    }
    if (Array.isArray(r.failures) && r.failures.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "agents.rook: an EXHAUSTED verdict must not carry failures — findings are how " +
          "'the review found something' is written down, and running out of attempts is not that",
        path: ["failures"],
      });
    }
  } else if (r.refusal !== undefined) {
    // Without this, the exhausted outcome could be parked under a PASS while
    // still recording the refusal honestly — the fail-open that every reader
    // checking `verdict === "PASS"` would walk straight past.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `agents.rook: refusal "${SECURITY_REREVIEW_EXHAUSTED}" was recorded against ` +
        `verdict ${JSON.stringify(r.verdict ?? null)} — only an EXHAUSTED verdict may carry it`,
      path: ["verdict"],
    });
  }
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

// ── Suite measurement (#224) ──────────────────────────────────────────────
//
// A suite result that does not say which commit it ran against is a number
// whose provenance was discarded: run wf_7ac5f614-d21 published
// `regressions: 0` over a branch with a failing test, and nothing could tell,
// because there was nothing to compare the count to. So `measuredSha` is
// required, and it must be a SHA rather than a ref — "HEAD" means "whatever
// the checkout happened to be", which is the same absence of provenance in
// different words.
//
// The verdict enum has no UNMEASURED member on purpose. UNMEASURED is what
// lib/suite-measurement.ts returns for the ABSENCE of a record; writing it
// would be a measurement asserting there was no measurement, and would give a
// caller a way to park an unmeasured run in the field that is supposed to
// prove the suite ran.
const MEASURED_SHA = /^[0-9a-f]{7,40}$/i;

const SuiteMeasurementShape = {
  verdict: z.enum(["PASS", "FAIL"]),
  measuredSha: z.string().regex(MEASURED_SHA, "measuredSha must be a commit SHA (7-40 hex), not a ref name"),
  failures: z.number().int().nonnegative(),
  measuredAt: z.string().optional(),
};

/**
 * The field names the measurement carries, exported so gates/schema-parity.test.ts
 * can check gates/SCHEMA-GUIDE.md against the schema in both directions — a
 * field added here and left undocumented turns that test red.
 */
export const SUITE_MEASUREMENT_FIELDS = Object.keys(SuiteMeasurementShape);

export const SuiteMeasurementSchema = z.object(SuiteMeasurementShape).superRefine((m, ctx) => {
  // A verdict its own count contradicts is not a result in either direction,
  // and the write path is where that is cheapest to stop.
  if (m.verdict === "PASS" && m.failures > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `suiteMeasurement: PASS with ${m.failures} failing test(s) — a PASS must carry zero failures`,
      path: ["failures"],
    });
  }
  if (m.verdict === "FAIL" && m.failures === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "suiteMeasurement: FAIL with no failing tests — a FAIL must name at least one",
      path: ["failures"],
    });
  }
});

// ── Evidence pre-validation (#235) ────────────────────────────────────────
//
// The scope gate dry-runs every AC's evidence command before Marcus runs. That
// result used to exist only as stdout from a promise nobody awaited: the gate
// wrote workflow-state.json, started the gate tests, and the verdict arrived
// afterwards into a log. A reading no later check can read is not a check.
//
// Unlike suiteMeasurement, UNMEASURED IS writable here, and the difference is
// deliberate. There, a recorded UNMEASURED would be a way to park an unmeasured
// run in the field that proves the suite ran. Here the failure mode runs the
// other way: a pre-validation that threw and a pre-validation that found
// nothing wrong both used to leave the field empty, and a reader cannot tell
// an absent field from a clean one. So a throw is recorded, with its reason,
// and absence keeps its own meaning — nobody got as far as measuring.
export const PREVALIDATION_VERDICTS = ["PASS", "FAIL", "UNMEASURED"] as const;
export const PREVALIDATION_AC_STATUSES = ["ok", "broken", "empty", "skipped"] as const;

export const PrevalidatedACSchema = z.object({
  id: z.string(),
  status: z.enum(PREVALIDATION_AC_STATUSES),
  autoFixed: z.boolean().optional(),
  originalCommand: z.string().optional(),
  fixedCommand: z.string().optional(),
  needsRewrite: z.boolean().optional(),
  diagnostic: z.string().optional(),
}).superRefine((ac, ctx) => {
  // An auto-fix that reports only its replacement cannot be reviewed: there is
  // nothing to compare it to, and a repaired command is indistinguishable from
  // one that was always written that way.
  if (ac.autoFixed) {
    for (const field of ["originalCommand", "fixedCommand"] as const) {
      if (!ac[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${ac.id}: autoFixed without ${field} — an auto-fix must carry both the original and the fixed command`,
          path: [field],
        });
      }
    }
  }
});

const EvidencePrevalidationShape = {
  verdict: z.enum(PREVALIDATION_VERDICTS),
  checkedAt: z.string(),
  acs: z.array(PrevalidatedACSchema),
  reason: z.string().nullable(),
};

/**
 * The field names the reading carries, exported so the parity test in
 * test/unit/evidence-prevalidation-gate.test.ts can check gates/SCHEMA-GUIDE.md
 * against the schema in both directions.
 */
export const EVIDENCE_PREVALIDATION_FIELDS = Object.keys(EvidencePrevalidationShape);

export const EvidencePrevalidationSchema = z.object(EvidencePrevalidationShape).superRefine((r, ctx) => {
  const broken = r.acs.filter((ac) => ac.status === "broken");

  if (r.verdict === "FAIL" && broken.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "evidencePrevalidation: FAIL with no broken evidence command — a FAIL must name at least one",
      path: ["acs"],
    });
  }
  if (r.verdict === "PASS" && broken.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `evidencePrevalidation: PASS with ${broken.length} broken evidence command(s) — a PASS must carry none`,
      path: ["acs"],
    });
  }
  if (r.verdict === "UNMEASURED") {
    if (!r.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "evidencePrevalidation: UNMEASURED with no reason — an absence nobody can explain is not actionable",
        path: ["reason"],
      });
    }
    if (r.acs.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `evidencePrevalidation: UNMEASURED with ${r.acs.length} AC result(s) — results mean it was measured`,
        path: ["acs"],
      });
    }
  } else if (r.reason !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "evidencePrevalidation: reason is only for UNMEASURED — a measured verdict explains itself through its ACs",
      path: ["reason"],
    });
  }
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
    rook: RookAgentSchema,
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

  issueType: z.enum(["feature", "bug-fix", "bug", "refactor", "chore"]).optional(),
  rca: z.object({
    rootCause: z.string().optional(),
    prediction: z.string().optional(),
    predictionVerified: z.boolean().optional(),
  }).optional(),

  blastRadius: z.object({
    filesRead: z.number(),
    filesChanged: z.number(),
  }).optional(),

  foundIssues: z.array(z.object({
    description: z.string(),
    disposition: z.enum(["fixed", "filed", "scoped-out"]).optional(),
    issueNumber: z.number().optional(),
  })).optional(),

  filesChangedOutsideBrief: z.array(z.string()).optional(),

  quinnJourneyPath: z.string().optional(),

  conformityFindings: z.any().optional(),

  preExistingFailures: z.array(z.string()).optional(),

  proofOfFix: z.object({
    commitSha: z.string(),
    verified: z.boolean(),
  }).optional(),

  // Absent means UNMEASURED (#224). Write it with
  // scripts/record-suite-measurement.ts, never by hand.
  suiteMeasurement: SuiteMeasurementSchema.optional(),

  // The scope gate's evidence dry-run (#235). Absent means UNMEASURED — the
  // gate never got as far as measuring. Written by the scope gate, not by hand.
  evidencePrevalidation: EvidencePrevalidationSchema.optional(),
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
