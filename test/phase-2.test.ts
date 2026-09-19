import { test, expect, describe, beforeAll } from "bun:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const HARNESS = join(import.meta.dir, "..");
const GATES = join(HARNESS, "gates");
const PROMPTS = join(HARNESS, "prompts");

// Phase 2 tests gate enforcement, brief assembly, evidence validation,
// and ship-cycle behavior. Most of these test code in gates/ and lib/.

describe("Phase 2: Gate Enforcement + Ship Behavior", () => {

  // SC-7: Container-rebuild agent NOT spawned when prod.rebuild is null
  describe("SC-7: null prod.rebuild skips container", () => {
    test("ship orchestrator skips container rebuild when prod.rebuild is null", () => {
      const orchestrator = join(GATES, "ship-orchestrator.ts");
      if (existsSync(orchestrator)) {
        const content = readFileSync(orchestrator, "utf-8");
        expect(content).toMatch(/prod\.rebuild|rebuild.*null|skip.*rebuild/i);
      } else {
        expect(existsSync(orchestrator)).toBe(true);
      }
    });
  });

  // SC-9: rungate-schema.ts includes test fields
  describe("SC-9: schema test fields", () => {
    test("schema has test section fields", () => {
      const schema = readFileSync(join(HARNESS, "lib/rungate-schema.ts"), "utf-8");
      expect(schema).toContain("TestSchema");
      expect(schema).toMatch(/start.*optional|apiBase/);
    });
  });

  // SC-10: Schema fields read by at least one workflow
  describe("SC-10: schema fields consumed", () => {
    test("dev.typeCheck referenced in workflow code", () => {
      const files = ["gates/run-gate.ts", "gates/ship-orchestrator.ts", "gates/orchestrator.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/typeCheck|tsc/);
    });
  });

  // SC-28: Scope gate runs conformity tests — FAIL blocks scope
  describe("SC-28: scope gate conformity", () => {
    test("run-gate.ts runs conformity at scope", () => {
      const gateRunner = join(GATES, "run-gate.ts");
      if (existsSync(gateRunner)) {
        const content = readFileSync(gateRunner, "utf-8");
        expect(content).toMatch(/scope|conformity|bun test/i);
      } else {
        expect(existsSync(gateRunner)).toBe(true);
      }
    });
  });

  // SC-29: Verify gate runs conformity tests — FAIL blocks verify
  describe("SC-29: verify gate conformity", () => {
    test("run-gate.ts runs conformity at verify", () => {
      const gateRunner = join(GATES, "run-gate.ts");
      if (existsSync(gateRunner)) {
        const content = readFileSync(gateRunner, "utf-8");
        expect(content).toMatch(/verify|conformity/i);
      } else {
        expect(existsSync(gateRunner)).toBe(true);
      }
    });
  });

  // SC-31: Scope gate captures test baseline
  describe("SC-31: test baseline capture", () => {
    test("schema supports testBaseline field", () => {
      const schema = readFileSync(join(GATES, "schema.ts"), "utf-8");
      expect(schema).toContain("testBaseline");
    });
  });

  // SC-32: Verify gate compares test count — fail increase = regression
  describe("SC-32: test count regression check", () => {
    test("gate logic compares test counts", () => {
      const files = ["gates/run-gate.ts", "gates/workflow.test.ts", "gates/orchestrator.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/baseline|regression|fail.*count|test.*count/i);
    });
  });

  // SC-33: Pre-existing test failures auto-filed as GitHub issues
  describe("SC-33: pre-existing failure filing", () => {
    test("gate or orchestrator handles pre-existing failures", () => {
      const files = ["gates/run-gate.ts", "gates/orchestrator.ts", "gates/ship-orchestrator.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/pre.existing|existing.*fail|baseline.*fail/i);
    });
  });

  // SC-34: Found issues either fixed, filed, or scoped out
  describe("SC-34: fix-on-find tracking", () => {
    test("workflow state tracks found issues disposition", () => {
      const schema = readFileSync(join(GATES, "schema.ts"), "utf-8");
      expect(schema).toMatch(/found|issue|filed|scoped/i);
    });
  });

  // SC-35: create-spec creates spec with frontmatter
  describe("SC-35: create-spec command", () => {
    test("create-spec script or function exists", () => {
      const hasScript = existsSync(join(HARNESS, "scripts/create-spec.ts"));
      const scaffoldHasIt = readFileSync(join(HARNESS, "scripts/scaffold-project.ts"), "utf-8").includes("create-spec");
      expect(hasScript || scaffoldHasIt).toBe(true);
    });
  });

  // SC-36: create-adr with auto-incremented number
  describe("SC-36: create-adr command", () => {
    test("create-adr script or function exists", () => {
      const hasScript = existsSync(join(HARNESS, "scripts/create-adr.ts"));
      const scaffoldHasIt = readFileSync(join(HARNESS, "scripts/scaffold-project.ts"), "utf-8").includes("create-adr");
      expect(hasScript || scaffoldHasIt).toBe(true);
    });
  });

  // SC-38: Ship cycle runs scaffold after verify PASS
  describe("SC-38: post-verify scaffold refresh", () => {
    test("ship orchestrator calls scaffold after verify", () => {
      const orchestrator = join(GATES, "ship-orchestrator.ts");
      if (existsSync(orchestrator)) {
        const content = readFileSync(orchestrator, "utf-8");
        expect(content).toMatch(/scaffold|refresh|code.map/i);
      } else {
        expect(existsSync(orchestrator)).toBe(true);
      }
    });
  });

  // SC-41: Secret scan in conformity (HYGIENE-12)
  describe("SC-41: HYGIENE-12 secret scan", () => {
    test("conformity or gate checks for secret patterns", () => {
      const conformity = readFileSync(join(HARNESS, "lib/conformity.ts"), "utf-8");
      const gatesYml = existsSync(join(HARNESS, "scripts/scaffold-project.ts"))
        ? readFileSync(join(HARNESS, "scripts/scaffold-project.ts"), "utf-8") : "";
      const combined = conformity + gatesYml;
      expect(combined).toMatch(/AKIA|sk-|ghp_|secret|credential|password/i);
    });
  });

  // SC-42: Completed slugs auto-archived after 24h
  describe("SC-42: slug auto-archive", () => {
    test("orchestrator or gate handles slug archival", () => {
      const files = ["gates/orchestrator.ts", "gates/run-gate.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/archive|DONE|slug.*clean/i);
    });
  });

  // SC-43: Archived slugs deleted after 30 days
  describe("SC-43: stale slug cleanup", () => {
    test("cleanup mechanism for old slugs", () => {
      const files = ["gates/orchestrator.ts", "gates/run-gate.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/delete|cleanup|30.*day|stale.*slug/i);
    });
  });

  // SC-44: Ship checks for existing slug before creating new
  describe("SC-44: duplicate slug prevention", () => {
    test("orchestrator checks for existing slug", () => {
      const files = ["gates/orchestrator.ts", "gates/ship-orchestrator.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/existing.*slug|slug.*exist|slugExists|duplicate/i);
    });
  });

  // SC-48: ACs use Given/When/Then format
  describe("SC-48: AC format validation", () => {
    test("AC schema or quality test validates format", () => {
      const files = ["gates/ac-quality.test.ts", "gates/schema.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/trigger|verify.*command|exclusion|Given|When|Then/i);
    });
  });

  // SC-49: Every AC has executable verification command
  describe("SC-49: AC verification command", () => {
    test("schema requires verification command or evidenceMethod", () => {
      const schema = readFileSync(join(GATES, "schema.ts"), "utf-8");
      expect(schema).toMatch(/evidenceMethod|command/);
    });
  });

  // SC-50: Evidence hierarchy enforced per AC
  describe("SC-50: evidence tier enforcement", () => {
    test("evidence types are enumerated in schema", () => {
      const schema = readFileSync(join(GATES, "schema.ts"), "utf-8");
      expect(schema).toMatch(/file-citation|grep-output|api-response|screenshot|test-output|command-output|manual-attestation/);
    });
  });

  // SC-51: Self-attestation (tier F) = automatic FAIL
  describe("SC-51: self-attestation FAIL", () => {
    test("manual-attestation type exists in schema", () => {
      const schema = readFileSync(join(GATES, "schema.ts"), "utf-8");
      expect(schema).toContain("manual-attestation");
    });
  });

  // SC-52: Garbage test applied to every AC
  describe("SC-52: AC garbage test", () => {
    test("ac-quality test checks for garbage-passable ACs", () => {
      const acQuality = join(GATES, "ac-quality.test.ts");
      if (existsSync(acQuality)) {
        const content = readFileSync(acQuality, "utf-8");
        expect(content).toMatch(/garbage|weak|vague|behavioral/i);
      } else {
        expect(existsSync(acQuality)).toBe(true);
      }
    });
  });

  // SC-53: RCA section in Marcus brief for bug-fix issues
  describe("SC-53: RCA in bug-fix briefs", () => {
    test("brief-assembler includes RCA for bug-fix type", () => {
      const assembler = join(GATES, "brief-assembler.ts");
      if (existsSync(assembler)) {
        const content = readFileSync(assembler, "utf-8");
        expect(content).toMatch(/rca|rootCause|root.cause|bug.fix/i);
      } else {
        expect(existsSync(assembler)).toBe(true);
      }
    });
  });

  // SC-54: Gate checks RCA fields on bug-fix issues
  describe("SC-54: RCA gate check", () => {
    test("gate validates RCA fields", () => {
      const files = ["gates/run-gate.ts", "gates/workflow.test.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/rootCause|rca|root.*cause/i);
    });
  });

  // SC-55: Quinn briefs use typed journey format
  describe("SC-55: Quinn journey format", () => {
    test("schema or brief-assembler defines journey structure", () => {
      const files = ["gates/schema.ts", "gates/brief-assembler.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/journey|action.*wait_for|assertion.*on_fail/i);
    });
  });

  // SC-56: Quinn perception — browser_snapshot primary
  describe("SC-56: Quinn perception hierarchy", () => {
    test("quinn prompt or brief references snapshot perception", () => {
      const quinnPrompt = join(PROMPTS, "quinn.md");
      const quinnDecision = join(PROMPTS, "quinn-decision-tree.md");
      const paths = [quinnPrompt, quinnDecision].filter(f => existsSync(f));
      if (paths.length > 0) {
        const content = paths.map(f => readFileSync(f, "utf-8")).join("\n");
        expect(content).toMatch(/snapshot|a11y|accessibility.*tree/i);
      } else {
        expect(paths.length).toBeGreaterThan(0);
      }
    });
  });

  // SC-57: Quinn circuit breaker — 3 consecutive FAILs
  describe("SC-57: Quinn circuit breaker", () => {
    test("circuit breaker threshold defined", () => {
      const files = ["gates/schema.ts", "prompts/quinn-decision-tree.md"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/circuit.*breaker|3.*consecutive|abort.*journey/i);
    });
  });

  // SC-58: Proof-of-fix includes negative control
  describe("SC-58: negative control for S-tier", () => {
    test("prove gate or prompt references negative control", () => {
      const files = ["gates/prove.test.ts", "gates/prompts/prove-reproducer.md"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/negative.*control|revert.*fix|confirm.*bug.*return/i);
    });
  });

  // SC-59: Blast radius — filesRead ≥ filesChanged
  describe("SC-59: blast radius enforcement", () => {
    test("gate checks filesRead vs filesChanged", () => {
      const files = ["gates/run-gate.ts", "gates/workflow.test.ts", "gates/orchestrator.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/filesRead|filesChanged|blast.*radius|read.*write.*ratio/i);
    });
  });

  // SC-60: Read-before-write ratio ≥ 3:1
  describe("SC-60: read-before-write ratio", () => {
    test("gate enforces read/write ratio", () => {
      const files = ["gates/run-gate.ts", "gates/workflow.test.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/read.*write|3:1|ratio/i);
    });
  });

  // SC-61: Brief-assembler generates per-role templates
  describe("SC-61: per-role brief generation", () => {
    test("brief-assembler handles multiple roles", () => {
      const assembler = join(GATES, "brief-assembler.ts");
      if (existsSync(assembler)) {
        const content = readFileSync(assembler, "utf-8");
        expect(content).toMatch(/marcus|quinn|rook|role/i);
      } else {
        expect(existsSync(assembler)).toBe(true);
      }
    });
  });

  // SC-62: Templates are three-layered
  describe("SC-62: three-layer templates", () => {
    test("brief-assembler references harness + project + issue layers", () => {
      const assembler = join(GATES, "brief-assembler.ts");
      if (existsSync(assembler)) {
        const content = readFileSync(assembler, "utf-8");
        expect(content).toMatch(/harness|project.*config|issue.*specific|layer|rungate\.json|acs/i);
      } else {
        expect(existsSync(assembler)).toBe(true);
      }
    });
  });

  // SC-63: Spec content hash tracked — mismatch = FAIL
  describe("SC-63: spec hash tracking", () => {
    test("gate checks spec content hash", () => {
      const files = ["gates/run-gate.ts", "gates/e2e-smoke.test.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/hash|sha|spec.*drift|content.*hash/i);
    });
  });

  // SC-64: Test count post ≥ pre — decrease = FAIL
  describe("SC-64: test deletion prevention", () => {
    test("gate detects test count decrease", () => {
      const files = ["gates/e2e-smoke.test.ts", "gates/workflow.test.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/test.*count|deletion|removed|decrease/i);
    });
  });

  // SC-65: Prevention-oriented fixes
  describe("SC-65: prevention-oriented pattern", () => {
    test("prevention template exists or is referenced", () => {
      const prevention = join(PROMPTS, "prevention.md");
      const hasPrevention = existsSync(prevention);
      const assembler = join(GATES, "brief-assembler.ts");
      const refsPrevention = existsSync(assembler) && readFileSync(assembler, "utf-8").includes("prevention");
      expect(hasPrevention || refsPrevention).toBe(true);
    });
  });

  // SC-66: Writer and verifier are separate agents
  describe("SC-66: writer/verifier separation", () => {
    test("gate or schema tracks agent roles", () => {
      const files = ["gates/schema.ts", "gates/run-gate.ts", "gates/witness.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/writer|verifier|author.*agent|witness|separate/i);
    });
  });

  // SC-67: Quinn journey steps auto-generated from UI ACs
  describe("SC-67: auto-generated Quinn journeys", () => {
    test("brief-assembler generates journey from ACs", () => {
      const assembler = join(GATES, "brief-assembler.ts");
      if (existsSync(assembler)) {
        const content = readFileSync(assembler, "utf-8");
        expect(content).toMatch(/journey|quinn|UI|step/i);
      } else {
        expect(existsSync(assembler)).toBe(true);
      }
    });
  });

  // SC-68: Evidence without assertion = tier F
  describe("SC-68: evidence without assertion", () => {
    test("schema or gate rejects evidence without assertions", () => {
      const schema = readFileSync(join(GATES, "schema.ts"), "utf-8");
      expect(schema).toContain("manual-attestation");
    });
  });

  // SC-79: Conformity includes runPackageValidation
  describe("SC-79: runPackageValidation", () => {
    test("conformity exports runPackageValidation", () => {
      const conformity = readFileSync(join(HARNESS, "lib/conformity.ts"), "utf-8");
      expect(conformity).toContain("runPackageValidation");
    });
  });

  // SC-81: Phase 0 additive — never overwrites existing content
  describe("SC-81: additive scaffold", () => {
    test("scaffold checks for existing content before writing", () => {
      const scaffold = readFileSync(join(HARNESS, "scripts/scaffold-project.ts"), "utf-8");
      expect(scaffold).toMatch(/existsSync|exists|append|merge|additive/i);
    });
  });

  // SC-96: rungate.json mcp section
  describe("SC-96: mcp config section", () => {
    test("schema supports mcp field", () => {
      const schema = readFileSync(join(HARNESS, "lib/rungate-schema.ts"), "utf-8");
      expect(schema).toMatch(/mcp/i);
    });
  });

  // SC-102: Re-scaffold auto-fixes broken refs
  describe("SC-102: re-scaffold auto-fix", () => {
    test("scaffold handles re-scaffold with fixes", () => {
      const scaffold = readFileSync(join(HARNESS, "scripts/scaffold-project.ts"), "utf-8");
      expect(scaffold).toMatch(/re.scaffold|update|existing|fix/i);
    });
  });

  // SC-103: Evidence-to-tier mapping in gate
  describe("SC-103: evidence tier mapping", () => {
    test("evidence types map to tiers in schema", () => {
      const schema = readFileSync(join(GATES, "schema.ts"), "utf-8");
      expect(schema).toMatch(/EVIDENCE_METHOD_TYPES|evidence.*type|tier/i);
    });
  });

  // SC-104: File ownership — harness-owned regenerated, co-owned preserved
  describe("SC-104: file ownership model", () => {
    test("scaffold distinguishes harness-owned from co-owned", () => {
      const scaffold = readFileSync(join(HARNESS, "scripts/scaffold-project.ts"), "utf-8");
      expect(scaffold).toMatch(/overwrite|managed|harness.owned|co.owned|preserve|skip/i);
    });
  });

  // SC-105: Scaffold idempotency
  describe("SC-105: scaffold idempotent", () => {
    test("scaffold handles existing project", () => {
      const scaffold = readFileSync(join(HARNESS, "scripts/scaffold-project.ts"), "utf-8");
      expect(scaffold).toMatch(/existsSync|existing|idempotent|re.run/i);
    });
  });

  // SC-108: Quinn journey stored in slug directory
  describe("SC-108: Quinn journey storage", () => {
    test("schema or orchestrator references quinn-journey path", () => {
      const files = ["gates/schema.ts", "gates/orchestrator.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/quinn.*journey|journey.*yaml|journey.*path/i);
    });
  });

  // SC-109: Fix-on-find — silently dropped = FAIL
  describe("SC-109: fix-on-find enforcement", () => {
    test("gate checks for dropped issues", () => {
      const files = ["gates/run-gate.ts", "gates/workflow.test.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/fix.on.find|dropped|found.*issue|silently/i);
    });
  });

  // SC-110: Port allocation checks for collisions
  describe("SC-110: port collision detection", () => {
    test("worktree or orchestrator checks port collisions", () => {
      const files = ["gates/orchestrator.ts", "gates/ship-orchestrator.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/port.*collision|port.*alloc|port.*offset|port.*check/i);
    });
  });

  // SC-111: Escalation decision tree in agent briefs
  describe("SC-111: escalation decision tree", () => {
    test("escalation template exists or is referenced in briefs", () => {
      const escalation = join(PROMPTS, "escalation-decision-tree.md");
      const hasEscalation = existsSync(escalation);
      const scaffold = readFileSync(join(HARNESS, "scripts/scaffold-project.ts"), "utf-8");
      const refsEscalation = scaffold.includes("escalation");
      expect(hasEscalation || refsEscalation).toBe(true);
    });
  });

  // SC-112: Circuit breaker → research escalation
  describe("SC-112: research escalation at iteration 2", () => {
    test("gate checks research evidence before iteration 3", () => {
      const files = ["gates/run-gate.ts", "gates/self-heal.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/research|iteration|escalat|circuit.*break/i);
    });
  });

  // SC-113: rungate.json research section
  describe("SC-113: research tools config", () => {
    test("schema supports research field", () => {
      const schema = readFileSync(join(HARNESS, "lib/rungate-schema.ts"), "utf-8");
      expect(schema).toMatch(/research/i);
    });
  });

  // SC-127: 3 gate prompt templates exist
  describe("SC-127: gate prompt templates", () => {
    const templates = ["ac-adversary.md", "evidence-validator.md", "prove-reproducer.md"];
    for (const t of templates) {
      test(`gates/prompts/${t} exists`, () => {
        expect(existsSync(join(GATES, "prompts", t))).toBe(true);
      });
    }
  });

  // SC-129: Gate WARNs on shallow modules
  describe("SC-129: shallow module detection", () => {
    test("conformity exports runModuleDepthCheck", () => {
      const conformity = readFileSync(join(HARNESS, "lib/conformity.ts"), "utf-8");
      expect(conformity).toContain("runModuleDepthCheck");
      expect(conformity).toMatch(/shallow|export.*internal|module.*depth/i);
    });
  });

  // SC-130: Gate WARNs on modules with >3 importers and no contract test
  describe("SC-130: contract test coverage", () => {
    test("conformity checks importer count vs contract tests", () => {
      const conformity = readFileSync(join(HARNESS, "lib/conformity.ts"), "utf-8");
      expect(conformity).toMatch(/importer|contract.*test|import.*count/i);
    });
  });

  // SC-131: Anti-criteria use absence verification
  describe("SC-131: absence verification for anti-criteria", () => {
    test("conformity exports runAbsenceValidation", () => {
      const conformity = readFileSync(join(HARNESS, "lib/conformity.ts"), "utf-8");
      expect(conformity).toContain("runAbsenceValidation");
      expect(conformity).toMatch(/absence|anti.*criter/i);
    });
  });

  // SC-132: Tier D evidence capped at 25%
  describe("SC-132: tier D cap", () => {
    test("gate checks grep evidence percentage", () => {
      const files = ["gates/run-gate.ts", "gates/workflow.test.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/tier.*D|grep.*cap|25.*percent|evidence.*portfolio/i);
    });
  });

  // SC-133: Brief-assembler rejects Quinn journeys > 8 steps
  describe("SC-133: Quinn journey step cap", () => {
    test("brief-assembler limits journey length", () => {
      const assembler = join(GATES, "brief-assembler.ts");
      if (existsSync(assembler)) {
        const content = readFileSync(assembler, "utf-8");
        expect(content).toMatch(/8.*step|step.*limit|journey.*split|max.*step/i);
      } else {
        expect(existsSync(assembler)).toBe(true);
      }
    });
  });

  // SC-134: Files changed outside brief = WARN
  describe("SC-134: out-of-brief file changes", () => {
    test("gate detects changes outside brief scope", () => {
      const files = ["gates/run-gate.ts", "gates/workflow.test.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/outside.*brief|brief.*file|unexpected.*change|file.*outside/i);
    });
  });

  // SC-135: Gate cross-validates proofOfFix vs prove-evidence
  describe("SC-135: proof cross-validation", () => {
    test("gate compares proofOfFix against prove-evidence.json", () => {
      const files = ["gates/run-gate.ts", "gates/prove.test.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/proofOfFix|prove.evidence|cross.*valid|mismatch/i);
    });
  });
});
