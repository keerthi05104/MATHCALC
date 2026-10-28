const DIFFICULTY = {
  easy: { add: [1, 20], mul: [1, 10], sub: [1, 20], div: [1, 10] },
  medium: { add: [10, 100], mul: [2, 15], sub: [10, 100], div: [2, 15] },
  hard: { add: [50, 500], mul: [5, 30], sub: [50, 500], div: [5, 30] }
};

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (items) => items[rand(0, items.length - 1)];

export function generateQuestion(difficulty = 'easy', used = new Set()) {
  const ranges = DIFFICULTY[difficulty] || DIFFICULTY.easy;
  const operations = ['+', '-', '×', '÷'];
  for (let tries = 0; tries < 100; tries++) {
    const op = pick(operations);
    const [min, max] = op === '+' ? ranges.add : op === '-' ? ranges.sub : op === '×' ? ranges.mul : ranges.div;
    let a = rand(min, max), b = rand(min, max), answer;
    if (op === '+') answer = a + b;
    if (op === '-') {
      // Keep subtraction meaningful while allowing negative answers at harder levels.
      if (Math.random() < 0.8 && a < b) [a, b] = [b, a];
      answer = a - b;
    }
    if (op === '×') answer = a * b;
    if (op === '÷') {
      b = rand(min, max);
      answer = rand(1, max);
      a = b * answer;
    }
    const text = `${a} ${op} ${b}`;
    if (!used.has(text)) {
      used.add(text);
      return { id: crypto.randomUUID(), text, answer: String(answer), operation: op, a, b };
    }
  }
  // Extremely unlikely fallback if used set is large.
  const a = rand(1, 9), b = rand(1, 9);
  return { id: crypto.randomUUID(), text: `${a} + ${b}`, answer: String(a + b), operation: '+', a, b };
}

export function publicQuestion(q) {
  return { id: q.id, text: q.text, sequence: q.sequence };
}
