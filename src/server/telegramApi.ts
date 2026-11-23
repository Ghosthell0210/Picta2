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
  const token = getTelegramBotToken();
  if (!token) return null;

  const info = await callTelegramApi<{ file_path?: string }>('getFile', { file_id: fileId }, 10_000);
  const filePath = info.result?.file_path;
  if (!info.ok || !filePath) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const dlRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
      signal: controller.signal,
    });
    if (!dlRes.ok) return null;
    const arr = await dlRes.arrayBuffer();
    if (arr.byteLength < 64 || arr.byteLength > 15 * 1024 * 1024) return null;
    const confined = resolveConfinedScratchPath(targetRelativePath);
    fs.writeFileSync(confined, Buffer.from(arr));
    return confined;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function tgRegisterDefaultCommands(): Promise<void> {
  await callTelegramApi('setMyCommands', {
    commands: [
      { command: 'menu', description: 'Abrir centro de control PictaBot' },
      { command: 'modo', description: 'Alternar modo Asistente / Rápido' },
      { command: 'catalogo', description: 'Explorar y editar publicaciones' },
      { command: 'series', description: 'Gestionar series y favoritas' },
      { command: 'listas', description: 'Gestionar listas de reproducción' },
      { command: 'comentarios', description: 'Comentarios y respuestas con IA' },
      { command: 'peticiones', description: 'Peticiones detectadas de usuarios' },
      { command: 'promos', description: 'Canales promocionales y difusión' },
      { command: 'cola', description: 'Ver cola y estado de subidas' },
      { command: 'unir', description: 'Ensamblar video multiparte o ZIP/TAR' },
      { command: 'unir_fin', description: 'Finalizar y subir ensamblaje /unir' },
      { command: 'buscar', description: 'Buscar película/serie en TMDB' },
      { command: 'login', description: 'Vincular tu cuenta propia de Picta' },
      { command: 'mis_canales', description: 'Cambiar tu canal activo de Picta' },
      { command: 'stats', description: 'Estadísticas de hoy en Picta' },
      { command: 'estado', description: 'Salud del bot, disco y MTProto' },
      { command: 'backup', description: 'Respaldar estado cifrado en Bóveda' },
    ],
  });
}
