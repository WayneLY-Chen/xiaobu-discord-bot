import type { Db } from '../database/client.js';
import {
  appendAssistantMessage,
  appendUserMessage,
  getOrCreateConversation,
  getRecentMessages,
  touchConversation,
} from '../database/repositories/conversations.js';
import { recordUsage } from '../database/repositories/usage.js';
import type { EffectiveSettings } from '../config/resolveSettings.js';
import { buildChatHistory, sanitizeSpeakerLabel } from './context.js';
import { buildSystemInstruction } from './prompt.js';
import type { ChatProvider } from './gemini.js';

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

export interface ChatServiceOptions {
  botName: string;
  contextMessageLimit: number;
  maxInputLength: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

/**
 * 把「一則 Discord 訊息」變成「一則 AI 回覆」的完整流程。
 * 刻意與 Discord 型別解耦，方便測試也方便之後接語音。
 */
export class ChatService {
  private botName: string;

  constructor(
    private readonly db: Db,
    private readonly provider: ChatProvider,
    private readonly options: ChatServiceOptions,
  ) {
    this.botName = options.botName;
  }

  /** 登入後才知道 Bot 在 Discord 上的真實顯示名稱，用它覆蓋預設值。 */
  setBotName(name: string): void {
    this.botName = name;
  }

  async reply(context: ChatContext, settings: EffectiveSettings): Promise<string> {
    const conversationId = getOrCreateConversation(this.db, context.guildId, context.channelId);
    const input = context.content.slice(0, this.options.maxInputLength);

    // 先寫入使用者訊息，這樣即使 AI 呼叫失敗，對話紀錄仍然完整
    appendUserMessage(this.db, conversationId, context.userId, context.displayName, input);

    const history = buildChatHistory(
      getRecentMessages(this.db, conversationId, this.options.contextMessageLimit),
    );

    const systemInstruction = buildSystemInstruction({
      botName: this.botName,
      guildName: context.guildName,
      channelName: context.channelName,
      speaker: sanitizeSpeakerLabel(context.displayName),
      locale: settings.locale,
      guildSystemPrompt: settings.systemPrompt,
      userPersonality: settings.personality,
    });

    const response = await this.provider.chat({
      model: settings.model,
      systemInstruction,
      history,
      maxOutputTokens: this.options.maxOutputTokens,
      timeoutMs: this.options.timeoutMs,
    });

    appendAssistantMessage(this.db, conversationId, response.text);
    touchConversation(this.db, conversationId);

    recordUsage(this.db, {
      guildId: context.guildId,
      userId: context.userId,
      provider: 'gemini',
      model: settings.model,
      kind: 'chat',
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
    });

    return response.text;
  }
}
