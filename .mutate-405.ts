#!/usr/bin/env bun
/** #405 mutation battery. Scratch — delete before the PR. */
import { readFileSync, writeFileSync } from "fs";
import { spawnSync, execFileSync } from "child_process";

const SUITE = ["test/prove-label-gate.test.ts"];

const MUTATIONS = [
  {
    name: "the authenticated read failure allows instead of refusing (the fail-open, restored)",
    file: "lib/prove-label-gate.ts",
    anchor: "  return {\n    verdict: \"REFUSE\",\n    message:\n      \"Close gate blocked: a token was present and the issue's labels still could not be read \" +",
    replace: "  return { verdict: \"ALLOW\", message: null };\n  return {\n    verdict: \"REFUSE\",\n    message:\n      \"Close gate blocked: a token was present and the issue's labels still could not be read \" +",
  },
  {
    name: "an unreadable label set is treated as no labels",
    file: "lib/prove-label-gate.ts",
    anchor: "  const detail = read.error instanceof Error ? read.error.message : String(read.error ?? \"no error reported\");",
    replace: "  return { verdict: \"ALLOW\", message: null };\n  const detail = read.error instanceof Error ? read.error.message : String(read.error ?? \"no error reported\");",
  },
  {
    name: "the token-less case refuses too (every local run blocked)",
    file: "lib/prove-label-gate.ts",
    anchor: "  if (!read.tokenPresent) {",
    replace: "  if (false) {",
  },
  {
    name: "the token-less case ALLOWS (UNMEASURED collapsed into clean)",
    file: "lib/prove-label-gate.ts",
    anchor: "      verdict: \"UNMEASURED\",",
    replace: "      verdict: \"ALLOW\",",
  },
  {
    name: "the two refusal texts become the same string",
    file: "lib/prove-label-gate.ts",
    anchor: "      \"Close gate blocked: a token was present and the issue's labels still could not be read \" +",
    replace: "      \"Close gate blocked: the issue carries `needs-prove` and not `proven`. \" +",
  },
  {
    name: "the detail is dropped from the refusal",
    file: "lib/prove-label-gate.ts",
    anchor: "      `(${detail}). \"No blocking label\" and \"could not find out\" are different facts, and this ` +",
    replace: "      `. \"No blocking label\" and \"could not find out\" are different facts, and this ` +",
  },
  {
    name: "the gate goes back to catch-and-return",
    file: "gates/workflow.test.ts",
    anchor: "      } catch (e) {\n        read = { error: e, tokenPresent };\n      }",
    replace: "      } catch (e) {\n        return;\n      }",
  },
  {
    name: "the gate reads the env directly instead of resolveGitHubToken",
    file: "gates/workflow.test.ts",
    anchor: "    const tokenPresent = Boolean(resolveGitHubToken());",
    replace: "    const tokenPresent = Boolean(process.env.GITHUB_TOKEN);",
  },
  {
    name: "the gate check is renamed, so the source guards read an empty slice",
    file: "gates/workflow.test.ts",
    anchor: "  test(\"prove-label-enforcement: needs-prove requires proven label\", async () => {",
    replace: "  test(\"prove-label-enforcement: needs-prove must carry proven\", async () => {",
  },
  {
    name: "the planted read becomes the verdict (the fixture buys a pass)",
    file: "lib/prove-label-gate.ts",
    anchor: "  return { labels: parsed as string[], tokenPresent: true };",
    replace: "  return { labels: [] as string[], tokenPresent: true };",
  },
  {
    name: "malformed fixture content falls back to the live read instead of throwing",
    file: "lib/prove-label-gate.ts",
    anchor: "    throw new Error(`${LABEL_FIXTURE_ENV} is not valid JSON: ${(e as Error).message}`);",
    replace: "    return null;",
  },
  {
    name: "a non-array fixture is accepted",
    file: "lib/prove-label-gate.ts",
    anchor: "  if (!Array.isArray(parsed) || parsed.some((l) => typeof l !== \"string\")) {",
    replace: "  if (false) {",
  },
];

function summary(out: string) {
  const passes = [...out.matchAll(/^\s*(\d+) pass$/gm)].map(m => Number(m[1]));
  const fails = [...out.matchAll(/^\s*(\d+) fail$/gm)].map(m => Number(m[1]));
  const names = [...out.matchAll(/^\(fail\) (.*)$/gm)].map(m => m[1]!.trim());
  return { pass: passes.at(-1) ?? 0, fail: fails.at(-1) ?? 0, names };
}

const verbose = process.argv.includes("--names");

for (const m of MUTATIONS) {
  const src = readFileSync(m.file, "utf-8");
  const count = src.split(m.anchor).length - 1;
  if (count !== 1) {
    console.log(`| ${m.name} | NOT APPLIED — anchor appears ${count} times in ${m.file} |`);
    continue;
  }
  writeFileSync(m.file, src.replace(m.anchor, m.replace));
  const r = spawnSync("bun", ["test", ...SUITE], { encoding: "utf-8", timeout: 300000 });
  const s = summary(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  execFileSync("git", ["checkout", "--", m.file]);
  console.log(`| ${m.name} | ${s.fail} of ${s.fail + s.pass} |`);
  if (verbose) for (const n of s.names) console.log(`      - ${n}`);
}
