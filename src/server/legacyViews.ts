import crypto from 'crypto';
import type {
  AuthorizedUser,
  ChannelAuditReport,
  PictaPoolAccount,
} from '../shared/types.ts';
import { isGeminiConfigured } from './mediaIntelligence.ts';
import { mtprotoPool } from './mtprotoFastDownload.ts';
import { pictaService, type PictaAuthContext } from './pictaClient.ts';
import { DEFAULT_MILESTONE_THRESHOLDS, getCubaDateStr, stateStore } from './stateStore.ts';
import {
  escHtml,
  formatMilestoneNumber,
  hudBox,
  hudHeader,
  hudSection,
  hudSegmentedBar,
  tgEditMessage,
  tgSendMessage,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
} from './telegramApi.ts';

const fmtMb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const fmtNum = (n: number) => Number(n || 0).toLocaleString('es-ES');

const auditCache = new Map<string, { report: ChannelAuditReport; expiresAt: number }>();

async function showOrEditHud(
  chatId: number,
  editMessageId: number | undefined,
  htmlText: string,
  markup?: InlineKeyboardMarkup
): Promise<void> {
  if (editMessageId) {
    const ok = await tgEditMessage(chatId, editMessageId, htmlText, markup);
    if (ok) return;
  }
  await tgSendMessage(chatId, htmlText, markup);
}

/**
 * 1. Exact Legacy Main Menu HUD (/menu, /start, /estado) with all 8 legacy rows + utility row
 */
export async function renderLegacyMainMenuHud(
  chatId: number,
  user: AuthorizedUser,
  isAdmin: boolean,
  editMessageId?: number
): Promise<void> {
  stateStore.resetDailyQuotasIfNeeded();
  const isMaster = stateStore.isMasterAdmin(user.telegramUserId);
  const session = stateStore.userSessions.find((s) => s.telegramUserId === user.telegramUserId);
  const accountLabel = session
    ? session.pictaUsername
    : isMaster
    ? `${process.env.PICTA_USERNAME || 'Cuenta Maestra'} (Maestra)`
    : 'Sin vincular (/login)';
  const channelLabel = session
    ? `${session.channelName} (#${session.channelId})`
    : isMaster
    ? `${pictaService.getDefaultChannelName()} (#${pictaService.getDefaultChannelId()})`
    : 'Sin canal activo';

  const q = stateStore.quotaSettings;
  const seriesToday = q.seriesUploadedToday || 0;
  const otherToday = q.otherUploadedToday || 0;
  const usedToday = seriesToday + otherToday;
  const poolAccs = q.poolAccounts || [];
  const activePoolWithChannelRole = poolAccs.filter((p) => p.canPublishDirectly).length;
  const totalDailyCap = 10 + activePoolWithChannelRole * 10;
  const quotaBar = hudSegmentedBar(usedToday, totalDailyCap, 10);

  const activeJobs = stateStore.jobs.filter((j) =>
    ['queued', 'downloading', 'assembling', 'uploading', 'creating_picta_publication', 'encoding_nomad'].includes(j.status)
  ).length;
  const pendingReqs = stateStore.channelRequests.filter((r) => r.status === 'pending').length;
  const pinned = stateStore.getPinnedSerieForUser(user.telegramUserId);
  const mt = mtprotoPool.getStatus();
  const modeLabel = user.uploadMode === 'fast' ? '⚡ Rápido' : '🧭 Asistente';

  const boxLines = [
    `👤 <b>Cuenta:</b> ${escHtml(accountLabel)}`,
    `📺 <b>Canal:</b> ${escHtml(channelLabel)}`,
    `🚀 <b>Motor:</b> MTProto 4 GB (${mt.connected ? '🟢 Online' : '🟡 Bot API'}) · S3 Directo`,
    `⚡ <b>Cuota Hoy:</b> <code>${quotaBar}</code> (<b>${usedToday}/${totalDailyCap}</b> · 📺 ${seriesToday} / 🎬 ${otherToday})`,
    `✨ <b>Modo:</b> ${modeLabel} · <b>IA Gemini:</b> ${isGeminiConfigured() ? '🟢 Activa' : '⚪ Off'}`,
    ...(pinned
      ? [`📌 <b>Modo Serie Fija:</b> ${escHtml(pinned.serieName)} (T${pinned.seasonNum} · Próx. Cap. ${pinned.nextEpisodeNumber || 'Auto'})`]
      : []),
  ];

  const text = [
    hudHeader('PANEL DE CONTROL', '🎬'),
    hudBox(boxLines),
    ``,
    `💡 <i>Envía cualquier video o archivo al chat para subirlo a Picta, o selecciona un módulo:</i>`,
  ].join('\n');

  const rows: InlineKeyboardButton[][] = [
    [
      { text: '🏛️ Estudio de Canal', callback_data: 'm:chan' },
      { text: '📊 Videos y Stats', callback_data: 'm:sta:1' },
    ],
    [
      { text: '📺 Mis Series y Ráfaga', callback_data: 'm:ser' },
      { text: '🔎 Buscar en Picta', callback_data: 'lg:search' },
    ],
    [
      { text: '💬 Comentarios', callback_data: 'm:com:u:0' },
      { text: '🏆 Logros y Alertas', callback_data: 'lg:logros' },
    ],
    [
      { text: '📂 Listas', callback_data: 'm:lis' },
      { text: '🛡️ Cuenta Picta', callback_data: 'm:acc' },
    ],
    [
      { text: '👥 Colaboradores', callback_data: 'lg:colab' },
      { text: '🎭 Actores y Tags', callback_data: 'lg:pers' },
    ],
    [
      { text: '📢 Canal de Pedidos', callback_data: 'lg:cped' },
      { text: `📥 Pedidos (${pendingReqs})`, callback_data: 'm:req:0' },
    ],
    [
      { text: '🩺 Auditoría Canal', callback_data: 'lg:audit:dup:1' },
      isAdmin
        ? { text: `👥 Usuarios (${stateStore.users.length})`, callback_data: 'us:list' }
        : { text: '🔑 Mi Sesión (/login)', callback_data: 'm:acc' },
    ],
    [
      { text: `📋 Cola (${activeJobs})${pinned ? ' · 📌 Serie' : ''}`, callback_data: 'm:col' },
      { text: `⚡ Cuota (${usedToday}/${totalDailyCap})`, callback_data: 'lg:cuota' },
    ],
    [
      { text: `Modo: ${modeLabel}`, callback_data: 'm:mode' },
      { text: '✨ Asistente IA', callback_data: 'm:ai' },
      { text: '🧩 Unir / URL', callback_data: 'm:tools' },
    ],
    [
      ...(isAdmin ? [{ text: '🛡️ Admin y Bóveda', callback_data: 'm:adm' }] : []),
      { text: '❓ Guía / Ayuda', callback_data: 'm:help' },
    ],
  ];

  await showOrEditHud(chatId, editMessageId, text, { inline_keyboard: rows });
}

