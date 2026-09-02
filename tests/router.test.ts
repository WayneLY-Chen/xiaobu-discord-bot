import { describe, expect, it } from 'vitest';
import { AiRouter } from '../src/ai/router.js';
import {
  CHAT_ONLY,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
} from '../src/ai/providers/types.js';
import type { ProviderId } from '../src/config/constants.js';
import {
  ContentBlockedError,
  ProviderAuthError,
  ProviderTimeoutError,
  QuotaExceededError,
  UserFacingError,
} from '../src/utils/errors.js';

class StubProvider implements ChatProvider {
  readonly capabilities = CHAT_ONLY;
  readonly calls: ChatRequest[] = [];

  constructor(
    readonly id: ProviderId,
    readonly tier: 'free' | 'paid' = 'free',
    private readonly failWith: Error | null = null,
  ) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    if (this.failWith) throw this.failWith;
    return { text: `${this.id} 的回覆`, tokensIn: 1, tokensOut: 2 };
  }
}

const request: ChatRequest = {
  model: 'gemini-3.5-flash',
  systemInstruction: '系統指示',
  history: [{ role: 'user', text: '嗨' }],
  maxOutputTokens: 256,
  timeoutMs: 1000,
};

function router(providers: ChatProvider[], overrides: Partial<{ paid: boolean; fallback: boolean }> = {}) {
  return new AiRouter(providers, {
    allowPaidProviders: overrides.paid ?? false,
    fallbackEnabled: overrides.fallback ?? true,
  });
}

describe('AiRouter', () => {
  it('依使用者選的 model 決定 provider，成功時不算換手', async () => {
    const gemini = new StubProvider('gemini');
    const groq = new StubProvider('groq');

    const result = await router([gemini, groq]).chat(request);

    expect(result.provider).toBe('gemini');
    expect(result.model).toBe('gemini-3.5-flash');
    expect(result.fellBack).toBe(false);
    expect(groq.calls).toHaveLength(0);
  });

  it('選 Groq 的 model 就送去 Groq，不會被第一順位攔走', async () => {
    const gemini = new StubProvider('gemini');
    const groq = new StubProvider('groq');

    const result = await router([gemini, groq]).chat({ ...request, model: 'qwen/qwen3.6-27b' });

    expect(result.provider).toBe('groq');
    expect(result.model).toBe('qwen/qwen3.6-27b');
    expect(gemini.calls).toHaveLength(0);
  });

  it('額度用完時換手到下一個免費 provider，並改用它的預設模型', async () => {
    const gemini = new StubProvider('gemini', 'free', new QuotaExceededError());
    const groq = new StubProvider('groq');

    const result = await router([gemini, groq]).chat(request);

    expect(result.provider).toBe('groq');
    expect(result.model).toBe('openai/gpt-oss-120b');
    expect(result.fellBack).toBe(true);
    expect(result.fallbackReason).toBeInstanceOf(QuotaExceededError);
    expect(result.text).toBe('groq 的回覆');
  });

  it('逾時與認證失敗也會換手', async () => {
    for (const error of [new ProviderTimeoutError(), new ProviderAuthError()]) {
      const groq = new StubProvider('groq');
      const result = await router([new StubProvider('gemini', 'free', error), groq]).chat(request);

      expect(result.provider).toBe('groq');
      expect(result.fellBack).toBe(true);
    }
  });

  it('內容被安全機制擋下時絕不換手 —— 換一家等於在找肯講的 provider', async () => {
    const gemini = new StubProvider('gemini', 'free', new ContentBlockedError());
    const groq = new StubProvider('groq');

    await expect(router([gemini, groq]).chat(request)).rejects.toThrow(ContentBlockedError);
    expect(groq.calls).toHaveLength(0);
  });

  it('關閉 fallback 後，主要 provider 失敗就直接報錯', async () => {
    const gemini = new StubProvider('gemini', 'free', new QuotaExceededError());
    const groq = new StubProvider('groq');

    await expect(router([gemini, groq], { fallback: false }).chat(request)).rejects.toThrow(
      QuotaExceededError,
    );
    expect(groq.calls).toHaveLength(0);
  });

  it('全部失敗時回報第一個錯誤，也就是使用者原本選的那家的問題', async () => {
    const gemini = new StubProvider('gemini', 'free', new QuotaExceededError());
    const groq = new StubProvider('groq', 'free', new ProviderTimeoutError());

    await expect(router([gemini, groq]).chat(request)).rejects.toThrow(QuotaExceededError);
    expect(groq.calls).toHaveLength(1);
  });

  it('ALLOW_PAID_PROVIDERS=false 時，付費 provider 不會被當成 fallback', async () => {
    const gemini = new StubProvider('gemini', 'free', new QuotaExceededError());
    const paid = new StubProvider('groq', 'paid');

    await expect(router([gemini, paid]).chat(request)).rejects.toThrow(QuotaExceededError);
    expect(paid.calls).toHaveLength(0);
  });

  it('只有付費 provider 時，預設情況下完全不呼叫，而不是偷偷用', async () => {
    const paid = new StubProvider('gemini', 'paid');

    await expect(router([paid]).chat(request)).rejects.toThrow(UserFacingError);
    expect(paid.calls).toHaveLength(0);
  });

  it('明確設定 ALLOW_PAID_PROVIDERS=true 才會用付費 provider', async () => {
    const gemini = new StubProvider('gemini', 'free', new QuotaExceededError());
    const paid = new StubProvider('groq', 'paid');

    const result = await router([gemini, paid], { paid: true }).chat(request);

    expect(result.provider).toBe('groq');
    expect(paid.calls).toHaveLength(1);
  });

  it('選到的 model 屬於沒設定的 provider 時，退回可用 provider 的預設模型', async () => {
    const gemini = new StubProvider('gemini');

    // Groq 沒註冊（沒有 GROQ_API_KEY），但資料庫裡還存著使用者之前選的 Groq 模型
    const result = await router([gemini]).chat({ ...request, model: 'openai/gpt-oss-120b' });

    expect(result.provider).toBe('gemini');
    expect(result.model).toBe('gemini-3.1-flash-lite');
    expect(result.fellBack).toBe(false);
  });

  it('沒有任何 provider 時給出可行動的錯誤，而不是崩潰', async () => {
    await expect(router([]).chat(request)).rejects.toThrow('沒有可用的 AI 服務');
  });

  it('availableProviders 只列出實際會被使用的 provider', () => {
    const instance = router([new StubProvider('gemini'), new StubProvider('groq', 'paid')]);

    expect(instance.availableProviders).toEqual(['gemini']);
    expect(instance.isConfigured('gemini')).toBe(true);
    expect(instance.isConfigured('groq')).toBe(false);
  });

  it('換手時把原本的 systemInstruction 與歷史原封不動帶過去', async () => {
    const groq = new StubProvider('groq');
    await router([new StubProvider('gemini', 'free', new QuotaExceededError()), groq]).chat(request);

    expect(groq.calls[0]).toMatchObject({
      systemInstruction: '系統指示',
      history: [{ role: 'user', text: '嗨' }],
      maxOutputTokens: 256,
    });
  });
});
