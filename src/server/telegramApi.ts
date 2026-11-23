import fs from 'fs';
import { resolveConfinedScratchPath } from './scratchDiskManager.ts';

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export function escHtml(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function getTelegramBotToken(): string {
  return (process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '').trim();
}

async function callTelegramApi<T = unknown>(
  method: string,
  payload: Record<string, unknown>,
  timeoutMs = 15_000
): Promise<{ ok: boolean; result?: T; description?: string }> {
  const token = getTelegramBotToken();
  if (!token) return { ok: false, description: 'TELEGRAM_BOT_TOKEN no configurado.' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return (await res.json()) as { ok: boolean; result?: T; description?: string };
  } catch (err) {
    return { ok: false, description: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function tgSendMessage(
  chatId: string | number,
  htmlText: string,
  replyMarkup?: InlineKeyboardMarkup
): Promise<number | null> {
  const res = await callTelegramApi<{ message_id?: number }>('sendMessage', {
    chat_id: chatId,
    text: htmlText.slice(0, 4050),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  if (res.ok && res.result?.message_id) return res.result.message_id;

  // Fallback to plain text if HTML formatting fails unexpectedly
  if (!res.ok && res.description?.includes('parse entities')) {
    const plain = htmlText.replace(/<[^>]+>/g, '');
    const retry = await callTelegramApi<{ message_id?: number }>('sendMessage', {
      chat_id: chatId,
      text: plain.slice(0, 4050),
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    return retry.ok && retry.result?.message_id ? retry.result.message_id : null;
  }
  return null;
}

export async function tgEditMessage(
  chatId: string | number,
  messageId: number,
  htmlText: string,
  replyMarkup?: InlineKeyboardMarkup
): Promise<boolean> {
  const res = await callTelegramApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: htmlText.slice(0, 4050),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  if (res.ok) return true;
  if (res.description?.includes('message is not modified')) return true;
  return false;
}

export async function tgDeleteMessage(chatId: string | number, messageId: number): Promise<boolean> {
  const res = await callTelegramApi('deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  });
  return Boolean(res.ok);
}

export async function tgAnswerCallback(
  callbackQueryId: string,
  text?: string,
  showAlert = false
): Promise<boolean> {
  const res = await callTelegramApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text: text.slice(0, 190) } : {}),
    show_alert: showAlert,
  });
  return Boolean(res.ok);
}

export async function tgSendPhoto(
  chatId: string | number,
  photoUrlOrBuffer: string | Buffer,
  captionHtml: string,
  replyMarkup?: InlineKeyboardMarkup
): Promise<boolean> {
  const token = getTelegramBotToken();
  if (!token) return false;

  if (typeof photoUrlOrBuffer === 'string') {
    const res = await callTelegramApi('sendPhoto', {
      chat_id: chatId,
      photo: photoUrlOrBuffer,
      caption: captionHtml.slice(0, 1000),
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    if (res.ok) return true;
    return Boolean(await tgSendMessage(chatId, captionHtml, replyMarkup));
  }

  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', captionHtml.slice(0, 1000));
  form.append('parse_mode', 'HTML');
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
  form.append('photo', new Blob([new Uint8Array(photoUrlOrBuffer)], { type: 'image/jpeg' }), 'cover.jpg');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    const body = (await res.json()) as { ok?: boolean };
    return Boolean(res.ok && body.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function tgDownloadSmallFileToScratch(fileId: string, targetRelativePath: string): Promise<string | null> {
  const res = await tgDownloadBotFileToScratch(fileId, targetRelativePath, 15 * 1024 * 1024);
  return res ? res.filePath : null;
}

/**
 * Streams a Telegram file (up to 20 MB Bot API limit) directly to scratch disk
 * so small videos/photos work even when MTProto FastSocket is not connected.
 */
export async function tgDownloadBotFileToScratch(
  fileId: string,
  targetRelativePath: string,
  maxBytes = 20 * 1024 * 1024,
  onProgress?: (downloadedBytes: number, totalBytes: number, speedMbps: number) => void
): Promise<{ filePath: string; bytesWritten: number; throughputMbps: number } | null> {
  const token = getTelegramBotToken();
  if (!token) return null;

  const info = await callTelegramApi<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId }, 12_000);
  const filePath = info.result?.file_path;
  if (!info.ok || !filePath) return null;
  if (info.result?.file_size && info.result.file_size > maxBytes) return null;

  const confined = resolveConfinedScratchPath(targetRelativePath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  const started = Date.now();
  let bytesWritten = 0;

  try {
    const dlRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
      signal: controller.signal,
    });
    if (!dlRes.ok || !dlRes.body) return null;

    const totalExpected = Number(dlRes.headers.get('content-length') || info.result?.file_size || 0);
    const out = fs.createWriteStream(confined);
    const reader = dlRes.body.getReader();
    let lastReport = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        bytesWritten += value.byteLength;
        if (bytesWritten > maxBytes) {
          throw new Error('El archivo excede el límite de descarga directa de Bot API.');
        }
        if (!out.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => out.once('drain', resolve));
        }
        const now = Date.now();
        if (onProgress && (now - lastReport >= 700 || (totalExpected > 0 && bytesWritten >= totalExpected))) {
          lastReport = now;
          const elapsed = Math.max(0.1, (now - started) / 1000);
          onProgress(bytesWritten, totalExpected || bytesWritten, Number(((bytesWritten / 1024 ** 2) / elapsed).toFixed(2)));
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve());
        out.on('error', reject);
      });
    } catch (err) {
      out.destroy();
      try {
        if (fs.existsSync(confined)) fs.rmSync(confined, { force: true });
      } catch {
        // Ignore cleanup failure
      }
      throw err;
    }

    if (bytesWritten < 64) {
      try {
        if (fs.existsSync(confined)) fs.rmSync(confined, { force: true });
      } catch {
        // Ignore
      }
      return null;
    }
    const elapsedSec = Math.max(0.1, (Date.now() - started) / 1000);
    return {
      filePath: confined,
      bytesWritten,
      throughputMbps: Number(((bytesWritten / 1024 ** 2) / elapsedSec).toFixed(2)),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const PRIVATE_IP_OR_HOST_REGEX =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|\[::1\]|.*\.local)$/i;

/**
 * SSRF-safe streaming direct HTTP/HTTPS video downloader to scratch disk for /url command.
 */
export async function downloadDirectUrlToScratch(params: {
  url: string;
  targetRelativePath: string;
  maxBytes: number;
  onProgress?: (downloadedBytes: number, totalBytes: number, speedMbps: number) => void;
}): Promise<{ filePath: string; bytesWritten: number; throughputMbps: number; detectedFileName: string }> {
  const parsed = new URL(params.url.trim());
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Solo se permiten enlaces HTTP o HTTPS.');
  }
  if (PRIVATE_IP_OR_HOST_REGEX.test(parsed.hostname)) {
    throw new Error('Enlace bloqueado por política de seguridad (host local/privado).');
  }

  const confined = resolveConfinedScratchPath(params.targetRelativePath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15 * 60_000);
  const started = Date.now();
  let bytesWritten = 0;

  try {
    const res = await fetch(parsed.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'PictaBot/2.0' },
    });
    if (!res.ok || !res.body) {
      throw new Error(`El servidor remoto respondió HTTP ${res.status}.`);
    }
    const finalParsed = new URL(res.url || parsed.toString());
    if (PRIVATE_IP_OR_HOST_REGEX.test(finalParsed.hostname)) {
      throw new Error('Redirección bloqueada por seguridad.');
    }

    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > 0 && contentLength > params.maxBytes) {
      throw new Error(`El archivo remoto (${(contentLength / 1024 ** 3).toFixed(2)} GB) supera el límite permitido.`);
    }

    const cd = res.headers.get('content-disposition') || '';
    const cdMatch = cd.match(/filename\*?=(?:UTF-8'')?"?([^";\r\n]+)"?/i);
    const urlBase = decodeURIComponent(finalParsed.pathname.split('/').pop() || '').trim();
    const detectedFileName = (cdMatch?.[1] || urlBase || 'video_url.mp4').replace(/[^a-zA-Z0-9._\-\s]/g, '_');

    const out = fs.createWriteStream(confined);
    const reader = res.body.getReader();
    let lastReport = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        bytesWritten += value.byteLength;
        if (bytesWritten > params.maxBytes) {
          throw new Error('El archivo descargado superó el límite permitido.');
        }
        if (!out.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => out.once('drain', resolve));
        }
        const now = Date.now();
        if (params.onProgress && (now - lastReport >= 900 || (contentLength > 0 && bytesWritten >= contentLength))) {
          lastReport = now;
          const elapsed = Math.max(0.1, (now - started) / 1000);
          params.onProgress(
            bytesWritten,
            contentLength || bytesWritten,
            Number(((bytesWritten / 1024 ** 2) / elapsed).toFixed(2))
          );
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve());
        out.on('error', reject);
      });
    } catch (err) {
      out.destroy();
      try {
        if (fs.existsSync(confined)) fs.rmSync(confined, { force: true });
      } catch {
        // Ignore
      }
      throw err;
    }

    if (bytesWritten < 1024) {
      throw new Error('El enlace no devolvió un archivo de video válido.');
    }

    const elapsedSec = Math.max(0.1, (Date.now() - started) / 1000);
    return {
      filePath: confined,
      bytesWritten,
      throughputMbps: Number(((bytesWritten / 1024 ** 2) / elapsedSec).toFixed(2)),
      detectedFileName,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function hudHeader(title: string, icon?: string): string {
  const prefix = icon ? `${icon} ` : '';
  return `<b>⟦ ${prefix}${escHtml(title)} ⟧</b>\n`;
}

export function hudSection(title: string): string {
  return `\n<b>▸ ${escHtml(title)}</b>\n`;
}

export function hudBox(lines: Array<string | null | undefined | false>): string {
  const valid = lines.filter((l): l is string => Boolean(l && String(l).trim()));
  if (valid.length === 0) return '';
  return `<blockquote>${valid.join('\n')}</blockquote>\n`;
}

export function hudSegmentedBar(valueOrPct: number, totalOrSegments = 10, explicitSegments?: number): string {
  const pct =
    explicitSegments !== undefined
      ? totalOrSegments > 0
        ? (valueOrPct / totalOrSegments) * 100
        : 0
      : valueOrPct;
  const segments = explicitSegments !== undefined ? explicitSegments : totalOrSegments;
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.round((clamped / 100) * segments);
  return '▰'.repeat(filled) + '▱'.repeat(Math.max(0, segments - filled));
}

export function formatMilestoneNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}

