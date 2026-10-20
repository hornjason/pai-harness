/**
 * #632 — the scaffold explains the review gate it just generated.
 *
 * #630 was expensive for a reason that is not a bug in any file: a consumer
 * who scaffolds with no credentials gets a green `ai-review` check and
 * nothing anywhere tells them it has never run. The job annotates UNMEASURED
 * on every run, which is correct and which nobody reads, because an
 * annotation lives inside a check that is already green.
 *
 * So the two positions a consumer actually reads are the ones this covers:
 * the top of the generated file, and the scaffold's own output.
 *
 * ## The three outcomes are not equally visible, which is the whole point
 *
 * "Reviewed and clean" and "reviewed and blocking" both look like a green
 * check until the blocking one fails. "Unmeasured for want of credentials"
 * looks like a green check always. From the checks list alone a consumer
 * cannot tell outcome 3 from outcome 2, and those are the two states whose
 * confusion costs the most.
 *
 * ## One declaration, because two descriptions of one fact drift
 *
 * Whether anything reads the findings payload is stated in exactly one place,
 * `AI_REVIEW_FINDINGS_ADJUDICATED`. Two positions describe that state — the
 * header a consumer reads and the run script's warning an operator reads —
 * and if each carried its own sentence they would drift the moment the fact
 * changed, in the dangerous direction: a header promising enforcement over a
 * job that has none. AC-3 holds them together and exercises both sides of
 * the seam.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Write the credential names into the header as literals.** It is the
 * obvious way to produce the sentence, it reads correctly today, and it puts
 * a second declaring position beside `AI_REVIEW_AUTH_PRECEDENCE` — so a mode
 * added to the ladder appears in the script and not in the explanation, and
 * the file tells a consumer to set a secret that is no longer the one that
 * matters. AC-2 is red under it: it compares the header against the table,
 * not against a string.
 *
 * ## What this does NOT do
 *
 * It does not make outcome 1 reachable. No step in the job reads the findings
 * payload (#675), so the header says so rather than describing a gate that
 * does not exist. That sentence is derived, not written twice, and it leaves
 * in the same commit that flips the constant.
 */
import { describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import {
  AI_REVIEW_AUTH_PRECEDENCE,
  AI_REVIEW_FINDINGS_ADJUDICATED,
  AI_REVIEW_REQUIRE_VALUE,
  AI_REVIEW_REQUIRE_VAR,
  AI_REVIEW_WORKFLOW_FILE,
  aiReviewScaffoldAction,
  buildOutcomesHeader,
  buildReviewRunScript,
  vertexCiConfig,
} from "../lib/scaffold/ai-review-step";
import { OWNED_FILES } from "../lib/scaffold/owned-files";
import { freshFixtureRoot } from "./helpers/scaffold-fixture";

const ROOT = join(import.meta.dir, "..");
const WORKFLOW = join(ROOT, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE);
const OWNED_PATH = `.github/workflows/${AI_REVIEW_WORKFLOW_FILE}`;

/** No `ci.vertex`, which is what every fresh consumer has. */
const NO_VERTEX = vertexCiConfig(undefined);

/**
 * Comment markers stripped and whitespace collapsed.
 *
 * Every assertion below goes through this, and the reason is a failure this
 * file produced on its first run: the header WRAPS, so `toContain("the Vertex
 * federation this project already declares")` was false over a header that
 * says exactly that, across two lines. A detector a line break defeats is the
 * third shape in `.claude/rules/checks-must-be-able-to-fail.md`, and it fails
 * in the direction that looks like the feature is missing.
 */
function prose(text: string): string {
  return text.replace(/^[ \t]*#[ \t]?/gm, " ").replace(/\s+/g, " ").trim();
}

describe("#632: the generated review gate explains itself", () => {
  test("AC-1: the workflow on disk names all three outcomes, and says 3 is not 2", () => {
    // Read off the GENERATED FILE, not off the builder. A builder that
    // produces the right string and a generator that never calls it are the
    // same defect this issue exists against, and only the file tells them
    // apart.
    const yml = readFileSync(WORKFLOW, "utf-8");

    const said = prose(yml);
    expect(said, "the generated workflow is not current — re-scaffold").toContain("THREE OUTCOMES");
    expect(said).toContain("REVIEWED AND BLOCKING");
    expect(said).toContain("REVIEWED AND CLEAN");
    expect(said).toContain("UNMEASURED FOR WANT OF CREDENTIALS");

    // The distinction that costs the most, asserted as its own sentence
    // rather than inferred from the three headings being present.
    expect(said, "the file does not say that UNMEASURED is not a clean review").toContain("This is NOT outcome 2");

    // Still a comment block. A header that stopped being comments would be a
    // workflow that no longer parses, and `toContain` cannot see that.
    const header = yml.slice(yml.indexOf("# THREE OUTCOMES"), yml.indexOf("name: AI Review"));
    const notComment = header.split("\n").filter(l => l.trim() !== "" && !l.startsWith("#"));
    expect(notComment, `the header left comment syntax:\n${notComment.join("\n")}`).toEqual([]);
  });

  test("AC-2: the credentials and the variable come from their tables, not from literals", () => {
    // The named cheapest wrong fix. Compared against the declaring positions,
    // so a mode added to the ladder with no mention in the header is red
    // here rather than silently absent from the explanation.
    const header = prose(buildOutcomesHeader(NO_VERTEX));

    expect(AI_REVIEW_AUTH_PRECEDENCE.length, "the ladder is empty, so this case asserts nothing").toBeGreaterThan(0);
    for (const credential of AI_REVIEW_AUTH_PRECEDENCE) {
      expect(header, `the header does not name ${credential.secret}`).toContain(credential.secret);
    }
    expect(header).toContain(AI_REVIEW_REQUIRE_VAR);
    expect(header).toContain(`'${AI_REVIEW_REQUIRE_VALUE}'`);

    // A project that declares federation is told about the thing it has,
    // not sent to configure it again — the pair varies one input.
    const federated = vertexCiConfig({
      vertex: {
        project: "jhorn-pai",
        workloadIdentityProvider:
          "projects/939083080179/locations/global/workloadIdentityPools/github/providers/github-actions",
      },
    });
    // The premise, asserted rather than assumed: vertexCiConfig refuses a
    // malformed block by returning `config: null`, and a refused fixture
    // would take the same branch as "no vertex" and the pair would vary
    // nothing. The first draft of this case did exactly that.
    expect(federated.config, `the vertex fixture was refused: ${federated.reason}`).not.toBeNull();
    const withVertex = prose(buildOutcomesHeader(federated));
    expect(withVertex).toContain("federation this project already declares");
    expect(prose(buildOutcomesHeader(NO_VERTEX))).toContain("ci.vertex");
  });

  test("AC-3: the header and the run script agree about whether findings are read", () => {
    // One fact, two readers. Both sides of the seam are driven, because a
    // caveat that is always printed is indistinguishable from a caveat that
    // is correctly printed — and the only way to tell is to ask for the
    // other value and watch it go.
    const unwired = buildOutcomesHeader(NO_VERTEX, false);
    const wired = buildOutcomesHeader(NO_VERTEX, true);

    expect(prose(unwired)).toContain("#675");
    expect(prose(wired), "the caveat survives a tree that adjudicates, so it is unconditional").not.toContain("#675");
    expect(unwired.length).toBeGreaterThan(wired.length);

    // And the two positions say the same thing about the live tree. If the
    // constant is ever flipped without the run script changing, this is the
    // case that notices.
    const live = buildOutcomesHeader(NO_VERTEX);
    const script = buildReviewRunScript();
    expect(AI_REVIEW_FINDINGS_ADJUDICATED).toBe(false);
    expect(live).toBe(unwired);
    expect(script, "the run script no longer reports the unread payload, but the header still does").toContain("#675");
  });

  test("AC-4: a real scaffold records one line saying the gate is inert, and what activates it", () => {
    // Spawned against a minimal project, because the claim is about what a
    // CONSUMER sees. Reading the function's return value would assert that a
    // string can be built; only a run asserts it is emitted.
    const dest = freshFixtureRoot("rungate-632-");
    writeFileSync(
      join(dest, "package.json"),
      JSON.stringify({ name: "inert-gate-consumer", version: "1.0.0", type: "module" }, null, 2) + "\n",
    );
    mkdirSync(join(dest, "src"), { recursive: true });
    writeFileSync(join(dest, "src", "index.ts"), 'export const x: string = "hi";\n');
    execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", {
      cwd: dest,
      stdio: "pipe",
    });

    const out = execSync(`bun "${join(ROOT, "scripts", "scaffold-project.ts")}" "${dest}" --fix`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 120_000,
    });

    const lines = out.split("\n").filter(l => l.includes(AI_REVIEW_WORKFLOW_FILE) && l.includes("INERT"));
    expect(lines, `the scaffold said nothing about the gate being inert:\n${out}`).toHaveLength(1);
    for (const credential of AI_REVIEW_AUTH_PRECEDENCE) {
      expect(lines[0], `the action line does not name ${credential.secret}`).toContain(credential.secret);
    }
    expect(lines[0]).toContain(AI_REVIEW_REQUIRE_VAR);
    expect(existsSync(join(dest, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE))).toBe(true);
  }, 180_000);

  test("AC-5: the ownership decision is declared once, and the rules table carries the row", () => {
    // #632 AC-10, which was already satisfied when this was written — by
    // #630/#631, not by this change. Asserted anyway: the criterion is that
    // the decision is declared ONCE, and a second entry is exactly what a
    // later author adding a sibling workflow would produce.
    const owned = OWNED_FILES.filter(f => f.path === OWNED_PATH);
    expect(owned, `the ai-review workflow is declared ${owned.length} times in OWNED_FILES`).toHaveLength(1);
    expect(owned[0].strategy).toBe("job-preserving");

    const table = readFileSync(join(ROOT, ".claude", "rules", "harness-managed.md"), "utf-8");
    const rows = table.split("\n").filter(l => l.startsWith("|") && l.includes(OWNED_PATH));
    expect(rows, "the harness-managed table has no row for the ai-review workflow").toHaveLength(1);
    expect(rows[0], "the row does not carry the declared strategy").toContain(owned[0].strategy);
  });

  test("AC-6: the header and the action line are deterministic", () => {
    // #632 AC-15's property at the level this change owns. The scaffold
    // reconciliation and idempotency suites assert it end to end; a date, a
    // random nonce or a Set iteration in either builder would make the second
    // scaffold rewrite the file and show up there as drift with no cause.
    expect(buildOutcomesHeader(NO_VERTEX)).toBe(buildOutcomesHeader(NO_VERTEX));
    expect(aiReviewScaffoldAction(NO_VERTEX)).toBe(aiReviewScaffoldAction(NO_VERTEX));
    // Non-empty FIRST, because `toContain("")` is true of every string — an
    // empty header would satisfy all three assertions in this case, which is
    // the vacuous-assertion shape and was this case's first draft.
    const firstLine = buildOutcomesHeader(NO_VERTEX).split("\n")[0];
    expect(firstLine.length, "the header is empty, so the comparison below is vacuous").toBeGreaterThan(20);
    expect(readFileSync(WORKFLOW, "utf-8")).toContain(firstLine);
  });
});
