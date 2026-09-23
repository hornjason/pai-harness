#!/usr/bin/env bun
import { promoteOutputs } from "../lib/promote-outputs.ts";
import { execSync } from "child_process";

const projectRoot = process.argv[2] || process.cwd();
const result = promoteOutputs(projectRoot);

if (result.promoted.length > 0) {
  console.log(`✅ Promoted: ${result.promoted.join(", ")}`);
  execSync(`git add docs/council/ docs/research/ 2>/dev/null || true`, { cwd: projectRoot });
}
if (result.archived.length > 0) {
  console.log(`📦 Archived ${result.archived.length} stale working dirs`);
}
if (result.errors.length > 0) {
  console.warn(`⚠️  Promote errors: ${result.errors.join(", ")}`);
}
