#!/usr/bin/env bun
/**
 * SpecSCGuard.hook.ts — PostToolUse on Edit/Write
 *
 * TRIGGER: PostToolUse (matcher: Edit, Write)
 *
 * PURPOSE:
 * Validate new SC lines added to specs/*.md files.
 * Ensures every new SC is either:
 *   1. Matchable by a pattern in config/matcher-registry.json
 *   2. Explicitly marked with (behavioral) suffix
 *
 * BEHAVIOR:
 *   - Strict compliance specs: BLOCK edits adding unmatchable SCs
 *   - Permissive compliance specs: WARN but allow
 *
 * Issue: #591
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseHookInput } from "./lib/parseStdin";
import {
  detectNewSCs,
  validateNewSCs,
  getLastCommittedContent,
  getComplianceMode,
} from "../lib/sc-guard";

interface PostToolUseInput {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    content?: string;
    old_string?: string;
    new_string?: string;
    [k: string]: unknown;
  };
  tool_response?: { output?: string; [k: string]: unknown } | string;
  [k: string]: unknown;
}

async function main() {
  const input = await parseHookInput<PostToolUseInput>();
  if (!input) process.exit(0);

  try {
    const toolName = input.tool_name ?? "";

    // Only process Edit and Write tool calls
    if (toolName !== "Edit" && toolName !== "Write") {
      process.exit(0);
    }

    const filePath = input.tool_input?.file_path ?? "";

    // Only process specs/*.md files
    if (!filePath.match(/specs\/[^/]+\.md$/)) {
      process.exit(0);
    }

    // Read the current file content after the edit
    if (!existsSync(filePath)) {
      console.error(`[SpecSCGuard] File not found after edit: ${filePath}`);
      process.exit(0);
    }

    const newContent = readFileSync(filePath, "utf-8");

    // Get relative path for git operations
    const specsMatch = filePath.match(/(specs\/[^/]+\.md)$/);
    const relativePath = specsMatch ? specsMatch[1] : filePath;

    // Get the previous version from git
    const oldContent = getLastCommittedContent(relativePath);

    // Detect new SC lines
    const newSCs = detectNewSCs(oldContent, newContent);
    if (newSCs.length === 0) {
      console.error("[SpecSCGuard] No new SC lines detected");
      process.exit(0);
    }

    // Get compliance mode from frontmatter
    const compliance = getComplianceMode(newContent);

    // Validate new SCs
    const results = validateNewSCs(newSCs, compliance);
    if (results.length === 0) {
      console.error(`[SpecSCGuard] ${newSCs.length} new SCs validated OK`);
      process.exit(0);
    }

    // Process validation results
    const blocked = results.filter(r => r.blocked);
    const warned = results.filter(r => !r.blocked);

    if (warned.length > 0) {
      const warnMessages = warned.map(r => r.message).join("\n");
      console.error(`[SpecSCGuard] WARN: ${warned.length} SCs without matching patterns:\n${warnMessages}`);
    }

    if (blocked.length > 0) {
      const blockMessages = blocked.map(r => r.message).join("\n");
      const decision = {
        decision: "block",
        reason: `${blocked.length} new SC(s) have no matching pattern and no (behavioral) suffix.\n${blockMessages}`,
      };
      console.log(JSON.stringify(decision));
      console.error(`[SpecSCGuard] BLOCKED: ${blocked.length} unmatchable SCs in strict spec`);
    }

    process.exit(0);
  } catch (err) {
    console.error(`[SpecSCGuard] Error: ${err}`);
    process.exit(0);
  }
}

main();
