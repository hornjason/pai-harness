import { describe, test, expect } from 'bun:test';
import {
  calculateAES,
  AES_WEIGHTS,
  type AESInput,
  type AESResult,
} from '../lib/aes-calculator.js';

/**
 * Helper: build a default AESInput with all scores at a given value.
 */
function makeInput(score = 50): AESInput {
  return {
    compliance: score,
    fileEfficiency: score,
    deliverableRatio: score,
    testDiscipline: score,
    contextDiscipline: score,
  };
}

describe('AES Calculator', () => {
  describe('AES_WEIGHTS', () => {
    test('weights sum to 1.0', () => {
      const sum =
        AES_WEIGHTS.compliance +
        AES_WEIGHTS.fileEfficiency +
        AES_WEIGHTS.deliverableRatio +
        AES_WEIGHTS.testDiscipline +
        AES_WEIGHTS.contextDiscipline;
      expect(sum).toBeCloseTo(1.0);
    });

    test('compliance weight is 0.3', () => {
      expect(AES_WEIGHTS.compliance).toBe(0.3);
    });

    test('fileEfficiency weight is 0.25', () => {
      expect(AES_WEIGHTS.fileEfficiency).toBe(0.25);
    });

    test('deliverableRatio weight is 0.25', () => {
      expect(AES_WEIGHTS.deliverableRatio).toBe(0.25);
    });

    test('testDiscipline weight is 0.1', () => {
      expect(AES_WEIGHTS.testDiscipline).toBe(0.1);
    });

    test('contextDiscipline weight is 0.1', () => {
      expect(AES_WEIGHTS.contextDiscipline).toBe(0.1);
    });
  });

  describe('calculateAES', () => {
    test('returns weighted composite of all five components', () => {
      const input: AESInput = {
        compliance: 100,
        fileEfficiency: 80,
        deliverableRatio: 60,
        testDiscipline: 40,
        contextDiscipline: 20,
      };
      // 100*0.3 + 80*0.25 + 60*0.25 + 40*0.1 + 20*0.1
      // = 30 + 20 + 15 + 4 + 2 = 71
      const result = calculateAES(input);
      expect(result.score).toBe(71);
    });

    test('returns 0 when all inputs are 0', () => {
      const result = calculateAES(makeInput(0));
      expect(result.score).toBe(0);
    });

    test('returns 100 when all inputs are 100', () => {
      const result = calculateAES(makeInput(100));
      expect(result.score).toBe(100);
    });

    test('returns 50 when all inputs are 50', () => {
      const result = calculateAES(makeInput(50));
      expect(result.score).toBe(50);
    });

    test('compliance has the largest impact (0.3)', () => {
      const highCompliance = makeInput(0);
      highCompliance.compliance = 100;
      const highFile = makeInput(0);
      highFile.fileEfficiency = 100;

      const compResult = calculateAES(highCompliance);
      const fileResult = calculateAES(highFile);

      expect(compResult.score).toBeGreaterThan(fileResult.score);
      expect(compResult.score).toBe(30);
      expect(fileResult.score).toBe(25);
    });

    test('result includes grade based on score', () => {
      expect(calculateAES(makeInput(95)).grade).toBe('A');
      expect(calculateAES(makeInput(75)).grade).toBe('B');
      expect(calculateAES(makeInput(60)).grade).toBe('C');
      expect(calculateAES(makeInput(40)).grade).toBe('D');
      expect(calculateAES(makeInput(20)).grade).toBe('F');
    });

    test('result includes the original input scores', () => {
      const input = makeInput(70);
      const result = calculateAES(input);
      expect(result.components).toEqual(input);
    });

    test('rounds score to nearest integer', () => {
      const input: AESInput = {
        compliance: 33,
        fileEfficiency: 67,
        deliverableRatio: 45,
        testDiscipline: 88,
        contextDiscipline: 12,
      };
      // 33*0.3 + 67*0.25 + 45*0.25 + 88*0.1 + 12*0.1
      // = 9.9 + 16.75 + 11.25 + 8.8 + 1.2 = 47.9 → 48
      const result = calculateAES(input);
      expect(result.score).toBe(48);
    });

    test('grade boundary at 90 is A', () => {
      expect(calculateAES(makeInput(90)).grade).toBe('A');
    });

    test('grade boundary at 89 is B', () => {
      // All 89 → 89*1.0 = 89 → B
      expect(calculateAES(makeInput(89)).grade).toBe('B');
    });

    test('grade boundary at 75 is B', () => {
      expect(calculateAES(makeInput(75)).grade).toBe('B');
    });

    test('grade boundary at 74 is C', () => {
      expect(calculateAES(makeInput(74)).grade).toBe('C');
    });

    test('grade boundary at 60 is C', () => {
      expect(calculateAES(makeInput(60)).grade).toBe('C');
    });

    test('grade boundary at 59 is D', () => {
      expect(calculateAES(makeInput(59)).grade).toBe('D');
    });

    test('grade boundary at 40 is D', () => {
      expect(calculateAES(makeInput(40)).grade).toBe('D');
    });

    test('grade boundary at 39 is F', () => {
      expect(calculateAES(makeInput(39)).grade).toBe('F');
    });
  });
});
