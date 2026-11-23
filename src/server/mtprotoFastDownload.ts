import bigInt from 'big-integer';
import fs from 'fs';
import { Api, TelegramClient } from 'telegram';
import { PromisedNetSockets } from 'telegram/extensions/PromisedNetSockets.js';
import { StringSession } from 'telegram/sessions/index.js';
import { netlog } from './netlog.ts';
import { ensureScratchSpaceForFile, resolveConfinedScratchPath } from './scratchDiskManager.ts';
import { stateStore } from './stateStore.ts';

/**
 * FastPromisedNetSockets disables Nagle buffering (TCP_NODELAY) and enables
 * TCP keep-alive so long 2-4 GB MTProto transfers stay stable on Altare's Always-On container.
 */
class FastPromisedNetSockets extends PromisedNetSockets {
  async connect(port: number, ip: string): Promise<void> {
    await super.connect(port, ip);
    const rawSocket = (this as unknown as { client?: { setNoDelay?: (v: boolean) => void; setKeepAlive?: (e: boolean, d: number) => void } }).client;
    if (rawSocket) {
      rawSocket.setNoDelay?.(true);
      rawSocket.setKeepAlive?.(true, 10_000);
    }
  }
}

function extractFloodWaitSeconds(message: string): number | null {
  const match = message.match(/FLOOD_WAIT_(\d+)/i) || message.match(/wait of (\d+) seconds/i);
  return match ? Number(match[1]) : null;
}

export class MtprotoPoolManager {
  private primaryClient: TelegramClient | null = null;
  private connected = false;
  private activeSockets = 0;
  private lastEventAt?: string;

  public isConfigured(): boolean {
    const apiId = Number(process.env.TELEGRAM_API_ID || process.env.API_ID || 0);
    const apiHash = (process.env.TELEGRAM_API_HASH || process.env.API_HASH || '').trim();
    const hasAuth = Boolean(
      stateStore.mtprotoSessionString || (process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '').trim()
    );
    return apiId > 0 && apiHash.length > 0 && hasAuth;
  }

  public getStatus() {
    const workers = stateStore.config.mtprotoWorkers;
    return {
      configured: this.isConfigured(),
      connected: this.connected,
      activeSockets: this.activeSockets,
      targetPoolSize: stateStore.config.mtprotoTcpPoolSize,
      safeParallelWorkers: workers,
      maxPrefetchLookahead: stateStore.config.maxPrefetchLookahead,
      aesPressureWarning: workers > 8,
      sessionPresent: Boolean(stateStore.mtprotoSessionString),
      lastEventAt: this.lastEventAt,
    };
  }

  public async connectIfConfigured(): Promise<boolean> {
    if (!this.isConfigured()) {
      this.connected = false;
      this.activeSockets = 0;
      netlog.info(
        'mtproto',
        'MTProto en espera: configura TELEGRAM_API_ID, TELEGRAM_API_HASH y TELEGRAM_BOT_TOKEN o TELEGRAM_MTPROTO_SESSION.'
      );
      return false;
    }

    if (this.connected && this.primaryClient) {
      return true;
    }

    const apiId = Number(process.env.TELEGRAM_API_ID || process.env.API_ID);
    const apiHash = (process.env.TELEGRAM_API_HASH || process.env.API_HASH || '').trim();
    const botToken = (process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '').trim();

    try {
      const session = new StringSession(stateStore.mtprotoSessionString || '');
      const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        useWSS: false,
        networkSocket: FastPromisedNetSockets as unknown as typeof PromisedNetSockets,
      });

      if (stateStore.mtprotoSessionString) {
        await client.connect();
      } else if (botToken) {
        await client.start({ botAuthToken: botToken });
        const saved = client.session.save() as unknown as string;
        if (typeof saved === 'string' && saved.length > 10) {
          stateStore.saveMtprotoSession(saved);
        }
      }

      this.primaryClient = client;
      this.connected = true;
      this.activeSockets = Math.min(stateStore.config.mtprotoTcpPoolSize, 8);
      this.lastEventAt = new Date().toISOString();

