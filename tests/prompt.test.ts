import { describe, expect, it } from 'vitest';
import { buildSystemInstruction } from '../src/ai/prompt.js';

const base = {
  botName: '小步',
  guildName: 'うちは一族',
  channelName: '說話聊天區',
  speaker: '宇智波イタチ',
  locale: 'zh-TW',
};

describe('語音模式的系統指示', () => {
  it('文字模式教它用 Markdown，語音模式不會出現這條', () => {
    const text = buildSystemInstruction(base);

    expect(text).toContain('善用 Markdown');
    expect(text).not.toContain('這是語音對話');
  });

  it('語音模式明確要求講短、不要 Markdown、不要唸網址', () => {
    const voice = buildSystemInstruction({ ...base, voiceMode: true });

    expect(voice).toContain('這是語音對話');
    expect(voice).toContain('100 字以內');
    expect(voice).toContain('不要用 Markdown');
    expect(voice).toContain('不要唸網址');
    // 這條是給眼睛看的規則，在語音裡會叫模型輸出反而會被唸出來
    expect(voice).not.toContain('善用 Markdown');
  });

  it('語音模式不影響人格、記憶與伺服器指示', () => {
    const voice = buildSystemInstruction({
      ...base,
      voiceMode: true,
      memories: [{ id: 7, content: '喜歡貓' }],
      guildFacts: ['這個伺服器在講火影'],
      guildSystemPrompt: '講話要有禮貌',
    });

    expect(voice).toContain('18 歲的女生');
    expect(voice).toContain('#7 喜歡貓');
    expect(voice).toContain('這個伺服器在講火影');
    expect(voice).toContain('講話要有禮貌');
  });
});
