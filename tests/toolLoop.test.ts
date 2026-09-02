import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatService } from '../src/ai/chatService.js';
import { TieredRateLimiter } from '../src/utils/rateLimiter.js';
import { AiRouter } from '../src/ai/router.js';
import { ImageRouter } from '../src/ai/image/router.js';
import type { ImageProvider } from '../src/ai/image/types.js';
import { SearchRouter } from '../src/ai/search/router.js';
import type { SearchProvider, SearchResult } from '../src/ai/search/types.js';
import {
  CHAT_WITH_TOOLS,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
} from '../src/ai/providers/types.js';
import { resolveSettings, type EffectiveSettings } from '../src/config/resolveSettings.js';
import { ProviderTimeoutError } from '../src/utils/errors.js';
import { createDatabase, type Db } from '../src/database/client.js';
import { addGuildFact } from '../src/database/repositories/guildFacts.js';
import {
  addMemory,
  listMemories,
  MAX_MEMORIES_PER_USER,
} from '../src/database/repositories/memories.js';
import { upsertGuild, upsertUser } from '../src/database/repositories/identity.js';
import {
  getOrCreateConversation,
  getRecentMessages,
} from '../src/database/repositories/conversations.js';

/** 依照腳本逐次回覆，用來驅動多輪工具呼叫。 */
class ScriptedProvider implements ChatProvider {
  readonly id = 'gemini' as const;
  readonly tier = 'free' as const;
  readonly capabilities = CHAT_WITH_TOOLS;
  readonly requests: ChatRequest[] = [];

  constructor(private readonly script: Partial<ChatResponse>[]) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(request));

    const step = this.script[this.requests.length - 1] ?? { text: '沒有腳本了' };
    return { text: '', tokensIn: 1, tokensOut: 1, ...step };
  }
}

const results: SearchResult[] = [
  { title: '第一筆', url: 'https://a.example', snippet: 'aaa', publishedAt: '2026-09-01' },
  { title: '第二筆', url: 'https://b.example', snippet: 'bbb' },
];

const searchProvider: SearchProvider = {
  id: 'tavily',
  async search() {
    return results;
  },
};

const settings = resolveSettings(undefined, undefined, {
  model: 'gemini-3.5-flash',
  locale: 'zh-TW',
});

const options = {
  botName: '小步',
  contextMessageLimit: 20,
  maxInputLength: 4000,
  maxOutputTokens: 1024,
  timeoutMs: 5000,
  toolTimeoutMs: 5000,
  imageTimeoutMs: 5000,
  timezone: 'Asia/Taipei',
};

let db: Db;
let close: () => void;

function serviceWith(
  script: Partial<ChatResponse>[],
  search = new SearchRouter([searchProvider]),
  image = new ImageRouter([]),
  imageLimiter = defaultImageLimiter(),
) {
  const provider = new ScriptedProvider(script);
  const service = new ChatService(
    db,
    new AiRouter([provider], { allowPaidProviders: false, fallbackEnabled: false }),
    search,
    image,
    imageLimiter,
    options,
  );
  return { provider, service };
}

function defaultImageLimiter(userLimit = 100): TieredRateLimiter {
  return new TieredRateLimiter({ windowMs: 60_000, userLimit, guildLimit: 1000, globalLimit: 1000 });
}

/** 大部分測試只在意文字，圖片的斷言另外寫。 */
async function ask(service: ChatService, content: string, userId = 'wayne') {
  return (await replyOf(service, content, userId)).text;
}

function replyOf(
  service: ChatService,
  content: string,
  userId = 'wayne',
  override: Partial<EffectiveSettings> = {},
) {
  return service.reply(
    {
      guildId: 'serverA',
      guildName: 'Server A',
      channelId: 'chan1',
      channelName: 'ai',
      userId,
      displayName: userId === 'wayne' ? 'Wayne' : 'Ming',
      content,
    },
    { ...settings, ...override },
  );
}

beforeEach(() => {
  const created = createDatabase(':memory:');
  db = created.db;
  close = () => created.connection.close();

  upsertGuild(db, 'serverA', 'Server A');
  upsertUser(db, 'wayne', 'Wayne');
  upsertUser(db, 'ming', 'Ming');
});

afterEach(() => close());

