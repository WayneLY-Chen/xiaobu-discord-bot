import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatService } from '../src/ai/chatService.js';
import { AiRouter } from '../src/ai/router.js';
import {
  CHAT_ONLY,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
} from '../src/ai/providers/types.js';
import type { ProviderId } from '../src/config/constants.js';
import { usage } from '../src/database/schema.js';
import { QuotaExceededError } from '../src/utils/errors.js';
import { createDatabase, type Db } from '../src/database/client.js';
import { upsertGuild, upsertUser } from '../src/database/repositories/identity.js';
import { getGuildUsage } from '../src/database/repositories/usage.js';
import {
  getOrCreateConversation,
  getRecentMessages,
} from '../src/database/repositories/conversations.js';
import { resolveSettings } from '../src/config/resolveSettings.js';

/** 記錄收到的請求，讓測試可以檢查真正送給模型的內容。 */
class FakeProvider implements ChatProvider {
  readonly tier = 'free' as const;
  readonly capabilities = CHAT_ONLY;

  readonly requests: ChatRequest[] = [];
  error: Error | null = null;
  reply = '這是回覆';

  constructor(readonly id: ProviderId = 'gemini') {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    if (this.error) throw this.error;
    return { text: this.reply, tokensIn: 12, tokensOut: 34 };
  }

  get lastRequest(): ChatRequest {
    const request = this.requests.at(-1);
    if (!request) throw new Error('尚未收到任何請求');
    return request;
  }
}

const settings = resolveSettings(undefined, undefined, {
  model: 'gemini-3.5-flash',
  locale: 'zh-TW',
});

function contextFor(displayName: string, content: string, userId: string) {
  return {
    guildId: 'serverA',
    guildName: 'Server A',
    channelId: 'chan1',
    channelName: 'ai',
    userId,
    displayName,
    content,
  };
}

/** ChatService 現在透過 Router 取得回覆，這裡包一層只有單一 provider 的 Router。 */
function routerFor(provider: ChatProvider): AiRouter {
  return new AiRouter([provider], { allowPaidProviders: false, fallbackEnabled: true });
}

let db: Db;
let close: () => void;
let provider: FakeProvider;
let service: ChatService;

beforeEach(() => {
  const created = createDatabase(':memory:');
  db = created.db;
  close = () => created.connection.close();

  upsertGuild(db, 'serverA', 'Server A');
  upsertUser(db, 'user123', 'Wayne');
  upsertUser(db, 'user456', 'Ming');

  provider = new FakeProvider();
  service = new ChatService(db, routerFor(provider), {
    botName: 'AI Bot',
    contextMessageLimit: 20,
    maxInputLength: 4000,
    maxOutputTokens: 1024,
    timeoutMs: 5000,
  });
});

afterEach(() => close());

