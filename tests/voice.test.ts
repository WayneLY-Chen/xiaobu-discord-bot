import { describe, expect, it } from 'vitest';
import { TtsRouter } from '../src/voice/router.js';
import { normalize } from '../src/voice/stt.js';
import type { SynthesizedSpeech, TtsProvider } from '../src/voice/types.js';
import { UserFacingError } from '../src/utils/errors.js';
import { Readable } from 'node:stream';

function fakeTts(overrides: Partial<TtsProvider> = {}): TtsProvider {
  return {
    id: 'fake',
    label: 'Fake',
    tier: 'free',
    isAvailable: async () => true,
    synthesize: async (): Promise<SynthesizedSpeech> => ({
      pcm: Readable.from([Buffer.alloc(4)]),
      sampleRate: 22_050,
      provider: 'fake',
      voice: 'fake-voice',
      dispose: () => undefined,
    }),
    ...overrides,
  };
}

const request = { text: '你好', timeoutMs: 1000 };

describe('語音辨識結果的整理', () => {
  it('簡體轉繁體，而且是台灣用詞不只是字形', () => {
    // tw 只會換字形變成「軟件／默認／網絡」，twp 才會換成台灣的說法
    expect(normalize('这个软件的默认设置需要重新配置网络连接')).toBe(
      '這個軟體的預設設定需要重新配置網路連線',
    );
  });

  it('已經是繁體的內容不會被改壞', () => {
    expect(normalize('今天天氣真好，我們去公園散步吧')).toBe('今天天氣真好，我們去公園散步吧');
  });

  it('靜音或只有標點的辨識結果視為沒聽到', () => {
    expect(normalize('')).toBe('');
    expect(normalize('。')).toBe('');
    expect(normalize('  ，  ')).toBe('');
  });

  it('丟掉 Whisper 對著靜音幻聽出來的字幕組署名', () => {
    // 這些字串在 Whisper 的訓練資料裡大量存在，對著雜訊很容易吐出來
    expect(normalize('字幕由Amara.org社群提供')).toBe('');
    expect(normalize('請不吝點贊 訂閱轉發打賞支持明鏡與點點欄目')).toBe('');
  });

  it('正常句子不會被幻聽偵測誤殺', () => {
    expect(normalize('謝謝你幫我查這個資料')).toBe('謝謝你幫我查這個資料');
  });
});

describe('TtsRouter', () => {
  it('模型檔案不存在的來源不會被當成可用', async () => {
    const router = new TtsRouter([fakeTts({ isAvailable: async () => false })]);

    expect(await router.ready()).toHaveLength(0);
    await expect(router.synthesize(request)).rejects.toThrow('沒有可用的語音合成服務');
  });

  it('第一家壞掉會換下一家', async () => {
    const broken = fakeTts({
      id: 'broken',
      synthesize: async () => {
        throw new UserFacingError('壞了');
      },
    });

    const speech = await new TtsRouter([broken, fakeTts()]).synthesize(request);

    expect(speech.provider).toBe('fake');
  });

  it('付費來源永遠不進候選名單', async () => {
    const router = new TtsRouter([fakeTts({ id: 'paid', tier: 'paid' })]);

    expect(await router.ready()).toHaveLength(0);
    expect(router.labels).toHaveLength(0);
  });
});
