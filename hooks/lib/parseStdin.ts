/**
 * Shared Stdin Parsing
 *
 * Centralizes JSON stdin reading used by all hooks.
 * Single source of truth — replaces stream, text, and event patterns.
 *
 * Issue: #370 (extracted from 34 hooks)
 */

export interface HookInput {
  tool_name?: string;
  tool_input?: { command?: string; file_path?: string; prompt?: string; [k: string]: unknown };
  tool_response?: { output?: string; [k: string]: unknown } | string;
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  [k: string]: unknown;
}

/**
 * Read and parse JSON from stdin with timeout.
 * Returns parsed object or null on failure/timeout/empty.
 */
export async function parseHookInput<T = HookInput>(timeoutMs = 2000): Promise<T | null> {
  try {
    const raw = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('stdin timeout')), timeoutMs),
      ),
    ]);
    if (!raw?.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
