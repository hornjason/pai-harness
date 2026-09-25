/**
 * Centralized Agent Efficiency Score (AES) calculator.
 *
 * Computes a weighted composite score from five component metrics:
 * compliance, file efficiency, deliverable ratio, test discipline,
 * and context discipline.
 */

/** Input scores for AES calculation (each 0-100). */
export interface AESInput {
  compliance: number;
  fileEfficiency: number;
  deliverableRatio: number;
  testDiscipline: number;
  contextDiscipline: number;
}

/** Result of an AES calculation. */
export interface AESResult {
  score: number;
  grade: string;
  components: AESInput;
}

/** Weight assigned to each AES component. Weights sum to 1.0. */
export const AES_WEIGHTS: Readonly<AESInput> = {
  compliance: 0.3,
  fileEfficiency: 0.25,
  deliverableRatio: 0.25,
  testDiscipline: 0.1,
  contextDiscipline: 0.1,
} as const;

/**
 * Compute grade from a numeric score.
 * A >= 90, B >= 75, C >= 60, D >= 40, F < 40.
 */
function gradeFromScore(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/**
 * Calculate the Agent Efficiency Score (AES) from component scores.
 *
 * Formula: compliance*0.3 + fileEfficiency*0.25 + deliverableRatio*0.25
 *        + testDiscipline*0.1 + contextDiscipline*0.1
 */
export function calculateAES(input: AESInput): AESResult {
  const score = Math.round(
    input.compliance * AES_WEIGHTS.compliance +
    input.fileEfficiency * AES_WEIGHTS.fileEfficiency +
    input.deliverableRatio * AES_WEIGHTS.deliverableRatio +
    input.testDiscipline * AES_WEIGHTS.testDiscipline +
    input.contextDiscipline * AES_WEIGHTS.contextDiscipline,
  );

  return {
    score,
    grade: gradeFromScore(score),
    components: input,
  };
}
