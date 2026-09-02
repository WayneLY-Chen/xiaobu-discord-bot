import { describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider } from '../src/ai/providers/openaiCompatible.js';
import type { ChatRequest } from '../src/ai/providers/types.js';
import {
  ContentBlockedError,
  ProviderAuthError,
  ProviderTimeoutError,
  QuotaExceededError,
  UserFacingError,
} from '../src/utils/errors.js';

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    messages: { role: string; content: string }[];
    max_tokens: number;
    stream: boolean;
  };
}

const captured: CapturedCall[] = [];

/** 用假的 fetch 攔下請求，檢查真正送出去的內容。 */
function fakeFetch(status: number, payload: unknown, raw?: string): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    captured.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    });

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (raw !== undefined) throw new SyntaxError('not json');
        return payload;
      },
    } as Response;
  }) as unknown as typeof fetch;
}

function providerWith(fetchImpl: typeof fetch): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    id: 'groq',
    tier: 'free',
    label: 'Groq',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'test-key',
    fetchImpl,
  });
}

const request: ChatRequest = {
  model: 'openai/gpt-oss-120b',
  systemInstruction: '你是小步',
  history: [
    { role: 'user', text: '[Wayne] 嗨' },
    { role: 'model', text: '嗨嗨' },
    { role: 'user', text: '[Ming] 在嗎' },
  ],
  maxOutputTokens: 512,
  timeoutMs: 5000,
};