describe('工具呼叫迴圈', () => {
  it('模型要求呼叫工具時執行它，再把結果送回去讓模型作答', async () => {
    const { provider, service } = serviceWith([
      { toolCalls: [{ id: 'c1', name: 'calculate', args: { expression: '2+2' } }] },
      { text: '答案是 4 喔' },
    ]);

    const answer = await ask(service, '2+2 等於多少');

    expect(answer).toBe('答案是 4 喔');
    expect(provider.requests).toHaveLength(2);

    // 第二次呼叫的歷史裡要有模型的工具呼叫，以及工具的執行結果
    const history = provider.requests[1]?.history ?? [];
    expect(history.at(-2)).toMatchObject({ role: 'model', toolCalls: [{ name: 'calculate' }] });
    expect(history.at(-1)).toMatchObject({ role: 'tool', toolName: 'calculate' });
    expect((history.at(-1) as { text: string }).text).toContain('2+2 = 4');
  });

  it('工具的中間過程不會寫進對話紀錄，只留最終答案', async () => {
    const { service } = serviceWith([
      { toolCalls: [{ id: 'c1', name: 'calculate', args: { expression: '2+2' } }] },
      { text: '答案是 4 喔' },
    ]);

    await ask(service, '2+2 等於多少');

    const rows = getRecentMessages(db, getOrCreateConversation(db, 'serverA', 'chan1'), 10);
    expect(rows.map((row) => [row.role, row.content])).toEqual([
      ['user', '2+2 等於多少'],
      ['assistant', '答案是 4 喔'],
    ]);
  });

  it('搜尋來源附在回覆下方，內容取自 API 而不是模型講的', async () => {
    const { service } = serviceWith([
      { toolCalls: [{ id: 'c1', name: 'web_search', args: { query: 'nvidia' } }] },
      { text: '查到了一些消息' },
    ]);

    const answer = await ask(service, '查一下 nvidia');

    expect(answer).toContain('**來源**');
    expect(answer).toContain('<https://a.example>');
    expect(answer).toContain('<https://b.example>');
    // API 有給日期就顯示，沒給就不顯示 —— 不會為了湊格式編一個
    expect(answer).toContain('2026-09-01');
  });

  it('重複的來源只列一次', async () => {
    const { service } = serviceWith([
      {
        toolCalls: [
          { id: 'c1', name: 'web_search', args: { query: 'a' } },
          { id: 'c2', name: 'web_search', args: { query: 'b' } },
        ],
      },
      { text: '好了' },
    ]);

    const answer = await ask(service, '查兩次');

    expect(answer.match(/https:\/\/a\.example/g)).toHaveLength(1);
  });

  it('沒有用到搜尋時不會多出來源區塊', async () => {
    const { service } = serviceWith([{ text: '純聊天' }]);

    expect(await ask(service, '嗨')).toBe('純聊天');
  });

  it('模型一直要工具時，最後一輪不再給工具，逼它把話講完', async () => {
    const call = { toolCalls: [{ id: 'c', name: 'calculate', args: { expression: '1+1' } }] };
    const { provider, service } = serviceWith([call, call, call, { text: '好啦我說' }]);

    const answer = await ask(service, '一直算');

    // 前 3 輪有工具，第 4 輪（MAX_TOOL_ROUNDS）沒有
    expect(provider.requests[0]?.tools?.length).toBeGreaterThan(0);
    expect(provider.requests[2]?.tools?.length).toBeGreaterThan(0);
    expect(provider.requests[3]?.tools).toBeUndefined();
    expect(answer).toBe('好啦我說');
  });

  it('繞完所有輪次仍然只吐工具呼叫時，回報錯誤而不是存一則空訊息', async () => {
    const call = { toolCalls: [{ id: 'c', name: 'calculate', args: { expression: '1+1' } }] };
    const { service } = serviceWith([call, call, call, call]);

    await expect(ask(service, '一直算')).rejects.toThrow('沒有整理出回覆');

    // 使用者的問題留著，但不能有空的 assistant 回覆污染之後的上下文
    const rows = getRecentMessages(db, getOrCreateConversation(db, 'serverA', 'chan1'), 10);
    expect(rows.map((row) => row.role)).toEqual(['user']);
  });

  it('工具呼叫的 signature 會原封不動帶回歷史 —— Gemini 少了它會回 400', async () => {
    const { provider, service } = serviceWith([
      {
        toolCalls: [
          { id: 'c1', name: 'calculate', args: { expression: '1+1' }, signature: 'sig-abc' },
        ],
      },
      { text: '2' },
    ]);

    await ask(service, '算一下');

    const history = provider.requests[1]?.history ?? [];
    expect(history.at(-2)).toMatchObject({ toolCalls: [{ signature: 'sig-abc' }] });
  });
});

