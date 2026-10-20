/**
 * The step that hands the diff to the agent, EXECUTED (#732).
 *
 * ## Why this file exists rather than a text assertion
 *
 * The reviewer's whole subject now arrives through
 * `steps.subject.outputs.diff`. A text assertion that the step "writes a
 * heredoc" would have been green over the defect that actually happened:
 *
 * > `##[error]Unable to process file command 'output' successfully.`
 * > `##[error]Invalid value. Matching delimiter not found 'EOF_ed27254a…'`
 *
 * Run **39339388211**, against a 110,547-byte diff. `head -c` cuts mid-line,
 * so the closing delimiter was appended to the end of a partial diff line and
 * GitHub refused the whole `GITHUB_OUTPUT` write. The step died, `auth` and
 * `Review` were skipped, and the only reason anyone saw it is that the
 * post-step this same change adds turned the job red — on the UNMEASURED
 * path, not on a finding.
 *
 * Nothing in the first dispatch could have caught it: that PR's diff was
 * 'under the cap, so the truncation branch had never run. Every natural
 * fixture is a fixture of the feature
 * (`.claude/rules/checks-must-be-able-to-fail.md`, "a battery whose fixtures
 * all meet a precondition"), and the branch on the other side of the cap is
 * the one nobody writes.
 *
 * So the step's own `run:` body is cut out of the workflow and RUN, against a
 * stub `gh` on `PATH` and a temporary `GITHUB_OUTPUT`, and the file it writes
 * is parsed the way the runner parses it.
 *
 * ## The cheapest wrong fix, named
 *
 * **Raise `MAX_BYTES`.** The symptom is one PR failing, and a bigger number
 * makes it stop — until the next PR. The cases here survive it: the cap is
 * read from the step's own `env:` and the fixture is sized relative to it, so
 * a larger cap produces a larger fixture and the truncation branch still runs.
 *
 * The second-cheapest: **drop the heredoc and write the diff to a file
 * instead.** That is arguably the better design, and these cases do not
 * survive it — they would abort in `beforeAll` with "the gather step does not
 * write a heredoc", which is a loud refusal to measure rather than a green
 * pass over a changed mechanism.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobSteps } from "../lib/review-tool-agreement";

const WORKFLOW = join(import.meta.dir, "..", ".github", "workflows", "claude-review.yml");
const source = readFileSync(WORKFLOW, "utf8");

/** The gather step, located by the command it runs rather than by its name. */
const gatherStep = (() => {
  const hits = jobSteps(source).filter(s => /^\s*gh pr diff /m.test(s));
  if (hits.length !== 1) throw new Error(`${hits.length} steps run \`gh pr diff\`, not one`);
  return hits[0];
})();

/**
 * The step's `run:` body, dedented to column zero so bash can run it.
 *
 * Bounded by INDENTATION, not by the end of the step. A step's trailing
 * comment block belongs to the next step's preamble in `jobSteps` (see its
 * docstring), and taking it produced `syntax error near unexpected token '('`
 * from a dedented `# … (#677, AC-15).` — a harness failure that reads exactly
 * like the step being broken.
 */
const runBody = (() => {
  const lines = gatherStep.split("\n");
  const at = lines.findIndex(l => l.trimStart() === "run: |");
  if (at === -1) throw new Error("the gather step has no `run: |` block");
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const base = indentOf(lines[at]);
  const body: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() !== "" && indentOf(lines[i]) <= base) break;
    body.push(lines[i]);
  }
  const indent = indentOf(body[0]);
  const out = body.map(l => l.slice(indent));
  if (!out.join("\n").includes("diff<<")) {
    throw new Error("the gather step does not write a heredoc — this file measures nothing");
  }
  return out.join("\n");
})();

const MAX_BYTES = Number(/MAX_BYTES:\s*"(\d+)"/.exec(gatherStep)?.[1]);

/** `GITHUB_OUTPUT` as the runner reads it: `k=v` lines and `k<<D … D` blocks. */
function parseOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heredoc = /^([A-Za-z0-9_-]+)<<(.+)$/.exec(lines[i]);
    if (heredoc) {
      const [, key, delimiter] = heredoc;
      const body: string[] = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (lines[i] === delimiter) {
          closed = true;
          break;
        }
        body.push(lines[i]);
      }
      if (!closed) {
        throw new Error(`Invalid value. Matching delimiter not found '${delimiter}'`);
      }
      out[key] = body.join("\n");
      continue;
    }
    const scalar = /^([A-Za-z0-9_-]+)=(.*)$/.exec(lines[i]);
    if (scalar) out[scalar[1]] = scalar[2];
  }
  return out;
}

/**
 * Run the real step body with a stub `gh`.
 *
 * `diffBytes` sizes the patch the stub prints. The final line is deliberately
 * long and unterminated at the cut point, which is what a real patch looks
 * like and what the defect needed.
 */