const okPayload = {
  choices: [{ message: { content: '  我在  ' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 40, completion_tokens: 7 },
};

describe('OpenAiCompatibleProvider', () => {
  it('把 systemInstruction 放在第一則 system 訊息', async () => {
    captured.length = 0;
    await providerWith(fakeFetch(200, okPayload)).chat(request);

    expect(captured[0]?.body.messages[0]).toEqual({ role: 'system', content: '你是小步' });
  });

  it('把內部的 model 角色轉成 OpenAI 的 assistant', async () => {
    captured.length = 0;
    await providerWith(fakeFetch(200, okPayload)).chat(request);

    expect(captured[0]?.body.messages.slice(1)).toEqual([
      { role: 'user', content: '[Wayne] 嗨' },
      { role: 'assistant', content: '嗨嗨' },
      { role: 'user', content: '[Ming] 在嗎' },
    ]);
  });

  it('不送 messages[].name —— Groq 收到這個欄位會回 400', async () => {
    captured.length = 0;
    await providerWith(fakeFetch(200, okPayload)).chat(request);

    for (const message of captured[0]?.body.messages ?? []) {
      expect(message).not.toHaveProperty('name');
    }
  });

  it('打到正確的路徑並帶上 Bearer token', async () => {
    captured.length = 0;
    await providerWith(fakeFetch(200, okPayload)).chat(request);

    expect(captured[0]?.url).toBe('https://api.example.test/v1/chat/completions');
    expect(captured[0]?.headers['authorization']).toBe('Bearer test-key');
  });

  it('回傳修剪過的內容與 token 用量', async () => {
    const response = await providerWith(fakeFetch(200, okPayload)).chat(request);

    expect(response).toEqual({ text: '我在', tokensIn: 40, tokensOut: 7 });
  });

  it('帶上 max_tokens 且不使用串流', async () => {
    captured.length = 0;
    await providerWith(fakeFetch(200, okPayload)).chat(request);

    expect(captured[0]?.body.max_tokens).toBe(512);
    expect(captured[0]?.body.stream).toBe(false);
  });

  it('429 轉成額度用完', async () => {
    const provider = providerWith(fakeFetch(429, { error: { message: 'rate limit reached' } }));
    await expect(provider.chat(request)).rejects.toThrow(QuotaExceededError);
  });

  it('401 與 403 轉成認證失敗', async () => {
    for (const status of [401, 403]) {
      const provider = providerWith(fakeFetch(status, { error: { message: 'invalid api key' } }));
      await expect(provider.chat(request)).rejects.toThrow(ProviderAuthError);
    }
  });

  it('內容政策造成的 400 轉成內容被擋，而不是一般錯誤', async () => {
    const provider = providerWith(
      fakeFetch(400, { error: { message: 'request blocked by content filter' } }),
    );
    await expect(provider.chat(request)).rejects.toThrow(ContentBlockedError);
  });

  it('空回應視為被擋下，不會回傳空字串給使用者', async () => {
    const provider = providerWith(
      fakeFetch(200, { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }),
    );
    await expect(provider.chat(request)).rejects.toThrow(ContentBlockedError);
  });

  it('推理型模型的 <think> 區塊會被清掉，使用者只看到答案', async () => {
    const provider = providerWith(
      fakeFetch(200, {
        choices: [
          {
            message: { content: '<think>\n先想一下要怎麼回\n</think>\n\n我是小步！' },
            finish_reason: 'stop',
          },
        ],
      }),
    );

    const response = await provider.chat(request);
    expect(response.text).toBe('我是小步！');
  });

  it('推理佔滿輸出長度時算長度不足，不是內容被擋 —— 這樣 Router 才會換手', async () => {
    // Qwen thinking 版本實際會這樣：整個預算都花在 <think> 裡，還沒吐出答案就被截斷
    const provider = providerWith(
      fakeFetch(200, {
        choices: [{ message: { content: '\n<think>\n想很久還沒想完' }, finish_reason: 'length' }],
      }),
    );

    await expect(provider.chat(request)).rejects.toThrow(/輸出長度/);
    // 關鍵：不能是 ContentBlockedError，否則 Router 會直接放棄而不換手
    await expect(provider.chat(request)).rejects.not.toThrow(ContentBlockedError);
  });

  it('回應不是 JSON 時給出友善錯誤，而不是拋出解析例外', async () => {
    const provider = providerWith(fakeFetch(502, undefined, '<html>bad gateway</html>'));

    await expect(provider.chat(request)).rejects.toThrow(UserFacingError);
    await expect(provider.chat(request)).rejects.not.toThrow(SyntaxError);
  });

  it('逾時會中止請求並轉成逾時錯誤', async () => {
    const hangingFetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;

    const provider = providerWith(hangingFetch);

    await expect(provider.chat({ ...request, timeoutMs: 20 })).rejects.toThrow(
      ProviderTimeoutError,
    );
  });

  it('錯誤訊息不會夾帶 API Key', async () => {
    const provider = providerWith(fakeFetch(401, { error: { message: 'invalid api key' } }));

    await expect(provider.chat(request)).rejects.toSatisfy(
      (error: Error) => !error.message.includes('test-key'),
    );
  });
});

describe('壞掉的回覆與各家擴充參數', () => {
  it('陷入重複迴圈的回覆被當成故障，而不是送到使用者面前', async () => {
    const garbage = `現在是台北時間 22:22~?${'\n\n...\n\n…\n\n......\n\n'.repeat(90)}抱歉啦！`;
    const provider = providerWith(
      fakeFetch(200, {
        choices: [{ message: { content: garbage }, finish_reason: 'stop' }],
      }),
    );

    // 不是 ContentBlockedError —— 那會讓 Router 直接放棄，不給換手的機會
    await expect(provider.chat(request)).rejects.toThrow(UserFacingError);
    await expect(provider.chat(request)).rejects.not.toThrow(ContentBlockedError);
  });

  it('extraBody 會原封不動送進 request body', async () => {
    captured.length = 0;
    const provider = new OpenAiCompatibleProvider({
      id: 'groq',
      tier: 'free',
      label: 'Groq',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'test-key',
      extraBody: { reasoning_format: 'hidden' },
      fetchImpl: fakeFetch(200, { choices: [{ message: { content: '嗨' } }] }),
    });

    await provider.chat(request);

    expect(captured[0]?.body).toMatchObject({ reasoning_format: 'hidden' });
  });
});
