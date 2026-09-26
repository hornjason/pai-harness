/**
 * Canary testing — plant known values in agent briefs, verify agents act on them.
 *
 * A "canary" is a unique phrase or instruction planted in a generated file.
 * After the agent runs, the transcript is checked for evidence the canary
 * was read AND followed (not just opened). This closes the gap between
 * "file was loaded" and "instruction was processed."
 *
 * Pattern per D-5 in INSTRUCTION-COMPLIANCE-SPEC.md.
 */

import { randomBytes } from "crypto";

export interface CanaryDefinition {
  id: string;
  phrase: string;
  location: "brief" | "agents-md" | "rungate-json" | "code-map";
  expectedBehavior: string;
  checkFn: (transcript: string) => boolean;
}

export interface CanaryResult {
  id: string;
  planted: boolean;
  triggered: boolean;
  phrase: string;
  location: string;
}

export interface CanaryReport {
  total: number;
  triggered: number;
  score: number;
  results: CanaryResult[];
  ts: string;
}

/**
 * Generate a unique canary phrase that won't collide with real content.
 * Format: CANARY-{hex} to make transcript grep trivial.
 */
export function generateCanaryPhrase(): string {
  return `CANARY-${randomBytes(4).toString("hex")}`;
}

/**
 * Built-in canary definitions — these test core agent behaviors.
 */
export function getDefaultCanaries(): CanaryDefinition[] {
  const phrase1 = generateCanaryPhrase();
  const phrase2 = generateCanaryPhrase();

  return [
    {
      id: "C-1",
      phrase: phrase1,
      location: "brief",
      expectedBehavior: "Agent mentions the canary phrase in its output or follows the instruction it wraps",
      checkFn: (transcript) => transcript.includes(phrase1),
    },
    {
      id: "C-2",
      phrase: phrase2,
      location: "agents-md",
      expectedBehavior: "Agent references the canary value when describing its approach",
      checkFn: (transcript) => transcript.includes(phrase2),
    },
  ];
}

/**
 * Plant canary values into a brief string.
 * Returns the modified brief and the canaries that were planted.
 */
export function plantCanaries(
  brief: string,
  canaries: CanaryDefinition[],
): { brief: string; planted: CanaryDefinition[] } {
  let result = brief;
  const planted: CanaryDefinition[] = [];

  for (const canary of canaries) {
    if (canary.location !== "brief") continue;

    const instruction = `\n## Canary Check\nWhen reporting results, include this verification token: ${canary.phrase}\n`;
    result += instruction;
    planted.push(canary);
  }

  return { brief: result, planted };
}

/**
 * Check transcript against planted canaries. Returns a report.
 */
export function checkCanaries(
  transcript: string,
  canaries: CanaryDefinition[],
): CanaryReport {
  const results: CanaryResult[] = canaries.map((c) => ({
    id: c.id,
    planted: true,
    triggered: c.checkFn(transcript),
    phrase: c.phrase,
    location: c.location,
  }));

  const triggered = results.filter((r) => r.triggered).length;

  return {
    total: results.length,
    triggered,
    score: results.length > 0 ? Math.round((triggered / results.length) * 100) : 100,
    results,
    ts: new Date().toISOString(),
  };
}
