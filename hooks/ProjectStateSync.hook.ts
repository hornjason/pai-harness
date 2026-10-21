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
 *
 * REGISTERED, in user scope, on BOTH Write and Edit. The header this replaced
 * carried #898's unregistered declaration and said the hook had never fired.
 * Measured 2026-10-21 by parsing `~/.claude/settings.json`:
 *
 *   PostToolUse  matcher='Write'  bun ${RUNGATE_HOOKS_DIR}/ProjectStateSync.hook.ts
 *   PostToolUse  matcher='Edit'   bun ${RUNGATE_HOOKS_DIR}/ProjectStateSync.hook.ts
 *
 * #898's census counted THIS REPOSITORY's registries and read zero as
 * absence. See `lib/hook-scopes.ts` for the reading that now cannot be taken
 * from one scope (#713, #910).
 *
 * ## The #296 interaction is LIVE, not hypothetical
 *
 * #910 raised it as a question about whether to register: "PROJECT-STATE.md is
 * DA-owned and an agent in a worktree must never write it (#296), so a
 * PostToolUse hook firing on any agent's write is a decision with blast
 * radius". That is the current configuration, taken by default, and it is
 * still open — it is a decision for Jason, not something to settle by
 * deregistering a hook from a user config an agent must not edit.
 *
 * What this hook can do is stop the question being unanswerable. Every
 * decision on a `project-state.json` write now records the file path and the
 * cwd in `hook-firings.jsonl` under the rungate work dir, so whether a
 * worktree agent has ever triggered it is a question the evidence answers
 * rather than an argument about blast radius.
 *
 * Only `project-state.json` writes are recorded. This hook is attached to
 * EVERY Write and Edit in every session, and a record per call is a file
 * nobody can read.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { parseHookInput } from "./lib/parseStdin";
import { errorFacts, recordHookFiring } from "../lib/hook-evidence";

const HOOK = "ProjectStateSync";

const input = await parseHookInput();
if (!input) process.exit(0);

const filePath: string = input.tool_input?.file_path || "";
// Out of population: this hook has nothing to say about any other write, and
// records nothing. Everything below IS in population, and every path out of
// it leaves a record — a decline and a hook that never ran are otherwise the
// same observation, which is #910.
if (!filePath.endsWith("project-state.json")) process.exit(0);

const projectRoot = filePath.replace(/\/project-state\.json$/, "");
const script = join(projectRoot, "scripts", "update-project-state.ts");
const cwd = (input as { cwd?: string }).cwd;

if (!existsSync(script)) {
  recordHookFiring(HOOK, "declined-no-generator", { filePath, cwd, script });
  process.exit(0);
}

try {
  execSync(`bun ${script} --skip-tests`, {
    cwd: projectRoot,
    stdio: "pipe",
    timeout: 10000,
  });
  recordHookFiring(HOOK, "synced", { filePath, cwd, script });
  console.log("✅ PROJECT-STATE.md synced from project-state.json");
} catch (e: any) {
  // The generator's message is not recorded: it quotes the argv that
  // produced it (#970 review, finding 2).
  recordHookFiring(HOOK, "sync-failed", { filePath, cwd, script, ...errorFacts(e) });
  console.error(`WARN: PROJECT-STATE.md sync failed: ${e.message}`);
}