/**
 * 2. Global Picta Search (/buscar, /search) across all of Picta (/v2/publicacion/ + /v2/serie/)
 */
export async function renderGlobalPictaSearchView(
  chatId: number,
  userId: string,
  query?: string,
  editMessageId?: number
): Promise<void> {
  if (!query || !query.trim()) {
    const promptLines = [
      hudHeader('BUSCADOR GLOBAL DE PICTA', '🔎'),
      hudBox([
        `Busca cualquier película, serie o capítulo en todo el catálogo nacional de <b>Picta</b> (<code>/v2/publicacion/</code> + <code>/v2/serie/</code>).`,
        `También puedes usar directamente: <code>/buscar Nombre</code>`,
      ]),
    ];
    await showOrEditHud(chatId, editMessageId, promptLines.join('\n'), {
      inline_keyboard: [
        [
          { text: '🔎 Escribir Título a Buscar', callback_data: 'lg:searchq' },
          { text: '🎬 Buscar en TMDB', callback_data: 'lg:tmdbq' },
        ],
        [{ text: '🏠 Menú Principal', callback_data: 'm:home' }],
      ],
    });
    return;
  }

  let ctx: PictaAuthContext | undefined;
  try {
    ctx = await pictaService.resolveContextForUser(userId);
  } catch {
    ctx = undefined;
  }

  const hits = await pictaService.searchGlobalPictaCatalog(query, ctx);
  const lines = [
    hudHeader('BUSCADOR GLOBAL DE PICTA', '🔎'),
    `Consulta: <b>"${escHtml(query)}"</b> · Resultados: <b>${hits.length}</b>`,
    ``,
  ];

  if (hits.length === 0) {
    lines.push(`No se encontraron publicaciones ni series en Picta con ese título.`);
  } else {
    hits.slice(0, 8).forEach((h, idx) => {
      const badge =
        h.matchScore >= 0.92 ? '🟢 Exacto' : h.matchScore >= 0.75 ? '🟡 Similar' : '⚪ Relacionado';
      const kindIcon = h.kind === 'serie' ? '📺 Serie' : '🎬 Video';
      const sizeStr = h.sizeBytes > 0 ? ` · 📦 ${fmtMb(h.sizeBytes)}` : '';
      const dateStr = h.createdAt ? ` · 📅 ${h.createdAt.slice(0, 10)}` : '';
      lines.push(
        `${idx + 1}. ${badge} · ${kindIcon} <a href="${escHtml(h.webUrl)}"><b>${escHtml(h.title)}</b></a>\n` +
          `   📺 ${escHtml(h.channelName)} · 📂 ${escHtml(h.categoryName)} · 👁 ${fmtNum(h.views)}${sizeStr}${dateStr}`
      );
    });
  }

  const rows: InlineKeyboardButton[][] = [
    [
      { text: '🔎 Nueva Búsqueda en Picta', callback_data: 'lg:searchq' },
      { text: '🎬 Buscar también en TMDB', callback_data: 'lg:tmdbq' },
    ],
    [{ text: '🏠 Menú Principal', callback_data: 'm:home' }],
  ];

  await showOrEditHud(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
}

/**
 * 3. Channel Health Audit (/auditoria, /saludcanal) with 4 tabs (dup, inc, unp, orp)
 */
export async function renderChannelAuditView(
  chatId: number,
  userId: string,
  tab: 'dup' | 'inc' | 'unp' | 'orp' = 'dup',
  page = 1,
  forceRefresh = false,
  editMessageId?: number
): Promise<void> {
  let ctx: PictaAuthContext;
  try {
    ctx = await pictaService.resolveContextForUser(userId);
  } catch (err) {
    await showOrEditHud(chatId, editMessageId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
    return;
  }

  const cacheKey = `${userId}:${ctx.channelId}`;
  let report = !forceRefresh ? auditCache.get(cacheKey)?.report : undefined;
  if (!report || (auditCache.get(cacheKey)?.expiresAt || 0) <= Date.now()) {
    report = await pictaService.auditChannelCatalog(ctx);
    auditCache.set(cacheKey, { report, expiresAt: Date.now() + 5 * 60_000 });
  }

  const tabTitles: Record<'dup' | 'inc' | 'unp' | 'orp', string> = {
    dup: `🔁 Duplicados (${report.duplicateGroups.length})`,
    inc: `🖼️ Incompletos (${report.incompleteItems.length})`,
    unp: `⏳ Sin publicar (${report.unpublishedItems.length})`,
    orp: `📺 Cap. sueltos (${report.orphanEpisodeItems.length})`,
  };

  const lines = [
    hudHeader('AUDITORÍA DE SALUD DEL CANAL', '🩺'),
    hudBox([
      `📺 <b>Canal:</b> ${escHtml(ctx.channelName)} (#${escHtml(ctx.channelId)})`,
      `📊 <b>Escaneados:</b> ${report.totalScanned} video(s)`,
      `🔁 Duplicados: <b>${report.duplicateGroups.length}</b> · 🖼️ Incompletos: <b>${report.incompleteItems.length}</b>`,
      `⏳ Sin publicar: <b>${report.unpublishedItems.length}</b> · 📺 Cap. sueltos: <b>${report.orphanEpisodeItems.length}</b>`,
    ]),
    hudSection(tabTitles[tab]),
  ];

  const rows: InlineKeyboardButton[][] = [
    [
      { text: tab === 'dup' ? `• 🔁 Dup (${report.duplicateGroups.length}) •` : `🔁 Dup (${report.duplicateGroups.length})`, callback_data: 'lg:audit:dup:1' },
      { text: tab === 'inc' ? `• 🖼️ Inc (${report.incompleteItems.length}) •` : `🖼️ Inc (${report.incompleteItems.length})`, callback_data: 'lg:audit:inc:1' },
    ],
    [
      { text: tab === 'unp' ? `• ⏳ Ocultos (${report.unpublishedItems.length}) •` : `⏳ Ocultos (${report.unpublishedItems.length})`, callback_data: 'lg:audit:unp:1' },
      { text: tab === 'orp' ? `• 📺 Sueltos (${report.orphanEpisodeItems.length}) •` : `📺 Sueltos (${report.orphanEpisodeItems.length})`, callback_data: 'lg:audit:orp:1' },
    ],
  ];

  const pageSize = 5;
  let totalItems = 0;

  if (tab === 'dup') {
    totalItems = report.duplicateGroups.length;
    const slice = report.duplicateGroups.slice((page - 1) * pageSize, page * pageSize);
    if (slice.length === 0) {
      lines.push(`✅ No se detectaron grupos de videos duplicados en tu canal.`);
    } else {
      slice.forEach((grp, idx) => {
        lines.push(
          `<b>${(page - 1) * pageSize + idx + 1}. ${escHtml(grp.reason)}</b>:\n` +
            grp.items.map((it) => `   • #<code>${it.id}</code> ${escHtml(it.nombre.slice(0, 42))} (👁 ${fmtNum(it.views)})`).join('\n')
        );
        const btnRow: InlineKeyboardButton[] = grp.items.slice(0, 2).map((it) => ({
          text: `🛠️ #${it.id} ${it.nombre.slice(0, 18)}`,
          callback_data: `cv:${it.id}`,
        }));
        if (btnRow.length > 0) rows.push(btnRow);
      });
    }
  } else {
    const list =
      tab === 'inc'
        ? report.incompleteItems
        : tab === 'unp'
        ? report.unpublishedItems
        : report.orphanEpisodeItems;
    totalItems = list.length;
    const slice = list.slice((page - 1) * pageSize, page * pageSize);
    if (slice.length === 0) {
      lines.push(`✅ Ninguna incidencia detectada en esta categoría.`);
    } else {
      slice.forEach((it, idx) => {
        lines.push(
          `<b>${(page - 1) * pageSize + idx + 1}. ${escHtml(it.nombre.slice(0, 48))}</b> (#<code>${it.id}</code>)\n` +
            `   ⚠️ <i>${escHtml(it.reason)}</i> · 👁 ${fmtNum(it.views)}`
        );
        rows.push([{ text: `🛠️ Editar #${it.id}: ${it.nombre.slice(0, 28)}`, callback_data: `cv:${it.id}` }]);
      });
    }
  }

  const nav: InlineKeyboardButton[] = [];
  if (page > 1) nav.push({ text: '⬅️ Ant.', callback_data: `lg:audit:${tab}:${page - 1}` });
  nav.push({ text: '🔄 Re-escanear', callback_data: `lg:auditref:${tab}` });
  if (page * pageSize < totalItems) nav.push({ text: 'Sig. ➡️', callback_data: `lg:audit:${tab}:${page + 1}` });
  rows.push(nav);
  rows.push([{ text: '🏛️ Estudio de Canal', callback_data: 'm:chan' }, { text: '🏠 Menú', callback_data: 'm:home' }]);

  await showOrEditHud(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
}

/**
 * 4. Daily Cuba Quota (10/day) & Multi-Account Pool (/cuota, /limite, /pool, /cuentas)
 */
export async function renderDailyQuotaAndPoolView(
  chatId: number,
  user: AuthorizedUser,
  isAdmin: boolean,
  editMessageId?: number
): Promise<void> {
  stateStore.resetDailyQuotasIfNeeded();
  const q = stateStore.quotaSettings;
  const seriesToday = q.seriesUploadedToday || 0;
  const otherToday = q.otherUploadedToday || 0;
  const usedToday = seriesToday + otherToday;
  const poolAccs = q.poolAccounts || [];
  const activeLeaderPool = poolAccs.filter((p) => p.canPublishDirectly).length;
  const totalCap = 10 + activeLeaderPool * 10;
  const bar = hudSegmentedBar(usedToday, totalCap, 10);
  const maxSer = q.maxSeriesPerDay ?? 5;
  const reserveLabel =
    maxSer >= 10
      ? '10/10 Sin Reserva (Libre)'
      : `${maxSer} Series / ${10 - maxSer} Películas`;

  const lines = [
    hudHeader('CUOTA DIARIA Y POOL MULTI-CUENTA', '⚡'),
    hudBox([
      `📅 <b>Fecha Cuba (America/Havana):</b> ${escHtml(q.currentDateCuba || getCubaDateStr())}`,
      `📊 <b>Capacidad Total Hoy:</b> <code>${bar}</code> <b>${usedToday}/${totalCap}</b> publ.`,
      `📺 <b>Series subidas hoy:</b> ${seriesToday} · 🎬 <b>Películas/Otros:</b> ${otherToday}`,
      `⚖️ <b>Reparto Diario:</b> ${escHtml(reserveLabel)}`,
      `📦 <b>Tu consumo en GB:</b> ${user.usedTodayGb.toFixed(2)} / ${user.dailyQuotaGb} GB (${user.filesToday} arch.)`,
    ]),
    hudSection(`CUENTAS SECUNDARIAS EN EL POOL (${poolAccs.length})`),
  ];

  if (poolAccs.length === 0) {
    lines.push(
      `<i>No hay cuentas secundarias en el Pool. Cada cuenta con rol "Jefe de canal" añade +10 publicaciones diarias y las cuentas estándar aceleran la subida a S3 MinIO.</i>`
    );
  } else {
    poolAccs.forEach((acc, idx) => {
      const roleBadge = acc.canPublishDirectly ? '👑 Jefe de canal (+10/día)' : '🚀 Acelerador S3';
      lines.push(
        `${idx + 1}. <b>${escHtml(acc.username)}</b> (${escHtml(acc.displayName)}) · ${roleBadge}\n   Hoy: <b>${acc.uploadedToday}/10</b>`
      );
    });
  }

  const rows: InlineKeyboardButton[][] = [
    [
      { text: `⚖️ Cambiar Reserva Series (${maxSer}/10)`, callback_data: 'lg:qsplit' },
    ],
  ];

  if (isAdmin) {
    rows.push([{ text: '➕ Añadir Cuenta al Pool (+10/día)', callback_data: 'lg:pooladd' }]);
    poolAccs.slice(0, 5).forEach((acc) => {
      rows.push([
        {
          text: `🗑️ Quitar Pool: ${acc.username}`,
          callback_data: `lg:pooldel:${acc.id}`,
        },
      ]);
    });
    rows.push([{ text: '🔄 Reiniciar Contadores de Hoy', callback_data: 'lg:qreset' }]);
  }

  rows.push([{ text: '🏠 Menú Principal', callback_data: 'm:home' }]);
  await showOrEditHud(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
}

/**
 * 5. Channel Collaborators (/colaboradores, /asociados)
 */
export async function renderCollaboratorsView(
  chatId: number,
  userId: string,
  editMessageId?: number
): Promise<void> {
  let ctx: PictaAuthContext;
  try {
    ctx = await pictaService.resolveContextForUser(userId);
  } catch (err) {
    await showOrEditHud(chatId, editMessageId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
    return;
  }

  const colab = await pictaService.fetchChannelCollaborators(ctx);
  const lines = [
    hudHeader('COLABORADORES DEL CANAL', '👥'),
    hudBox([
      `📺 <b>Canal:</b> ${escHtml(colab.channelName)} (#${escHtml(colab.channelId)})`,
      `👑 <b>Propietario ID:</b> <code>${colab.ownerId ?? 'N/D'}</code>`,
      `🤝 <b>Usuarios Asociados:</b> ${colab.collaborators.length}`,
    ]),
    hudSection('LISTA DE ASOCIADOS'),
  ];

  const rows: InlineKeyboardButton[][] = [];
  if (colab.collaborators.length === 0) {
    lines.push(`No hay colaboradores asociados actualmente a este canal.`);
  } else {
    colab.collaborators.forEach((a, idx) => {
      lines.push(`${idx + 1}. ${a.isOwner ? '👑' : '🤝'} <b>${escHtml(a.label)}</b> (ID: <code>${a.id}</code>)`);
      if (!a.isOwner) {
        rows.push([{ text: `🗑️ Quitar Colaborador #${a.id}`, callback_data: `lg:colabrem:${a.id}` }]);
      }
    });
  }

  rows.push([{ text: '➕ Añadir Colaborador (ID, Usuario o Canal)', callback_data: 'lg:colabadd' }]);
  rows.push([{ text: '🏛️ Estudio de Canal', callback_data: 'm:chan' }, { text: '🏠 Menú', callback_data: 'm:home' }]);
  await showOrEditHud(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
}

/**
 * 6. Catalog of Actors/Directors & Keywords (/personas, /actores, /etiquetas, /tags)
 */
export async function renderPersonasAndTagsView(
  chatId: number,
  lastResultHtml?: string,
  editMessageId?: number
): Promise<void> {
  const lines = [
    hudHeader('CATÁLOGO DE PERSONAS Y ETIQUETAS', '🎭'),
    hudBox([
      `👤 <b>Personas (/v2/persona/):</b> Busca o registra actores, directores y productores en Picta.`,
      `🏷️ <b>Palabras Clave (/v2/palabra_clave/):</b> Busca o crea etiquetas oficiales para posicionar tus videos.`,
    ]),
    ...(lastResultHtml ? [``, lastResultHtml] : []),
  ];

  const rows: InlineKeyboardButton[][] = [
    [{ text: '👤 Registrar / Buscar Actor o Director', callback_data: 'lg:persadd' }],
    [{ text: '🏷️ Registrar / Buscar Etiqueta (Palabra Clave)', callback_data: 'lg:tagadd' }],
    [{ text: '🏛️ Estudio de Canal', callback_data: 'm:chan' }, { text: '🏠 Menú', callback_data: 'm:home' }],
  ];

  await showOrEditHud(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
}

/**
 * 7. Progressive Milestones & Alerts Config (/logros, /alertas, /metas)
 */
export async function renderLogrosAndAlertsHud(
  chatId: number,
  user: AuthorizedUser,
  editMessageId?: number
): Promise<void> {
  const prefs = stateStore.getAlertPrefsForUser(user.telegramUserId);
  const m = prefs.enabledMetrics;
  const thresholdsStr = (prefs.thresholds.length ? prefs.thresholds : DEFAULT_MILESTONE_THRESHOLDS)
    .map((t) => formatMilestoneNumber(t))
    .join(' → ');

  const recent = stateStore.alerts.slice(0, 6);
  const lines = [
    hudHeader('LOGROS PROGRESIVOS Y ALERTAS', '🏆'),
    hudBox([
      `💬 <b>Alertas de Comentarios:</b> ${prefs.commentsEnabled ? '🟢 ACTIVAS' : '🔴 PAUSADAS'}`,
      `🏆 <b>Alertas de Logros:</b> ${prefs.milestonesEnabled ? '🟢 ACTIVAS' : '🔴 PAUSADAS'}`,
      `📊 <b>Métricas vigiladas:</b>`,
      `   ${m.plays ? '✅' : '⬜'} ▶️ Reproducciones · ${m.likes ? '✅' : '⬜'} ❤️ Likes`,
      `   ${m.downloads ? '✅' : '⬜'} 📥 Descargas · ${m.comments ? '✅' : '⬜'} 💬 Comentarios`,
      `   🚫 <i>👀 Vistas: Excluida permanentemente para evitar spam</i>`,
      `🎯 <b>Escala de Metas:</b> <code>${escHtml(thresholdsStr)}</code>`,
    ]),
    hudSection(`ÚLTIMOS LOGROS Y AVISOS (${stateStore.alerts.length})`),
    ...(recent.length > 0
      ? recent.map(
          (a) =>
            `• ${a.type === 'milestone' ? '🏆' : '💬'} <b>${escHtml(a.videoTitle.slice(0, 34))}</b> — ${escHtml(a.summary)}`
        )
      : ['• Sin alertas recientes registradas.']),
  ];

  const rows: InlineKeyboardButton[][] = [
    [
      {
        text: prefs.commentsEnabled ? '💬 Comentarios: ON' : '🔕 Comentarios: OFF',
        callback_data: 'lg:al:c',
      },
      {
        text: prefs.milestonesEnabled ? '🏆 Logros: ON' : '🔕 Logros: OFF',
        callback_data: 'lg:al:s',
      },
    ],
    [
      { text: `${m.plays ? '✅' : '⬜'} ▶️ Reprod.`, callback_data: 'lg:al:v' },
      { text: `${m.likes ? '✅' : '⬜'} ❤️ Likes`, callback_data: 'lg:al:l' },
    ],
    [
      { text: `${m.downloads ? '✅' : '⬜'} 📥 Descargas`, callback_data: 'lg:al:d' },
      { text: `${m.comments ? '✅' : '⬜'} 💬 Coment.`, callback_data: 'lg:al:c' },
    ],
    [
      { text: '✏️ Editar Metas Progresivas', callback_data: 'lg:al:th' },
      { text: '♻️ Metas por Defecto', callback_data: 'lg:al:reset' },
    ],
    [
      { text: '🔄 Revisar Comentarios y Logros Ahora', callback_data: 'al:scan' },
      ...(stateStore.alerts.length > 0 ? [{ text: '🧹 Limpiar', callback_data: 'al:clr' }] : []),
    ],
    [{ text: '🏠 Menú Principal', callback_data: 'm:home' }],
  ];

  await showOrEditHud(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
}

/**
 * 8. Canal de Pedidos & Monitored Group Auto-Verifier (/canalpedidos, /promocion, /pedidoscanal)
 */
export async function renderCanalPedidosView(
  chatId: number,
  userId: string,
  editMessageId?: number
): Promise<void> {
  const cfg = stateStore.getRequestsGroupConfigForUser(userId);
  const promos = stateStore.promoChannels;
  const modeLabels: Record<'off' | 'prefix' | 'all', string> = {
    off: '⚪ Auto: OFF (Desactivado)',
    prefix: '🟡 Auto: Solo #pedido / /pedir / /buscar',
    all: '🟢 Auto: Todo mensaje en el grupo',
  };

  const lines = [
    hudHeader('CANAL Y GRUPO DE PEDIDOS', '📢'),
    hudBox([
      `📢 <b>Canales de Difusión / Promo:</b> ${promos.length} configurado(s)`,
      `👥 <b>Grupo de Pedidos Vinculado:</b> ${cfg.requestsGroupChatId ? `${escHtml(cfg.requestsGroupLabel || cfg.requestsGroupChatId)} (<code>${escHtml(cfg.requestsGroupChatId)}</code>)` : '<i>Sin vincular</i>'}`,
      `🤖 <b>Auto-Verificador en Grupo:</b> ${modeLabels[cfg.requestsMonitorMode]}`,
    ]),
    `<i>Cuando un usuario pide una película o serie en el Grupo de Pedidos vinculado, el bot busca automáticamente en todo Picta: si ya existe responde con el enlace directo, y si no existe lo anota en /pedidos.</i>`,
  ];

  const rows: InlineKeyboardButton[][] = [
    [
      {
        text: cfg.requestsMonitorMode === 'off' ? '• ⚪ Auto: OFF •' : '⚪ Auto: OFF',
        callback_data: 'lg:cped:m_off',
      },
      {
        text: cfg.requestsMonitorMode === 'prefix' ? '• 🟡 #pedido •' : '🟡 #pedido',
        callback_data: 'lg:cped:m_prefix',
      },
      {
        text: cfg.requestsMonitorMode === 'all' ? '• 🟢 Todo •' : '🟢 Todo',
        callback_data: 'lg:cped:m_all',
      },
    ],
    [
      { text: '🔗 Vincular Grupo de Pedidos', callback_data: 'lg:cped:grp' },
      { text: '📣 Publicar Tarjeta Buzón', callback_data: 'lg:cped:sendcard' },
    ],
    [
      { text: '📢 Gestionar Canales Promo', callback_data: 'm:prm' },
      { text: '📥 Ver Pedidos (/pedidos)', callback_data: 'm:req:0' },
    ],
    [{ text: '🏠 Menú Principal', callback_data: 'm:home' }],
  ];

  await showOrEditHud(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
}

/**
 * 9. Live Account Diagnostics (/cuenta, /micuenta)
 */
export async function renderLiveAccountDiagnosticsView(
  chatId: number,
  userId: string,
  editMessageId?: number
): Promise<void> {
  const isMaster = stateStore.isMasterAdmin(userId);
  const session = stateStore.userSessions.find((s) => s.telegramUserId === userId);
  let ctx: PictaAuthContext | null = null;
  let profileInfo: {
    id?: number;
    username?: string;
    firstName?: string;
    lastName?: string;
    groups: string[];
    hasChannelAdminRole: boolean;
  } | null = null;
  let livePerm: { allowed: boolean; statusText: string } | null = null;

  try {
    ctx = await pictaService.resolveContextForUser(userId);
    const [me, perm] = await Promise.all([
      pictaService.fetchMeProfileWithToken(ctx.accessToken),
      pictaService.checkLivePublishPermission(ctx.accessToken),
    ]);
    profileInfo = me;
    livePerm = perm;
  } catch {
    // Handled in box below
  }

  const fullName = [profileInfo?.firstName, profileInfo?.lastName].filter(Boolean).join(' ').trim() || profileInfo?.username;

  const lines = [
    hudHeader('DIAGNÓSTICO DE CUENTA EN VIVO', '🛡️'),
    hudBox([
      `👤 <b>Sesión Activa:</b> ${session ? escHtml(session.pictaUsername) : isMaster ? '👑 Cuenta Maestra del Servidor' : 'Sin vincular'}`,
      `🆔 <b>Titular Picta:</b> ${fullName ? `${escHtml(fullName)} (#${profileInfo?.id || 'N/A'})` : 'N/D'}`,
      `📺 <b>Canal Activo:</b> ${ctx ? `${escHtml(ctx.channelName)} (#${escHtml(ctx.channelId)})` : 'Ninguno'}`,
      `🏷️ <b>Grupos Picta:</b> ${profileInfo && profileInfo.groups.length > 0 ? escHtml(profileInfo.groups.join(', ')) : 'Usuario estándar'}`,
      `🚦 <b>Permiso de Publicación:</b> ${livePerm ? escHtml(livePerm.statusText) : '⚪ Sin sesión activa'}`,
      `🔐 <b>Cifrado:</b> AES-256-GCM Aislado`,
    ]),
  ];

  const rows: InlineKeyboardButton[][] = [];
  if (session && session.availableChannels.length > 1) {
    lines.push(hudSection('CAMBIAR ENTRE TUS CANALES'));
    for (const ch of session.availableChannels.slice(0, 6)) {
      const activeMark = String(ch.id) === String(session.channelId) ? '✅ ' : '';
      rows.push([{ text: `${activeMark}${ch.nombre} (#${ch.id})`, callback_data: `ch:${ch.id}` }]);
    }
  }

  rows.push([
    { text: '🔑 Vincular / Cambiar Cuenta (/login)', callback_data: 'ac:login' },
    ...(session ? [{ text: '🚪 Cerrar Sesión', callback_data: 'ac:logout' }] : []),
  ]);
  rows.push([
    { text: '🔄 Cambiar Canal por Link/ID', callback_data: 'lg:chswitch' },
    { text: '⚡ Pool Multi-Cuenta', callback_data: 'lg:cuota' },
  ]);
  rows.push([{ text: '🏛️ Estudio de Canal', callback_data: 'm:chan' }, { text: '🏠 Menú', callback_data: 'm:home' }]);

  await showOrEditHud(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
}

/**
 * 10. Direct Download Backdoor Modal (🚪 Descarga Directa / Puerta Trasera)
 */
export async function renderDirectDownloadBackdoorView(
  chatId: number,
  userId: string,
  videoId: string,
  editMessageId?: number
): Promise<void> {
  let ctx: PictaAuthContext;
  try {
    ctx = await pictaService.resolveContextForUser(userId);
  } catch (err) {
    await showOrEditHud(chatId, editMessageId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
    return;
  }

  let info: {
    id: string;
    nombre: string;
    webUrl: string;
    url_descarga?: string;
    url_manifiesto?: string;
    tamanio: number;
    duracion: number;
  } | null = null;
  try {
    info = await pictaService.fetchPublicationDirectLinks(ctx, videoId);
  } catch {
    info = null;
  }
  if (!info) {
    await showOrEditHud(chatId, editMessageId, `❌ No se pudo extraer enlaces directos para #<code>${escHtml(videoId)}</code>.`, {
      inline_keyboard: [[{ text: '⬅️ Volver al Video', callback_data: `cv:${videoId}` }]],
    });
    return;
  }

  const lines = [
    hudHeader('DESCARGA DIRECTA (PUERTA TRASERA)', '🚪'),
    hudBox([
      `🎞️ <b>Video:</b> ${escHtml(info.nombre)} (#<code>${escHtml(info.id)}</code>)`,
      `📦 <b>Archivo MP4 Directo:</b> ${info.url_descarga ? '🟢 Disponible' : '⚪ No expuesto'}`,
      `📡 <b>Stream HLS (.m3u8):</b> ${info.url_manifiesto ? '🟢 Disponible' : '⚪ No expuesto'}`,
    ]),
    ...(info.url_descarga ? [`\n📥 <b>MP4 Directo:</b>\n<code>${escHtml(info.url_descarga)}</code>`] : []),
    ...(info.url_manifiesto ? [`\n📡 <b>Manifiesto HLS (.m3u8):</b>\n<code>${escHtml(info.url_manifiesto)}</code>`] : []),
  ];

  const rows: InlineKeyboardButton[][] = [];
  if (info.url_descarga) {
    rows.push([{ text: '📥 Descargar Archivo MP4 Directo', url: info.url_descarga }]);
  }
  if (info.url_manifiesto) {
    rows.push([{ text: '📡 Abrir Manifiesto HLS (.m3u8)', url: info.url_manifiesto }]);
  }
  rows.push([{ text: '▶️ Abrir en Picta Web', url: info.webUrl }]);
  rows.push([{ text: '⬅️ Volver a Ficha del Video', callback_data: `cv:${videoId}` }]);

  await showOrEditHud(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
}

/**
 * 11. Helper to add a secondary Picta account to the Daily Pool
 */
export async function addSecondaryAccountToPool(
  username: string,
  passwordPlain: string,
  ownerUserId = 'master'
): Promise<PictaPoolAccount> {
  const inspected = await pictaService.authenticateAndInspectAccount(username, passwordPlain);
  const encryptedPassword = stateStore.encryptUserSecret(passwordPlain);
  if (!stateStore.quotaSettings.poolAccounts) {
    stateStore.quotaSettings.poolAccounts = [];
  }
  const pool = stateStore.quotaSettings.poolAccounts;
  const existingIdx = pool.findIndex(
    (p) => p.username.toLowerCase() === username.toLowerCase()
  );

  const acc: PictaPoolAccount = {
    id: existingIdx >= 0 ? pool[existingIdx].id : crypto.randomBytes(4).toString('hex'),
    ownerUserId,
    username,
    displayName: inspected.displayName || username,
    encryptedPassword,
    canPublishDirectly: inspected.hasChannelAdminRole,
    uploadedToday: existingIdx >= 0 ? pool[existingIdx].uploadedToday : 0,
    addedAt: new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    pool[existingIdx] = acc;
  } else {
    pool.push(acc);
  }
  stateStore.saveQuotaSettings();
  return acc;
}
