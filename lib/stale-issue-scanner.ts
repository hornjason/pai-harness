import { readFileSync, existsSync } from "fs";
import { join } from "path";

interface Phase {
  name: string;
  scs: Array<{ id: string; done: boolean }>;
  note?: string;
}

interface ScanResult {
  scanned: number;
  staleIssues: number[];
}

export function findStaleIssues(projectRoot: string): ScanResult {
  const statePath = join(projectRoot, "project-state.json");
  if (!existsSync(statePath)) return { scanned: 0, staleIssues: [] };

  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  const phases: Phase[] = state.phases || [];
  const issuePattern = /#(\d+)/g;
  const staleIssues: number[] = [];

  for (const phase of phases) {
    if (phase.scs.length === 0) continue;
    const allDone = phase.scs.every((sc) => sc.done);
    if (!allDone) continue;

    let match;
    while ((match = issuePattern.exec(phase.name)) !== null) {
      staleIssues.push(parseInt(match[1], 10));
    }
  }

  return { scanned: phases.length, staleIssues: [...new Set(staleIssues)] };
}