export async function tgRegisterDefaultCommands(): Promise<void> {
  await callTelegramApi('setMyCommands', {
    commands: [
      { command: 'buscar', description: '🔎 Buscar si una película, serie o video ya existe en Picta' },
      { command: 'canal', description: '🏛️ Editar mi Canal de Picta (Nombre, Lema, Avatar, Portada)' },
      { command: 'series', description: '📺 Series de mi Canal y 📌 Modo Serie Fija (Ráfaga)' },
      { command: 'cola', description: '📋 Ver Cola de Espera, Modo Ráfaga y Cancelar Subidas' },
      { command: 'cuota', description: '⚡ Dividir Cuota Diaria (10/día) y Pool Multi-Cuenta (+10/cuenta)' },
      { command: 'stats', description: '📊 Dashboard de Picta y Edición de Videos Publicados' },
      { command: 'auditoria', description: '🩺 Auditar duplicados internos, faltantes y salud de tu canal' },
      { command: 'pedidos', description: '📥 Gestor de pedidos y verificador rápido en Picta' },
      { command: 'canalpedidos', description: '📢 Configurar Canal/Grupo de Pedidos y auto-verificador' },
      { command: 'logros', description: '🏆 Alertas de Comentarios y Metas de Reproducciones/Likes' },
      { command: 'cuenta', description: '🛡️ Estado y permisos Jefe de canal de tu cuenta Picta' },
      { command: 'colaboradores', description: '👥 Gestionar Colaboradores asociados a tu canal Picta' },
      { command: 'personas', description: '🎭 Registrar y buscar Actores, Directores y Etiquetas API' },
      { command: 'listas', description: '📂 Gestionar Listas de Reproducción del canal' },
      { command: 'comentarios', description: '💬 Responder Comentarios por Categoría o con IA' },
      { command: 'reintentar', description: '🔄 Reintentar última publicación pendiente con S3' },
      { command: 'unir', description: '🧩 Unir videos multiparte o archivos en disco' },
      { command: 'login', description: '🔑 Vincular tu cuenta personal de Picta (aislada)' },
      { command: 'menu', description: '🟢 Menú principal y estado del bot' },
    ],
  });
}

