import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { guildTriggers, type GuildTriggerRow } from '../schema.js';
import { isUsableTriggerPhrase, normalizeForMatch } from '../../utils/textMatch.js';
import { MAX_SPEECH_LENGTH } from '../../voice/types.js';

export const MAX_TRIGGERS_PER_GUILD = 20;
export const MAX_TRIGGER_PHRASE_LENGTH = 50;
/**
 * 台詞長度上限直接綁 MAX_SPEECH_LENGTH。
 *
 * 刻意**不**照抄 guild_facts 的 300 —— 那會讓一段 450 字的台詞被靜默截掉三分之一，
 * 而管理員在指令回覆裡看不到任何提示。
 */
export const MAX_TRIGGER_RESPONSE_LENGTH = MAX_SPEECH_LENGTH;

/**
 * 每個伺服器自己設定的「關鍵字 → 語音台詞」。
 *
 * 範圍是 (guild_id)，與 guild_facts 同一套權限模型（Manage Guild）。
 * 所有查詢都帶 guildId，包含刪除 —— id 是全域遞增的，少帶 guildId 的話
 * A 伺服器的管理員猜一個整數就能刪掉 B 伺服器的設定。
 */
export function listGuildTriggers(db: Db, guildId: string): GuildTriggerRow[] {
  return db
    .select()
    .from(guildTriggers)
    .where(eq(guildTriggers.guildId, guildId))
    .orderBy(desc(guildTriggers.id))
    .all();
}

export interface AddTriggerOutcome {
  status: 'added' | 'duplicate' | 'full' | 'phrase-too-short';
  total: number;
}

export function addGuildTrigger(
  db: Db,
  guildId: string,
  phraseRaw: string,
  response: string,
  createdBy: string,
): AddTriggerOutcome {
  const trimmedRaw = phraseRaw.trim().slice(0, MAX_TRIGGER_PHRASE_LENGTH);
  const phrase = normalizeForMatch(trimmedRaw);
  const existing = listGuildTriggers(db, guildId);

  // 空字串或只有標點的觸發詞會命中每一則訊息（'任何字'.includes('') 永遠是 true）
  if (!isUsableTriggerPhrase(phrase)) {
    return { status: 'phrase-too-short', total: existing.length };
  }

  if (existing.some((row) => row.phrase === phrase)) {
    return { status: 'duplicate', total: existing.length };
  }

  if (existing.length >= MAX_TRIGGERS_PER_GUILD) {
    return { status: 'full', total: existing.length };
  }

  db.insert(guildTriggers)
    .values({
      guildId,
      phrase,
      phraseRaw: trimmedRaw,
      response: response.trim().slice(0, MAX_TRIGGER_RESPONSE_LENGTH),
      createdBy,
    })
    .run();

  return { status: 'added', total: existing.length + 1 };
}

export function removeGuildTrigger(db: Db, guildId: string, id: number): boolean {
  const result = db
    .delete(guildTriggers)
    .where(and(eq(guildTriggers.id, id), eq(guildTriggers.guildId, guildId)))
    .run();

  return result.changes > 0;
}

/**
 * 找出這則訊息命中的台詞，沒有就回 null。
 *
 * 命中多條時取**最長**的觸發詞：設了「天氣」之後還想要「窗外的天氣」有自己的台詞，
 * 用資料庫順序的話短的會永遠蓋過長的。一則訊息只唸一段，不會連唸。
 */
export function matchTrigger(rows: GuildTriggerRow[], content: string): GuildTriggerRow | null {
  const haystack = normalizeForMatch(content);
  let best: GuildTriggerRow | null = null;

  for (const row of rows) {
    if (!haystack.includes(row.phrase)) continue;
    if (best === null || row.phrase.length > best.phrase.length) best = row;
  }

  return best;
}
