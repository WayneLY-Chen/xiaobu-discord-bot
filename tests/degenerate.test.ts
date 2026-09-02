import { describe, expect, it } from 'vitest';
import { isDegenerate } from '../src/ai/providers/output.js';

/** 實際發生過的壞掉回覆：問「現在幾點？」回了 2,705 字元，只有 133 個是真正的字。 */
const REAL_INCIDENT = `現在是台北時間 2026/09/02 22:22~? \n\n（其實  ​    \n\n${'\n\n...\n\n…\n\n......\n\n… \n\n'.repeat(
  90,
)}看起來我剛剛的回覆有點怪怪的，抱歉啦！現在是 2026/09/02 22:01（台北時間）。有什麼想聊的嗎？🙂`;

describe('重複迴圈偵測', () => {
  it('抓得到實際發生過的那則省略號洗版', () => {
    expect(REAL_INCIDENT.length).toBeGreaterThan(2000);
    expect(isDegenerate(REAL_INCIDENT)).toBe(true);
  });

  it('正常的長回覆不會被誤判', () => {
    const normal =
      '台北現在是陰天，氣溫大約 27 度半左右，濕度還蠻高的。不過接下來幾天降雨機率很高喔，'.repeat(12);

    expect(normal.length).toBeGreaterThan(300);
    expect(isDegenerate(normal)).toBe(false);
  });

  it('短回覆一律放行 —— 只有符號或表情是正常的說話方式', () => {
    expect(isDegenerate('……')).toBe(false);
    expect(isDegenerate('🙂')).toBe(false);
    expect(isDegenerate('...'.repeat(30))).toBe(false);
  });

  it('長的程式碼區塊不會被誤判成壞掉', () => {
    const code = ['```ts', 'const x = items.filter((item) => item.enabled).map((item) => item.id);'];
    const block = `${code[0]}\n${(code[1] ?? '').repeat(6)}\n\`\`\``;

    expect(block.length).toBeGreaterThan(300);
    expect(isDegenerate(block)).toBe(false);
  });

  it('滿滿的 emoji 也不算壞掉 —— 那是風格不是故障', () => {
    const emoji = `太棒了 🎉 我覺得超讚 ✨ 真的很不錯 🔥 推推 👍 `.repeat(12);

    expect(emoji.length).toBeGreaterThan(300);
    expect(isDegenerate(emoji)).toBe(false);
  });
});
