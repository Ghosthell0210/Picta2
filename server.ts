import 'dotenv/config';
import express from 'express';
import { netlog } from './src/server/netlog.ts';
import { stateStore } from './src/server/stateStore.ts';
import { telegramRuntime } from './src/server/telegramRuntime.ts';

async function startHeadlessBotServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const healthHandler = async (_req: express.Request, res: express.Response) => {
    const t = await telegramRuntime.getTelemetry();
    const activeJobs = stateStore.jobs.filter((j) =>
      ['queued', 'downloading', 'assembling', 'uploading', 'encoding_nomad'].includes(j.status)
    ).length;

    res.json({
      ok: true,
      service: 'pictabot-headless',
      uptimeSeconds: t.uptimeSeconds,
      mode: t.telegram.mode,
      botUsername: t.telegram.botUsername || null,
      pollingActive: t.telegram.pollingActive,
      webhookActive: t.telegram.webhookActive,
      mtprotoConnected: t.mtproto.connected,
      queueActive: activeJobs,
      memoryRssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    });
  };

  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  app.get('/', (_req, res) => {
    res
      .status(200)
      .type('text/plain; charset=utf-8')
      .send('PictaBot 24/7 — Headless Telegram Bot Active. Controla todo desde Telegram con /menu.');
  });

  const webhookHandler = async (req: express.Request, res: express.Response) => {
    if (stateStore.config.telegramMode !== 'webhook') {
      res.status(409).json({ error: 'El bot opera en modo Long Polling.' });
      return;
    }
    const secretHeader = req.header('x-telegram-bot-api-secret-token');
    if (!telegramRuntime.verifyWebhookSecretHeader(secretHeader)) {
      res.status(403).json({ error: 'Encabezado secreto de Telegram inválido.' });
      return;
    }
    res.status(200).json({ ok: true });
    try {
      await telegramRuntime.handleIncomingUpdate(req.body);
    } catch (err) {
      netlog.error('telegram', `Error webhook: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  app.post('/telegram/webhook', webhookHandler);
  app.post('/api/telegram/webhook', webhookHandler);

  const port = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(
      `[PictaBot] Bot headless activo en puerto ${port} (${process.env.NODE_ENV || 'development'} · RAM ${Math.round(
        process.memoryUsage().rss / (1024 * 1024)
      )} MB)`
    );
    void telegramRuntime.start();
  });

  let shuttingDown = false;
  const gracefulExit = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await telegramRuntime.shutdown();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => void gracefulExit());
  process.on('SIGTERM', () => void gracefulExit());
}

void startHeadlessBotServer();
