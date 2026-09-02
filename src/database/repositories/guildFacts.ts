import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { guildFacts, type GuildFactRow } from '../schema.js';

export const MAX_FACTS_PER_GUILD = 50;
export const MAX_FACT_LENGTH = 300;

/**
 * 伺服器共用的背景知識，範圍是 (guild_id)。
 *
 * 與 memories 的差別：memories 是 (guild_id, user_id) 每人一份、使用者自己說「記住我…」；
 * guild_facts 是整個伺服器共用，只有 Manage Guild 權限能增刪，
 * 內容由伺服器管理員自行決定並負責（Planning Phase 3）。
 */
export function listGuildFacts(db: Db, guildId: string): GuildFactRow[] {
  return db
    .select()
    .from(guildFacts)
    .where(eq(guildFacts.guildId, guildId))
    .orderBy(desc(guildFacts.id))
    .all();
}

export interface AddFactOutcome {
  status: 'added' | 'duplicate' | 'full';
  total: number;
}

export function addGuildFact(
  db: Db,
  guildId: string,
  content: string,
  createdBy: string,
): AddFactOutcome {
  const trimmed = content.trim().slice(0, MAX_FACT_LENGTH);
  const existing = listGuildFacts(db, guildId);

  if (existing.some((row) => row.content === trimmed)) {
    return { status: 'duplicate', total: existing.length };
  }

  if (existing.length >= MAX_FACTS_PER_GUILD) {
    return { status: 'full', total: existing.length };
  }

  db.insert(guildFacts).values({ guildId, content: trimmed, createdBy }).run();

  return { status: 'added', total: existing.length + 1 };
}

export function removeGuildFact(db: Db, guildId: string, id: number): boolean {
  const result = db
    .delete(guildFacts)
    .where(and(eq(guildFacts.id, id), eq(guildFacts.guildId, guildId)))
    .run();

  return result.changes > 0;
}

export function clearGuildFacts(db: Db, guildId: string): number {
  return db.delete(guildFacts).where(eq(guildFacts.guildId, guildId)).run().changes;
}
