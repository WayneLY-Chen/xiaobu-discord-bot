import type { Tool, ToolResult } from './types.js';
import { requireString, validateArgs } from './types.js';

const MAX_EXPRESSION_LENGTH = 200;

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

const FUNCTIONS: Record<string, { arity: number; apply: (args: number[]) => number }> = {
  sqrt: { arity: 1, apply: ([x]) => Math.sqrt(x ?? 0) },
  abs: { arity: 1, apply: ([x]) => Math.abs(x ?? 0) },
  round: { arity: 1, apply: ([x]) => Math.round(x ?? 0) },
  floor: { arity: 1, apply: ([x]) => Math.floor(x ?? 0) },
  ceil: { arity: 1, apply: ([x]) => Math.ceil(x ?? 0) },
  ln: { arity: 1, apply: ([x]) => Math.log(x ?? 0) },
  log: { arity: 1, apply: ([x]) => Math.log10(x ?? 0) },
  sin: { arity: 1, apply: ([x]) => Math.sin(x ?? 0) },
  cos: { arity: 1, apply: ([x]) => Math.cos(x ?? 0) },
  tan: { arity: 1, apply: ([x]) => Math.tan(x ?? 0) },
  min: { arity: 2, apply: (args) => Math.min(...args) },
  max: { arity: 2, apply: (args) => Math.max(...args) },
  pow: { arity: 2, apply: ([a, b]) => (a ?? 0) ** (b ?? 0) },
};

export class CalculationError extends Error {}

/**
 * 安全的算式求值。
 *
 * **絕對不用 eval 或 new Function**（規格 §28：不要讓 AI 直接執行任意程式碼）——
 * 這裡是自己寫的遞迴下降解析器，只認得數字、四則運算、括號與白名單內的函式。
 * 就算模型被誘導產生 `process.exit()` 之類的字串，也只會得到語法錯誤。
 */
export function evaluateExpression(input: string): number {
  if (input.length > MAX_EXPRESSION_LENGTH) {
    throw new CalculationError(`算式太長了（上限 ${MAX_EXPRESSION_LENGTH} 個字元）。`);
  }

  const parser = new Parser(input);
  const value = parser.parseExpression();
  parser.expectEnd();

  if (!Number.isFinite(value)) {
    throw new CalculationError('計算結果不是有限的數字（可能除以零或超出範圍）。');
  }

  return value;
}

class Parser {
  private position = 0;

  constructor(private readonly source: string) {}

  parseExpression(): number {
    let value = this.parseTerm();

    for (;;) {
      const operator = this.peekOperator(['+', '-']);
      if (!operator) return value;

      this.position += 1;
      const right = this.parseTerm();
      value = operator === '+' ? value + right : value - right;
    }
  }

  expectEnd(): void {
    this.skipSpaces();
    if (this.position < this.source.length) {
      throw new CalculationError(`看不懂算式裡的「${this.source.slice(this.position)}」。`);
    }
  }

  private parseTerm(): number {
    let value = this.parseFactor();

    for (;;) {
      const operator = this.peekOperator(['*', '/', '%', '×', '÷']);
      if (!operator) return value;

      this.position += 1;
      const right = this.parseFactor();

      if ((operator === '/' || operator === '÷' || operator === '%') && right === 0) {
        throw new CalculationError('不能除以零。');
      }

      if (operator === '*' || operator === '×') value *= right;
      else if (operator === '%') value %= right;
      else value /= right;
    }
  }

  /** 次方是右結合：2^3^2 是 2^(3^2)。 */
  private parseFactor(): number {
    const base = this.parseUnary();

    this.skipSpaces();
    if (this.source[this.position] === '^') {
      this.position += 1;
      return base ** this.parseFactor();
    }

    return base;
  }

  private parseUnary(): number {
    this.skipSpaces();
    const char = this.source[this.position];

    if (char === '-') {
      this.position += 1;
      return -this.parseUnary();
    }

    if (char === '+') {
      this.position += 1;
      return this.parseUnary();
    }

    return this.parsePrimary();
  }

