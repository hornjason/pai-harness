import { afterAll } from "bun:test";
import { readFileSync, appendFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

const WORK_DIR = join(process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate"));
const STATE_DIR = join(process.env.HOME || "", ".claude", "state");
const RESULTS_PATH = join(STATE_DIR, "gate-results.jsonl");
const RECURRENCE_THRESHOLD = 3;

function findActiveWorkflow(): string | null {
  const testDir = process.env.TEST_WORK_DIR;
  if (testDir) {
    const wfPath = join(testDir, "workflow-state.json");
    return existsSync(wfPath) ? wfPath : null;
  }
  if (!existsSync(WORK_DIR)) return null;
  let newest: { path: string; mtime: number } | null = null;
  for (const entry of readdirSync(WORK_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const wfPath = join(WORK_DIR, entry.name, "workflow-state.json");
    if (!existsSync(wfPath)) continue;
    const stat = statSync(wfPath);
    if (!newest || stat.mtimeMs > newest.mtime) {
      newest = { path: wfPath, mtime: stat.mtimeMs };
    }
  }
  return newest?.path ?? null;
}

function findActiveIssue(): number | null {
  const wfPath = findActiveWorkflow();
  if (!wfPath) return null;
  try {
    return JSON.parse(readFileSync(wfPath, "utf-8")).issue ?? null;
  } catch { return null; }
}

function checkRecurrence(): string[] {
  if (!existsSync(RESULTS_PATH)) return [];
  const lines = readFileSync(RESULTS_PATH, "utf-8").trim().split("\n");
  const failCounts = new Map<string, number>();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.result === "fail") failCounts.set(entry.testName, (failCounts.get(entry.testName) || 0) + 1);
    } catch { /* skip */ }
  }
  const recurring: string[] = [];
  for (const [name, count] of failCounts) {
    if (count >= RECURRENCE_THRESHOLD) recurring.push(`[learn] recurring failure (${count}x): ${name}`);
  }
  return recurring;
}

const capturedTests: { testName: string; result: string }[] = [];

afterAll(() => {
  const issueNumber = findActiveIssue();

  if (existsSync(STATE_DIR)) {
    for (const t of capturedTests) {
      appendFileSync(RESULTS_PATH, JSON.stringify({
        ts: new Date().toISOString(),
        testName: t.testName,
        result: t.result,
        issueNumber,
      }) + "\n");
    }
  }

  const recurring = checkRecurrence();
  for (const msg of recurring) console.log(msg);
});

export function recordTest(name: string, passed: boolean) {
  capturedTests.push({ testName: name, result: passed ? "pass" : "fail" });
}
