import { describe, expect, it } from 'vitest';
import { CalculationError, calculatorTool, evaluateExpression } from '../src/ai/tools/calculator.js';

function evaluate(expression: string): number {
  return evaluateExpression(expression);
}

describe('算式求值', () => {
  it('四則運算與優先順序', () => {
    expect(evaluate('1+2')).toBe(3);
    expect(evaluate('2+3*4')).toBe(14);
    expect(evaluate('(2+3)*4')).toBe(20);
    expect(evaluate('10-2-3')).toBe(5);
    expect(evaluate('100/4/5')).toBe(5);
    expect(evaluate('7%3')).toBe(1);
  });

  it('次方是右結合', () => {
    expect(evaluate('2^3')).toBe(8);
    expect(evaluate('2^3^2')).toBe(512);
  });

  it('一元正負號', () => {
    expect(evaluate('-5')).toBe(-5);
    expect(evaluate('-(2+3)')).toBe(-5);
    expect(evaluate('3 - -2')).toBe(5);
    expect(evaluate('+7')).toBe(7);
  });

  it('函式與常數', () => {
    expect(evaluate('sqrt(16)')).toBe(4);
    expect(evaluate('abs(-3)')).toBe(3);
    expect(evaluate('round(2.6)')).toBe(3);
    expect(evaluate('min(3,7)')).toBe(3);
    expect(evaluate('max(3,7)')).toBe(7);
    expect(evaluate('pow(2,10)')).toBe(1024);
    expect(evaluate('pi')).toBeCloseTo(Math.PI);
  });

  it('全形乘除號也吃得下 —— 中文輸入法常打出這個', () => {
    expect(evaluate('6×7')).toBe(42);
    expect(evaluate('84÷2')).toBe(42);
  });

  it('科學記號與底線分隔', () => {
    expect(evaluate('1e3')).toBe(1000);
    expect(evaluate('1.5e-2')).toBe(0.015);
    expect(evaluate('1_000_000')).toBe(1_000_000);
  });

  it('空白不影響結果', () => {
    expect(evaluate('  1 +  2 * ( 3 - 1 )  ')).toBe(5);
  });

  it('除以零會被擋下，不會回傳 Infinity', () => {
    expect(() => evaluate('1/0')).toThrow(CalculationError);
    expect(() => evaluate('1%0')).toThrow(CalculationError);
  });

  it('拒絕任何看起來像程式碼的東西 —— 這裡不是 eval', () => {
    const attacks = [
      'process.exit(1)',
      'require("fs")',
      'globalThis',
      'constructor',
      '[].constructor',
      '1;console.log(1)',
      'this',
      '__proto__',
      'fetch("http://evil")',
      '(function(){return 1})()',
    ];

    for (const attack of attacks) {
      expect(() => evaluate(attack), `${attack} 不該被接受`).toThrow(CalculationError);
    }
  });

  it('語法錯誤會回報而不是靜默給出怪答案', () => {
    expect(() => evaluate('1+')).toThrow(CalculationError);
    expect(() => evaluate('(1+2')).toThrow(CalculationError);
    expect(() => evaluate('1+2)')).toThrow(CalculationError);
    expect(() => evaluate('sqrt()')).toThrow(CalculationError);
    expect(() => evaluate('sqrt(1,2)')).toThrow(CalculationError);
  });

  it('過長的算式直接拒絕，避免有人拿它當 CPU 消耗器', () => {
    expect(() => evaluate('1+'.repeat(200) + '1')).toThrow(/太長/);
  });

  it('修掉浮點誤差的尾巴', () => {
    expect(evaluate('0.1+0.2')).toBeCloseTo(0.3);
  });
});

describe('calculate 工具', () => {
  const context = {} as never;

  it('回傳算式與結果', async () => {
    const result = await calculatorTool.execute({ expression: '(1+2)*3' }, context);
    expect(result.text).toBe('(1+2)*3 = 9');
  });

  it('0.1+0.2 不會印出一長串浮點誤差', async () => {
    const result = await calculatorTool.execute({ expression: '0.1+0.2' }, context);
    expect(result.text).toBe('0.1+0.2 = 0.3');
  });

  it('算不出來時回傳錯誤說明給模型，而不是拋例外', async () => {
    const result = await calculatorTool.execute({ expression: 'require("fs")' }, context);

    expect(result.text).toContain('計算失敗');
    expect(result.sources).toBeUndefined();
  });

  it('缺少參數時回報，不會當掉', async () => {
    const result = await calculatorTool.execute({}, context);
    expect(result.text).toContain('缺少必填參數 expression');
  });
});
