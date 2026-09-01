import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { usage } from '../schema.js';

export interface UsageRecord {
  guildId: string;
  userId: string;
  provider: string;
  model: string;
  kind: 'chat' | 'image' | 'search' | 'voice';
  tokensIn?: number;
  tokensOut?: number;
}

export function recordUsage(db: Db, record: UsageRecord): void {
  db.insert(usage)
    .values({
      guildId: record.guildId,
      userId: record.userId,
      provider: record.provider,
      model: record.model,
      kind: record.kind,
      tokensIn: record.tokensIn ?? 0,
      tokensOut: record.tokensOut ?? 0,
    })
    .run();
}

export interface UsageSummary {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  uniqueUsers: number;
}

/** 某個 guild 在過去 N 天的用量。只給有 Manage Guild 權限的人看。 */
export function getGuildUsage(db: Db, guildId: string, sinceDays: number): UsageSummary {
  const since = Math.floor(Date.now() / 1000) - sinceDays * 86_400;

  const row = db
    .select({
      requests: sql<number>`coalesce(sum(${usage.requests}), 0)`,
      tokensIn: sql<number>`coalesce(sum(${usage.tokensIn}), 0)`,
      tokensOut: sql<number>`coalesce(sum(${usage.tokensOut}), 0)`,
      uniqueUsers: sql<number>`count(distinct ${usage.userId})`,
    })
    .from(usage)
    .where(and(eq(usage.guildId, guildId), gte(usage.createdAt, since)))
    .get();

  return row ?? { requests: 0, tokensIn: 0, tokensOut: 0, uniqueUsers: 0 };
}

export interface TopModelRow {
  model: string;
  requests: number;
}

export function getGuildTopModels(db: Db, guildId: string, sinceDays: number): TopModelRow[] {
  const since = Math.floor(Date.now() / 1000) - sinceDays * 86_400;

  return db
    .select({
      model: usage.model,
      requests: sql<number>`coalesce(sum(${usage.requests}), 0)`,
    })
    .from(usage)
    .where(and(eq(usage.guildId, guildId), gte(usage.createdAt, since)))
    .groupBy(usage.model)
    .orderBy(sql`sum(${usage.requests}) desc`)
    .limit(5)
    .all();
}
