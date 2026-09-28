/**
 * SpecConformityTrigger — PostToolUse hook that auto-runs conformity
 *
 * SC-370 (HOOK-ARCHITECTURE-SPEC): Hook SC traceability
 * SC-371 (HOOK-ARCHITECTURE-SPEC): No hook exceeds 150 lines
 * when spec files are modified via Edit or Write.
 *
 * Thin trigger: detects the event, delegates to lib/spec-change-conformity.
 *
 * Issue: #581
 */

import { parseHookInput } from "./lib/parseStdin";
import { isSpecFile, runSpecChangeConformity } from "../lib/spec-change-conformity";

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  const toolName = input.tool_name;
  if (toolName !== "Edit" && toolName !== "Write") process.exit(0);

  const filePath = input.tool_input?.file_path;
  if (!filePath || !isSpecFile(filePath)) process.exit(0);

  try {
    const projectRoot = process.cwd();
    const result = runSpecChangeConformity(projectRoot);

    if (result.flippedCount > 0) {
      console.error(`[SpecConformityTrigger] Flipped ${result.flippedCount} checkbox(es)`);
    }
    if (result.failing.length > 0) {
      console.error(`[SpecConformityTrigger] ${result.failing.length} SC(s) still failing`);
    }
  } catch (err) {
    console.error(`[SpecConformityTrigger] Error: ${err}`);
  }

  process.exit(0);
}

main();