  private parsePrimary(): number {
    this.skipSpaces();
    const char = this.source[this.position];

    if (char === undefined) throw new CalculationError('算式不完整。');

    if (char === '(') {
      this.position += 1;
      const value = this.parseExpression();
      this.expect(')');
      return value;
    }

    if (/[0-9.]/.test(char)) return this.parseNumber();
    if (/[a-zA-Z]/.test(char)) return this.parseNameOrCall();

    throw new CalculationError(`算式裡有看不懂的符號「${char}」。`);
  }

  private parseNumber(): number {
    const start = this.position;
    while (/[0-9._]/.test(this.source[this.position] ?? '')) this.position += 1;

    // 支援科學記號 1e5 / 1.2e-3
    if (/[eE]/.test(this.source[this.position] ?? '')) {
      const save = this.position;
      this.position += 1;
      if (/[+-]/.test(this.source[this.position] ?? '')) this.position += 1;

      if (/[0-9]/.test(this.source[this.position] ?? '')) {
        while (/[0-9]/.test(this.source[this.position] ?? '')) this.position += 1;
      } else {
        this.position = save;
      }
    }

    const text = this.source.slice(start, this.position).replaceAll('_', '');
    const value = Number(text);

    if (!Number.isFinite(value)) throw new CalculationError(`「${text}」不是有效的數字。`);
    return value;
  }

  private parseNameOrCall(): number {
    const start = this.position;
    while (/[a-zA-Z0-9]/.test(this.source[this.position] ?? '')) this.position += 1;

    const name = this.source.slice(start, this.position).toLowerCase();

    this.skipSpaces();
    if (this.source[this.position] !== '(') {
      const constant = CONSTANTS[name];
      if (constant === undefined) throw new CalculationError(`不認得「${name}」。`);
      return constant;
    }

    const fn = FUNCTIONS[name];
    if (!fn) throw new CalculationError(`不支援 ${name}() 這個函式。`);

    this.position += 1;
    const args = [this.parseExpression()];

    this.skipSpaces();
    while (this.source[this.position] === ',') {
      this.position += 1;
      args.push(this.parseExpression());
      this.skipSpaces();
    }

    this.expect(')');

    if (args.length !== fn.arity) {
      throw new CalculationError(`${name}() 需要 ${fn.arity} 個參數，收到 ${args.length} 個。`);
    }

    return fn.apply(args);
  }

  private peekOperator(operators: string[]): string | undefined {
    this.skipSpaces();
    const char = this.source[this.position];
    return char !== undefined && operators.includes(char) ? char : undefined;
  }

  private expect(char: string): void {
    this.skipSpaces();
    if (this.source[this.position] !== char) {
      throw new CalculationError(`算式裡少了「${char}」。`);
    }
    this.position += 1;
  }

  private skipSpaces(): void {
    while (/\s/.test(this.source[this.position] ?? '')) this.position += 1;
  }
}

export const calculatorTool: Tool = {
  definition: {
    name: 'calculate',
    description:
      '計算數學算式。支援 + - * / % ^、括號，以及 sqrt abs round floor ceil ln log sin cos tan min max pow 與常數 pi、e。' +
      '需要精確的數值計算時使用，不要自己心算。',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: '要計算的算式，例如 (1+2)*3 或 sqrt(16)+pow(2,10)',
        },
      },
      required: ['expression'],
    },
  },

  async execute(args): Promise<ToolResult> {
    const validated = validateArgs(calculatorTool.definition.parameters, args);
    if (!validated.ok) return { text: `參數有問題：${validated.message}` };

    const expression = requireString(validated.value, 'expression');

    try {
      const value = evaluateExpression(expression);
      return { text: `${expression} = ${formatNumber(value)}` };
    } catch (error) {
      const reason = error instanceof CalculationError ? error.message : '算式無法計算。';
      return { text: `計算失敗：${reason}` };
    }
  },
};

/** 避免 0.1+0.2 這種浮點誤差直接印成 0.30000000000000004。 */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);

  const rounded = Number(value.toPrecision(12));
  return String(rounded);
}