function runGather(diffBytes: number) {
  const dir = mkdtempSync(join(tmpdir(), "r732-gather-"));
  const bin = join(dir, "bin");
  writeFileSync(join(dir, "ignored"), "");
  Bun.spawnSync(["mkdir", "-p", bin]);
  const stub = join(bin, "gh");
  writeFileSync(
    stub,
    `#!/bin/bash
if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then
  # One long unterminated line at the end, which is what a patch hunk is and
  # what makes a byte-cut land mid-line.
  printf 'diff --git a/x b/x\\n'
  head -c ${diffBytes} < /dev/zero | tr '\\0' '+'
  exit 0
fi
if [ "$1" = "api" ]; then echo 3; exit 0; fi
exit 1
`,
  );
  chmodSync(stub, 0o755);
  const outputFile = join(dir, "github_output");
  writeFileSync(outputFile, "");
  const script = join(dir, "step.sh");
  writeFileSync(script, runBody);
  const p = Bun.spawnSync(["bash", script], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_OUTPUT: outputFile,
      GH_TOKEN: "stub",
      PR: "746",
      REPO: "hornjason/pai-harness",
      MAX_BYTES: String(MAX_BYTES),
    },
  });
  return {
    code: p.exitCode,
    stdout: new TextDecoder().decode(p.stdout),
    outputs: () => parseOutputs(readFileSync(outputFile, "utf8")),
  };
}

describe("the gather step hands the agent a diff the runner can actually read (#732)", () => {
  test("AC-0: the step was found and the cap was read — otherwise this file measures nothing", () => {
    expect(MAX_BYTES).toBeGreaterThan(0);
    expect(runBody).toContain("gh pr diff");
    expect(runBody).toContain("reviews_before=");
  });

  /**
   * The control. Under the cap, nothing is truncated and the diff round-trips
   * whole — so a failure in the row below is about the cut and not about the
   * harness.
   */
  test("AC-1: a diff under the cap round-trips whole, truncated=false", () => {
    const r = runGather(Math.floor(MAX_BYTES / 2));
    expect(r.code).toBe(0);
    const o = r.outputs();
    expect(o.truncated).toBe("false");
    expect(o.reviews_before).toBe("3");
    expect(o.diff.length).toBeGreaterThan(MAX_BYTES / 4);
    expect(o.diff).toContain("diff --git a/x b/x");
    expect(o.diff).not.toContain("truncated at");
  });

  /**
   * Run 39339388211, reproduced. The cut lands mid-line; without a newline
   * after it the delimiter is swallowed by that line and `parseOutputs`
   * raises the runner's own message.
   */
  test("AC-2: a diff over the cap is truncated AND the delimiter is still readable", () => {
    const r = runGather(MAX_BYTES * 2);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("::warning::diff truncated");
    const o = r.outputs();
    expect(o.truncated).toBe("true");
    expect(o.reviews_before).toBe("3");
    // The agent is TOLD its subject is incomplete. A silently cut diff is the
    // same defect as a silently skipped review, one layer down.
    expect(o.diff).toContain("*** diff truncated at");
    expect(o.diff.length).toBeGreaterThan(MAX_BYTES - 1000);
  });

  /**
   * The mutation, performed rather than asserted: the line break removed.
   *
   * **The fixture is UNDER the cap, and that is the whole point.** Over the
   * cap the truncation marker ends in a newline of its own, so either line
   * saves the parse and a mutation of one is invisible — two deciders that
   * agree (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
   * Measured rather than argued: with the live workflow intact and this
   * fixture pointed over the cap, the mutant's output parses and bun reports
   * *"Received function did not throw"*. An over-cap fixture cannot witness
   * this mutation at all.
   *
   * The untruncated branch is the input only `echo ""` reaches, and it is the
   * branch nobody writes a fixture for: every real `gh pr diff` happens to
   * end in a newline, so the defect only shows when one does not.
   *
   * `parseOutputs` must raise, and it must raise the RUNNER's sentence — a
   * harness that merely returned a short string would pass this row over a
   * step that still kills the job.
   */
  test("AC-3: without the line break before it, the runner cannot parse the output at all", () => {
    const needle = '  echo ""\n  echo "$d"\n';
    const occurrences = runBody.split(needle).length - 1;
    if (occurrences !== 1) {
      throw new Error(`could not build the mutant: the blank line appears ${occurrences} times`);
    }
    const broken = runBody.replace(needle, '  echo "$d"\n');
    expect(broken, "the mutation did not apply").not.toEqual(runBody);

    const dir = mkdtempSync(join(tmpdir(), "r732-broken-"));
    const bin = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    const stub = join(bin, "gh");
    writeFileSync(
      stub,
      `#!/bin/bash
if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then
  printf 'diff --git a/x b/x\\n'
  head -c ${Math.floor(MAX_BYTES / 2)} < /dev/zero | tr '\\0' '+'
  exit 0
fi
if [ "$1" = "api" ]; then echo 3; exit 0; fi
exit 1
`,
    );
    chmodSync(stub, 0o755);
    const outputFile = join(dir, "github_output");
    writeFileSync(outputFile, "");
    const script = join(dir, "step.sh");
    writeFileSync(script, broken);
    const p = Bun.spawnSync(["bash", script], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: outputFile,
        GH_TOKEN: "stub",
        PR: "746",
        REPO: "hornjason/pai-harness",
        MAX_BYTES: String(MAX_BYTES),
      },
    });
    // bash is happy — which is the whole problem. The runner is not.
    expect(p.exitCode).toBe(0);
    expect(() => parseOutputs(readFileSync(outputFile, "utf8"))).toThrow(
      /Matching delimiter not found/,
    );
  });
});
