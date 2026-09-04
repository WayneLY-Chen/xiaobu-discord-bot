import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import prism from 'prism-media';
import { toUserMessage, UserFacingError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { DISCORD_CHANNELS, DISCORD_SAMPLE_RATE } from './types.js';
import type { TtsRouter } from './router.js';
import type { GroqWhisperStt } from './stt.js';

/** 等待 Discord 語音連線就緒的時間。 */
const CONNECTION_READY_MS = 20_000;

/** 太短的錄音多半是「嗯」或按到麥克風，送去辨識只是浪費額度。 */
const MIN_UTTERANCE_BYTES = 8_000;

export interface VoiceSessionDeps {
  tts: TtsRouter;
  stt: GroqWhisperStt;
  /**
   * 把辨識出來的文字交給既有的聊天流程，回傳要唸出來的答覆。
   * 語音對話用語音頻道的 ID 當作對話串，與文字頻道的上下文分開。
   */
  respond(where: { guildId: string; channelId: string; userId: string }, text: string): Promise<string>;
  ttsTimeoutMs: number;
  /**
   * 等一段語音播完的上限。
   *
   * 刻意與 ttsTimeoutMs 分開：那個管的是「合成要多久才吐第一個位元組」，
   * 這個管的是「這段音檔本身有多長」。用同一個數字的話，一段 450 字、
   * 將近 100 秒的台詞會在 60 秒處被當成逾時砍掉三分之一。
   */
  maxPlaybackMs: number;
  sttTimeoutMs: number;
  silenceMs: number;
  maxUtteranceMs: number;
}

/**
 * 一個伺服器的語音階段。
 *
 * 流程（規格 §15）：Discord Voice → STT → AI → TTS → Discord Voice
 *
 * 這台機器只有 1 顆 CPU，所以盡量把工作丟給 ffmpeg，Node 只搬位元組：
 * - **說**：Piper 出 raw PCM → ffmpeg 轉 Opus/OGG → discord.js
 *   直接 passthrough 播出，完全不用 JS 端編碼。
 * - **聽**：Discord 給的是裸 Opus 封包，必須先解碼（見 captureUtterance
 *   的說明），再交給 ffmpeg 轉成 Whisper 要的 16k 單聲道 WAV。
 */
export class VoiceSession {
  private readonly player: AudioPlayer;
  private readonly listening = new Set<string>();
  /** Piper 一次只跑得動一路，所以合成與播放要排隊。 */
  private speaking: Promise<void> = Promise.resolve();
  private destroyed = false;

  private constructor(
    readonly guildId: string,
    readonly channelId: string,
    private readonly connection: VoiceConnection,
    private readonly deps: VoiceSessionDeps,
  ) {
    this.player = createAudioPlayer({
      // 沒有訂閱者時照播不誤。設成 Pause 的話，語音頻道裡沒有人的時候播放會停住、
      // 永遠等不到 Idle，每一段都得吃滿逾時才結束，佇列後面的東西全部被卡住。
      // 當初選 Pause 是為了省 Piper 的 CPU，現在合成在雲端，空轉只剩 ffmpeg。
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    this.player.on('error', (error) => logger.error('語音播放失敗', error));
    this.connection.subscribe(this.player);
    this.startListening();
  }

  static async join(
    channel: VoiceBasedChannel,
    deps: VoiceSessionDeps,
  ): Promise<VoiceSession> {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      // 必須關閉自我靜音，否則收不到別人的聲音也放不出聲音
      selfDeaf: false,
      selfMute: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, CONNECTION_READY_MS);
    } catch (error) {
      connection.destroy();
      throw new UserFacingError('加入語音頻道失敗，請確認我有連線與說話的權限。', error);
    }

    return new VoiceSession(channel.guild.id, channel.id, connection, deps);
  }

  /** 把一段文字唸出來。多次呼叫會排隊，不會互相蓋掉。 */
  speak(text: string): Promise<void> {
    this.speaking = this.speaking.then(() => this.speakNow(text)).catch((error: unknown) => {
      logger.error('語音合成失敗', error);
    });

    return this.speaking;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.player.stop(true);
    this.connection.destroy();
    logger.info(`已離開語音頻道 ${this.channelId}`);
  }

  private async speakNow(text: string): Promise<void> {
    if (this.destroyed) return;

    const speech = await this.deps.tts.synthesize({
      text,
      timeoutMs: this.deps.ttsTimeoutMs,
    });

    // ffmpeg 一手包辦重新取樣、轉單聲道為立體聲、編碼成 Opus。
    // 交給它做而不是在 Node 裡處理，是因為 discord.js 收到 OggOpus
    // 可以直接 passthrough，省下一次 JS 端的 Opus 編碼。
    // 裸 PCM 沒有標頭，取樣率與聲道數必須明講；MP3 自己帶得動
    const input =
      speech.format === 'mp3'
        ? ['-f', 'mp3', '-i', 'pipe:0']
        : ['-f', 's16le', '-ar', String(speech.sampleRate), '-ac', '1', '-i', 'pipe:0'];

    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error',
        ...input,
        '-c:a', 'libopus', '-b:a', '64k',
        '-ar', String(DISCORD_SAMPLE_RATE), '-ac', String(DISCORD_CHANNELS),
        // Ogg 預設一頁裝 1 秒音訊，湊滿才吐 —— 那 1 秒是每句話都要付的延遲。
        // 改成 20ms 一頁並強制 flush，VM 實測第一包從 1038ms 降到 390ms。
        // 代價是頁首變多、輸出大約多 18%，那是頻寬不是 CPU。
        '-page_duration', '20000', '-flush_packets', '1',
        '-f', 'ogg', 'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let ffmpegError = '';
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      ffmpegError = (ffmpegError + chunk.toString()).slice(-300);
    });

    // 讓 PCM 流進 ffmpeg。這裡不 await —— 要邊合成邊播，
    // 等它結束才播就失去串流的意義了。
    void pipeline(speech.audio, ffmpeg.stdin).catch(() => {
      // 播放被中止時上游會被關掉，這裡的 EPIPE 是預期行為
    });

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
    this.player.play(resource);

    try {
      await entersState(this.player, AudioPlayerStatus.Playing, 15_000);
      await entersState(this.player, AudioPlayerStatus.Idle, this.deps.maxPlaybackMs);
    } catch (error) {
      logger.warn(`語音播放未正常結束：${ffmpegError.trim() || String(error)}`);
    } finally {
      speech.dispose();
      killQuietly(ffmpeg);
    }
  }

  private startListening(): void {
    const receiver = this.connection.receiver;

    receiver.speaking.on('start', (userId) => {
      // 同一個人重複觸發時不要開第二條訂閱，否則會收到重複的音訊
      if (this.listening.has(userId) || this.destroyed) return;
      this.listening.add(userId);

      void this.captureUtterance(userId).finally(() => this.listening.delete(userId));
    });
  }

  /** 錄一句話 → 辨識 → 交給 AI → 唸出答覆。 */
  private async captureUtterance(userId: string): Promise<void> {
    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.deps.silenceMs },
    });

    // Discord 給的是**裸 Opus 封包**，沒有容器，Whisper 讀不了。
    // prism-media 1.x 沒有 OggLogicalBitstream（那在 2.0.0-alpha，
    // 不想在正式環境用 alpha），所以走解碼路線：
    //   Opus → PCM 48k 立體聲 → ffmpeg → WAV 16k 單聲道
    // 輸出 WAV 而不是再壓回 Opus：16k 單聲道的 WAV 不需要任何編碼運算，
    // 而 16kHz 正好是 Whisper 的原生取樣率。
    const decoder = new prism.opus.Decoder({
      rate: DISCORD_SAMPLE_RATE,
      channels: DISCORD_CHANNELS,
      frameSize: 960,
    });

    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error',
        '-f', 's16le', '-ar', String(DISCORD_SAMPLE_RATE), '-ac', String(DISCORD_CHANNELS),
        '-i', 'pipe:0',
        '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const chunks: Buffer[] = [];
    const cutoff = setTimeout(() => opus.destroy(), this.deps.maxUtteranceMs);

    try {
      ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      await pipeline(opus, decoder, ffmpeg.stdin);
      // stdin 關掉之後 ffmpeg 還要把 WAV 的尾巴寫完，等它自己結束。
      // 先檢查是否已經退出 —— 否則 close 事件早就發生過，這裡會永遠等下去。
      if (ffmpeg.exitCode === null && ffmpeg.signalCode === null) {
        await new Promise<void>((resolve) => ffmpeg.once('close', () => resolve()));
      }
    } catch (error) {
      logger.debug(`錄音中斷：${String(error)}`);
      return;
    } finally {
      clearTimeout(cutoff);
      killQuietly(ffmpeg);
    }

    const audio = Buffer.concat(chunks);
    if (audio.length < MIN_UTTERANCE_BYTES || this.destroyed) return;

    try {
      const heard = await this.deps.stt.transcribe(audio, { timeoutMs: this.deps.sttTimeoutMs });
      if (heard.length === 0) return;

      logger.info(`語音辨識：${heard}`);

      const answer = await this.deps.respond(
        { guildId: this.guildId, channelId: this.channelId, userId },
        heard,
      );
      if (answer.length > 0) await this.speak(answer);
    } catch (error) {
      logger.warn(`語音處理失敗：${toUserMessage(error)}`);
      // 只有使用者看得懂的錯誤才唸出來，內部錯誤不要變成噪音
      if (error instanceof UserFacingError) await this.speak(error.message);
    }
  }
}

function killQuietly(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
