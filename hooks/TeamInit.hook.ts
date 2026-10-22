#!/usr/bin/env bun
/**
 * TeamInit.hook.ts — Ensure team directory exists for current session (SessionStart)
 *
 * Governing SCs: SC-370 (traceability), SC-371 (thin trigger, under 150 lines)
 *
 * PURPOSE:
 * Creates <claude-config-dir>/teams/session-{id}/config.json when missing.
 * Fixes typed agent spawns failing after context compaction with
 * "team file not found".
 *
 * TRIGGER: SessionStart
 *
 * INPUT:
 * - env: CLAUDE_CODE_SESSION_ID (full UUID, first 8 chars used)
 *
 * OUTPUT:
 * - stdout: None (never)
 * - stderr: Minimal status (dir created / already exists)
 * - exit(0): Always
 *
 * SIDE EFFECTS:
 * - Creates: <claude-config-dir>/teams/session-{id}/config.json (if missing)
 *
 * ERROR HANDLING:
 * - CLAUDE_CODE_SESSION_ID not set: exit 0 silently
 * - Existing valid config.json: no-op (idempotent)
 * - All errors: exit 0 (never block session start)
 *
 * PORTABILITY (#713): `getPaiDir()` resolves `PAI_DIR` and otherwise
 * `~/.claude` — Claude Code's OWN configuration directory, which is where
 * `teams/` lives on every machine running Claude Code, PAI installed or not.
 * The function name is PAI-flavoured; the directory it returns is not, and
 * the bug this fixes reaches any agent-spawning product equally.
 *
 * Fixes: #151
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPaiDir } from './lib/paths';

const sessionId = process.env.CLAUDE_CODE_SESSION_ID;

// Guard: no session ID → exit silently
if (!sessionId) {
  process.exit(0);
}

try {
  const shortId = sessionId.substring(0, 8);
  const teamDir = join(getPaiDir(), 'teams', `session-${shortId}`);
  const configPath = join(teamDir, 'config.json');

  // Check if config already exists and is valid JSON
  if (existsSync(configPath)) {
    try {
      JSON.parse(readFileSync(configPath, 'utf-8'));
      // Valid JSON exists — idempotent no-op
      process.exit(0);
    } catch {
      // Invalid JSON — overwrite below
      console.error(`[TeamInit] Invalid config.json at ${configPath} — recreating`);
    }
  }

  // Create directory if missing
  if (!existsSync(teamDir)) {
    mkdirSync(teamDir, { recursive: true });
  }

  // Write minimal config
  const config = {
    session_id: `session-${shortId}`,
    created: new Date().toISOString(),
  };

  writeFileSync(configPath, JSON.stringify(config), 'utf-8');
  console.error(`[TeamInit] Created team config: session-${shortId}`);
} catch (err) {
  // Never block session start
  console.error(`[TeamInit] Error (non-fatal): ${String(err).slice(0, 80)}`);
}

process.exit(0);