      netlog.info(
        'mtproto',
        `Pool MTProto FastSocket conectado (${this.activeSockets} sockets TCP · ${stateStore.config.mtprotoWorkers} workers seguros).`
      );
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('AUTH_KEY_DUPLICATED') && botToken) {
        netlog.warn('mtproto', 'AUTH_KEY_DUPLICATED detectado; regenerando sesion MTProto limpia.');
        stateStore.saveMtprotoSession('');
      }
      this.connected = false;
      this.activeSockets = 0;
      this.lastEventAt = new Date().toISOString();
      netlog.error('mtproto', `Error iniciando cliente MTProto: ${errMsg}`);
      return false;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.primaryClient) {
      try {
        await this.primaryClient.disconnect();
      } catch {
        // Ignore disconnect error on shutdown
      }
      this.primaryClient = null;
    }
    this.connected = false;
    this.activeSockets = 0;
  }

  /**
   * Direct parallel chunk downloader using Api.upload.GetFile with positional disk writes
   * (zero multi-GB buffering in RAM). Automatically falls back from 1 MB to 512 KB chunks on LIMIT_INVALID.
   */
  private async downloadDocumentDirectParallel(params: {
    client: TelegramClient;
    doc: Api.Document;
    fullPath: string;
    workers: number;
    onProgress?: (downloadedBytes: number, totalBytes: number, speedMbps: number) => void;
  }): Promise<{ bytesWritten: number; throughputMbps: number }> {
    const totalBytes = Number(params.doc.size);
    const location = new Api.InputDocumentFileLocation({
      id: params.doc.id,
      accessHash: params.doc.accessHash,
      fileReference: params.doc.fileReference,
      thumbSize: '',
    });

    const started = Date.now();
    let chunkSize = 1024 * 1024; // 1 MB preferred chunk size
    let nextOffset = 0;
    let downloadedBytes = 0;
    let lastReportAt = 0;
    let fatalError: Error | null = null;

    const fh = await fs.promises.open(params.fullPath, 'w');
    try {
      const workerLoop = async () => {
        while (!fatalError) {
          const offset = nextOffset;
          if (offset >= totalBytes) break;
          const requestLimit = chunkSize;
          nextOffset += requestLimit;

          let retries = 0;
          let success = false;
          while (!success && retries < 6 && !fatalError) {
            try {
              const res = await params.client.invoke(
                new Api.upload.GetFile({
                  location,
                  offset: bigInt(offset),
                  limit: requestLimit,
                  precise: true,
                  cdnSupported: false,
                })
              );

              if (res instanceof Api.upload.File && res.bytes && res.bytes.length > 0) {
                const buf = Buffer.from(res.bytes);
                await fh.write(buf, 0, buf.length, offset);
                downloadedBytes += buf.length;
                const now = Date.now();
                if (params.onProgress && (now - lastReportAt >= 500 || downloadedBytes >= totalBytes)) {
                  lastReportAt = now;
                  const elapsedSec = Math.max(0.1, (now - started) / 1000);
                  const speedMbps = Number(((downloadedBytes / (1024 * 1024)) / elapsedSec).toFixed(2));
                  params.onProgress(Math.min(downloadedBytes, totalBytes), totalBytes, speedMbps);
                }
              }
              success = true;
            } catch (err) {
              retries += 1;
              const msg = err instanceof Error ? err.message : String(err);

              if (msg.includes('LIMIT_INVALID') && chunkSize > 512 * 1024) {
                chunkSize = 512 * 1024;
                nextOffset = Math.min(nextOffset, offset + chunkSize);
                netlog.warn('mtproto', 'LIMIT_INVALID recibido; ajustando tamano de bloque a 512 KB.');
                continue;
              }

              const floodSec = extractFloodWaitSeconds(msg);
              if (floodSec !== null) {
                netlog.warn('mtproto', `FLOOD_WAIT_${floodSec}s durante descarga paralela; pausando worker.`);
                await new Promise((r) => setTimeout(r, Math.min(30, floodSec + 1) * 1000));
                continue;
              }

              if (msg.includes('FILE_MIGRATE') || msg.includes('FILE_REFERENCE_EXPIRED') || retries >= 6) {
                fatalError = err instanceof Error ? err : new Error(msg);
                break;
              }

              await new Promise((r) => setTimeout(r, 700 * retries));
            }
          }
        }
      };

      const workerCount = Math.min(params.workers, Math.max(1, Math.ceil(totalBytes / chunkSize)));
      await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));

      if (fatalError) {
        throw fatalError;
      }
    } finally {
      await fh.close();
    }

    const elapsedSec = Math.max(0.1, (Date.now() - started) / 1000);
    const bytesWritten = fs.existsSync(params.fullPath) ? fs.statSync(params.fullPath).size : 0;
    const throughputMbps = Number(((bytesWritten / (1024 * 1024)) / elapsedSec).toFixed(2));
    return { bytesWritten, throughputMbps };
  }

  public async downloadTelegramMessageMedia(params: {
    chatId: string | number;
    messageId: number;
    expectedBytes: number;
    targetRelativePath: string;
    onProgress?: (downloadedBytes: number, totalBytes: number, speedMbps?: number) => void;
  }): Promise<{ filePath: string; bytesWritten: number; throughputMbps: number }> {
    const space = await ensureScratchSpaceForFile(params.expectedBytes);
    if (!space.ok) {
      throw new Error(space.reason || 'Espacio en disco insuficiente antes de iniciar descarga MTProto.');
    }

    const ready = await this.connectIfConfigured();
    if (!ready || !this.primaryClient) {
      throw new Error('Cliente MTProto no conectado. Verifica TELEGRAM_API_ID y TELEGRAM_API_HASH.');
    }

    const fullPath = resolveConfinedScratchPath(params.targetRelativePath);
    const messages = await this.primaryClient.getMessages(params.chatId, { ids: [params.messageId] });
    const message = messages?.[0];
    if (!message || !message.media) {
      throw new Error(`Mensaje #${params.messageId} no contiene archivo descargable.`);
    }

    const workers = Math.min(12, Math.max(2, stateStore.config.mtprotoWorkers));
    if (workers > 8) {
      netlog.warn(
        'mtproto',
        `Ejecutando descarga con ${workers} workers paralelos: vigila latencia AES en CPU compartida de Altare.`
      );
    }

    // Prefer direct parallel Api.upload.GetFile for Api.MessageMediaDocument (> 1 MB)
    if (
      message.media instanceof Api.MessageMediaDocument &&
      message.media.document instanceof Api.Document &&
      Number(message.media.document.size) > 1024 * 1024
    ) {
      try {
        const directRes = await this.downloadDocumentDirectParallel({
          client: this.primaryClient,
          doc: message.media.document,
          fullPath,
          workers,
          onProgress: (d, t, spd) => params.onProgress?.(d, t, spd),
        });
        this.lastEventAt = new Date().toISOString();
        netlog.info('mtproto', `Descarga directa FastSocket completada: ${params.targetRelativePath}`, {
          throughputMbps: directRes.throughputMbps,
          workers,
        });
        return { filePath: fullPath, ...directRes };
      } catch (err) {
        netlog.warn(
          'mtproto',
          `Descarga directa recayo a downloadMedia estandar: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const started = Date.now();
    const downloadOpts: Parameters<TelegramClient['downloadMedia']>[1] & { workers?: number } = {
      outputFile: fullPath,
      workers,
      progressCallback: (downloaded, total) => {
        const dNum = Number(downloaded);
        const tNum = Number(total || params.expectedBytes || 1);
        const elapsedSec = Math.max(0.1, (Date.now() - started) / 1000);
        const speedMbps = Number(((dNum / (1024 * 1024)) / elapsedSec).toFixed(2));
        params.onProgress?.(dNum, tNum, speedMbps);
      },
    };
    await this.primaryClient.downloadMedia(message, downloadOpts);

    const elapsedSec = Math.max(0.1, (Date.now() - started) / 1000);
    const bytesWritten = fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0;
    const throughputMbps = Number(((bytesWritten / (1024 * 1024)) / elapsedSec).toFixed(2));
    this.lastEventAt = new Date().toISOString();

    netlog.info('mtproto', `Descarga MTProto completada: ${params.targetRelativePath}`, {
      throughputMbps,
      workers,
    });

    return { filePath: fullPath, bytesWritten, throughputMbps };
  }
}

export const mtprotoPool = new MtprotoPoolManager();
