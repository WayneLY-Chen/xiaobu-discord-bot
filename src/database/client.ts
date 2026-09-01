import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';
import { logger } from '../utils/logger.js';

export type Db = BetterSQLite3Database<typeof schema>;

let connection: Database.Database | null = null;
let db: Db | null = null;

/**
 * 開啟 SQLite 並套用 migration。
 * WAL 模式讓讀寫不互相阻塞，foreign_keys 讓 cascade delete 真的生效
 *（SQLite 預設是關的，忘了開會靜默失敗）。
 */
export interface CreatedDatabase {
  db: Db;
  connection: Database.Database;
}

/**
 * 開一個獨立的資料庫連線（不共用單例）。測試需要多個互不干擾的資料庫時用這個。
 */
export function createDatabase(
  databasePath: string,
  migrationsFolder = './drizzle',
): CreatedDatabase {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  }

  const created = new Database(databasePath);
  created.pragma('journal_mode = WAL');
  created.pragma('foreign_keys = ON');
  created.pragma('busy_timeout = 5000');

  const instance = drizzle(created, { schema });
  migrate(instance, { migrationsFolder });

  return { db: instance, connection: created };
}

/** 應用程式共用的單例連線。 */
export function initDatabase(databasePath: string, migrationsFolder = './drizzle'): Db {
  if (db) return db;

  const created = createDatabase(databasePath, migrationsFolder);
  connection = created.connection;
  db = created.db;

  logger.info(`SQLite 已就緒：${resolve(databasePath)}`);
  return db;
}

export function getDatabase(): Db {
  if (!db) throw new Error('資料庫尚未初始化，請先呼叫 initDatabase()');
  return db;
}

export function closeDatabase(): void {
  connection?.close();
  connection = null;
  db = null;
}