describe('記憶與伺服器背景知識', () => {
  it('remember 工具真的寫進資料庫', async () => {
    const { service } = serviceWith([
      { toolCalls: [{ id: 'c1', name: 'remember', args: { content: 'Wayne 喜歡 Qwen' } }] },
      { text: '記住了' },
    ]);

    await ask(service, '記住我喜歡 Qwen');

    expect(listMemories(db, 'serverA', 'wayne').map((row) => row.content)).toEqual([
      'Wayne 喜歡 Qwen',
    ]);
  });

  it('已存的記憶會注入 system instruction', async () => {
    addMemory(db, 'serverA', 'wayne', 'Wayne 喜歡 Qwen');
    const { provider, service } = serviceWith([{ text: '你喜歡 Qwen' }]);

    await ask(service, '我喜歡什麼');

    expect(provider.requests[0]?.systemInstruction).toContain('Wayne 喜歡 Qwen');
  });

  it('存到上限的 50 則會全部注入，沒有存了卻用不到的死資料', async () => {
    for (let i = 0; i < MAX_MEMORIES_PER_USER; i += 1) {
      addMemory(db, 'serverA', 'wayne', `第 ${i} 則記憶`);
    }

    const { provider, service } = serviceWith([{ text: '好' }]);
    await ask(service, '我跟你說過什麼');

    const instruction = provider.requests[0]?.systemInstruction ?? '';
    // 最舊的那則也要在 —— 只驗最新幾則的話，注入上限被改小也看不出來
    expect(instruction).toContain('第 0 則記憶');
    expect(instruction).toContain(`第 ${MAX_MEMORIES_PER_USER - 1} 則記憶`);
  });

  it('記憶帶著 #編號注入，模型要刪就不必再花一次請求去查編號', async () => {
    addMemory(db, 'serverA', 'wayne', '喜歡 Qwen');
    const id = listMemories(db, 'serverA', 'wayne')[0]?.id ?? 0;

    const { provider, service } = serviceWith([{ text: '好' }]);
    await ask(service, '嗨');

    expect(provider.requests[0]?.systemInstruction).toContain(`#${id} 喜歡 Qwen`);
  });

  it('別人的記憶不會出現在自己的 system instruction', async () => {
    addMemory(db, 'serverA', 'wayne', 'Wayne 的祕密');
    const { provider, service } = serviceWith([{ text: '不知道' }]);

    await ask(service, '我喜歡什麼', 'ming');

    expect(provider.requests[0]?.systemInstruction).not.toContain('Wayne 的祕密');
  });

  it('記憶關閉時既不注入也不提供記憶工具', async () => {
    addMemory(db, 'serverA', 'wayne', 'Wayne 喜歡 Qwen');
    const { provider, service } = serviceWith([{ text: '好' }]);

    await service.reply(
      {
        guildId: 'serverA',
        guildName: 'Server A',
        channelId: 'chan1',
        channelName: 'ai',
        userId: 'wayne',
        displayName: 'Wayne',
        content: '嗨',
      },
      { ...settings, memoryEnabled: false },
    );

    const request = provider.requests[0];
    expect(request?.systemInstruction).not.toContain('Wayne 喜歡 Qwen');
    expect(request?.tools?.map((tool) => tool.name)).not.toContain('remember');
  });

  it('伺服器背景知識會注入，而且對這個伺服器的每個人都適用', async () => {
    addGuildFact(db, 'serverA', '週會固定在每週三晚上八點', 'admin');
    const { provider, service } = serviceWith([{ text: '好' }]);

    await ask(service, '週會什麼時候', 'ming');

    expect(provider.requests[0]?.systemInstruction).toContain('週會固定在每週三晚上八點');
  });

  it('沒有搜尋來源時，system instruction 不會提供搜尋工具', async () => {
    const { provider, service } = serviceWith([{ text: '好' }], new SearchRouter([]));

    await ask(service, '嗨');

    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).not.toContain('web_search');
  });
});

