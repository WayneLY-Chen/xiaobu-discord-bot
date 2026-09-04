import type { VoiceBasedChannel } from 'discord.js';
import { UserFacingError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { VoiceSession, type VoiceSessionDeps } from './session.js';

/**
 * 呼叫端要提供的相依。
 *
 * onIdle 由 VoiceManager 自己補上 —— 那是「把自己從 map 裡移掉」，
 * 只有 manager 知道怎麼做，讓外面填等於把內部狀態的責任丟出去。
 */
export type VoiceManagerDeps = Omit<VoiceSessionDeps, 'onIdle'>;

/**
 * 管理各伺服器的語音階段。
 *
 * 有全域上限：Piper 的 real-time factor 是 0.62，這台 1 OCPU 的機器
 * 同時跑兩路語音就會來不及合成、聲音開始斷斷續續。與其讓所有人一起爛掉，
 * 不如明確拒絕後來的請求並說明原因。
 */
export class VoiceManager {
  private readonly sessions = new Map<string, VoiceSession>();

  constructor(
    private readonly deps: VoiceManagerDeps,
    private readonly maxSessions: number,
  ) {}

  get activeCount(): number {
    return this.sessions.size;
  }

  sessionFor(guildId: string): VoiceSession | undefined {
    return this.sessions.get(guildId);
  }

  async join(channel: VoiceBasedChannel): Promise<VoiceSession> {
    const existing = this.sessions.get(channel.guild.id);

    // 同一個伺服器換頻道時先退出舊的，Discord 不允許一個 Bot 同時待在兩個語音頻道
    if (existing) {
      if (existing.channelId === channel.id) return existing;
      existing.destroy();
      this.sessions.delete(channel.guild.id);
    }

    if (this.sessions.size >= this.maxSessions) {
      throw new UserFacingError(
        `目前語音功能已達同時使用上限（${this.maxSessions} 個伺服器），請稍後再試。`,
      );
    }

    const session = await VoiceSession.join(channel, {
      ...this.deps,
      // 閒置逾時要把名額還回去，否則一個沒人講話的連線會永久佔住全域唯一的位置
      onIdle: (guildId) => {
        this.leave(guildId);
      },
    });
    this.sessions.set(channel.guild.id, session);
    logger.info(`已加入語音頻道 ${channel.name}（${channel.guild.name}）`);

    return session;
  }

  leave(guildId: string): boolean {
    const session = this.sessions.get(guildId);
    if (!session) return false;

    session.destroy();
    this.sessions.delete(guildId);
    return true;
  }

  /** 關機時收乾淨，不要留下懸空的語音連線。 */
  destroyAll(): void {
    for (const [guildId, session] of this.sessions) {
      session.destroy();
      this.sessions.delete(guildId);
    }
  }
}
