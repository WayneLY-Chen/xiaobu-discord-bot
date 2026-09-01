import { createDatabase } from '../database/client.js';
import { getRecentMessages } from '../database/repositories/conversations.js';
import { buildChatHistory } from '../ai/context.js';
import { conversations } from '../database/schema.js';

/** 開發用：印出資料庫存了什麼，以及實際送進模型的對話歷史長什麼樣子。 */
const { db, connection } = createDatabase(process.env.DATABASE_PATH ?? './data/bot.db');
const rows = db.select().from(conversations).all();

if (rows.length === 0) {
  console.log('目前沒有任何對話紀錄。');
}

for (const conversation of rows) {
  const messages = getRecentMessages(db, conversation.id, 20);
  console.log(`=== guild ${conversation.guildId} / channel ${conversation.channelId} ===`);
  console.log(`資料庫存了 ${messages.length} 則，每則都記著發話者：`);

  for (const message of messages) {
    const who = message.role === 'assistant' ? '(bot)' : `${message.username} / ${message.userId}`;
    console.log(`  ${message.role.padEnd(9)} ${who}`);
  }

  console.log('\n實際送進模型的歷史：');
  for (const turn of buildChatHistory(messages)) {
    const text = turn.text.length > 100 ? `${turn.text.slice(0, 100)}…` : turn.text;
    console.log(`  [${turn.role}] ${text.replaceAll('\n', '\n          ')}`);
  }
  console.log('');
}

connection.close();
