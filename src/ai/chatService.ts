import type { Db } from '../database/client.js';
import {
  appendAssistantMessage,
  appendUserMessage,
  getOrCreateConversation,
  getRecentMessages,
  touchConversation,
} from '../database/repositories/conversations.js';
import { listGuildFacts } from '../database/repositories/guildFacts.js';
import { listMemories } from '../database/repositories/memories.js';
import { recordUsage } from '../database/repositories/usage.js';
import { PROVIDER_LABEL } from '../config/constants.js';
import type { EffectiveSettings } from '../config/resolveSettings.js';
import { UserFacingError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { buildChatHistory, sanitizeSpeakerLabel } from './context.js';
import { buildSystemInstruction } from './prompt.js';
import type { GeneratedImage } from './image/types.js';
import type { ImageRouter } from './image/router.js';
import type { ChatTurn } from './providers/types.js';
import type { AiRouter } from './router.js';
import type { SearchRouter } from './search/router.js';
import type { SearchResult } from './search/types.js';
import { executeTool, toolsFor } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';
import type { TieredRateLimiter } from '../utils/rateLimiter.js';

export interface ChatContext {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  userId: string;
  /** Discord displayName（暱稱優先），會被清理後放進 prompt。 */
  displayName: string;
  content: string;
}

/**
 * 一次回覆的完整結果。
 *
 * 圖片不能塞進文字裡讓模型轉述，所以走獨立欄位交給呼叫端當附件送出。
 */
export interface ChatReply {
  text: string;
  images: GeneratedImage[];
}

export interface ChatServiceOptions {
  botName: string;
  contextMessageLimit: number;
  maxInputLength: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /** 單一工具呼叫的逾時，比整體對話短。 */
  toolTimeoutMs: number;
  /** 生圖的逾時。生圖比文字慢得多，所以獨立設定。 */
  imageTimeoutMs: number;
  timezone: string;
}

/**
 * 模型最多能連續呼叫幾輪工具。
 *
 * 每一輪都是一次完整的 API 呼叫，會吃掉額度也會拖慢回覆。
 * 三輪足夠「查時間 → 搜尋 → 計算」這種組合，又不會讓模型無限繞圈。
 */
const MAX_TOOL_ROUNDS = 3;

/**
 * 把「一則 Discord 訊息」變成「一則 AI 回覆」的完整流程。
 * 刻意與 Discord 型別解耦，方便測試也方便之後接語音。
 */
export class ChatService {
  private botName: string;

  constructor(
    private readonly db: Db,
    private readonly router: AiRouter,
    private readonly search: SearchRouter,
    private readonly image: ImageRouter,
    /** 生圖專用的限流，與一般聊天分開計算（規格 §19）。 */
    private readonly imageLimiter: TieredRateLimiter,
    private readonly options: ChatServiceOptions,
  ) {
    this.botName = options.botName;
  }

  /** 登入後才知道 Bot 在 Discord 上的真實顯示名稱，用它覆蓋預設值。 */
  setBotName(name: string): void {
    this.botName = name;
  }

  /** /help 用來決定要不要把搜尋列進功能清單 —— 沒設定搜尋來源時就不該宣稱有這個功能。 */
  get searchEnabled(): boolean {
    return this.search.enabled;
  }

  /** /help 用來決定要不要把生圖列進功能清單。 */
  get imageEnabled(): boolean {
    return this.image.enabled;
  }

  async reply(context: ChatContext, settings: EffectiveSettings): Promise<ChatReply> {
    const conversationId = getOrCreateConversation(this.db, context.guildId, context.channelId);
    const input = context.content.slice(0, this.options.maxInputLength);

    // 先寫入使用者訊息，這樣即使 AI 呼叫失敗，對話紀錄仍然完整
    appendUserMessage(this.db, conversationId, context.userId, context.displayName, input);

    const toolContext: ToolContext = {
      db: this.db,
      guildId: context.guildId,
      userId: context.userId,
      locale: settings.locale,
      memoryEnabled: settings.memoryEnabled,
      imageEnabled: settings.imageEnabled,
      search: this.search,
      image: this.image,
      timeoutMs: this.options.toolTimeoutMs,
      imageTimeoutMs: this.options.imageTimeoutMs,
      timezone: this.options.timezone,
      // check() 通過就會記帳，所以呼叫這個等於「即將生一張圖」
      checkImageQuota: () => this.imageLimiter.check(context.guildId, context.userId),
    };

    const tools = toolsFor(toolContext);

    const systemInstruction = buildSystemInstruction({
      botName: this.botName,
      guildName: context.guildName,
      channelName: context.channelName,
      speaker: sanitizeSpeakerLabel(context.displayName),
      locale: settings.locale,
      guildSystemPrompt: settings.systemPrompt,
      userPersonality: settings.personality,
      guildFacts: listGuildFacts(this.db, context.guildId).map((row) => row.content),
      // 存幾則就注入幾則，不另外設注入上限 ——
      // 真正的天花板是 MAX_MEMORIES_PER_USER（存的時候就擋住了）。
      // 這裡再設一個獨立的數字只會讓兩者悄悄長歪：使用者存了 50 則，
      // 卻只有最新的幾則真的在小步眼前，剩下的變成看得到用不到的死資料。
      memories: settings.memoryEnabled
        ? listMemories(this.db, context.guildId, context.userId).map((row) => ({
            id: row.id,
            content: row.content,
          }))
        : [],
      toolsAvailable: tools.length > 0,
    });

    const turns: ChatTurn[] = buildChatHistory(
      getRecentMessages(this.db, conversationId, this.options.contextMessageLimit),
    );

    const sources: SearchResult[] = [];
    const images: GeneratedImage[] = [];
    let searchCount = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let response: Awaited<ReturnType<AiRouter['chat']>> | undefined;

    // 一旦換手成功，後面幾輪就固定用接手的那個模型，不要每輪都再去試已經掛掉的那家。
    // 否則一次問答會把 AI_TIMEOUT_MS 付好幾遍 —— 實際發生過：問「現在幾點？」
    // 第二輪又等了 Gemini 整整 60 秒才換手。順帶讓整段工具對話由同一個模型完成，
    // 它才看得懂自己前面發出的工具呼叫。
    let activeModel: string = settings.model;
    let everFellBack = false;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      // 最後一輪不再給工具，逼模型用已經拿到的資料把話講完，而不是繼續要工具
      const lastRound = round === MAX_TOOL_ROUNDS;

      response = await this.router.chat({
        model: activeModel,
        systemInstruction,
        history: turns,
        maxOutputTokens: this.options.maxOutputTokens,
        timeoutMs: this.options.timeoutMs,
        ...(tools.length > 0 && !lastRound ? { tools } : {}),
      });

      tokensIn += response.tokensIn;
      tokensOut += response.tokensOut;
      everFellBack ||= response.fellBack;
      activeModel = response.model;

      const calls = response.toolCalls ?? [];
      if (calls.length === 0) break;

      turns.push({ role: 'model', text: response.text, toolCalls: calls });

      for (const call of calls) {
        if (call.name === 'web_search') searchCount += 1;

        const result = await executeTool(call, toolContext);
        if (result.sources) sources.push(...result.sources);
        if (result.images) images.push(...result.images);

        turns.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          text: result.text,
        });
      }

      logger.debug(`第 ${round + 1} 輪呼叫了 ${calls.map((c) => c.name).join('、')}`);
    }

    if (!response) throw new Error('router 沒有回傳任何回應');

    const answer = response.text.trim();

    // 最後一輪已經不給工具了，模型照理說會直接作答。真的還是吐空的話，
    // 寧可回報錯誤，也不要把一則空訊息寫進對話紀錄毒害之後的上下文。
    if (answer.length === 0) {
      logger.warn('模型在工具迴圈結束後仍未產生文字回覆');
      throw new UserFacingError('我這次沒有整理出回覆，換個說法再問一次看看。');
    }

    // 只把模型真正說的話寫進對話紀錄。來源與換手提示是給這一次的讀者看的，
    // 不該混進之後送回模型的歷史。
    appendAssistantMessage(this.db, conversationId, answer);
    touchConversation(this.db, conversationId);

    recordUsage(this.db, {
      guildId: context.guildId,
      userId: context.userId,
      provider: response.provider,
      model: response.model,
      kind: 'chat',
      tokensIn,
      tokensOut,
      searches: searchCount,
      images: images.length,
    });

    return {
      text: answer + formatSources(sources) + formatFallbackNotice(response.provider, everFellBack),
      images,
    };
  }
}

