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

  /**
   * 同一個 guild 正在建立中的連線。
   *
   * join 在 get 與 set 之間隔著一個最長 20 秒的 await，兩個 /voice join 同時
   * 進來時兩邊都會看到 map 是空的，於是建出兩個 session 共用同一條 Discord
   * 連線 —— 同一句話會跑兩次 STT 兩次 AI，額度直接雙倍，而且先建的那個變成
   * 沒人握有參照的孤兒。這個 Map 讓第二個呼叫等第一個的結果。
   */
  private readonly pending = new Map<string, Promise<VoiceSession>>();

  async join(channel: VoiceBasedChannel): Promise<VoiceSession> {
    const inFlight = this.pending.get(channel.guild.id);
    if (inFlight) {
      const session = await inFlight.catch(() => null);
      if (session && session.channelId === channel.id) return session;
    }

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

    const creating = VoiceSession.join(channel, {
      ...this.deps,
      // 閒置逾時要把名額還回去，否則一個沒人講話的連線會永久佔住全域唯一的位置。
      // session 已經自己 destroy 過了，這裡只負責把 map 條目拿掉 ——
      // 而且要先確認 map 裡的就是它本人：併發的 join 可能留下孤兒 session，
      // 孤兒身上的計時器不該把當下正在用的那一個收掉。
      onIdle: (guildId, session) => {
        if (this.sessions.get(guildId) !== session) return;
        this.sessions.delete(guildId);
      },
    });

    this.pending.set(channel.guild.id, creating);

    let session: VoiceSession;
    try {
      session = await creating;
    } finally {
      this.pending.delete(channel.guild.id);
    }

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