describe('ChatService', () => {
  it('回傳模型的回覆，並把兩邊訊息都寫進對話紀錄', async () => {
    const answer = await service.reply(contextFor('Wayne', '你好', 'user123'), settings);

    expect(answer).toBe('這是回覆');

    const rows = getRecentMessages(db, getOrCreateConversation(db, 'serverA', 'chan1'), 10);
    expect(rows.map((row) => [row.role, row.content])).toEqual([
      ['user', '你好'],
      ['assistant', '這是回覆'],
    ]);
  });

  it('送進模型的歷史帶有說話者標記', async () => {
    await service.reply(contextFor('Wayne', '我喜歡 Qwen', 'user123'), settings);

    expect(provider.lastRequest.history).toEqual([
      { role: 'user', text: '[Wayne] 我喜歡 Qwen' },
    ]);
  });

  it('多人對話時，模型看得到每一則是誰說的', async () => {
    await service.reply(contextFor('Wayne', '我喜歡 Qwen', 'user123'), settings);
    await service.reply(contextFor('Ming', '我喜歡什麼？', 'user456'), settings);

    expect(provider.lastRequest.history).toEqual([
      { role: 'user', text: '[Wayne] 我喜歡 Qwen' },
      { role: 'model', text: '這是回覆' },
      { role: 'user', text: '[Ming] 我喜歡什麼？' },
    ]);
  });

  it('system instruction 會說明現在是誰在說話', async () => {
    await service.reply(contextFor('Ming', '嗨', 'user456'), settings);

    const instruction = provider.lastRequest.systemInstruction;
    expect(instruction).toContain('「Ming」');
    expect(instruction).toContain('`[名字]`');
  });

  it('system instruction 帶有小步的人格設定', async () => {
    await service.reply(contextFor('Wayne', '嗨', 'user123'), settings);

    const instruction = provider.lastRequest.systemInstruction;
    expect(instruction).toContain('18 歲的女生');
    expect(instruction).toContain('不要說「作為一個 AI」');
  });

  it('system instruction 禁止編造真實人物的事情', async () => {
    await service.reply(contextFor('Wayne', '嗨', 'user123'), settings);

    const instruction = provider.lastRequest.systemInstruction;
    expect(instruction).toContain('不要編造關於真實人物的事情');
    expect(instruction).toContain('負面、涉及性或違法的描述');
  });

  it('使用者的風格設定是疊加，不會蓋掉人格', async () => {
    await service.reply(contextFor('Wayne', '嗨', 'user123'), {
      ...settings,
      personality: '講話簡短一點',
    });

    const instruction = provider.lastRequest.systemInstruction;
    expect(instruction).toContain('18 歲的女生');
    expect(instruction).toContain('講話簡短一點');
  });

  it('把使用者的回覆風格帶進 system instruction', async () => {
    await service.reply(contextFor('Wayne', '嗨', 'user123'), {
      ...settings,
      personality: '講話簡短一點',
    });

    expect(provider.lastRequest.systemInstruction).toContain('講話簡短一點');
  });

  it('使用生效的 model', async () => {
    await service.reply(contextFor('Wayne', '嗨', 'user123'), {
      ...settings,
      model: 'gemini-3.7-flash',
    });

    expect(provider.lastRequest.model).toBe('gemini-3.7-flash');
  });

  it('過長的輸入會被截斷，避免一個人吃掉整個 context', async () => {
    const short = new ChatService(db, routerFor(provider), {
      botName: 'AI Bot',
      contextMessageLimit: 20,
      maxInputLength: 10,
      maxOutputTokens: 1024,
      timeoutMs: 5000,
    });

    await short.reply(contextFor('Wayne', 'a'.repeat(100), 'user123'), settings);

    expect(provider.lastRequest.history[0]?.text).toBe(`[Wayne] ${'a'.repeat(10)}`);
  });

  it('記錄 token 用量', async () => {
    await service.reply(contextFor('Wayne', '嗨', 'user123'), settings);

    const summary = getGuildUsage(db, 'serverA', 1);
    expect(summary).toMatchObject({ requests: 1, tokensIn: 12, tokensOut: 34 });
  });

  it('模型失敗時仍保留使用者訊息，但不寫入假的 bot 回覆，也不記用量', async () => {
    provider.error = new QuotaExceededError();

    await expect(service.reply(contextFor('Wayne', '嗨', 'user123'), settings)).rejects.toThrow(
      QuotaExceededError,
    );

    const rows = getRecentMessages(db, getOrCreateConversation(db, 'serverA', 'chan1'), 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('user');
    expect(getGuildUsage(db, 'serverA', 1).requests).toBe(0);
  });

  it('不同伺服器的同一個頻道 id 不會共用上下文', async () => {
    await service.reply(contextFor('Wayne', 'A 的祕密', 'user123'), settings);
    await service.reply(
      { ...contextFor('Wayne', 'B 說了什麼', 'user123'), guildId: 'serverB' },
      settings,
    );

    expect(provider.lastRequest.history).toEqual([
      { role: 'user', text: '[Wayne] B 說了什麼' },
    ]);
  });

  it('用量記錄的是實際回答的 provider 與 model', async () => {
    await service.reply(contextFor('Wayne', '嗨', 'user123'), {
      ...settings,
      model: 'gemini-3.7-flash',
    });

    const rows = db.select({ provider: usage.provider, model: usage.model }).from(usage).all();

    expect(rows).toEqual([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
  });
});

describe('ChatService 換手到備援 provider 時', () => {
  let backup: FakeProvider;
  let fallbackService: ChatService;

  beforeEach(() => {
    provider.error = new QuotaExceededError();
    backup = new FakeProvider('groq');
    backup.reply = '備援的回覆';

    fallbackService = new ChatService(
      db,
      new AiRouter([provider, backup], { allowPaidProviders: false, fallbackEnabled: true }),
      {
        botName: 'AI Bot',
        contextMessageLimit: 20,
        maxInputLength: 4000,
        maxOutputTokens: 1024,
        timeoutMs: 5000,
      },
    );
  });

  it('回覆後面附上提示，讓使用者知道換了服務', async () => {
    const answer = await fallbackService.reply(contextFor('Wayne', '嗨', 'user123'), settings);

    expect(answer).toContain('備援的回覆');
    expect(answer).toContain('改由 Groq 回答');
  });

  it('提示只給這一次的讀者看，不會混進之後送回模型的歷史', async () => {
    await fallbackService.reply(contextFor('Wayne', '嗨', 'user123'), settings);

    const rows = getRecentMessages(db, getOrCreateConversation(db, 'serverA', 'chan1'), 10);
    const assistant = rows.find((row) => row.role === 'assistant');

    expect(assistant?.content).toBe('備援的回覆');
    expect(assistant?.content).not.toContain('改由');
  });

  it('用量記在真正回答的那家頭上，而不是原本選的那家', async () => {
    await fallbackService.reply(contextFor('Wayne', '嗨', 'user123'), settings);

    const rows = db.select({ provider: usage.provider, model: usage.model }).from(usage).all();

    expect(rows).toEqual([{ provider: 'groq', model: 'llama-3.3-70b-versatile' }]);
  });
});
