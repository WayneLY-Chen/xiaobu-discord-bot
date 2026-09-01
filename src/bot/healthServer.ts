import { createServer, type Server } from 'node:http';
import type { Client } from 'discord.js';
import { logger } from '../utils/logger.js';

/**
 * 極簡健康檢查端點，給 Docker healthcheck 用。
 * 只綁 127.0.0.1，不對外開放，所以不需要在 Oracle 防火牆開任何 port。
 */
export function startHealthServer(client: Client, port: number): Server {
  const server = createServer((request, response) => {
    if (request.url !== '/health') {
      response.writeHead(404).end();
      return;
    }

    const ready = client.isReady();
    const body = JSON.stringify({
      status: ready ? 'ok' : 'starting',
      uptimeSeconds: Math.floor(process.uptime()),
      guilds: ready ? client.guilds.cache.size : 0,
      wsPingMs: ready ? Math.round(client.ws.ping) : null,
    });

    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    response.end(body);
  });

  // port 被佔用之類的問題不該讓整個 Bot 掛掉：Discord 連線與聊天都不依賴這個端點。
  // 沒有這個 handler 的話，http server 的 error 事件會變成 uncaught exception 直接終止 process。
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(
        `健康檢查 port ${port} 已被佔用（可能有另一個 Bot 實例還在跑）。` +
          '請關掉舊的實例，或改用 .env 的 HEALTH_PORT 換一個 port。Bot 會繼續運作，但健康檢查停用。',
      );
      return;
    }
    logger.error('健康檢查伺服器錯誤', error);
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info(`健康檢查端點：http://127.0.0.1:${port}/health`);
  });

  return server;
}