describe('換手之後不再回頭試已經掛掉的那家', () => {
  /** 第一家每次都逾時，第二家正常。用來確認第二輪不會又去等第一家。 */
  class DeadProvider implements ChatProvider {
    readonly id = 'gemini' as const;
    readonly tier = 'free' as const;
    readonly capabilities = CHAT_WITH_TOOLS;
    calls = 0;

    async chat(): Promise<ChatResponse> {
      this.calls += 1;
      throw new ProviderTimeoutError('逾時');
    }
  }

  class LiveProvider implements ChatProvider {
    readonly id = 'groq' as const;
    readonly tier = 'free' as const;
    readonly capabilities = CHAT_WITH_TOOLS;
    readonly requests: ChatRequest[] = [];

    constructor(private readonly script: Partial<ChatResponse>[]) {}

    async chat(request: ChatRequest): Promise<ChatResponse> {
      this.requests.push(structuredClone(request));
      const step = this.script[this.requests.length - 1] ?? { text: '沒有腳本了' };
      return { text: '', tokensIn: 1, tokensOut: 1, ...step };
    }
  }

  it('第一輪換手後，第二輪直接用接手的模型，不再付一次逾時', async () => {
    const dead = new DeadProvider();
    const live = new LiveProvider([
      { toolCalls: [{ id: 'c1', name: 'get_current_time', args: {} }] },
      { text: '現在是晚上十點' },
    ]);

    const service = new ChatService(
      db,
      new AiRouter([dead, live], { allowPaidProviders: false, fallbackEnabled: true }),
      new SearchRouter([searchProvider]),
      new ImageRouter([]),
      defaultImageLimiter(),
      options,
    );

    const answer = await ask(service, '現在幾點？');

    expect(answer).toContain('現在是晚上十點');
    // 掛掉的那家只被試了一次，不是每一輪都試
    expect(dead.calls).toBe(1);
    expect(live.requests).toHaveLength(2);
    expect(live.requests[1]?.model).toBe('openai/gpt-oss-120b');
  });

  it('中途換過手就會附上提示，即使最後一輪本身沒有換手', async () => {
    const live = new LiveProvider([
      { toolCalls: [{ id: 'c1', name: 'get_current_time', args: {} }] },
      { text: '現在是晚上十點' },
    ]);

    const service = new ChatService(
      db,
      new AiRouter([new DeadProvider(), live], {
        allowPaidProviders: false,
        fallbackEnabled: true,
      }),
      new SearchRouter([searchProvider]),
      new ImageRouter([]),
      defaultImageLimiter(),
      options,
    );

    expect(await ask(service, '現在幾點？')).toContain('改由 Groq 回答');
  });
});


describe('生圖走的是附件旁路，不是文字', () => {
  const pixel = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  const fakeImage: ImageProvider = {
    id: 'fake',
    tier: 'free',
    label: 'Fake',
    generate: async () => ({
      data: pixel,
      filename: 'fox.png',
      provider: 'fake',
      model: 'fake-1',
    }),
  };

  function drawService(script: Partial<ChatResponse>[], userLimit = 100) {
    return serviceWith(
      script,
      new SearchRouter([searchProvider]),
      new ImageRouter([fakeImage]),
      defaultImageLimiter(userLimit),
    );
  }

  const drawCall = {
    toolCalls: [{ id: 'i1', name: 'generate_image', args: { prompt: 'a red fox' } }],
  };

  it('圖片跟著回覆一起交出來，位元組不會混進文字裡', async () => {
    const { service } = drawService([drawCall, { text: '畫好囉！' }]);

    const reply = await replyOf(service, '幫我畫一隻狐狸', 'wayne', { imageEnabled: true });

    expect(reply.text).toBe('畫好囉！');
    expect(reply.images).toHaveLength(1);
    expect(reply.images[0]?.data).toEqual(pixel);
  });

  it('圖片不會被寫進對話紀錄 —— 那裡只留模型說的話', async () => {
    const { service } = drawService([drawCall, { text: '畫好囉！' }]);

    await replyOf(service, '幫我畫一隻狐狸', 'wayne', { imageEnabled: true });

    const rows = getRecentMessages(db, getOrCreateConversation(db, 'serverA', 'chan1'), 10);
    expect(rows.map((row) => row.content)).toEqual(['幫我畫一隻狐狸', '畫好囉！']);
  });

  it('生圖次數用完後就擋下來，不會再打生圖服務', async () => {
    const { service } = drawService([drawCall, { text: '畫好囉！' }], 1);

    const first = await replyOf(service, '畫一隻狐狸', 'wayne', { imageEnabled: true });
    expect(first.images).toHaveLength(1);

    // 第二次同一個人再畫，配額只有 1，應該生不出來
    const { service: second } = drawService([drawCall, { text: '這次不行' }], 0);
    const blocked = await replyOf(second, '再畫一隻', 'wayne', { imageEnabled: true });

    expect(blocked.images).toHaveLength(0);
  });

  it('管理員關掉生圖時，模型連這個工具都拿不到', async () => {
    const { provider, service } = drawService([{ text: '好' }]);

    await service.reply(
      {
        guildId: 'serverA',
        guildName: 'Server A',
        channelId: 'chan1',
        channelName: 'ai',
        userId: 'wayne',
        displayName: 'Wayne',
        content: '畫一隻狐狸',
      },
      { ...settings, imageEnabled: false },
    );

    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).not.toContain('generate_image');
  });

  it('沒有任何生圖來源時也不提供這個工具', async () => {
    const { provider, service } = serviceWith(
      [{ text: '好' }],
      new SearchRouter([searchProvider]),
      new ImageRouter([]),
    );

    await replyOf(service, '畫一隻狐狸', 'wayne', { imageEnabled: true });

    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).not.toContain('generate_image');
  });
});
