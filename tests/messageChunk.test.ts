import { describe, expect, it } from 'vitest';
import { chunkMessage } from '../src/utils/messageChunk.js';

describe('chunkMessage', () => {
  it('短訊息不切割', () => {
    expect(chunkMessage('你好')).toEqual(['你好']);
  });

  it('空字串回傳空陣列', () => {
    expect(chunkMessage('   ')).toEqual([]);
  });

  it('每一段都不超過上限', () => {
    const chunks = chunkMessage('a'.repeat(5000), 100);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it('切割後內容不遺失', () => {
    const text = Array.from({ length: 200 }, (_, i) => `第 ${i} 行`).join('\n');
    const rejoined = chunkMessage(text, 100).join('\n').replace(/\s+/g, '');

    expect(rejoined).toBe(text.replace(/\s+/g, ''));
  });

  it('優先在換行處斷開', () => {
    const text = `${'a'.repeat(60)}\n${'b'.repeat(60)}`;
    const chunks = chunkMessage(text, 80);

    expect(chunks[0]).toBe('a'.repeat(60));
  });

  it('在 code block 中間切斷時會補上收尾與開頭', () => {
    const code = Array.from({ length: 40 }, (_, i) => `const x${i} = ${i};`).join('\n');
    const chunks = chunkMessage(['```ts', code, '```'].join('\n'), 200);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.endsWith('```')).toBe(true);
    expect(chunks[1]?.startsWith('```ts')).toBe(true);

    // 每一段的 fence 數量都是偶數，Discord 才能正確渲染
    for (const chunk of chunks) {
      const fences = chunk.match(/```/g)?.length ?? 0;
      expect(fences % 2).toBe(0);
    }

    // 補上的 fence 也算在長度內，不能因此超過上限
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
  });

  it('多個連續 code block 也不會超過上限', () => {
    const blocks = Array.from({ length: 6 }, (_, i) =>
      [`說明文字 ${i}`, '```js', 'x'.repeat(120), '```'].join('\n'),
    ).join('\n\n');

    for (const chunk of chunkMessage(blocks, 150)) {
      expect(chunk.length).toBeLessThanOrEqual(150);
    }
  });
});
