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
  // #339. `acs-have-type` is named by all three ceremony profiles and the
  // field was `.optional()`, so an AC with no type passed the check named
  // after requiring one. Refined rather than made non-optional, to match how
  // `threshold` above states the same kind of rule.
  //
  // Safe to require: 0 of the 456 ACs across the 82 completed runs in
  // ~/.rungate lack a type. This makes a check that could not fail start
  // being true, not start failing.
  if (!ac.type) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${ac.id}: missing type (CODE or OUTCOME)`, path: ["type"] });
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
  // #490 — what the run covered, beside what it found. A verdict with no
  // coverage beside it cannot tell `0 fail` over 324 files from `0 fail` over
  // one empty one, and both print the same summary.
  //
  // `.nullable()`, and the recorder writes null rather than omitting the key
  // when a runner does not report a count: absent means "a harness older than
  // this field", null means "this runner was asked and did not say", and 0
  // means "it said none". Collapsing those is the defect one level down.
  tests: z.number().int().nonnegative().nullable().optional(),
  files: z.number().int().positive().nullable().optional(),
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
  // #490. `files: z.number().positive()` refuses a run over no files, and on
  // its own that would be the PROXY enforced in place of the property: one
  // empty file satisfies it and measures nothing. A recorded `tests: 0` is
  // the property, and it is the shape this field exists to make visible.
  if (m.tests === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'suiteMeasurement: a record carrying "tests": 0 is not a measurement — a runner that ' +
        "discovered nothing to run exits exactly like a clean suite (#490)",
      // Worded so it cannot be mistaken for `lib/suite-run-reading.ts`'s
      // refusal, which says "executed 0 tests". The two are a legitimate
      // pair — this one also catches a state the recorder did not produce —
      // but a test asserting on the reading's sentence must not be able to
      // pass on this one's. Measured: with identical wording, disabling the
      // reading's refusal left two rows green that exist to witness it.
      path: ["tests"],
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

/**
 * Which gate took the reading. Optional: a reading written before #264 has no
 * answer.
 *
 * In phase order, which is what `shouldRetakePrevalidation` and
 * `prevalidationViolations` both read. `ship` joined the list in #280, where
 * the ship gate was found consuming whatever block the verify gate left
 * behind — on run `wf_ea3e428f-64f` a reading an hour old that disagreed with
 * the tree by four ACs.
 */
export const PREVALIDATION_SOURCES = ["scope", "verify", "ship"] as const;

export type PrevalidationSource = (typeof PREVALIDATION_SOURCES)[number];

const EvidencePrevalidationShape = {
  verdict: z.enum(PREVALIDATION_VERDICTS),
  checkedAt: z.string(),
  acs: z.array(PrevalidatedACSchema),
  reason: z.string().nullable(),
  // Which gate measured this (#264).
  //
  // "A reading exists" cannot separate two cases that want opposite treatment
  // on the next verify attempt: the scope gate measured this run's STARTING
  // conditions, which re-measuring after Marcus has run would answer a
  // different question; or a previous verify attempt measured it, in which
  // case freezing that reading means no heal round can ever clear a refusal.
  // #261 could not tell them apart and froze both, so run wf_c71f950f-c88
  // spent four verify attempts judged against one reading taken in the wrong
  // directory, with all six of its ACs passing.
  //
  // Optional, so a reading written before this field existed still validates
  // and still behaves exactly as it did — absent is treated as "not verify",
  // which preserves it.
  takenAt: z.enum(PREVALIDATION_SOURCES).optional(),
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

  /**
   * The tree a gate check must MEASURE, as opposed to `projectRoot`, which is
   * where configuration is READ from (#314).
   *
   * On a worktree-isolated run these differ: `projectRoot` is the main
   * checkout, already merged and green by construction, while the change under
   * test lives in `.claude/worktrees/<run>-N`. Eight checks executed commands
   * against `projectRoot` and therefore measured the wrong tree — `tsc-pass`
   * typechecked `main`, `code-committed` ran `git status` on a checkout the
   * work was never in, and `code-pushed` asked whether `main` was ahead of its
   * upstream. All three passed unconditionally.
   *
   * ship.js writes this whenever it establishes the commit directory. Absent is
   * a refusal rather than a fallback to `projectRoot`: falling back is exactly
   * the behaviour being removed, and it is indistinguishable from a correct
   * measurement.
   */
  treeUnderTest: z.string().optional(),

  /**
   * Every worktree this run built in, so a gate can read each one's `origin`
   * off the disk (#414, follow-up to #218).
   *
   * `treeUnderTest` names ONE tree. A decomposed run has one worktree per
   * sub-issue, and the #218 incident was a second agent landing in a
   * different checkout while the first was correct — so checking only the
   * tree under test reads the right answer off the wrong worktree.
   *
   * `reportedRepo` is what the AGENT said `git remote get-url origin`
   * printed. It is recorded, not trusted: the gate compares the disk, and
   * keeping the reply beside it is what lets the refusal distinguish "the
   * worktree is in the wrong place" from "the reply was right and the
   * checkout disagrees". The second is the case the ship workflow
   * structurally cannot see, because the reply is the only remote it has.
   *
   * Absent is not a pass — `worktreeRepoViolations` refuses an empty list,
   * because every run reaching this gate has at least a tree under test.
   */
  worktrees: z.array(z.object({
    path: z.string(),
    reportedRepo: z.string().optional(),
  })).optional(),

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

  /**
   * Dev- and prod-server liveness as the prove gate measured it, or did not
   * (#304).
   *
   * `UNMEASURED` is a first-class status, not an absence. The prove gate used
   * to `process.exit(1)` when a server did not answer at a route hardcoded
   * into the harness; the route is read from `dev.healthPath` now, and a
   * consumer that has not set one cannot be probed. Reporting DOWN for that
   * consumer is a false FAIL on a healthy server, so the gate does not refuse
   * — which means the gap has to be written down somewhere durable, or
   * relaxing the refusal is a silent fail-open.
   *
   * Nothing refuses on this yet; #346 defines the refusal that should.
   */
  liveness: z.array(z.object({
    tier: z.string(),
    status: z.enum(["UP", "DOWN", "UNMEASURED"]),
    detail: z.string(),
  })).optional(),

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

  iterationCount: z.number().optional(),
  startTs: z.string().optional(),
  updatedTs: z.string().optional(),

  phaseTimings: z.record(z.string(), z.array(PhaseTimingEntry)).optional(),

  gateContract: z.object({
    /**
     * How many tests each file declared at the last gate run (#307 SC-A19).
     *
     * Carried across gate runs so a heal round that deletes a test is
     * visible to the re-run that follows it. Not banked when a regression
     * is found — see `nextCensus`.
     */
    testCensus: z.record(z.string(), z.number()).optional(),
    environments: z.any().optional(),
    verdicts: z.any().optional(),
    evidence: z.any().optional(),
    baselines: z.object({
      testBaseline: z.number().optional(),
      /**
       * Why no number is recorded (#307). Present exactly when `testBaseline`
       * is absent, and never beside it: a reason sitting next to a `0` would
       * let `?? 0` keep reading the run as a measured clean tree, which is
       * the defect the reason exists to report.
       */
      testBaselineUnmeasured: z.string().optional(),
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

  /**
   * What this run decided to measure, and what it decided not to (#251).
   *
   * A finished run showing six ACs is ambiguous: six because the issue had
   * six criteria, or six because one was dropped? Run wf_e105dd33-220 was the
   * second, and nothing anywhere recorded it. `deferrals` is the answer, and
   * `uncovered` must be empty on any run that got past discovery — a
   * non-empty one is a run that shipped against criteria it never measured.
   */
  acCoverage: z.object({
    criteriaCount: z.number(),
    acCount: z.number(),
    covered: z.array(z.string()),
    deferrals: z.array(z.object({
      specElement: z.string(),
      reason: z.string(),
      subIssue: z.number().optional(),
    })),
    uncovered: z.array(z.string()),
  }).nullable().optional(),

  /**
   * Which run wrote this file (#288).
   *
   * `WORK_DIR` is keyed by slug, so every run of one issue writes into one
   * directory. Without this a reader cannot tell a live run's state file from
   * the previous night's — and on 2026-10-13 a healthy #254 run was cancelled
   * on exactly that misreading. `gates/run-attribution.ts` compares it against
   * the directory's `run.json` marker; a disagreement reads as MIXED.
   */
  runId: z.string().optional(),

  /**
   * The prior branch this run adopted work from, as detection reported it
   * (#288). Null means detection ran and found none; absent means nobody
   * looked.
   *
   * ship.js has passed this to `initWorkflow` since the field existed and
   * nothing persisted it — the call is assembled into a `bun -e` template
   * string, so TypeScript never saw the excess property and the drop was
   * silent. It is why #185 and #223 each had to reconstruct prior-branch
   * detection from scratch to investigate it.
   */
  priorWork: z.object({
    branch: z.string().optional(),
    refName: z.string().optional(),
    commitCount: z.number().nullable().optional(),
    acStatus: z.array(z.object({
      id: z.string(),
      status: z.string(),
      evidence: z.string().optional(),
    })).optional(),
  }).passthrough().nullable().optional(),

  /**
   * Where each AC's verdict came from: earned by this run, or adopted from a
   * prior branch (#288).
   *
   * A run that inherited six passing ACs and a run that implemented six
   * passing ACs produce the same artefact without it. Every AC in the prior
   * work's list is labelled, because an absent entry is what an AC nobody
   * classified looks like.
   */
  acProvenance: z.record(z.object({
    source: z.enum(["adopted", "this-run"]),
    branch: z.string().optional(),
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

  conformityFindings: z.any().optional(),

  preExistingFailures: z.array(z.string()).optional(),

  /**
   * The commit the run built and measured. Written by
   * `scripts/record-build-commit.ts`.
   *
   * Read at the ship gate (`gates/workflow.test.ts`) to decide whether the run
   * has a commit at all, and undeclared until #317 — a field that gates
   * shipping was not in the contract describing the state it is shipped from.
   */
  buildCommit: z.string().optional(),

  /** The merge commit, written by `gates/orchestrator.ts` after the merge. */
  mergeCommitSha: z.string().optional(),

  /**
   * Instruction-compliance grades for the run's agents, written by
   * `scripts/persist-compliance.ts`. `z.any()` rather than a shape: the
   * grader owns the structure and this schema only needs to stop claiming the
   * field does not exist.
   */
  compliance: z.any().optional(),

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
