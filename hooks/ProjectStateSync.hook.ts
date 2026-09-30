#!/usr/bin/env bun
/**
 * ProjectStateSync.hook.ts — Auto-regenerate PROJECT-STATE.md when project-state.json changes
 *
 * SC-370 (HOOK-ARCHITECTURE-SPEC): Hook SC traceability
 * SC-371 (HOOK-ARCHITECTURE-SPEC): No hook exceeds 150 lines
 *
 * TRIGGER: PostToolUse (Write/Edit)
 *
 * Thin trigger: runs update-project-state.ts when project-state.json is modified.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { parseHookInput } from "./lib/parseStdin";

const input = await parseHookInput();
if (!input) process.exit(0);

const filePath: string = input.tool_input?.file_path || "";
if (!filePath.endsWith("project-state.json")) process.exit(0);

const projectRoot = filePath.replace(/\/project-state\.json$/, "");
const script = join(projectRoot, "scripts", "update-project-state.ts");

if (!existsSync(script)) process.exit(0);

try {
  execSync(`bun ${script} --skip-tests`, {
    cwd: projectRoot,
    stdio: "pipe",
    timeout: 10000,
  });
  console.log("✅ PROJECT-STATE.md synced from project-state.json");
} catch (e: any) {
  console.error(`WARN: PROJECT-STATE.md sync failed: ${e.message}`);
}
