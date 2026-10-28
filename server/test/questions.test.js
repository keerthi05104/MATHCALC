import { describe, it, expect } from 'vitest';
import { generateQuestion } from '../src/questions.js';

describe('question generation', () => {
  it('generates answers that match the displayed expression', () => {
    for (let i = 0; i < 200; i++) {
      const q = generateQuestion('medium', new Set());
      const expected = q.operation === '+' ? q.a + q.b
        : q.operation === '-' ? q.a - q.b
        : q.operation === '×' ? q.a * q.b
        : q.a / q.b;
      expect(Number(q.answer)).toBe(expected);
      expect(Number.isInteger(Number(q.answer))).toBe(true);
      if (q.operation === '÷') expect(q.a % q.b).toBe(0);
    }
  });
});