/**
 * 來源清單直接用搜尋 API 回傳的資料組成，不經過模型 ——
 * 規格 §12 要求「不得捏造來源」，讓模型自己轉述網址一定會有改寫的風險。
 *
 * 網址用 <> 包起來，Discord 才不會為每一條來源展開一張預覽卡把版面洗掉。
 */
function formatSources(sources: SearchResult[]): string {
  if (sources.length === 0) return '';

  const unique: SearchResult[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    if (source.url.length === 0 || seen.has(source.url)) continue;
    seen.add(source.url);
    unique.push(source);
  }

  if (unique.length === 0) return '';

  const lines = unique.map((source, index) => {
    const date = source.publishedAt ? `　${source.publishedAt}` : '';
    return `${index + 1}. ${truncateTitle(source.title)} <${source.url}>${date}`;
  });

  return `\n\n**來源**\n${lines.join('\n')}`;
}

/**
 * 只要這輪對話中途換過手就要提示 —— 換手後的幾輪 fellBack 會是 false
 * （因為那時已經直接用接手的模型當第一順位了），不能只看最後一次的結果。
 */
function formatFallbackNotice(provider: string, fellBack: boolean): string {
  if (!fellBack) return '';

  // 換了 provider 等於換了模型，回答風格與品質會不一樣，讓使用者知道比較誠實
  const label = PROVIDER_LABEL[provider as keyof typeof PROVIDER_LABEL] ?? provider;
  return `\n-# ⚠️ 原本的 AI 服務暫時無法使用，這則改由 ${label} 回答。`;
}

function truncateTitle(title: string): string {
  const cleaned = title.replace(/\s+/g, ' ').trim();
  return cleaned.length <= 80 ? cleaned : `${cleaned.slice(0, 80)}…`;
}
