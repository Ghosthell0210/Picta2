// @ts-nocheck
// Suppress Node 25/26 ExperimentalWarning for globalThis.localStorage accessed by gramJS
try {
  Object.defineProperty(globalThis, "localStorage", {
    value: void 0,
    writable: true,
    configurable: true
  });
} catch {}
// server.ts
import express from "express";
import fs3 from "fs";
import path3 from "path";
import http from "http";
import https from "https";
import crypto from "crypto";
import zlib from "zlib";
import { URL as URL2 } from "url";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import bigInt from "big-integer";

// src/types.ts
var PICTA_TIPOLOGIAS = [
  { id: 1, nombre: "Pel\xEDcula", modelo: "pelicula" },
  { id: 5, nombre: "Serie", modelo: "capitulo" },
  { id: 2, nombre: "Documental", modelo: "documental" },
  { id: 8, nombre: "Audiovisual", modelo: "audiovisual" },
  { id: 15, nombre: "Shorts", modelo: "shorts" },
  { id: 19, nombre: "Humor\xEDstico", modelo: "humoristico" },
  { id: 3, nombre: "Video Musical", modelo: "video_musical" },
  { id: 11, nombre: "Videoclip", modelo: "videoclip" },
  { id: 6, nombre: "Deporte", modelo: "deporte" },
  { id: 14, nombre: "Gameplay", modelo: "gameplay" },
  { id: 18, nombre: "Receta", modelo: "receta" },
  { id: 17, nombre: "Reportaje", modelo: "reportaje" }
];

// src/utils/pictaChannelIsolation.ts
var PICTA_CHANNEL_CLASIFICACIONES = [
  "TP",
  "+12",
  "+16",
  "18+",
  "Todos"
];
function isMasterAdminChat(chatId) {
  const clean = String(chatId || "").trim();
  return clean === "1981484200";
}
function extractPictaEntityId(raw) {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    const m = trimmed.match(/\/(\d+)\/?$/);
    if (m) return Number(m[1]);
    return 0;
  }
  if (raw && typeof raw === "object") {
    const obj = raw;
    return extractPictaEntityId(obj.id ?? obj.pk ?? obj.canal_id ?? obj.channel_id ?? obj.user_id);
  }
  return 0;
}
function normalizeOwnerToken(val) {
  return String(val || "").trim().replace(/^@+/, "").toLowerCase();
}
function normalizeOwnershipIdentity(userIdOrIdentity) {
  const tokens = /* @__PURE__ */ new Set();
  let userId = 0;
  let phone8 = "";
  const addToken = (raw) => {
    const t = normalizeOwnerToken(raw);
    if (t && t.length >= 3 && !/^\d+$/.test(t)) {
      tokens.add(t);
    }
    const digits = String(raw || "").replace(/\D/g, "");
    if (digits.length >= 8) {
      const tail8 = digits.slice(-8);
      if (!phone8) phone8 = tail8;
      tokens.add(`+53${tail8}`);
      tokens.add(`53${tail8}`);
      tokens.add(tail8);
    }
  };
  if (typeof userIdOrIdentity === "number") {
    userId = Number.isFinite(userIdOrIdentity) && userIdOrIdentity > 0 ? Math.trunc(userIdOrIdentity) : 0;
  } else if (userIdOrIdentity && typeof userIdOrIdentity === "object") {
    if (userIdOrIdentity.userId && userIdOrIdentity.userId > 0) {
      userId = Math.trunc(userIdOrIdentity.userId);
    }
    addToken(userIdOrIdentity.username);
    addToken(userIdOrIdentity.phone);
    addToken(userIdOrIdentity.email);
  }
  return { userId, tokens, phone8 };
}
function candidateMatchesOwnerIdentity(cand, norm) {
  if (cand === void 0 || cand === null || cand === "") return false;
  const cid = extractPictaEntityId(cand);
  if (norm.userId > 0 && cid > 0 && cid === norm.userId) {
    return true;
  }
  if (norm.tokens.size > 0 || norm.phone8) {
    const strFields = [];
    if (typeof cand === "string") {
      strFields.push(cand);
    } else if (typeof cand === "object") {
      const obj = cand;
      strFields.push(
        obj.username,
        obj.user_name,
        obj.phone_number,
        obj.telefono,
        obj.email,
        obj.slug
      );
    }
    for (const rawField of strFields) {
      const t = normalizeOwnerToken(rawField);
      if (t && norm.tokens.has(t)) return true;
      const digits = String(rawField || "").replace(/\D/g, "");
      if (norm.phone8 && digits.length >= 8 && digits.slice(-8) === norm.phone8) {
        return true;
      }
    }
  }
  return false;
}
function isChannelOwnedOrAssociatedByUser(record, userIdOrIdentity) {
  if (!record || typeof record !== "object") return null;
  const norm = normalizeOwnershipIdentity(userIdOrIdentity);
  if (!norm.userId && norm.tokens.size === 0) return null;
  const ownerCandidates = [
    record.propietario,
    record.propietario_id,
    record.usuario,
    record.usuario_id,
    record.owner,
    record.owner_id,
    record.user,
    record.user_id,
    record.creador,
    record.creador_id,
    record.usuario_creador,
    record.admin,
    record.admin_id
  ];
  let sawOwnershipField = false;
  for (const cand of ownerCandidates) {
    if (cand !== void 0 && cand !== null && cand !== "") {
      sawOwnershipField = true;
      if (candidateMatchesOwnerIdentity(cand, norm)) {
        return true;
      }
    }
  }
  const assocSources = [
    record.usuarios_asociados,
    record.colaboradores,
    record.users,
    record.miembros,
    record.gestores,
    record.editors
  ];
  for (const assocRaw of assocSources) {
    if (Array.isArray(assocRaw)) {
      sawOwnershipField = true;
      for (const entry of assocRaw) {
        if (candidateMatchesOwnerIdentity(entry, norm)) {
          return true;
        }
      }
    }
  }
  return sawOwnershipField ? false : null;
}
function extractScalarChannelIdsFromRecord(record, excludeIds = /* @__PURE__ */ new Set()) {
  if (!record || typeof record !== "object") return [];
  const found = /* @__PURE__ */ new Set();
  const addId = (raw) => {
    const id = extractPictaEntityId(raw);
    if (id > 0 && !excludeIds.has(String(id))) {
      found.add(id);
    }
  };
  addId(record.canal_id);
  addId(record.channel_id);
  addId(record.canal_principal_id);
  addId(record.canal);
  addId(record.channel);
  if (record.publicacion && typeof record.publicacion === "object") {
    const pub = record.publicacion;
    addId(pub.canal_id);
    addId(pub.channel_id);
    addId(pub.canal);
    addId(pub.channel);
  }
  for (const listKey of ["canales", "mis_canales", "channels", "canales_asociados", "usuario_canales"]) {
    const arr = record[listKey];
    if (Array.isArray(arr)) {
      for (const entry of arr) {
        addId(entry);
      }
    }
  }
  return Array.from(found);
}
function extractChannelsFromPictaRecords(records, excludeIds = /* @__PURE__ */ new Set(), userIdOrIdentity) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const norm = normalizeOwnershipIdentity(userIdOrIdentity);
  const checkOwnership = norm.userId > 0 || norm.tokens.size > 0;
  const tryPush = (obj) => {
    if (!obj || typeof obj !== "object") return;
    const id = extractPictaEntityId(obj.id ?? obj.canal_id ?? obj.channel_id);
    if (!id || id <= 0 || excludeIds.has(String(id)) || seen.has(id)) return;
    if (checkOwnership) {
      const owned = isChannelOwnedOrAssociatedByUser(obj, userIdOrIdentity);
      if (owned === false) return;
    }
    const nombre = String(obj.nombre || obj.title || obj.name || `Canal #${id}`).trim();
    const alias = obj.alias ? String(obj.alias).trim() : void 0;
    const slugUrl = obj.slug_url ? String(obj.slug_url).trim() : void 0;
    seen.add(id);
    out.push({
      id,
      nombre,
      ...alias ? { alias } : {},
      ...slugUrl ? { slug_url: slugUrl } : {}
    });
  };
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw;
    for (const listKey of ["canales", "mis_canales", "channels", "canales_asociados", "usuario_canales"]) {
      const arr = rec[listKey];
      if (Array.isArray(arr)) {
        for (const c of arr) {
          if (c && typeof c === "object") tryPush(c);
        }
      }
    }
    if (rec.canal && typeof rec.canal === "object") {
      tryPush(rec.canal);
    }
    if (rec.channel && typeof rec.channel === "object") {
      tryPush(rec.channel);
    }
    if (rec.nombre || rec.alias || rec.slug_url || rec.propietario !== void 0) {
      tryPush(rec);
    }
  }
  return out;
}
function filterMatchingOwnedChannels(channels, query, userIdOrIdentity, excludeIds = /* @__PURE__ */ new Set(), requireMatch = true) {
  const q = String(query || "").trim().toLowerCase();
  const res = [];
  const norm = normalizeOwnershipIdentity(userIdOrIdentity);
  const checkOwnership = norm.userId > 0 || norm.tokens.size > 0;
  for (const ch of channels || []) {
    if (!ch || !ch.id) continue;
    const id = Number(ch.id);
    if (excludeIds.has(String(id))) continue;
    if (checkOwnership) {
      const owned = isChannelOwnedOrAssociatedByUser(ch, userIdOrIdentity);
      if (owned === false) continue;
    }
    const nombre = String(ch.nombre || "").trim();
    const alias = String(ch.alias || "").trim();
    const slug = String(ch.slug_url || "").trim();
    if (requireMatch && q) {
      const hay = `${id} ${nombre} ${alias} ${slug}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    res.push({
      id,
      nombre: nombre || `Canal #${id}`,
      ...alias ? { alias } : {},
      ...slug ? { slug_url: slug } : {}
    });
  }
  return res;
}
function resolveGuestOrAdminChannelMeta(chatId, session, masterChannelId, masterChannelName) {
  const isMaster = isMasterAdminChat(chatId);
  if (isMaster) {
    const chId = String(session?.channelId || masterChannelId || "36319").trim();
    const chName = String(session?.channelName || masterChannelName || "Multiverso Visual").trim();
    return {
      isMaster: true,
      isLinked: Boolean(chId),
      channelId: chId,
      channelName: chName
    };
  }
  const guestChanId = String(session?.channelId || "").trim();
  if (!session || !guestChanId || guestChanId === String(masterChannelId)) {
    return {
      isMaster: false,
      isLinked: false,
      channelId: "",
      channelName: ""
    };
  }
  return {
    isMaster: false,
    isLinked: true,
    channelId: guestChanId,
    channelName: String(session.channelName || `Canal #${guestChanId}`).trim()
  };
}
function sanitizeLeakedUserSession(session, masterChannelId) {
  if (isMasterAdminChat(session.chatId)) {
    return { session, changed: false };
  }
  const masterIdStr = String(masterChannelId || "36319").trim();
  let changed = false;
  const copy = { ...session };
  if (Array.isArray(copy.availableChannels)) {
    const filtered = copy.availableChannels.filter((c) => String(c.id) !== masterIdStr);
    if (filtered.length !== copy.availableChannels.length) {
      copy.availableChannels = filtered;
      changed = true;
    }
  }
  if (String(copy.channelId || "").trim() === masterIdStr) {
    const fallback = (copy.availableChannels || [])[0];
    if (fallback) {
      copy.channelId = String(fallback.id);
      copy.channelName = fallback.nombre;
    } else {
      copy.channelId = "";
      copy.channelName = "";
      copy.verifiedChannelOwnership = false;
    }
    changed = true;
  }
  return { session: copy, changed };
}
function normalizePictaChannelDetails(raw, fallbackId, fallbackName, fallbackClasificacion = "18+") {
  const src = raw && typeof raw === "object" ? raw : {};
  const id = Number(src.id || fallbackId || 0);
  const nombre = String(src.nombre || src.name || fallbackName || `Canal #${id}`).trim();
  const alias = String(src.alias || "").trim();
  const descripcion = String(src.descripcion || src.description || "").trim();
  const clasificacion = String(src.clasificacion || fallbackClasificacion || "18+").trim();
  const slugUrl = src.slug_url ? String(src.slug_url).trim() : void 0;
  return {
    id,
    nombre,
    alias,
    descripcion,
    clasificacion,
    ...slugUrl ? { slug_url: slugUrl } : {},
    visible: src.visible !== void 0 ? Boolean(src.visible) : src.publicado !== void 0 ? Boolean(src.publicado) : true,
    publicado: src.publicado !== void 0 ? Boolean(src.publicado) : src.visible !== void 0 ? Boolean(src.visible) : true,
    recibir_donacion: src.recibir_donacion !== void 0 ? Boolean(src.recibir_donacion) : Boolean(src.donacion ?? src.donar),
    donacion: src.donacion !== void 0 ? Boolean(src.donacion) : Boolean(src.recibir_donacion ?? src.donar),
    cantidad_suscriptores: Number(src.cantidad_suscriptores || 0),
    cantidad_publicaciones: Number(src.cantidad_publicaciones || 0),
    ...src.url_avatar ? { url_avatar: String(src.url_avatar) } : {},
    ...src.url_imagen ? { url_imagen: String(src.url_imagen) } : {}
  };
}
function isGenericAutoSynopsis(synopsis, rawCaption) {
  const s = String(synopsis || "").trim();
  if (!s || s.length < 25) return true;
  const lower = s.toLowerCase();
  if (lower.includes("disponible en el canal") || lower.includes("video publicado autom\xE1ticamente") || lower.includes("video disponible en") || lower.includes("cap\xEDtulo de la serie") || lower.startsWith("archivo:") || lower.startsWith("sin sinopsis") || lower.startsWith("pendiente")) {
    return true;
  }
  if (rawCaption && s === String(rawCaption).trim() && s.length < 55) {
    return true;
  }
  return false;
}
function filterSeriesForChannel(seriesList, channelId, isMaster, masterChannelId = "36319") {
  const targetId = Number(channelId || 0);
  if (!targetId) return [];
  const masterNum = Number(masterChannelId || 36319);
  return (seriesList || []).filter((s) => {
    const cId = Number(
      s.canal_id || (typeof s.canal === "object" ? s.canal?.id : s.canal) || 0
    );
    if (cId > 0) return cId === targetId;
    return isMaster && targetId === masterNum;
  });
}

// src/utils/scratchDiskManager.ts
import fs from "fs";
import path from "path";
function resolveScratchUploadDir() {
  const candidates = [
    process.env.PICTA_SCRATCH_DIR,
    "/mnt/picta_scratch",
    "/tmp/picta_uploads"
  ].filter((p) => Boolean(p && p.trim()));
  for (const dir of candidates) {
    try {
      if (dir === "/mnt/picta_scratch" && !fs.existsSync("/mnt/picta_scratch")) {
        continue;
      }
      fs.mkdirSync(dir, { recursive: true });
      const testFile = path.join(dir, `.probe_${process.pid}_${Date.now()}`);
      fs.writeFileSync(testFile, "ok");
      fs.unlinkSync(testFile);
      return dir;
    } catch {
    }
  }
  const fallback = "/tmp/picta_uploads";
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch {
  }
  return fallback;
}
function getScratchDiskStats(dirPath) {
  const isEphemeral = dirPath.startsWith("/mnt/picta_scratch") || Boolean(process.env.PICTA_SCRATCH_DIR) && dirPath === process.env.PICTA_SCRATCH_DIR;
  const storageType = isEphemeral ? "ephemeral_disk" : dirPath.startsWith("/tmp") ? "tmpfs_ram" : "auto";
  try {
    const statFn = fs.statfsSync;
    if (typeof statFn === "function") {
      const st = statFn(dirPath);
      const bsize = Number(st.bsize || 4096);
      const blocks = Number(st.blocks || 0);
      const bavail = Number(st.bavail || st.bfree || 0);
      const totalBytes = blocks * bsize;
      const freeBytes = bavail * bsize;
      const usedPercent = totalBytes > 0 ? Math.min(100, Math.max(0, Math.round((totalBytes - freeBytes) / totalBytes * 100))) : 0;
      return {
        path: dirPath,
        isEphemeralVolume: isEphemeral,
        storageType,
        totalBytes,
        freeBytes,
        usedPercent
      };
    }
  } catch {
  }
  return {
    path: dirPath,
    isEphemeralVolume: isEphemeral,
    storageType,
    totalBytes: 10 * 1024 * 1024 * 1024,
    freeBytes: 8 * 1024 * 1024 * 1024,
    usedPercent: 20
  };
}
function ensureScratchSpaceForFile(dirPath, requiredBytes, protectedPaths = []) {
  const protectedSet = protectedPaths instanceof Set ? protectedPaths : new Set(protectedPaths.map((p) => path.resolve(p)));
  let freedBytes = 0;
  const deletedFiles = [];
  try {
    if (fs.existsSync(dirPath)) {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = path.resolve(path.join(dirPath, entry.name));
        if (protectedSet.has(full)) continue;
        try {
          const st = fs.statSync(full);
          fs.unlinkSync(full);
          freedBytes += st.size;
          deletedFiles.push(full);
        } catch {
        }
      }
    }
  } catch {
  }
  const statsAfter = getScratchDiskStats(dirPath);
  const requiredWithMargin = requiredBytes + 16 * 1024 * 1024;
  const ok = statsAfter.freeBytes >= requiredBytes || statsAfter.freeBytes >= requiredWithMargin || statsAfter.freeBytes >= 512 * 1024 * 1024;
  return {
    ok: statsAfter.freeBytes >= requiredBytes,
    freedBytes,
    deletedFiles,
    freeBytesAfter: statsAfter.freeBytes
  };
}
function cleanupOrphanedScratchFiles(dirPath, protectedPaths = [], maxAgeMs = 30 * 60 * 1e3) {
  const protectedSet = protectedPaths instanceof Set ? protectedPaths : new Set(protectedPaths.map((p) => path.resolve(p)));
  let removedCount = 0;
  const now = Date.now();
  try {
    if (!fs.existsSync(dirPath)) return 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = path.resolve(path.join(dirPath, entry.name));
      if (protectedSet.has(fullPath)) continue;
      try {
        const st = fs.statSync(fullPath);
        if (now - st.mtimeMs >= maxAgeMs) {
          fs.unlinkSync(fullPath);
          removedCount++;
        }
      } catch {
      }
    }
  } catch {
  }
  return removedCount;
}
function getMemoryTelemetry() {
  const mem = process.memoryUsage();
  return {
    rssBytes: Number(mem.rss || 0),
    heapUsedBytes: Number(mem.heapUsed || 0)
  };
}

// src/utils/transferPipelinePlanner.ts
var MAX_PREFETCH_LOOKAHEAD = 1;
function isJobReadyForUpload(job) {
  if (!job) return false;
  if (job.stage === "quota_paused" || job.stage === "encoder_paused") return false;
  if (job.stage !== "queued") return false;
  if (job.minioKey) return true;
  return Boolean(job.integrityVerified && job.fileExistsOnDisk);
}
function selectNextUploadJob(queue, jobsMap, activeUploadJobId2, _activeDownloadJobId) {
  if (activeUploadJobId2) return null;
  for (const id of queue) {
    const job = jobsMap.get(id);
    if (isJobReadyForUpload(job)) {
      return job;
    }
  }
  return null;
}
function selectNextDownloadJob(queue, jobsMap, activeDownloadJobId2, _activeUploadJobId, maxLookahead = MAX_PREFETCH_LOOKAHEAD) {
  if (activeDownloadJobId2) return null;
  let prefetchedCount = 0;
  for (const id of queue) {
    const job = jobsMap.get(id);
    if (!job) continue;
    if (job.stage === "quota_paused" || job.stage === "encoder_paused") continue;
    if (isJobReadyForUpload(job)) {
      prefetchedCount++;
      continue;
    }
    if (job.stage === "queued") {
      if (prefetchedCount >= maxLookahead) {
        return null;
      }
      return job;
    }
  }
  return null;
}
function filterJobsForUser(jobs, chatId, _masterAdminChatId) {
  const target = String(chatId || "").trim();
  if (!target) return [];
  return (jobs || []).filter((j) => String(j.telegramChatId || "").trim() === target);
}

// src/utils/mediaMetadataMatcher.ts
function normalizeCmp(str) {
  return String(str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function isLikelyEnglishText(text) {
  const t = String(text || "").trim();
  if (!t || t.length < 15) return false;
  const lower = ` ${t.toLowerCase()} `;
  const englishStopwords = [
    " the ",
    " and ",
    " with ",
    " from ",
    " that ",
    " this ",
    " when ",
    " into ",
    " their ",
    " where ",
    " his ",
    " her ",
    " they ",
    " after ",
    " before ",
    " which "
  ];
  const spanishStopwords = [
    " el ",
    " la ",
    " los ",
    " las ",
    " una ",
    " uno ",
    " con ",
    " para ",
    " por ",
    " sobre ",
    " entre ",
    " cuando ",
    " donde ",
    " despu\xE9s ",
    " antes ",
    " su ",
    " sus ",
    " del ",
    " al "
  ];
  let enHits = 0;
  let esHits = 0;
  for (const w of englishStopwords) if (lower.includes(w)) enHits++;
  for (const w of spanishStopwords) if (lower.includes(w)) esHits++;
  if (/[áéíóúñü¿¡]/i.test(t) && esHits >= enHits) return false;
  return enHits >= 2 && enHits > esHits;
}
function cleanMediaTitleForSearch(rawQuery) {
  let raw = String(rawQuery || "").trim();
  const yearMatch = raw.match(/\b(19\d\d|20\d\d)\b/);
  const year = yearMatch ? yearMatch[1] : void 0;
  raw = raw.replace(/\.(mp4|mkv|avi|mov|webm|flv|wmv|ts|m4v|srt|vtt)$/i, "").replace(/[._]+/g, " ").replace(/\[[^\]]*\]/g, " ").replace(/\((?:1080p|720p|480p|2160p|4k|hd|bluray|web-?dl|webrip|hdrip|dvdrip|x264|x265|hevc|aac|latino|español|espanol|subtitulado|dual|castellano)\)/gi, " ").replace(/\b(?:1080p|720p|480p|2160p|4k|uhd|hdr|bluray|bdrip|brrip|web-?dl|webrip|hdrip|dvdrip|camrip|x264|x265|h264|h265|hevc|aac|ac3|dts|latino|castellano|subtitulado|dual|vose)\b/gi, " ").replace(/\bS\d{1,2}E\d{1,3}\b/gi, " ").replace(/\b\d{1,2}x\d{1,3}\b/gi, " ").replace(/\b(?:temporada|season|cap[íi]tulo|episodio|episode|ep|cap)\s*\d+\b/gi, " ");
  if (year) {
    raw = raw.replace(new RegExp(`\\(?\\b${year}\\b\\)?`, "g"), " ");
  }
  const cleanQuery = raw.replace(/\s+/g, " ").replace(/[-:|\s]+$/g, "").trim();
  let subtitleQuery;
  let franchise;
  let simplifiedTitle = cleanQuery;
  const colonSplit = cleanQuery.split(/[:\-–—]/);
  if (colonSplit.length >= 2 && colonSplit[0].trim().length >= 3) {
    simplifiedTitle = colonSplit[0].trim();
    franchise = simplifiedTitle;
    const rest = colonSplit.slice(1).join(" ").trim();
    if (rest.length >= 3) subtitleQuery = rest;
  }
  return {
    cleanQuery,
    simplifiedTitle,
    ...franchise ? { franchise } : {},
    ...subtitleQuery ? { subtitleQuery } : {},
    ...year ? { year } : {}
  };
}
function isTitleMatchStrict(query, candidateTitle, originalTitle) {
  const nq = normalizeCmp(query);
  if (!nq) return false;
  const titles = [normalizeCmp(candidateTitle), normalizeCmp(originalTitle || "")].filter(Boolean);
  for (const nt of titles) {
    if (nt === nq) return true;
    if (nt.includes(nq) || nq.includes(nt)) {
      const qWords = nq.split(" ").filter(Boolean);
      const tWords = nt.split(" ").filter(Boolean);
      const overlap = qWords.filter((w) => tWords.includes(w)).length;
      if (overlap >= Math.max(1, Math.ceil(Math.min(qWords.length, tWords.length) * 0.7))) {
        return true;
      }
    }
  }
  return false;
}
function scoreCandidateMatch(cleanQuery, candidateTitle, originalTitle = "", candidateYear, targetYear, subtitleQuery, popularity = 0) {
  const nq = normalizeCmp(cleanQuery);
  const nt = normalizeCmp(candidateTitle);
  const no = normalizeCmp(originalTitle);
  if (!nq || !nt && !no) return 0;
  let bestTextScore = 0;
  for (const target of [nt, no].filter(Boolean)) {
    if (target === nq) {
      bestTextScore = Math.max(bestTextScore, 95);
    } else if (target.startsWith(nq) || nq.startsWith(target)) {
      bestTextScore = Math.max(bestTextScore, 75);
    } else {
      const qWords = nq.split(" ").filter((w) => w.length > 1);
      const tWords = target.split(" ").filter((w) => w.length > 1);
      if (qWords.length > 0 && tWords.length > 0) {
        const hits = qWords.filter((w) => tWords.includes(w)).length;
        const ratio = hits / Math.max(qWords.length, tWords.length);
        bestTextScore = Math.max(bestTextScore, Math.round(ratio * 70));
      }
    }
  }
  if (subtitleQuery) {
    const ns = normalizeCmp(subtitleQuery);
    if (ns && (nt.includes(ns) || no.includes(ns))) {
      bestTextScore += 10;
    }
  }
  if (targetYear && candidateYear) {
    if (String(targetYear) === String(candidateYear)) {
      bestTextScore += 15;
    } else {
      bestTextScore -= 12;
    }
  }
  if (popularity > 0) {
    bestTextScore += Math.min(8, Math.log10(popularity + 1) * 2.5);
  }
  return Math.max(0, Math.round(bestTextScore));
}
function decideBestOrTop3Candidates(cleanQuery, candidates, releaseYear) {
  if (!candidates || candidates.length === 0) {
    return { confidentWinner: null, topCandidates: [], needsDisambiguation: false };
  }
  const deduped = [];
  const seenKeys = /* @__PURE__ */ new Set();
  const sorted = [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0));
  for (const c of sorted) {
    const key = `${normalizeCmp(c.title)}:${c.mediaType}:${c.year || ""}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(c);
  }
  const top3 = deduped.slice(0, 3);
  const first = top3[0];
  const second = top3[1];
  const exact = isTitleMatchStrict(cleanQuery, first.title, first.originalTitle);
  const yearMatches = !releaseYear || !first.year || String(first.year) === String(releaseYear);
  const strongLead = !second || first.score - second.score >= 12 || exact && yearMatches && first.score >= 85;
  if (first.score >= 70 && strongLead) {
    return {
      confidentWinner: first,
      topCandidates: top3,
      needsDisambiguation: false
    };
  }
  return {
    confidentWinner: top3.length === 1 ? first : null,
    topCandidates: top3,
    needsDisambiguation: top3.length > 1
  };
}

// src/utils/pictaApiToolkit.ts
function filterChannelPlaylists(records, channelId) {
  const targetId = Number(channelId || 0);
  const out = [];
  for (const item of records || []) {
    if (!item || typeof item !== "object") continue;
    const cId = Number(
      typeof item.canal === "object" ? item.canal?.id : item.canal_id ?? item.canal ?? 0
    );
    if (targetId > 0 && cId > 0 && cId !== targetId) continue;
    const pubsRaw = Array.isArray(item.publicaciones) ? item.publicaciones : [];
    const pubsIds = pubsRaw.map((p) => Number(typeof p === "object" ? p?.id : p)).filter((n) => Number.isFinite(n) && n > 0);
    out.push({
      id: Number(item.id || 0),
      nombre: String(item.nombre || `Lista #${item.id}`).trim(),
      publicado: item.publicado !== false,
      descarga: Boolean(item.descarga),
      ...item.fecha_creacion ? { fecha_creacion: String(item.fecha_creacion) } : {},
      canalId: cId || targetId,
      canalNombre: String(
        typeof item.canal === "object" ? item.canal?.nombre || "" : item.canal_nombre || ""
      ).trim(),
      publicacionesIds: pubsIds
    });
  }
  return out;
}
function filterChannelComments(records, channelId, pubIdFilter, pubMetaMap) {
  const targetChan = Number(channelId || 0);
  const out = [];
  const seenIds = /* @__PURE__ */ new Set();
  const pushNormalizedItem = (item, forcedParentId, inheritedPubObj) => {
    if (!item || typeof item !== "object") return;
    const id = Number(item.id || 0);
    if (!id || seenIds.has(id)) return;
    const pubObj = typeof item.publicacion === "object" && item.publicacion ? item.publicacion : inheritedPubObj || null;
    const pubId = Number(pubObj?.id ?? item.publicacion_id ?? item.publicacion ?? 0);
    if (pubIdFilter && pubId && pubId !== Number(pubIdFilter)) return;
    const commentChanId = Number(
      typeof pubObj?.canal === "object" ? pubObj.canal?.id : pubObj?.canal_id ?? pubObj?.canal ?? item.canal_id ?? item.canal ?? 0
    );
    if (targetChan > 0 && commentChanId > 0 && commentChanId !== targetChan) return;
    seenIds.add(id);
    const userObj = typeof item.usuario === "object" && item.usuario ? item.usuario : null;
    const usuario = String(
      userObj?.username || userObj?.nombre || item.usuario_username || item.usuario || "Usuario"
    ).trim();
    const metaFromMap = pubId && pubMetaMap ? pubMetaMap.get(pubId) : void 0;
    const rawCatObj = pubObj?.categoria;
    const rawTipObj = rawCatObj?.tipologia || pubObj?.tipologia;
    const tipologiaId = Number(rawTipObj?.id || metaFromMap?.tipologiaId || 0) || void 0;
    const categoriaNombre = String(
      rawTipObj?.nombre || rawCatObj?.nombre || metaFromMap?.categoriaNombre || "Otros"
    ).trim();
    const parentRaw = forcedParentId || item.comentario_padre?.id || item.comentario_padre || item.parent_id || item.padre_id || 0;
    const parentId = Number(parentRaw) > 0 ? Number(parentRaw) : void 0;
    out.push({
      id,
      texto: String(item.texto || item.comentario || item.contenido || "").trim(),
      usuario,
      usuarioId: userObj?.id ? Number(userObj.id) : item.usuario_id ? Number(item.usuario_id) : void 0,
      fecha: String(item.fecha || item.created_at || item.creado || ""),
      publicacionId: pubId,
      publicacionNombre: String(
        pubObj?.nombre || metaFromMap?.nombre || item.publicacion_nombre || (pubId ? `Video #${pubId}` : "Video")
      ).trim(),
      ...tipologiaId ? { tipologiaId } : {},
      categoriaNombre: categoriaNombre || "Otros",
      ...parentId ? { parentId } : {}
    });
    const nestedReplies = Array.isArray(item.respuestas) ? item.respuestas : Array.isArray(item.replies) ? item.replies : [];
    for (const rep of nestedReplies) {
      pushNormalizedItem(rep, id, pubObj);
    }
  };
  for (const item of records || []) {
    pushNormalizedItem(item);
  }
  const replyCountByParent = /* @__PURE__ */ new Map();
  for (const c of out) {
    if (c.parentId) {
      replyCountByParent.set(c.parentId, (replyCountByParent.get(c.parentId) || 0) + 1);
    }
  }
  for (const c of out) {
    const rCount = replyCountByParent.get(c.id) || 0;
    c.replyCount = rCount;
    c.answered = Boolean(c.parentId) || rCount > 0;
  }
  out.sort((a, b) => {
    const tA = a.fecha ? new Date(a.fecha).getTime() : 0;
    const tB = b.fecha ? new Date(b.fecha).getTime() : 0;
    const validA = Number.isFinite(tA) && tA > 0 ? tA : 0;
    const validB = Number.isFinite(tB) && tB > 0 ? tB : 0;
    if (validB !== validA) return validB - validA;
    return b.id - a.id;
  });
  return out;
}
function computeUpdatedChannelCollaborators(currentAssocRaw, ownerId, targetUserId, action) {
  const set = /* @__PURE__ */ new Set();
  if (ownerId > 0) set.add(Number(ownerId));
  for (const raw of currentAssocRaw || []) {
    const id = Number(typeof raw === "object" && raw ? raw.id : raw);
    if (Number.isFinite(id) && id > 0) set.add(id);
  }
  if (targetUserId > 0) {
    if (action === "add") {
      set.add(Number(targetUserId));
    } else if (action === "remove" && Number(targetUserId) !== Number(ownerId)) {
      set.delete(Number(targetUserId));
    }
  }
  return Array.from(set);
}
function extractPictaPublicationLinks(pub) {
  const id = Number(pub?.id || 0);
  const slug = String(pub?.slug_url || "").trim();
  const webUrl = slug ? `https://www.picta.cu/medias/${slug.replace(/^\/+/, "")}` : `https://www.picta.cu/medias/${id}`;
  const directStreamUrl = String(pub?.url_manifiesto || pub?.url_hls || pub?.manifest_url || "").trim() || void 0;
  const downloadUrl = String(pub?.url_descarga || pub?.download_url || "").trim() || void 0;
  const coverUrl = String(pub?.url_imagen || pub?.imagen_secundaria || "").trim() || void 0;
  return {
    webUrl,
    ...directStreamUrl ? { directStreamUrl } : {},
    ...downloadUrl ? { downloadUrl } : {},
    ...coverUrl ? { coverUrl } : {}
  };
}
function normalizeDenunciaCounts(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const pendientes = Number(src.cantidad_pendientes ?? src.pendientes ?? 0) || 0;
  const enProceso = Number(src.cantidad_en_proceso ?? src.en_proceso ?? 0) || 0;
  const noProceden = Number(src.cantidad_no_proceden ?? src.no_proceden ?? 0) || 0;
  const procesadas = Number(src.cantidad_procesadas ?? src.procesadas ?? 0) || 0;
  const total = Number(src.total ?? pendientes + enProceso + noProceden + procesadas) || 0;
  return {
    cantidad_pendientes: pendientes,
    cantidad_en_proceso: enProceso,
    cantidad_no_proceden: noProceden,
    cantidad_procesadas: procesadas,
    total
  };
}

// src/utils/posterMediaResolver.ts
function buildTmdbImageUrls(posterPath, backdropPath) {
  const cleanPoster = String(posterPath || "").trim();
  const cleanBackdrop = String(backdropPath || "").trim();
  const posterUrl = cleanPoster ? cleanPoster.startsWith("http") ? cleanPoster : `https://image.tmdb.org/t/p/w780${cleanPoster.startsWith("/") ? "" : "/"}${cleanPoster}` : void 0;
  const backdropUrl = cleanBackdrop ? cleanBackdrop.startsWith("http") ? cleanBackdrop : `https://image.tmdb.org/t/p/w1280${cleanBackdrop.startsWith("/") ? "" : "/"}${cleanBackdrop}` : void 0;
  return {
    ...posterUrl || backdropUrl ? { imageUrl: posterUrl || backdropUrl } : {},
    ...posterUrl ? { posterUrl } : {},
    ...backdropUrl ? { backdropUrl } : {}
  };
}
function selectOnlineImageForSlot(onlineInfo, slot) {
  if (!onlineInfo) return void 0;
  if (slot === "poster") {
    return onlineInfo.posterUrl || onlineInfo.imageUrl || onlineInfo.backdropUrl;
  }
  return onlineInfo.backdropUrl || onlineInfo.imageUrl || onlineInfo.posterUrl;
}
function cleanTitleForTmdbPosterSearch(rawTitle, parentSerieName) {
  const parent = String(parentSerieName || "").trim();
  if (parent) {
    return parent.replace(/\bT\d+\s*Cap\.?\s*\d+.*$/i, "").replace(/\bS\d{1,2}E\d{1,3}.*$/i, "").replace(/\s+/g, " ").trim();
  }
  return String(rawTitle || "").replace(/\bT\d+\s*Cap\.?\s*\d+.*$/i, "").replace(/\bS\d{1,2}E\d{1,3}.*$/i, "").replace(/\b(?:Temporada|Season)\s*\d+.*$/i, "").replace(/\(\d{4}\)/g, "").replace(/\s+/g, " ").trim();
}
function selectUploadPairBuffers(params) {
  const {
    customCoverBuf,
    customPosterBuf,
    onlineBackdropBuf,
    onlinePosterBuf,
    videoFrameBuf,
    preferVideoFrameCover,
    fallbackBuf
  } = params;
  const isValid = (b) => Boolean(b && b.byteLength > 100);
  let urlImagenBuf;
  if (preferVideoFrameCover && isValid(videoFrameBuf)) {
    urlImagenBuf = videoFrameBuf;
  } else if (isValid(customCoverBuf)) {
    urlImagenBuf = customCoverBuf;
  } else if (isValid(onlineBackdropBuf)) {
    urlImagenBuf = onlineBackdropBuf;
  } else if (isValid(videoFrameBuf)) {
    urlImagenBuf = videoFrameBuf;
  } else if (isValid(onlinePosterBuf)) {
    urlImagenBuf = onlinePosterBuf;
  } else {
    urlImagenBuf = fallbackBuf;
  }
  let imagenSecundariaBuf;
  if (isValid(customPosterBuf)) {
    imagenSecundariaBuf = customPosterBuf;
  } else if (isValid(onlinePosterBuf)) {
    imagenSecundariaBuf = onlinePosterBuf;
  } else if (isValid(customCoverBuf)) {
    imagenSecundariaBuf = customCoverBuf;
  } else if (isValid(onlineBackdropBuf)) {
    imagenSecundariaBuf = onlineBackdropBuf;
  } else {
    imagenSecundariaBuf = urlImagenBuf;
  }
  return { urlImagenBuf, imagenSecundariaBuf };
}
function buildPublicationImagePatchFiles(params) {
  const { slot, uploadedBuffer, tmdbPortadaBuffer, tmdbPosterBuffer } = params;
  const out = {};
  if (uploadedBuffer && uploadedBuffer.byteLength > 100) {
    if (slot === "portada" || slot === "both") out.coverBuffer = uploadedBuffer;
    if (slot === "poster" || slot === "both") out.posterBuffer = uploadedBuffer;
    return out;
  }
  if ((slot === "portada" || slot === "both") && tmdbPortadaBuffer && tmdbPortadaBuffer.byteLength > 100) {
    out.coverBuffer = tmdbPortadaBuffer;
  }
  if ((slot === "poster" || slot === "both") && tmdbPosterBuffer && tmdbPosterBuffer.byteLength > 100) {
    out.posterBuffer = tmdbPosterBuffer;
  }
  return out;
}
function buildSerieImagePatchFiles(params) {
  const { slot, uploadedBuffer, tmdbPortadaBuffer, tmdbPosterBuffer } = params;
  const out = {};
  if (uploadedBuffer && uploadedBuffer.byteLength > 100) {
    if (slot === "portada" || slot === "both") out.portadaBuffer = uploadedBuffer;
    if (slot === "poster" || slot === "both") out.posterBuffer = uploadedBuffer;
    return out;
  }
  if ((slot === "portada" || slot === "both") && tmdbPortadaBuffer && tmdbPortadaBuffer.byteLength > 100) {
    out.portadaBuffer = tmdbPortadaBuffer;
  }
  if ((slot === "poster" || slot === "both") && tmdbPosterBuffer && tmdbPosterBuffer.byteLength > 100) {
    out.posterBuffer = tmdbPosterBuffer;
  }
  return out;
}

// src/utils/seriesEpisodeParser.ts
function cleanGeneralVideoTitle(rawName) {
  const s = String(rawName || "").replace(/\.(mp4|mkv|avi|mov|webm|flv|wmv|ts|m4v|part\d*|rar|zip|7z)$/i, "").replace(/[._]+/g, " ").replace(/\[[^\]]*\]/g, " ").replace(/\((?:1080p|720p|480p|2160p|4k|hd|bluray|web-?dl|webrip|hdrip|dvdrip|x264|x265|hevc|aac|latino|español|espanol|subtitulado|dual|castellano)\)/gi, " ").replace(/\b(?:1080p|720p|480p|2160p|4k|uhd|hdr|bluray|bdrip|brrip|web-?dl|webrip|hdrip|dvdrip|camrip|x264|x265|h264|h265|hevc|aac|ac3|dts|latino|castellano|subtitulado|dual|vose|mp4|mkv)\b/gi, " ").replace(/\s+/g, " ").replace(/^[-:|_\s]+|[-:|_\s]+$/g, "").trim();
  if (!s) return "";
  return s;
}
function isGenericOrInvalidSerieName(name) {
  const clean = String(name || "").trim().toLowerCase();
  if (!clean || clean.length < 2) return true;
  const generics = /* @__PURE__ */ new Set([
    "serie",
    "series",
    "nueva serie",
    "video",
    "capitulo",
    "cap\xEDtulo",
    "episodio",
    "temporada",
    "desconocido",
    "desconocida",
    "pendiente",
    "sin nombre",
    "untitled",
    "document",
    "file",
    "archivo"
  ]);
  if (generics.has(clean)) return true;
  if (/^(?:cap(?:itulo|[ií]tulo)?|ep(?:isodio)?|temp(?:orada)?|s\d+|t\d+|\d+)$/i.test(clean)) {
    return true;
  }
  return false;
}
function isRandomOrCrypticFilename(name) {
  const clean = cleanGeneralVideoTitle(String(name || "")).replace(/\s+/g, "");
  if (!clean || clean.length < 2) return true;
  if (/^(?:vid|video|mov|img|doc|file|wa|tg|telegram|document|clip)[_-]?\d{4,}$/i.test(clean)) {
    return true;
  }
  if (/^[0-9a-f]{12,}$/i.test(clean)) return true;
  if (/^\d{6,}$/.test(clean)) return true;
  const digits = (clean.match(/\d/g) || []).length;
  const letters = (clean.match(/[a-zA-ZáéíóúñÁÉÍÓÚÑ]/g) || []).length;
  if (letters < 2) return true;
  if (clean.length >= 10 && digits / clean.length > 0.72) return true;
  return false;
}
function parseSingleSeriesCandidate(rawText) {
  const text = cleanGeneralVideoTitle(rawText);
  let temporada = "1";
  let numero = "1";
  let hasExplicitNumbers = false;
  let serieName = text;
  let episodeSubtitle;
  const sxeMatch = text.match(/^(.*?)\bS(\d{1,2})\s*[ExX](\d{1,3})\b(.*)$/i);
  const txCapMatch = text.match(/^(.*?)\bT(\d{1,2})\s*[-·.]?\s*(?:Cap\.?|Capítulo|Capitulo|Ep\.?|E)\s*(\d{1,3})\b(.*)$/i);
  const xMatch = text.match(/^(.*?)\b(\d{1,2})x(\d{1,3})\b(.*)$/i);
  const tempEpMatch = text.match(
    /^(.*?)\b(?:Temporada|Temp\.?|Season)\s*(\d{1,2})\s*[-·,]?\s*(?:Cap[íi]tulo|Cap\.?|Episodio|Ep\.?)\s*(\d{1,3})\b(.*)$/i
  );
  const capOnlyMatch = text.match(/^(.*?)\b(?:Cap[íi]tulo|Cap\.?|Episodio|Ep\.?|E)\s*(\d{1,3})\b(.*)$/i);
  const chosen = sxeMatch || txCapMatch || xMatch || tempEpMatch;
  if (chosen) {
    hasExplicitNumbers = true;
    serieName = (chosen[1] || "").replace(/[-·:|_\s]+$/g, "").trim();
    temporada = String(Number(chosen[2] || 1));
    numero = String(Number(chosen[3] || 1));
    const tail = (chosen[4] || "").replace(/^[-·:|_\s]+/, "").trim();
    if (tail && !isRandomOrCrypticFilename(tail)) {
      episodeSubtitle = tail;
    }
  } else if (capOnlyMatch) {
    hasExplicitNumbers = true;
    serieName = (capOnlyMatch[1] || "").replace(/[-·:|_\s]+$/g, "").trim();
    temporada = "1";
    numero = String(Number(capOnlyMatch[2] || 1));
    const tail = (capOnlyMatch[3] || "").replace(/^[-·:|_\s]+/, "").trim();
    if (tail && !isRandomOrCrypticFilename(tail)) {
      episodeSubtitle = tail;
    }
  }
  return {
    hasExplicitNumbers,
    serieName,
    temporada,
    numero,
    ...episodeSubtitle ? { episodeSubtitle } : {}
  };
}
function formatSerieEpisodeTitle(serieName, temporada = "1", numero = "1", episodeSubtitle) {
  const cleanName = String(serieName || "Serie").trim() || "Serie";
  const temp = Number(String(temporada || "1").replace(/\D/g, "") || 1);
  const ep = Number(String(numero || "1").replace(/\D/g, "") || 1);
  const base = `${cleanName} T${temp} Cap. ${ep}`;
  const sub = String(episodeSubtitle || "").trim();
  return sub ? `${base} \xB7 ${sub}` : base;
}
function extractSeriesInfoFromText(fileName, caption) {
  const capLines = String(caption || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const firstCap = capLines[0] || "";
  const fromCap = firstCap ? parseSingleSeriesCandidate(firstCap) : null;
  const fromFile = parseSingleSeriesCandidate(fileName);
  const chosenSerieName = (fromCap && !isGenericOrInvalidSerieName(fromCap.serieName) ? fromCap.serieName : "") || (!isGenericOrInvalidSerieName(fromFile.serieName) ? fromFile.serieName : "");
  const hasExplicitNumbers = Boolean(fromCap?.hasExplicitNumbers || fromFile.hasExplicitNumbers);
  const temporada = fromCap?.hasExplicitNumbers ? fromCap.temporada : fromFile.hasExplicitNumbers ? fromFile.temporada : "1";
  const numero = fromCap?.hasExplicitNumbers ? fromCap.numero : fromFile.hasExplicitNumbers ? fromFile.numero : "1";
  const episodeSubtitle = fromCap?.episodeSubtitle || fromFile.episodeSubtitle;
  return {
    serieName: chosenSerieName || "Serie",
    temporada,
    numero,
    ...episodeSubtitle ? { episodeSubtitle } : {},
    missingSerieName: isGenericOrInvalidSerieName(chosenSerieName),
    hasExplicitNumbers
  };
}
function splitCaptionIntoTitleAndSynopsis(caption) {
  const lines = String(caption || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { title: "", synopsis: "" };
  if (lines.length === 1) {
    const line = lines[0];
    if (line.length > 90) {
      return { title: "", synopsis: line };
    }
    return { title: cleanGeneralVideoTitle(line), synopsis: "" };
  }
  return {
    title: cleanGeneralVideoTitle(lines[0]),
    synopsis: lines.slice(1).join(" ").trim()
  };
}
function analyzeVideoTitleAndSynopsis(fileName, caption) {
  const capSplit = splitCaptionIntoTitleAndSynopsis(caption || "");
  const cleanFileTitle = cleanGeneralVideoTitle(fileName);
  const filenameIsRandom = isRandomOrCrypticFilename(fileName);
  const seriesInfo = extractSeriesInfoFromText(fileName, caption);
  const hasCaptionTitle = Boolean(capSplit.title && !isRandomOrCrypticFilename(capSplit.title));
  let initialTitle = "";
  let titleSource = "none";
  if (hasCaptionTitle) {
    initialTitle = capSplit.title;
    titleSource = "caption";
  } else if (!filenameIsRandom && cleanFileTitle) {
    initialTitle = cleanFileTitle;
    titleSource = "filename";
  }
  const needsManualTitle = !initialTitle;
  if (!initialTitle) {
    initialTitle = "Pendiente de elecci\xF3n...";
  }
  return {
    initialTitle,
    initialSynopsis: capSplit.synopsis || "",
    filenameIsRandom,
    needsManualTitle,
    titleSource,
    ...seriesInfo.episodeSubtitle ? { episodeSubtitle: seriesInfo.episodeSubtitle } : {},
    seriesInfo
  };
}
function detectDominantSeriesTitleStyle(chapterTitles, _serieName) {
  if (!chapterTitles || chapterTitles.length === 0) return null;
  let txCap = 0;
  let sxe = 0;
  let tempCap = 0;
  let capOnly = 0;
  let padded = 0;
  let withSub = 0;
  for (const t of chapterTitles) {
    const title = String(t || "").trim();
    if (/T\d+\s*Cap\.?\s*\d+/i.test(title)) {
      txCap++;
      if (/Cap\.?\s*0\d/i.test(title)) padded++;
    } else if (/S\d{1,2}E\d{1,3}/i.test(title)) {
      sxe++;
      if (/E0\d/i.test(title)) padded++;
    } else if (/Temporada\s*\d+.*Cap[íi]tulo\s*\d+/i.test(title)) {
      tempCap++;
    } else if (/Cap[íi]tulo\s*\d+/i.test(title)) {
      capOnly++;
    }
    if (/[·\-:]/.test(title)) withSub++;
  }
  const max = Math.max(txCap, sxe, tempCap, capOnly);
  if (max === 0) return null;
  const pattern = sxe === max ? "sxe" : tempCap === max ? "temporada_cap" : capOnly === max ? "cap_only" : "tx_capx";
  const padEp = padded > chapterTitles.length / 2;
  const includeSubtitle = withSub >= Math.max(1, Math.floor(chapterTitles.length / 2));
  const descriptionMap = {
    tx_capx: padEp ? "Nombre T1 Cap. 01" : "Nombre T1 Cap. 1",
    sxe: "Nombre S01E01",
    temporada_cap: "Nombre Temporada 1 Cap\xEDtulo 1",
    cap_only: "Nombre Cap\xEDtulo 1"
  };
  return {
    pattern,
    padEp,
    includeSubtitle,
    separator: " \xB7 ",
    sampleCount: chapterTitles.length,
    sampleTitle: String(chapterTitles[0] || "").trim(),
    description: descriptionMap[pattern]
  };
}
function formatEpisodeWithSeriesStyle(style, params) {
  const name = String(params.serieName || "Serie").trim();
  const tempNum = Number(String(params.temporada || "1").replace(/\D/g, "") || 1);
  const epNum = Number(String(params.numero || "1").replace(/\D/g, "") || 1);
  const tempPad = String(tempNum).padStart(2, "0");
  const epStr = style.padEp ? String(epNum).padStart(2, "0") : String(epNum);
  let base = `${name} T${tempNum} Cap. ${epStr}`;
  if (style.pattern === "sxe") {
    base = `${name} S${tempPad}E${String(epNum).padStart(2, "0")}`;
  } else if (style.pattern === "temporada_cap") {
    base = `${name} Temporada ${tempNum} Cap\xEDtulo ${epStr}`;
  } else if (style.pattern === "cap_only") {
    base = `${name} Cap\xEDtulo ${epStr}`;
  }
  const sub = String(params.episodeSubtitle || "").trim();
  if (sub && style.includeSubtitle !== false) {
    return `${base}${style.separator || " \xB7 "}${sub}`;
  }
  return base;
}
function buildSerieTitleOptions(params) {
  const cleanName = String(params.serieName || "Serie").trim() || "Serie";
  const temp = Number(String(params.temporada || "1").replace(/\D/g, "") || 1);
  const ep = Number(String(params.numero || "1").replace(/\D/g, "") || 1);
  const epPad = String(ep).padStart(2, "0");
  const tempPad = String(temp).padStart(2, "0");
  const sub = String(params.episodeSubtitle || "").trim();
  const candidates = [];
  if (params.inheritedStyle) {
    const styled = formatEpisodeWithSeriesStyle(params.inheritedStyle, {
      serieName: cleanName,
      temporada: temp,
      numero: ep,
      episodeSubtitle: sub
    });
    candidates.push({
      label: `Estilo de la serie: ${styled}`,
      buttonLabel: `\u{1F3A8} ${styled.slice(0, 44)}`,
      title: styled
    });
  }
  const txCap = `${cleanName} T${temp} Cap. ${ep}${sub ? ` \xB7 ${sub}` : ""}`;
  const sxe = `${cleanName} S${tempPad}E${epPad}${sub ? ` \xB7 ${sub}` : ""}`;
  const fullEs = `${cleanName} \xB7 Temporada ${temp} Cap\xEDtulo ${ep}`;
  for (const item of [
    { label: `Est\xE1ndar (${txCap})`, buttonLabel: `\u{1F4CC} ${txCap.slice(0, 44)}`, title: txCap },
    { label: `Internacional (${sxe})`, buttonLabel: `\u{1F310} ${sxe.slice(0, 44)}`, title: sxe },
    { label: `Descriptivo (${fullEs})`, buttonLabel: `\u{1F4DD} ${fullEs.slice(0, 44)}`, title: fullEs }
  ]) {
    if (!candidates.some((c) => c.title.toLowerCase() === item.title.toLowerCase())) {
      candidates.push(item);
    }
  }
  return candidates.slice(0, 4);
}
function isStaleOrGenericSerieSynopsis(synopsis, rawCaption, expectedEpNum) {
  const s = String(synopsis || "").trim();
  if (!s || s.length < 24) return true;
  const lower = s.toLowerCase();
  if (lower.includes("disponible en el canal") || lower.includes("video publicado autom\xE1ticamente") || lower.includes("sin sinopsis") || lower.startsWith("pendiente")) {
    return true;
  }
  if (rawCaption && s === String(rawCaption).trim() && s.length < 55) {
    return true;
  }
  const epStr = String(expectedEpNum || "").replace(/\D/g, "");
  if (epStr) {
    const m = s.match(/\b(?:cap[íi]tulo|episodio)\s*(\d+)\b/i);
    if (m && m[1] !== epStr && lower.includes("de la temporada")) {
      return true;
    }
  }
  return false;
}

// src/utils/pictaEncoderRetry.ts
var MAX_ENCODER_AUTO_RETRIES = 6;
var RETRY_DELAYS_MIN = [2, 5, 10, 15, 25, 40];
function isPictaEncoderOrTransientServerError(errorMsg, statusCode) {
  const msg = String(errorMsg || "").toLowerCase();
  if (statusCode && [500, 502, 503, 504, 520, 521, 522, 524].includes(Number(statusCode))) {
    return true;
  }
  return msg.includes("codificador") || msg.includes("nomad") || msg.includes("502 bad gateway") || msg.includes("503 service unavailable") || msg.includes("504 gateway") || msg.includes("econnreset") || msg.includes("etimedout") || msg.includes("socket hang up") || msg.includes("fetch failed") || msg.includes("error interno del servidor") || msg.includes("error http 5");
}
function extractShortEncoderErrorReason(errorMsg) {
  const raw = String(errorMsg || "").trim();
  if (!raw) return "Codificador / Servidor Picta temporalmente ocupado";
  const lower = raw.toLowerCase();
  if (lower.includes("nomad") || lower.includes("codificador")) {
    return "El servidor codificador (Nomad) de Picta est\xE1 saturado moment\xE1neamente";
  }
  if (lower.includes("502") || lower.includes("503") || lower.includes("504")) {
    return "Picta devolvi\xF3 un error temporal de puerta de enlace (502/503/504)";
  }
  if (lower.includes("timeout") || lower.includes("etimedout") || lower.includes("econnreset")) {
    return "Tiempo de espera agotado al conectar con Picta";
  }
  return raw.slice(0, 110);
}
function computeNextEncoderRetryState(currentRetryCount, nowMs = Date.now()) {
  const count = Math.max(0, Number(currentRetryCount || 0));
  if (count >= MAX_ENCODER_AUTO_RETRIES) {
    return {
      shouldContinue: false,
      nextAttemptCount: count,
      waitMinutes: 0,
      nextRetryAtMs: 0
    };
  }
  const waitMinutes = RETRY_DELAYS_MIN[Math.min(count, RETRY_DELAYS_MIN.length - 1)] || 15;
  return {
    shouldContinue: true,
    nextAttemptCount: count + 1,
    waitMinutes,
    nextRetryAtMs: nowMs + waitMinutes * 60 * 1e3
  };
}
function isEncoderJobPausedInQueue(job) {
  if (!job || job.stage !== "queued") return false;
  if (!job.encoderRetryActive) return false;
  return Number(job.encoderRetryNextAt || 0) > Date.now();
}
function isEncoderJobDueForRetry(job) {
  if (!job || job.stage !== "queued") return false;
  if (!job.encoderRetryActive) return false;
  const nextAt = Number(job.encoderRetryNextAt || 0);
  return nextAt > 0 && Date.now() >= nextAt;
}

// src/utils/pictaAccountDiagnostics.ts
function extractPictaGroupSummary(profileObj) {
  if (!profileObj || typeof profileObj !== "object") {
    return { groupNames: [], hasChannelAdminRole: false };
  }
  const rawGroups = Array.isArray(profileObj.groups) ? profileObj.groups : Array.isArray(profileObj.grupos) ? profileObj.grupos : [];
  const groupNames = [];
  for (const g of rawGroups) {
    if (typeof g === "string" && g.trim()) {
      groupNames.push(g.trim());
    } else if (g && typeof g === "object") {
      const name = String(g.name || g.nombre || "").trim();
      if (name) groupNames.push(name);
    }
  }
  const isSuperuser = Boolean(profileObj.is_superuser || profileObj.is_staff);
  const hasChannelAdminRole = isSuperuser || groupNames.some((n) => {
    const low = n.toLowerCase();
    return low.includes("jefe de canal") || low.includes("admin") || low.includes("creador") || low.includes("supervisor") || low.includes("moderador");
  });
  return { groupNames, hasChannelAdminRole };
}
function isPictaForbiddenResponse(statusCode, responseText) {
  if (Number(statusCode) === 403) return true;
  const low = String(responseText || "").toLowerCase();
  return low.includes("forbidden") || low.includes("no tiene permiso") || low.includes("permission");
}
function buildPictaRoleDiagnosticLines(params) {
  const groupsText = params.groupNames.length > 0 ? params.groupNames.join(", ") : "Usuario com\xFAn";
  const chText = params.channelName ? ` en el canal "${params.channelName}"` : "";
  return `\u26A0\uFE0F <b>Diagn\xF3stico de permisos Picta (@${params.username}):</b>
\u2022 Rol detectado: <code>${groupsText}</code>${params.hasChannelAdminRole ? " (con permiso)" : " (sin rol Jefe de canal)"}
\u2022 Esta cuenta no tiene permisos para crear publicaciones directamente${chText}. Solicita al soporte de Picta activar el grupo <b>"Jefe de canal"</b>.`;
}

// src/utils/pictaAlertsAndMilestones.ts
var ACHIEVEMENT_METRICS_META = {
  plays: { label: "Reproducciones", icon: "\u25B6\uFE0F" },
  likes: { label: "Me gusta", icon: "\u2764\uFE0F" },
  downloads: { label: "Descargas", icon: "\u{1F4E5}" },
  comments: { label: "Comentarios", icon: "\u{1F4AC}" },
  views: { label: "Visitas", icon: "\u{1F441}\uFE0F" }
};
var DEFAULT_MILESTONE_THRESHOLDS = [
  50,
  100,
  250,
  500,
  1e3,
  2500,
  5e3,
  1e4,
  25e3,
  5e4,
  1e5
];
function getDefaultAlertPreferences() {
  return {
    milestonesEnabled: true,
    commentsEnabled: true,
    enabledMetrics: {
      plays: true,
      likes: true,
      downloads: true,
      comments: true,
      views: false
    },
    thresholds: [...DEFAULT_MILESTONE_THRESHOLDS]
  };
}
function normalizeAlertPreferences(partial) {
  const def = getDefaultAlertPreferences();
  if (!partial || typeof partial !== "object") return def;
  const rawMetrics = partial.enabledMetrics;
  const enabledMetrics = { ...def.enabledMetrics };
  if (Array.isArray(rawMetrics)) {
    enabledMetrics.plays = rawMetrics.includes("plays");
    enabledMetrics.likes = rawMetrics.includes("likes");
    enabledMetrics.downloads = rawMetrics.includes("downloads");
    enabledMetrics.comments = rawMetrics.includes("comments");
    enabledMetrics.views = false;
  } else if (rawMetrics && typeof rawMetrics === "object") {
    const obj = rawMetrics;
    enabledMetrics.plays = obj.plays !== void 0 ? Boolean(obj.plays) : def.enabledMetrics.plays;
    enabledMetrics.likes = obj.likes !== void 0 ? Boolean(obj.likes) : def.enabledMetrics.likes;
    enabledMetrics.downloads = obj.downloads !== void 0 ? Boolean(obj.downloads) : def.enabledMetrics.downloads;
    enabledMetrics.comments = obj.comments !== void 0 ? Boolean(obj.comments) : def.enabledMetrics.comments;
    enabledMetrics.views = false;
  }
  const thresholds = Array.isArray(partial.thresholds) ? Array.from(
    new Set(
      partial.thresholds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
    )
  ).sort((a, b) => a - b) : def.thresholds;
  return {
    milestonesEnabled: partial.milestonesEnabled !== void 0 ? Boolean(partial.milestonesEnabled) : true,
    commentsEnabled: partial.commentsEnabled !== void 0 ? Boolean(partial.commentsEnabled) : true,
    enabledMetrics,
    thresholds: thresholds.length > 0 ? thresholds : def.thresholds
  };
}
function parseCustomMilestoneThresholds(input) {
  const parts = String(input || "").split(/[,;\s]+/).map((s) => Number(s.replace(/[^0-9]/g, ""))).filter((n) => Number.isFinite(n) && n >= 1);
  const unique = Array.from(new Set(parts)).sort((a, b) => a - b);
  if (unique.length === 0) {
    return {
      valid: false,
      thresholds: [],
      error: "Ingresa n\xFAmeros separados por coma (ej: 50, 100, 500, 1000)."
    };
  }
  return { valid: true, thresholds: unique.slice(0, 20) };
}
function formatMilestoneNumber(num) {
  const n = Number(num || 0);
  return n.toLocaleString("es-CU");
}
function evaluatePublicationMilestones(params) {
  const { pub, prefs, prevSnapshot, baselineInitialized } = params;
  const currentMetrics = {
    plays: Number(pub.cantidad_reproducciones || 0),
    likes: Number(pub.cantidad_me_gusta || 0),
    downloads: Number(pub.cantidad_descargas || 0),
    comments: Number(pub.cantidad_comentarios || 0),
    views: Number(pub.cantidad_visitas || 0)
  };
  const notifiedMilestones = prevSnapshot?.notifiedMilestones ? JSON.parse(JSON.stringify(prevSnapshot.notifiedMilestones)) : {};
  const events = [];
  const activeMetricKeys = ["plays", "likes", "downloads", "comments"].filter((k) => Boolean(prefs.enabledMetrics?.[k]));
  for (const metricKey of activeMetricKeys) {
    const val = currentMetrics[metricKey];
    const already = new Set(notifiedMilestones[metricKey] || []);
    const newlyCrossed = prefs.thresholds.filter((th) => val >= th && !already.has(th));
    if (newlyCrossed.length > 0) {
      for (const th of newlyCrossed) already.add(th);
      notifiedMilestones[metricKey] = Array.from(already).sort((a, b) => a - b);
      if (baselineInitialized && prefs.milestonesEnabled && prevSnapshot) {
        const meta = ACHIEVEMENT_METRICS_META[metricKey];
        events.push({
          pubId: pub.id,
          pubTitle: pub.nombre,
          metricKey,
          metricLabel: meta.label,
          metricIcon: meta.icon,
          threshold: newlyCrossed[newlyCrossed.length - 1],
          crossedThresholds: newlyCrossed,
          currentValue: val,
          statsSummary: currentMetrics
        });
      }
    }
  }
  return {
    nextSnapshot: {
      pubId: pub.id,
      title: pub.nombre,
      plays: currentMetrics.plays,
      likes: currentMetrics.likes,
      downloads: currentMetrics.downloads,
      comments: currentMetrics.comments,
      views: currentMetrics.views,
      commentCount: currentMetrics.comments,
      notifiedMilestones
    },
    events
  };
}
function detectNewChannelComments(params) {
  const seen = new Set((params.seenCommentIds || []).map((n) => Number(n)));
  const newComments = [];
  const ownNameLow = String(params.ownUsername || "").trim().toLowerCase();
  for (const c of params.comments || []) {
    const cid = Number(c.id || 0);
    if (!cid) continue;
    const isNew = !seen.has(cid);
    seen.add(cid);
    if (!params.baselineInitialized || !isNew) continue;
    if (params.ownUserId && c.usuarioId && Number(c.usuarioId) === Number(params.ownUserId)) {
      continue;
    }
    if (ownNameLow && c.usuario.toLowerCase() === ownNameLow) {
      continue;
    }
    newComments.push(c);
  }
  const nextSeenCommentIds = Array.from(seen).slice(-500);
  return { newComments, nextSeenCommentIds };
}

// src/utils/telegramHud.ts
function hudHeader(title, subtitle) {
  const sub = subtitle ? ` \xB7 ${subtitle}` : "";
  return `<b>\u25C8 ${title}${sub}</b>`;
}
function hudSection(title) {
  return `<b>\u25B8 ${title}</b>`;
}
function hudBox(lines) {
  const clean = (lines || []).filter((l) => Boolean(l && String(l).trim()));
  if (clean.length === 0) return "";
  return clean.map((l) => `\u2502 ${l}`).join("\n");
}
function hudSegmentedBar(percent, segments = 10) {
  const p = Math.max(0, Math.min(100, Number(percent || 0)));
  const total = Math.max(4, segments);
  const filled = Math.round(p / 100 * total);
  return `${"\u25B0".repeat(filled)}${"\u25B1".repeat(total - filled)} ${p}%`;
}
function hudWizardStep(step) {
  const labels = ["T\xEDtulo", "Sinopsis", "Portada", "Subt\xEDtulos"];
  return `Paso ${step}/4 (${labels[step - 1] || ""})`;
}

// src/utils/pictaDashboardStats.ts
function getCubaTodayStr(now = /* @__PURE__ */ new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Havana",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(now);
    const y = parts.find((p) => p.type === "year")?.value || "2026";
    const m = parts.find((p) => p.type === "month")?.value || "01";
    const d = parts.find((p) => p.type === "day")?.value || "01";
    return `${y}-${m}-${d}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
function toCubaDateStr(isoDate) {
  if (!isoDate) return "";
  try {
    const dt = new Date(isoDate);
    if (isNaN(dt.getTime())) return "";
    return getCubaTodayStr(dt);
  } catch {
    return "";
  }
}
function getPictaDateRangeForPeriod(period, cubaTodayStr) {
  if (period === "all") return {};
  if (period === "today") {
    return { dateGte: cubaTodayStr, dateLte: cubaTodayStr };
  }
  const base = /* @__PURE__ */ new Date(`${cubaTodayStr}T12:00:00Z`);
  if (isNaN(base.getTime())) return {};
  const daysBack = period === "7d" ? 6 : 29;
  const start = new Date(base.getTime() - daysBack * 864e5);
  return {
    dateGte: start.toISOString().slice(0, 10),
    dateLte: cubaTodayStr
  };
}
function parsePictaNextPageUrl(baseUrl, nextVal, currentPage) {
  if (!nextVal) return null;
  if (typeof nextVal === "string") {
    const trimmed = nextVal.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^\d+$/.test(trimmed)) {
      const u = new URL(baseUrl);
      u.searchParams.set("page", trimmed);
      return u.toString();
    }
    try {
      return new URL(trimmed, baseUrl).toString();
    } catch {
      return null;
    }
  }
  if (typeof nextVal === "number" && Number.isFinite(nextVal) && nextVal > currentPage) {
    const u = new URL(baseUrl);
    u.searchParams.set("page", String(Math.trunc(nextVal)));
    return u.toString();
  }
  return null;
}
function extractPictaResumenMetrics(raw) {
  const src = Array.isArray(raw) ? raw[0] || {} : raw?.results?.[0] || raw || {};
  return {
    publicadas: Number(src.publicadas ?? src.cantidad_publicaciones ?? src.total ?? src.count ?? 0) || 0,
    views: Number(src.visitas ?? src.cantidad_visitas ?? src.views ?? 0) || 0,
    plays: Number(src.reproducciones ?? src.cantidad_reproducciones ?? src.plays ?? 0) || 0,
    likes: Number(src.me_gusta ?? src.cantidad_me_gusta ?? src.likes ?? 0) || 0,
    downloads: Number(src.descargas ?? src.cantidad_descargas ?? src.downloads ?? 0) || 0,
    comments: Number(src.comentarios ?? src.cantidad_comentarios ?? src.comments ?? 0) || 0
  };
}
function mergeAndDedupeChannelPublications(batches, channelId) {
  const targetChan = Number(channelId || 0);
  const byId = /* @__PURE__ */ new Map();
  for (const list of batches || []) {
    for (const item of list || []) {
      if (!item || typeof item !== "object") continue;
      const id = Number(item.id || 0);
      if (!id) continue;
      const itemChan = Number(
        typeof item.canal === "object" ? item.canal?.id : item.canal_id ?? item.canal ?? 0
      );
      if (targetChan > 0 && itemChan > 0 && itemChan !== targetChan) continue;
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, item);
      } else {
        byId.set(id, { ...prev, ...item });
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
}
function computeGlobalChannelStats(publications, opts) {
  let totalViews = 0;
  let totalPlays = 0;
  let totalLikes = 0;
  let totalDownloads = 0;
  let totalComments = 0;
  let publishedToday = 0;
  let publishedCount = 0;
  let hiddenOrPendingCount = 0;
  let topViewed = void 0;
  let topLiked = void 0;
  for (const p of publications || []) {
    const views = Number(p?.cantidad_visitas || 0);
    const plays = Number(p?.cantidad_reproducciones || 0);
    const likes = Number(p?.cantidad_me_gusta || 0);
    const downloads = Number(p?.cantidad_descargas || 0);
    const comments = Number(p?.cantidad_comentarios || 0);
    totalViews += views;
    totalPlays += plays;
    totalLikes += likes;
    totalDownloads += downloads;
    totalComments += comments;
    if (p?.publicado === false) {
      hiddenOrPendingCount++;
    } else {
      publishedCount++;
    }
    if (!topViewed || views > Number(topViewed.cantidad_visitas || 0)) {
      topViewed = p;
    }
    if (!topLiked || likes > Number(topLiked.cantidad_me_gusta || 0)) {
      topLiked = p;
    }
    const pubDate = toCubaDateStr(
      p?.fecha_publicado || p?.fecha_publicacion || p?.fecha_creacion || p?.created_at || p?.fecha
    );
    if (pubDate && pubDate === opts.cubaTodayStr) {
      publishedToday++;
    }
  }
  const fetchedVideos = publications.length;
  const reportedTotal = Number(opts.reportedApiTotalCount || 0);
  const totalVideos = Math.max(fetchedVideos, reportedTotal);
  return {
    totalVideos,
    fetchedVideos,
    isPartialCatalog: reportedTotal > fetchedVideos,
    publishedCount,
    hiddenOrPendingCount,
    publishedToday,
    dailyCapacity: Number(opts.dailyQuotaCapacity || 10),
    quotaUsedToday: Number(opts.quotaUsedToday || 0),
    channelSubscribers: Number(opts.channelSubscribers || 0),
    totalViews,
    totalPlays,
    totalLikes,
    totalDownloads,
    totalComments,
    topViewed,
    topLiked,
    webAdminAllTime: opts.webAdminAllTime || null,
    webAdminLast30d: opts.webAdminLast30d || null,
    webAdminLast7d: opts.webAdminLast7d || null,
    webAdminToday: opts.webAdminToday || null
  };
}

// src/utils/moviePromoCard.ts
function resolveRequestsChannelForChat(chatId, masterAdminChatId, userPromoChannels2, masterDefaultConfig) {
  const cleanChat = String(chatId || "").trim();
  const custom = userPromoChannels2.get(cleanChat);
  if (custom) {
    if (custom.disabled) {
      return {
        configured: false,
        isPrivateMasterDefault: false,
        targetChannelId: "",
        targetChannelLabel: "",
        autoSendToRequests: false
      };
    }
    if (custom.targetChannelId) {
      return {
        configured: true,
        isPrivateMasterDefault: false,
        targetChannelId: custom.targetChannelId,
        targetChannelLabel: custom.targetChannelLabel || custom.targetChannelId,
        customPictaChannelUrl: custom.customPictaChannelUrl,
        autoSendToRequests: Boolean(custom.autoSendToRequests)
      };
    }
  }
  if (cleanChat === String(masterAdminChatId)) {
    return {
      configured: true,
      isPrivateMasterDefault: true,
      targetChannelId: masterDefaultConfig.targetChannelId,
      targetChannelLabel: masterDefaultConfig.targetChannelLabel,
      customPictaChannelUrl: masterDefaultConfig.pictaChannelUrl,
      autoSendToRequests: false
    };
  }
  return {
    configured: false,
    isPrivateMasterDefault: false,
    targetChannelId: "",
    targetChannelLabel: "",
    autoSendToRequests: false
  };
}
function parseTelegramChannelInput(raw) {
  const clean = String(raw || "").trim();
  if (!clean) {
    return { valid: false, error: "Ingresa un @canal, enlace t.me/canal o ID num\xE9rico -100..." };
  }
  if (/^-100\d{5,}$/.test(clean) || /^-\d{6,}$/.test(clean)) {
    return { valid: true, targetChannelId: clean, displayLabel: clean };
  }
  const linkMatch = clean.match(/(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,})/i);
  if (linkMatch) {
    const uname = `@${linkMatch[1]}`;
    return { valid: true, targetChannelId: uname, displayLabel: uname };
  }
  if (/^@[A-Za-z0-9_]{4,}$/.test(clean)) {
    return { valid: true, targetChannelId: clean, displayLabel: clean };
  }
  if (/^[A-Za-z0-9_]{5,}$/.test(clean)) {
    const uname = `@${clean}`;
    return { valid: true, targetChannelId: uname, displayLabel: uname };
  }
  return {
    valid: false,
    error: "Formato inv\xE1lido. Usa @tu_canal, https://t.me/tu_canal o ID num\xE9rico -100..."
  };
}
function resolveCanonicalPictaChannelUrl(params) {
  const custom = String(params.customUrl || "").trim();
  if (custom && /^https?:\/\//i.test(custom)) return custom;
  const slug = String(params.slugUrl || "").trim().replace(/^\/+/, "");
  if (slug) return `https://www.picta.cu/canal/${slug}`;
  return `https://www.picta.cu/canal/${params.channelId}`;
}
function normalizeMovieRatingLabel(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const m = s.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return s.slice(0, 16);
  const val = Number(m[1].replace(",", "."));
  if (!Number.isFinite(val) || val <= 0) return "";
  if (val <= 10) return `${val.toFixed(1)}/10`;
  return `${Math.round(val)}`;
}
function escapePromoHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function buildMoviePromoCardPayload(params) {
  const titleLine = `\u{1F3AC} ${escapePromoHtml(params.title)}`;
  const metaParts = [];
  if (params.year) metaParts.push(`\u{1F4C5} A\xF1o: ${escapePromoHtml(params.year)}`);
  if (params.rating) metaParts.push(`\u2B50 Calificaci\xF3n: ${escapePromoHtml(params.rating)}/10`);
  const metaLine = metaParts.join(" \xB7 ");
  const genreLine = params.genre ? `\u{1F3AD} G\xE9nero: ${escapePromoHtml(params.genre)}` : "";
  const syn = String(params.synopsis || "").trim();
  const lines = [titleLine, ""];
  if (metaLine) lines.push(metaLine);
  if (genreLine) lines.push(genreLine);
  if (metaLine || genreLine) lines.push("");
  if (syn) {
    lines.push(`\u{1F4DD} Sinopsis:
${escapePromoHtml(syn)}`);
    lines.push("");
  }
  lines.push("\u25B6\uFE0F Toca los botones de abajo para verla al instante en Picta:");
  const textMessageHtml = lines.join("\n");
  const photoCaptionHtml = textMessageHtml.length > 1024 ? `${textMessageHtml.slice(0, 1015)}...` : textMessageHtml;
  const preferredImageUrl = params.posterUrl || params.backdropUrl;
  return {
    captionHtml: photoCaptionHtml,
    photoCaptionHtml,
    textMessageHtml,
    imageUrl: preferredImageUrl,
    preferredImageUrl,
    inlineKeyboard: [
      [{ text: "\u25B6\uFE0F Ver Pel\xEDcula en Picta", url: params.pictaVideoUrl }],
      [{ text: `\u{1F4FA} Canal ${params.pictaChannelName}`, url: params.pictaChannelUrl }]
    ]
  };
}

// src/utils/mtprotoFastDownload.ts
var MTPROTO_TURBO_CHUNK_BYTES = 1024 * 1024;
var MTPROTO_FALLBACK_CHUNK_BYTES = 512 * 1024;
var MTPROTO_SAFE_PARALLEL_WORKERS = 12;
var MTPROTO_TCP_POOL_SIZE = 6;
var MTPROTO_SLEEP_THRESHOLD_SECONDS = 30;
var S3_UPLOAD_HIGH_WATER_MARK_BYTES = 256 * 1024;
var TELEGRAM_MTPROTO_MAX_FILE_MB = 4096;
var PICTA_S3_MAX_OBJECT_BYTES = 5 * 1024 * 1024 * 1024;
function rleDecodeTelegramFileId(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) {
      const count = buf[i + 1] ?? 0;
      i++;
      for (let j = 0; j < count; j++) {
        out.push(0);
      }
    } else {
      out.push(b);
    }
  }
  return Buffer.from(out);
}
function readTlBytes(buf, offset) {
  if (offset >= buf.length) return null;
  let len = buf[offset];
  let cursor = offset + 1;
  if (len === 254) {
    if (cursor + 3 > buf.length) return null;
    len = buf[cursor] | buf[cursor + 1] << 8 | buf[cursor + 2] << 16;
    cursor += 3;
  }
  if (cursor + len > buf.length) return null;
  const data = Buffer.from(buf.subarray(cursor, cursor + len));
  const totalBytes = (len === buf[offset] ? 1 : 4) + len;
  const pad = (4 - totalBytes % 4) % 4;
  return { data, nextOffset: cursor + len + pad };
}
function readInt64LeSigned(buf, offset) {
  const lo = BigInt(buf.readUInt32LE(offset));
  const hi = BigInt(buf.readInt32LE(offset + 4));
  return hi << 32n | lo;
}
function decodeTelegramBotFileId(fileId) {
  const rawStr = String(fileId || "").trim();
  if (!rawStr || rawStr.length < 16) return null;
  try {
    const b64 = rawStr.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - b64.length % 4);
    const rawBuf = Buffer.from(b64 + pad, "base64");
    if (rawBuf.length < 20) return null;
    const decoded = rleDecodeTelegramFileId(rawBuf);
    if (decoded.length < 22) return null;
    const major = decoded[decoded.length - 1];
    let body = decoded;
    if (major >= 4) {
      body = decoded.subarray(0, decoded.length - 2);
    } else if (major === 2 || major === 3) {
      body = decoded.subarray(0, decoded.length - 1);
    }
    if (body.length < 24) return null;
    const rawTypeId = body.readInt32LE(0);
    const dcId = body.readInt32LE(4);
    if (dcId < 1 || dcId > 5) return null;
    const hasWebLocation = (rawTypeId & 33554432) !== 0;
    const hasFileReference = (rawTypeId & 16777216) !== 0;
    const baseFileType = rawTypeId & 16777215;
    const isPhoto = baseFileType === 0 || baseFileType === 1 || baseFileType === 2;
    if (hasWebLocation) return null;
    let cursor = 8;
    let fileReference = Buffer.alloc(0);
    if (hasFileReference) {
      const ref = readTlBytes(body, cursor);
      if (!ref) return null;
      fileReference = ref.data;
      cursor = ref.nextOffset;
    }
    if (cursor + 16 > body.length) return null;
    const mediaId = readInt64LeSigned(body, cursor);
    const accessHash = readInt64LeSigned(body, cursor + 8);
    return {
      valid: true,
      dcId,
      fileType: baseFileType,
      mediaId: mediaId.toString(),
      accessHash: accessHash.toString(),
      fileReference,
      isPhoto
    };
  } catch {
    return null;
  }
}
function buildDirectDownloadChunks(totalBytes, chunkBytes = MTPROTO_TURBO_CHUNK_BYTES) {
  const safeTotal = Math.max(0, Number(totalBytes || 0));
  const safeChunk = Math.max(64 * 1024, Number(chunkBytes || MTPROTO_TURBO_CHUNK_BYTES));
  const chunks = [];
  let offset = 0;
  let index = 0;
  while (offset < safeTotal) {
    const remaining = safeTotal - offset;
    const expectedBytes = Math.min(safeChunk, remaining);
    chunks.push({
      index,
      offset,
      requestLimit: safeChunk,
      expectedBytes
    });
    offset += expectedBytes;
    index++;
  }
  return chunks;
}
function splitChunkInto512KbParts(chunk, totalBytes) {
  const half = MTPROTO_FALLBACK_CHUNK_BYTES;
  if (chunk.expectedBytes <= half) {
    return [
      {
        index: chunk.index,
        offset: chunk.offset,
        requestLimit: half,
        expectedBytes: Math.min(chunk.expectedBytes, Math.max(0, totalBytes - chunk.offset))
      }
    ];
  }
  const firstExpected = Math.min(half, chunk.expectedBytes);
  const secondOffset = chunk.offset + firstExpected;
  const secondExpected = Math.max(0, Math.min(chunk.expectedBytes - firstExpected, totalBytes - secondOffset));
  const out = [
    {
      index: chunk.index,
      offset: chunk.offset,
      requestLimit: half,
      expectedBytes: firstExpected
    }
  ];
  if (secondExpected > 0) {
    out.push({
      index: chunk.index,
      offset: secondOffset,
      requestLimit: half,
      expectedBytes: secondExpected
    });
  }
  return out;
}
function classifyMtprotoDownloadError(err) {
  const msg = String(err?.errorMessage || err?.message || err || "Error desconocido").trim();
  const upper = msg.toUpperCase();
  if (upper.includes("SUBIDA_CANCELADA_POR_USUARIO") || upper.includes("ABORT")) {
    return { kind: "cancelled", retryable: false, waitSeconds: 0, message: msg };
  }
  if (upper.includes("AUTH_KEY_DUPLICATED") || upper.includes("AUTH_KEY_UNREGISTERED") || upper.includes("SESSION_REVOKED") || upper.includes("USER_DEACTIVATED")) {
    return { kind: "fatal_auth", retryable: false, waitSeconds: 0, message: msg };
  }
  const floodMatch = upper.match(/FLOOD_WAIT_(\d+)/);
  if (floodMatch) {
    return {
      kind: "flood_wait",
      retryable: true,
      waitSeconds: Number(floodMatch[1] || 5),
      message: msg
    };
  }
  if (upper.includes("FILE_REFERENCE_EXPIRED") || upper.includes("FILE_REFERENCE_INVALID")) {
    return { kind: "file_reference_expired", retryable: true, waitSeconds: 0, message: msg };
  }
  const dcMatch = upper.match(/(?:FILE_MIGRATE|NETWORK_MIGRATE|PHONE_MIGRATE)_(\d+)/);
  if (dcMatch) {
    const migratedDc = Number(dcMatch[1]);
    return {
      kind: "file_migrate",
      retryable: true,
      waitSeconds: 0,
      newDcId: migratedDc,
      dcId: migratedDc,
      message: msg
    };
  }
  if (upper.includes("OFFSET_INVALID")) {
    return { kind: "offset_invalid", retryable: false, waitSeconds: 0, message: msg };
  }
  if (upper.includes("LIMIT_INVALID")) {
    return { kind: "limit_invalid", retryable: true, waitSeconds: 0, message: msg };
  }
  if (upper.includes("TIMEOUT") || upper.includes("ECONNRESET") || upper.includes("EPIPE") || upper.includes("CLOSED") || upper.includes("DISCONNECT")) {
    return { kind: "transient_network", retryable: true, waitSeconds: 0, message: msg };
  }
  return { kind: "unknown", retryable: true, waitSeconds: 0, message: msg };
}
function shouldUseMainClientSenderForPrimarySlot(targetDcId, homeDcId) {
  if (!targetDcId || !homeDcId) return true;
  return Number(targetDcId) === Number(homeDcId);
}
function selectLeastBusySenderSlot(inFlightCounts, healthyFlags, roundRobinCounter = 0) {
  const len = inFlightCounts.length;
  if (len === 0) return 0;
  let bestIdx = -1;
  let bestLoad = Number.POSITIVE_INFINITY;
  for (let step = 0; step < len; step++) {
    const idx = (roundRobinCounter + step) % len;
    if (!healthyFlags[idx]) continue;
    const load = inFlightCounts[idx] ?? 0;
    if (load < bestLoad) {
      bestLoad = load;
      bestIdx = idx;
    }
  }
  return bestIdx >= 0 ? bestIdx : 0;
}
function computePoolWarmupCount(totalBytes, maxPoolSize = MTPROTO_TCP_POOL_SIZE) {
  const mb = Number(totalBytes || 0) / (1024 * 1024);
  if (mb <= 15) return Math.min(2, maxPoolSize);
  if (mb <= 80) return Math.min(4, maxPoolSize);
  return maxPoolSize;
}
function formatMtprotoDownloadHudLine(params) {
  const dcStr = params.dcId ? `DC #${params.dcId}` : "DC Auto";
  const speed = Number(params.speedMBps || 0);
  const speedStr = speed > 0 ? `${speed.toFixed(2)} MB/s` : "Calculando...";
  return `\u{1F310} <b>Red MTProto:</b> <code>${dcStr}</code> \xB7 \u{1F50C} <b>Sockets:</b> ${params.activeSockets}/${params.maxSockets} \xB7 \u{1F680} <b>${speedStr}</b>`;
}

// src/utils/fastNetSocket.ts
import { PromisedNetSockets } from "telegram/extensions/PromisedNetSockets.js";
var FastPromisedNetSockets = class extends PromisedNetSockets {
  async connect(port, ip) {
    const result = await super.connect(port, ip);
    try {
      const sock = this.client;
      if (sock) {
        if (typeof sock.setNoDelay === "function") {
          sock.setNoDelay(true);
        }
        if (typeof sock.setKeepAlive === "function") {
          sock.setKeepAlive(true, 1e4);
        }
      }
    } catch {
    }
    return result;
  }
  toString() {
    return "FastPromisedNetSocket";
  }
};

// src/utils/adminUsersDashboard.ts
function computeEnrichedAdminUsersSummary(params) {
  const {
    currentDateCuba,
    masterAdminChatId,
    masterAdminPictaUsername,
    masterAdminChannelId,
    masterAdminChannelName,
    masterAdminDailyCapacity,
    masterAdminSeriesToday,
    masterAdminOtherToday,
    authorizedUsers: authorizedUsers2,
    sessionsByChatId,
    pinnedByChatId,
    promoByChatId,
    jobs,
    toCubaDateStr: toCubaDateStr2
  } = params;
  const userMap = /* @__PURE__ */ new Map();
  userMap.set(masterAdminChatId, {
    chatId: masterAdminChatId,
    username: "ghosthell0210",
    firstName: "Admin Principal",
    authorizedAt: (/* @__PURE__ */ new Date(0)).toISOString()
  });
  for (const au of authorizedUsers2 || []) {
    if (!au?.chatId) continue;
    userMap.set(String(au.chatId), {
      chatId: String(au.chatId),
      username: au.username,
      firstName: au.firstName,
      authorizedAt: au.authorizedAt || (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  let linkedPictaUsers = 0;
  let unlinkedPictaUsers = 0;
  let totalUploadedTodayAllUsers = 0;
  let totalMoviesTodayAllUsers = 0;
  let totalSeriesTodayAllUsers = 0;
  let totalBytesTodayAllUsers = 0;
  let totalCompletedHistoricalAllUsers = 0;
  let totalBytesHistoricalAllUsers = 0;
  let totalActiveOrQueuedAllUsers = 0;
  const entries = [];
  for (const u of userMap.values()) {
    const isMasterAdmin = String(u.chatId) === String(masterAdminChatId);
    const sess = sessionsByChatId.get(u.chatId);
    const pictaLinked = isMasterAdmin ? true : Boolean(sess && sess.channelId);
    if (pictaLinked) linkedPictaUsers++;
    else unlinkedPictaUsers++;
    const userJobs = (jobs || []).filter((j) => String(j.telegramChatId) === String(u.chatId)).sort(
      (a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
    );
    let completedCount = 0;
    let totalBytesUploaded = 0;
    let failedCount = 0;
    let speedSum = 0;
    let speedCount = 0;
    let moviesToday = 0;
    let seriesToday = 0;
    let bytesToday = 0;
    let failedTodayCount = 0;
    let activeJobsCount = 0;
    let queuedJobsCount = 0;
    let activeJobTitle;
    let lastUploadTitle;
    let lastUploadAt;
    for (const j of userJobs) {
      const dateStr = toCubaDateStr2(j.updatedAt || j.createdAt);
      const isToday = dateStr === currentDateCuba;
      const bytes = Number(j.diskVerifiedBytes || j.expectedBytes || 0);
      if (j.stage === "completed") {
        completedCount++;
        totalBytesUploaded += bytes;
        if (!lastUploadTitle) {
          lastUploadTitle = j.title;
          lastUploadAt = j.updatedAt || j.createdAt;
        }
        if (Number(j.speedMBps || 0) > 0) {
          speedSum += Number(j.speedMBps);
          speedCount++;
        }
        if (isToday) {
          bytesToday += bytes;
          if (Number(j.tipologiaId) === 5) seriesToday++;
          else moviesToday++;
        }
      } else if (j.stage === "failed") {
        failedCount++;
        if (isToday) failedTodayCount++;
      } else if (j.stage === "queued") {
        queuedJobsCount++;
      } else if (j.stage !== "cancelled") {
        activeJobsCount++;
        if (!activeJobTitle) activeJobTitle = j.title;
      }
    }
    const effectiveSeriesToday = isMasterAdmin ? Math.max(seriesToday, Number(masterAdminSeriesToday || 0)) : seriesToday;
    const effectiveMoviesToday = isMasterAdmin ? Math.max(moviesToday, Number(masterAdminOtherToday || 0)) : moviesToday;
    const uploadedTodayCount = effectiveSeriesToday + effectiveMoviesToday;
    const dailyQuotaLimit = isMasterAdmin ? Math.max(10, masterAdminDailyCapacity) : 10;
    const remainingTodayCount = Math.max(0, dailyQuotaLimit - uploadedTodayCount);
    const quotaPercent = Math.min(100, Math.round(uploadedTodayCount / dailyQuotaLimit * 100));
    totalUploadedTodayAllUsers += uploadedTodayCount;
    totalMoviesTodayAllUsers += effectiveMoviesToday;
    totalSeriesTodayAllUsers += effectiveSeriesToday;
    totalBytesTodayAllUsers += bytesToday;
    totalCompletedHistoricalAllUsers += completedCount;
    totalBytesHistoricalAllUsers += totalBytesUploaded;
    totalActiveOrQueuedAllUsers += activeJobsCount + queuedJobsCount;
    const pictaChannelLabel = isMasterAdmin ? `${masterAdminChannelName} (#${masterAdminChannelId})` : sess?.channelId ? `${sess.channelName || "Canal"} (#${sess.channelId})` : "Sin canal vinculado";
    const pictaAccountLabel = isMasterAdmin ? masterAdminPictaUsername : sess?.username || "Sin cuenta Picta";
    const sessionStatusLabel = isMasterAdmin ? "\u{1F7E2} Activa (Principal)" : !sess ? "\u26AA No iniciada" : sess.tokenExpiresAt && sess.tokenExpiresAt > Date.now() ? "\u{1F7E2} Token OAuth vigente" : "\u{1F7E1} Renovaci\xF3n autom\xE1tica al subir";
    const recentJobs = userJobs.slice(0, 6).map((j) => ({
      id: j.id,
      title: j.title,
      category: j.category,
      stage: j.stage,
      bytes: Number(j.diskVerifiedBytes || j.expectedBytes || 0),
      speedMBps: Number(j.speedMBps || 0),
      pictaPublicationId: j.pictaPublicationId,
      updatedAt: j.updatedAt || j.createdAt,
      isToday: toCubaDateStr2(j.updatedAt || j.createdAt) === currentDateCuba
    }));
    entries.push({
      chatId: u.chatId,
      displayName: isMasterAdmin ? "Admin Principal" : u.firstName || (u.username ? `@${u.username}` : `Usuario ${u.chatId}`),
      username: u.username,
      isMasterAdmin,
      pictaLinked,
      authorizedAt: u.authorizedAt,
      pictaChannelLabel,
      pictaAccountLabel,
      availableChannelsCount: sess?.availableChannelsCount || (pictaLinked ? 1 : 0),
      sessionStatusLabel,
      dailyQuotaLimit,
      uploadedTodayCount,
      remainingTodayCount,
      quotaPercent,
      moviesUploadedTodayCount: effectiveMoviesToday,
      seriesUploadedTodayCount: effectiveSeriesToday,
      bytesUploadedToday: bytesToday,
      failedTodayCount,
      totalCompletedCount: completedCount,
      totalBytesUploaded,
      totalFailedCount: failedCount,
      avgSpeedMBps: speedCount > 0 ? Number((speedSum / speedCount).toFixed(2)) : 0,
      activeJobsCount,
      queuedJobsCount,
      activeJobTitle,
      pinnedSerie: pinnedByChatId.get(u.chatId),
      promoChannel: promoByChatId.get(u.chatId),
      lastUploadTitle,
      lastUploadAt,
      recentJobs
    });
  }
  entries.sort((a, b) => {
    if (a.isMasterAdmin !== b.isMasterAdmin) return a.isMasterAdmin ? -1 : 1;
    return b.uploadedTodayCount - a.uploadedTodayCount || b.totalCompletedCount - a.totalCompletedCount;
  });
  return {
    currentDateCuba,
    totalAuthorizedUsers: entries.length,
    linkedPictaUsers,
    unlinkedPictaUsers,
    totalUploadedTodayAllUsers,
    totalMoviesTodayAllUsers,
    totalSeriesTodayAllUsers,
    totalBytesTodayAllUsers,
    totalCompletedHistoricalAllUsers,
    totalBytesHistoricalAllUsers,
    totalActiveOrQueuedAllUsers,
    users: entries
  };
}

// src/utils/multiPartDiskAssembler.ts
import fs2 from "fs";
import path2 from "path";
import { execFile } from "child_process";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
var VIDEO_EXTS = /* @__PURE__ */ new Set([".mp4", ".mkv", ".avi", ".mov", ".webm", ".flv", ".wmv", ".ts", ".m4v"]);
function findLargestVideoFileRecursive(dirPath) {
  let bestFile = null;
  let bestSize = -1;
  const walk = (dir) => {
    for (const entry of fs2.readdirSync(dir, { withFileTypes: true })) {
      const full = path2.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = path2.extname(entry.name).toLowerCase();
        const sz = fs2.statSync(full).size;
        if ((VIDEO_EXTS.has(ext) || bestFile === null) && sz > bestSize) {
          bestSize = sz;
          bestFile = full;
        }
      }
    }
  };
  walk(dirPath);
  return bestFile;
}
function cleanupPartFiles(parts, keepPath) {
  for (const p of parts) {
    if (keepPath && path2.resolve(p.filePath) === path2.resolve(keepPath)) continue;
    try {
      if (fs2.existsSync(p.filePath)) fs2.unlinkSync(p.filePath);
    } catch {
    }
  }
}
async function assembleMultiPartFilesOnDisk(parts, scratchDir, masterJobId) {
  if (!parts || parts.length === 0) {
    throw new Error("No hay archivos descargados para unir.");
  }
  const sorted = [...parts].sort(
    (a, b) => a.fileName.localeCompare(b.fileName, void 0, { numeric: true, sensitivity: "base" })
  );
  const first = sorted[0];
  const firstLower = first.fileName.toLowerCase();
  const isSplitNumeric = /\.\d{3}$/.test(firstLower) || /\.part\d+$/i.test(firstLower);
  const allVideos = sorted.every((p) => VIDEO_EXTS.has(path2.extname(p.fileName).toLowerCase()));
  const isZip = firstLower.endsWith(".zip") || firstLower.includes(".z01");
  const isTar = /\.(tar|tar\.gz|tgz)$/i.test(firstLower);
  if (isSplitNumeric) {
    const cleanBase = first.fileName.replace(/\.\d{3}$/i, "").replace(/\.part\d+$/i, "");
    const joinedPath = path2.join(scratchDir, `${masterJobId}_joined_${path2.basename(cleanBase)}`);
    const outStream = fs2.createWriteStream(joinedPath, { highWaterMark: 256 * 1024 });
    for (const part of sorted) {
      await new Promise((resolve, reject) => {
        const rs = fs2.createReadStream(part.filePath, { highWaterMark: 256 * 1024 });
        rs.on("error", reject);
        outStream.on("error", reject);
        rs.on("end", resolve);
        rs.pipe(outStream, { end: false });
      });
    }
    await new Promise((resolve, reject) => {
      outStream.end(() => resolve());
      outStream.on("error", reject);
    });
    if (cleanBase.toLowerCase().endsWith(".zip")) {
      const extractDir = path2.join(scratchDir, `${masterJobId}_unzip`);
      fs2.mkdirSync(extractDir, { recursive: true });
      await execFileAsync("unzip", ["-o", joinedPath, "-d", extractDir]);
      try {
        fs2.unlinkSync(joinedPath);
      } catch {
      }
      const extractedVideo = findLargestVideoFileRecursive(extractDir);
      if (!extractedVideo) {
        throw new Error("No se encontr\xF3 ning\xFAn archivo de video dentro del ZIP ensamblado.");
      }
      const finalFileName = path2.basename(extractedVideo);
      const finalFilePath = path2.join(scratchDir, `${masterJobId}${path2.extname(finalFileName) || ".mp4"}`);
      fs2.renameSync(extractedVideo, finalFilePath);
      fs2.rmSync(extractDir, { recursive: true, force: true });
      cleanupPartFiles(sorted, finalFilePath);
      return {
        finalFilePath,
        finalFileName,
        finalSizeBytes: fs2.statSync(finalFilePath).size,
        modeUsed: "concat_binario_zip"
      };
    }
    cleanupPartFiles(sorted, joinedPath);
    return {
      finalFilePath: joinedPath,
      finalFileName: cleanBase || `${masterJobId}.mp4`,
      finalSizeBytes: fs2.statSync(joinedPath).size,
      modeUsed: "concat_binario"
    };
  }
  if (isZip) {
    const extractDir = path2.join(scratchDir, `${masterJobId}_unzip`);
    fs2.mkdirSync(extractDir, { recursive: true });
    await execFileAsync("unzip", ["-o", first.filePath, "-d", extractDir]);
    const extractedVideo = findLargestVideoFileRecursive(extractDir);
    if (!extractedVideo) {
      throw new Error("No se encontr\xF3 un archivo de video v\xE1lido dentro del archivo ZIP.");
    }
    const finalFileName = path2.basename(extractedVideo);
    const finalFilePath = path2.join(scratchDir, `${masterJobId}${path2.extname(finalFileName) || ".mp4"}`);
    fs2.renameSync(extractedVideo, finalFilePath);
    fs2.rmSync(extractDir, { recursive: true, force: true });
    cleanupPartFiles(sorted, finalFilePath);
    return {
      finalFilePath,
      finalFileName,
      finalSizeBytes: fs2.statSync(finalFilePath).size,
      modeUsed: "extraccion_zip"
    };
  }
  if (isTar) {
    const extractDir = path2.join(scratchDir, `${masterJobId}_untar`);
    fs2.mkdirSync(extractDir, { recursive: true });
    const flags = firstLower.endsWith(".gz") || firstLower.endsWith(".tgz") ? "-xzf" : "-xf";
    await execFileAsync("tar", [flags, first.filePath, "-C", extractDir]);
    const extractedVideo = findLargestVideoFileRecursive(extractDir);
    if (!extractedVideo) {
      throw new Error("No se encontr\xF3 un archivo de video v\xE1lido dentro del archivo TAR.");
    }
    const finalFileName = path2.basename(extractedVideo);
    const finalFilePath = path2.join(scratchDir, `${masterJobId}${path2.extname(finalFileName) || ".mp4"}`);
    fs2.renameSync(extractedVideo, finalFilePath);
    fs2.rmSync(extractDir, { recursive: true, force: true });
    cleanupPartFiles(sorted, finalFilePath);
    return {
      finalFilePath,
      finalFileName,
      finalSizeBytes: fs2.statSync(finalFilePath).size,
      modeUsed: "extraccion_tar"
    };
  }
  if (allVideos && sorted.length > 1) {
    const listFile = path2.join(scratchDir, `${masterJobId}_concat.txt`);
    const lines = sorted.map((p) => `file '${p.filePath.replace(/'/g, "'\\''")}'`).join("\n");
    fs2.writeFileSync(listFile, lines, "utf-8");
    const ext = path2.extname(first.fileName) || ".mp4";
    const outPath = path2.join(scratchDir, `${masterJobId}${ext}`);
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listFile,
        "-c",
        "copy",
        outPath
      ]);
    } finally {
      try {
        fs2.unlinkSync(listFile);
      } catch {
      }
    }
    cleanupPartFiles(sorted, outPath);
    const cleanName = first.fileName.replace(/[._\s-]*(?:part|parte|cd)?\s*\d+(?=\.[^.]+$)/i, "");
    return {
      finalFilePath: outPath,
      finalFileName: cleanName || first.fileName,
      finalSizeBytes: fs2.statSync(outPath).size,
      modeUsed: "ffmpeg_concat_copy"
    };
  }
  return {
    finalFilePath: first.filePath,
    finalFileName: first.fileName,
    finalSizeBytes: fs2.existsSync(first.filePath) ? fs2.statSync(first.filePath).size : first.sizeBytes,
    modeUsed: "directo"
  };
}

// src/utils/linkVideoIngestion.ts
var VIDEO_EXT_REGEX = /\.(mp4|mkv|mov|avi|webm|m4v|ts|flv)$/i;
function parseTelegramMessageLink(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;
  const privMatch = text.match(
    /(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/c\/(\d{5,})\/(\d+)(?:[/?#][^\s]*)?/i
  );
  if (privMatch) {
    const internalId = privMatch[1];
    const msgId = Number(privMatch[2]);
    if (internalId && Number.isFinite(msgId) && msgId > 0) {
      return {
        rawUrl: privMatch[0],
        kind: "private_channel",
        internalChannelId: internalId,
        mtprotoPeer: `-100${internalId}`,
        messageId: msgId
      };
    }
  }
  const pubMatch = text.match(
    /(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,})\/(\d+)(?:[/?#][^\s]*)?/i
  );
  if (pubMatch) {
    const username = pubMatch[1];
    const msgId = Number(pubMatch[2]);
    if (username && !["c", "s", "joinchat", "addstickers", "boost", "proxy"].includes(username.toLowerCase()) && Number.isFinite(msgId) && msgId > 0) {
      return {
        rawUrl: pubMatch[0],
        kind: "public",
        username,
        mtprotoPeer: username,
        messageId: msgId
      };
    }
  }
  return null;
}
function extractDirectVideoUrl(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;
  if (parseTelegramMessageLink(text)) return null;
  const urlMatch = text.match(/https?:\/\/[^\s<>"'`]+/i);
  if (!urlMatch) return null;
  let candidate = urlMatch[0].replace(/[),.;!?]+$/, "");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host.includes("t.me") || host.includes("telegram.") || host.includes("picta.cu") || host.includes("youtube.com") || host.includes("youtu.be") || host.includes("themoviedb.org") || host.includes("imdb.com")) {
    return null;
  }
  const rawPathName = decodeURIComponent(parsed.pathname.split("/").pop() || "").trim();
  const queryFileName = parsed.searchParams.get("filename") || parsed.searchParams.get("file") || parsed.searchParams.get("name") || "";
  const cleanName = (queryFileName || rawPathName || `video_${Date.now()}.mp4`).replace(
    /[^\w.\- ()[\]]+/g,
    "_"
  );
  const hasExplicitVideoExt = VIDEO_EXT_REGEX.test(cleanName) || VIDEO_EXT_REGEX.test(parsed.pathname);
  return {
    url: candidate,
    inferredFileName: VIDEO_EXT_REGEX.test(cleanName) ? cleanName : `${cleanName}.mp4`,
    hasExplicitVideoExt
  };
}
function parseFilenameFromContentDisposition(headerVal) {
  const raw = String(headerVal || "").trim();
  if (!raw) return "";
  const utf8Match = raw.match(/filename\*=(?:UTF-8''|utf-8'')([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^["']|["']$/g, ""));
    } catch {
      return utf8Match[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  const plainMatch = raw.match(/filename=([^;]+)/i);
  if (plainMatch?.[1]) {
    return plainMatch[1].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}
function isProbableVideoHttpResponse(params) {
  const ct = String(params.contentType || "").split(";")[0].trim().toLowerCase();
  const cdName = parseFilenameFromContentDisposition(params.contentDisposition);
  const extracted = extractDirectVideoUrl(params.url);
  const baseName = cdName || extracted?.inferredFileName || `video_url_${Date.now()}.mp4`;
  const hasVideoExt = VIDEO_EXT_REGEX.test(baseName);
  if (ct.startsWith("text/html") || ct.includes("application/json") || ct.includes("application/xml")) {
    return {
      ok: false,
      fileName: baseName,
      mimeType: ct,
      reason: `El enlace devolvi\xF3 una p\xE1gina o datos (${ct}) y no un archivo de video directo.`
    };
  }
  if (ct.startsWith("video/") || ct === "application/mp4" || ct === "application/x-matroska") {
    return {
      ok: true,
      fileName: hasVideoExt ? baseName : `${baseName}.mp4`,
      mimeType: ct || "video/mp4"
    };
  }
  if ((!ct || ct === "application/octet-stream" || ct === "binary/octet-stream") && hasVideoExt) {
    return {
      ok: true,
      fileName: baseName,
      mimeType: "video/mp4"
    };
  }
  if (hasVideoExt && !ct.startsWith("image/") && !ct.startsWith("audio/")) {
    return {
      ok: true,
      fileName: baseName,
      mimeType: ct || "video/mp4"
    };
  }
  return {
    ok: false,
    fileName: baseName,
    mimeType: ct || "unknown",
    reason: `Tipo de contenido no compatible para subida directa (${ct || "sin tipo"}). Debe apuntar a un archivo .mp4, .mkv, .mov o .webm.`
  };
}

// src/utils/channelAudit.ts
var EPISODE_PATTERN_REGEX = /(?:\bs\d{1,2}\s*e\d{1,3}\b|\b\d{1,2}x\d{1,3}\b|\b(?:cap[ií]tulo|episodio|ep\.?)\s*#?\d{1,3}\b|\btemporada\s*\d+\b)/i;
function normalizeAuditTitle(rawTitle) {
  return String(rawTitle || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\.(mp4|mkv|avi|mov|webm|m4v|ts)$/i, "").replace(
    /\b(?:1080p|720p|480p|360p|2160p|4k|hdrip|webrip|web-dl|bluray|brrip|x264|x265|hevc|aac|ac3|dual|latino|espanol|castellano|subtitulada|sub|hd)\b/gi,
    " "
  ).replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}
function toAuditItem(pub, issueSummary) {
  const tipId = Number(pub.categoria?.tipologia?.id || pub.categoria?.id || 8);
  const catName = String(
    pub.categoria?.tipologia?.nombre || pub.categoria?.nombre || "Audiovisual"
  ).trim();
  return {
    id: Number(pub.id || 0),
    nombre: String(pub.nombre || `Video #${pub.id}`).trim(),
    categoriaNombre: catName || "Audiovisual",
    tipologiaId: tipId,
    views: Number(pub.cantidad_visitas || 0),
    likes: Number(pub.cantidad_me_gusta || 0),
    tamanio: Number(pub.tamanio || 0),
    duracion: Number(pub.duracion || 0),
    publicado: pub.publicado !== false,
    estado: String(pub.estado || ""),
    fecha: String(pub.fecha_creacion || ""),
    slugUrl: pub.slug_url,
    issueSummary
  };
}
function buildChannelAuditReport(publications) {
  const list = Array.isArray(publications) ? publications : [];
  const byTitleMap = /* @__PURE__ */ new Map();
  const bySizeDurMap = /* @__PURE__ */ new Map();
  const incompleteItems = [];
  const unpublishedItems = [];
  const orphanEpisodeItems = [];
  for (const pub of list) {
    if (!pub || !pub.id) continue;
    const normTitle = normalizeAuditTitle(pub.nombre || "");
    if (normTitle.length >= 3) {
      const arr = byTitleMap.get(normTitle) || [];
      arr.push(pub);
      byTitleMap.set(normTitle, arr);
    }
    const size = Number(pub.tamanio || 0);
    const dur = Number(pub.duracion || 0);
    if (size > 2 * 1024 * 1024 && dur > 30) {
      const sig = `${size}:${Math.round(dur)}`;
      const arr = bySizeDurMap.get(sig) || [];
      arr.push(pub);
      bySizeDurMap.set(sig, arr);
    }
    const rawPubAny = pub;
    const stateStr = String(pub.estado || "").trim();
    const stateLower = stateStr.toLowerCase();
    const rejectReason = String(
      rawPubAny.motivo_rechazo || rawPubAny.rechazo || rawPubAny.razon_rechazo || ""
    ).trim();
    const hasPublishedDate = Boolean(rawPubAny.fecha_publicado);
    const isConverted = rawPubAny.convertido !== false;
    const isHidden = pub.publicado === false || stateLower.includes("error") || stateLower.includes("fail") || stateLower.includes("pend") || stateLower.includes("rechaz") || stateLower.includes("ocult") || stateLower.includes("elimin");
    if (isHidden) {
      let reason = "No publicado";
      if (rejectReason) {
        reason = `No aprobado (${rejectReason.slice(0, 60)})`;
      } else if (stateLower.includes("rechaz")) {
        reason = `No aprobado en moderaci\xF3n (${stateStr})`;
      } else if (stateLower.includes("error") || stateLower.includes("fail")) {
        reason = `Error de procesamiento (${stateStr})`;
      } else if (!isConverted) {
        reason = "Sin convertir en Nomad / Sin aprobar";
      } else if (pub.publicado === false && !hasPublishedDate) {
        reason = "Nunca publicado / Sin aprobaci\xF3n de Picta";
      } else if (pub.publicado === false) {
        reason = "Oculto manualmente en tu canal";
      } else if (stateStr) {
        reason = `Estado: ${stateStr}`;
      }
      unpublishedItems.push(toAuditItem(pub, reason));
    }
    const missingCover = !String(pub.url_imagen || "").trim() && !String(pub.url_imagen_resized || "").trim();
    const descLen = String(pub.descripcion || "").trim().length;
    const missingDesc = descLen < 12;
    const missingTags = !Array.isArray(pub.palabras_clave) || pub.palabras_clave.length === 0;
    if (missingCover || missingDesc || missingTags) {
      const missingParts = [];
      if (missingCover) missingParts.push("Sin portada");
      if (missingDesc) missingParts.push("Sin sinopsis");
      if (missingTags) missingParts.push("Sin etiquetas");
      incompleteItems.push(toAuditItem(pub, missingParts.join(" \xB7 ")));
    }
    const rawPub = pub;
    const hasLinkedSerie = Boolean(
      rawPub.pelicula_serie || rawPub.serie || rawPub.serie_id || Number(pub.categoria?.tipologia?.id || 0) === 5
    );
    const looksLikeEpisode = EPISODE_PATTERN_REGEX.test(String(pub.nombre || ""));
    if (looksLikeEpisode && !hasLinkedSerie) {
      orphanEpisodeItems.push(
        toAuditItem(pub, "Parece cap\xEDtulo de serie pero est\xE1 en otra categor\xEDa sin vincular")
      );
    } else if (Number(pub.categoria?.tipologia?.id || 0) === 5 && !rawPub.pelicula_serie && !rawPub.serie && !rawPub.temporada) {
      orphanEpisodeItems.push(
        toAuditItem(pub, "Categor\xEDa Serie sin serie/temporada vinculada")
      );
    }
  }
  const seenGroupSignatures = /* @__PURE__ */ new Set();
  const duplicateGroups = [];
  const duplicateItemIds = /* @__PURE__ */ new Set();
  const duplicateItems = [];
  const registerGroup = (groupKey, reason, pubs) => {
    if (pubs.length < 2) return;
    const sorted = [...pubs].sort((a, b) => Number(a.id) - Number(b.id));
    const sig = sorted.map((p) => p.id).join(",");
    if (seenGroupSignatures.has(sig)) return;
    seenGroupSignatures.add(sig);
    const mapped = sorted.map((p) => toAuditItem(p, reason));
    duplicateGroups.push({
      groupKey,
      reason,
      items: mapped
    });
    for (const item of mapped) {
      if (!duplicateItemIds.has(item.id)) {
        duplicateItemIds.add(item.id);
        duplicateItems.push(item);
      }
    }
  };
  for (const [normTitle, pubs] of byTitleMap.entries()) {
    if (pubs.length >= 2) {
      registerGroup(`title:${normTitle}`, `T\xEDtulo repetido (${pubs.length} copias)`, pubs);
    }
  }
  for (const [sig, pubs] of bySizeDurMap.entries()) {
    if (pubs.length >= 2) {
      registerGroup(`file:${sig}`, `Mismo peso y duraci\xF3n (${pubs.length} archivos)`, pubs);
    }
  }
  return {
    totalScanned: list.length,
    duplicateGroups,
    duplicateItems,
    incompleteItems,
    unpublishedItems,
    orphanEpisodeItems,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}

// src/utils/channelRequestsManager.ts
var REQUEST_STOPWORDS = /* @__PURE__ */ new Set([
  "la",
  "el",
  "los",
  "las",
  "de",
  "del",
  "en",
  "un",
  "una",
  "y",
  "por",
  "para",
  "con",
  "the",
  "of",
  "and",
  "in",
  "a",
  "an",
  "pelicula",
  "peliculas",
  "serie",
  "series",
  "subir",
  "sube",
  "suban",
  "porfa",
  "favor",
  "hola",
  "buenas",
  "alguien",
  "tiene",
  "tienen",
  "pueden",
  "puede",
  "quiero",
  "busco",
  "solicito",
  "pedido"
]);
function normalizeRequestTitle(raw) {
  return String(raw || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\((?:19|20)\d{2}\)|\[(?:19|20)\d{2}\]/g, " ").replace(/\b(?:1080p|720p|480p|4k|hd|latino|espanol|subtitulada|dual|mp4|mkv)\b/gi, " ").replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}
function extractNumbers(str) {
  return (str.match(/\d+/g) || []).map((n) => String(Number(n)));
}
function parseSubscriberRequestMessage(rawText, mode) {
  const text = String(rawText || "").trim();
  if (!text || text.length > 220) {
    return { matched: false, query: "", triggerType: "prefix" };
  }
  const cmdMatch = text.match(/^\/(?:buscar|pedir|solicitar|pedido)(?:@[A-Za-z0-9_]+)?\s+(.+)/is);
  if (cmdMatch?.[1]) {
    return {
      matched: true,
      query: cmdMatch[1].trim().slice(0, 120),
      triggerType: "command"
    };
  }
  const prefixMatch = text.match(
    /^(?:#?(?:pedido|pedir|solicitud|solicito|busco)\s*[:\-]?\s+|por\s+favor\s+(?:suban|sube)\s+|pueden\s+subir\s+|quiero\s+ver\s+)(.+)/is
  );
  if (prefixMatch?.[1]) {
    const cleaned = prefixMatch[1].trim().slice(0, 120);
    if (cleaned.length >= 2) {
      return { matched: true, query: cleaned, triggerType: "prefix" };
    }
  }
  if (mode === "all" && !text.startsWith("/") && !/https?:\/\//i.test(text)) {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length >= 3 && clean.length <= 90) {
      return { matched: true, query: clean, triggerType: "open" };
    }
  }
  return { matched: false, query: "", triggerType: "prefix" };
}
function findMatchingPendingRequests(requests, ownerChatId, uploadedTitle) {
  const normUpload = normalizeRequestTitle(uploadedTitle);
  if (!normUpload || normUpload.length < 2) return [];
  const uploadTokens = normUpload.split(" ").filter((t) => t.length >= 2 && !REQUEST_STOPWORDS.has(t));
  const uploadNums = extractNumbers(normUpload);
  const matched = [];
  for (const req of requests) {
    if (req.ownerChatId !== ownerChatId || req.status !== "pending") continue;
    const normReq = req.normalizedTitle || normalizeRequestTitle(req.requestedTitle);
    if (!normReq || normReq.length < 2) continue;
    const reqNums = extractNumbers(normReq);
    if (reqNums.length > 0 && uploadNums.length > 0) {
      const sharesNum = reqNums.some((n) => uploadNums.includes(n));
      if (!sharesNum) continue;
    } else if (reqNums.length > 0 && uploadNums.length === 0) {
      continue;
    }
    if (normUpload === normReq || normUpload.includes(normReq) || normReq.includes(normUpload)) {
      matched.push(req);
      continue;
    }
    const reqTokens = normReq.split(" ").filter((t) => t.length >= 2 && !REQUEST_STOPWORDS.has(t));
    if (reqTokens.length === 0 || uploadTokens.length === 0) continue;
    const hits = reqTokens.filter((t) => uploadTokens.includes(t)).length;
    const overlap = hits / Math.max(reqTokens.length, uploadTokens.length);
    if (overlap >= 0.72 || reqTokens.length >= 2 && hits === reqTokens.length) {
      matched.push(req);
    }
  }
  return matched;
}
function escapeHtmlBasic(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function formatSizeBasic(bytes) {
  if (!bytes || bytes <= 0) return "N/D";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function formatSubscriberPictaReplyHtml(query, matches) {
  const top = matches.slice(0, 3);
  const lines = top.map((m, idx) => {
    const resStr = m.maxResolutionLabel ? m.maxResolutionLabel : Array.isArray(m.resolutions) && m.resolutions.length > 0 ? m.resolutions.join(", ") : m.kind === "serie" ? "Cat\xE1logo Serie" : "Est\xE1ndar";
    const sizeStr = formatSizeBasic(m.sizeBytes);
    const channelPart = m.channelName ? `\u{1F4FA} ${escapeHtmlBasic(m.channelName)}` : "\u{1F4FA} Picta";
    return `<b>${idx + 1}. ${escapeHtmlBasic(m.title)}</b>
   ${channelPart} \xB7 \u{1F4E6} ${sizeStr} \xB7 \u{1F39E}\uFE0F ${escapeHtmlBasic(resStr)}
   \u{1F517} ${escapeHtmlBasic(m.webUrl)}`;
  });
  const html = `\u2705 <b>\xA1"<i>${escapeHtmlBasic(query)}</i>" ya est\xE1 disponible en Picta!</b>
Antes de pedirlo o volverlo a subir, puedes verlo aqu\xED:

${lines.join("\n\n")}`;
  const keyboard = top.map((m, idx) => [
    {
      text: `\u25B6\uFE0F Ver Opci\xF3n ${idx + 1} en Picta`,
      url: m.webUrl
    }
  ]);
  return { html, keyboard };
}
var NON_REQUEST_COMMENT_REGEX = /^(?:gracias+|muchas gracias+|excelente+|buen[ao]\s+(?:peli|pelicula|serie|canal|calidad)|me\s+encant[oa]|genial+|bravo+|saludos+|hola+|no\s+(?:carga|abre|se\s+ve|tiene\s+audio|funciona|reproduce)|se\s+(?:traba|corta)|sin\s+audio|subtitulos?\s+desincronizados?)[\s!.,?]*$/i;
var GENERIC_VAGUE_TAIL = /* @__PURE__ */ new Set([
  "mas",
  "otra",
  "otro",
  "esto",
  "eso",
  "esa",
  "ese",
  "algo",
  "algo mas",
  "por favor",
  "porfa",
  "gracias",
  "sube mas",
  "el resto",
  "lo demas",
  "todos",
  "todas",
  "completo",
  "completa",
  "videos",
  "mas videos",
  "contenido",
  "mas contenido",
  "peliculas",
  "series",
  "cosas",
  "cosas nuevas"
]);
var FALSE_POSITIVE_PRAISE_OR_GENERIC_REGEX = /(?:\bla\s+cabra\b|\bel\s+mejor\b|\bcrack\b|\bsigue\s+as[ií]\b|\bbuen\s+canal\b|\bexcelente\s+canal\b|\bvideos?\s+(?:a|en|de)\s+picta\b|\bcosas\s+en\s+el\s+apartado\b|\bcontenido\s+(?:a|en)\s+picta\b|\bm[aá]s\s+videos?\b|\bm[aá]s\s+contenido\b)/i;
function cleanExtractedCommentTitle(raw) {
  let s = String(raw || "").replace(/https?:\/\/\S+/gi, " ").replace(/[@#]\S+/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(
    /^(?:por\s+favor|porfa+|xfa|de\s+favor|si\s+pueden|si\s+es\s+posible|hola|buenas|saludos|que\s+)[\s,:\-]*/i,
    ""
  );
  s = s.replace(
    /^(?:la\s+pel[ií]cula\s+(?:de\s+)?|pel[ií]cula\s+(?:de\s+)?|la\s+serie\s+(?:de\s+)?|serie\s+(?:de\s+)?|el\s+anime\s+(?:de\s+)?|anime\s+(?:de\s+)?|la\s+novela\s+(?:de\s+)?|el\s+dorama\s+(?:de\s+)?|el\s+documental\s+(?:de\s+)?|la\s+saga\s+(?:de\s+)?|el\s+|la\s+|los\s+|las\s+|a\s+)/i,
    ""
  );
  s = s.replace(
    /[\s,.\-!]*(?:por\s+favor+|porfa+|xfa|de\s+favor|si\s+pueden|si\s+pudieran|si\s+se\s+puede|cuando\s+puedan|se\s+los\s+agradeceria|muchas\s+gracias|gracias+|en\s+espa[ñn]ol|en\s+latino|audio\s+latino|subtitulad[ao]s?|doblada|por\s+fis)[\s!?.]*$/gi,
    ""
  );
  s = s.replace(
    /[\s,.\-!]*(?:por\s+favor+|porfa+|xfa|muchas\s+gracias|gracias+)[\s!?.]*$/gi,
    ""
  );
  s = s.replace(/^["'«“(]+|["'»”?!.,:;]+$/g, "").replace(/\s+/g, " ").trim();
  return s.slice(0, 100);
}
function isInvalidExtractedCandidate(candidate, norm) {
  if (!candidate || candidate.length < 2 || norm.length < 2) return true;
  if (GENERIC_VAGUE_TAIL.has(norm)) return true;
  if (/^(?:aqui|aca|picta|telegram|canal|este\s+canal|tu\s+canal)$/i.test(norm)) return true;
  if (FALSE_POSITIVE_PRAISE_OR_GENERIC_REGEX.test(candidate)) return true;
  if (/^(?:cosas|algo|todo|videos?|pelis|pel[ií]culas?|series?)\s+(?:de|en|para|sobre|como)\b/i.test(norm) && norm.split(" ").length <= 5) {
    return true;
  }
  return false;
}
function extractMediaRequestFromPictaComment(rawText, publicationTitle) {
  const text = String(rawText || "").replace(/\s+/g, " ").trim();
  if (!text || text.length < 5 || text.length > 320) {
    return { matched: false, title: "", reason: "" };
  }
  if (NON_REQUEST_COMMENT_REGEX.test(text)) {
    return { matched: false, title: "", reason: "" };
  }
  const explicitMatch = text.match(
    /(?:^|\s)(?:#?pedido|#?solicitud|petici[oó]n)\s*[:\-]\s*([^.!?\n]{2,110})/i
  );
  if (explicitMatch?.[1]) {
    const title = cleanExtractedCommentTitle(explicitMatch[1]);
    const norm = normalizeRequestTitle(title);
    if (!isInvalidExtractedCandidate(title, norm)) {
      return { matched: true, title, reason: "Etiqueta expl\xEDcita de pedido" };
    }
  }
  const followupMatch = text.match(
    /(?:cuando\s+(?:suben|sube|salen?|sale)|para\s+cuando|falta[n]?|suban|sube|podr[ií]an\s+subir|pueden\s+subir)\s+(?:el\s+|los\s+|la\s+|las\s+)?((?:cap[ií]tulo|episodio|ep\.?|temporada|parte|part)\s*#?\d+(?:\s*(?:al|a|-)\s*\d+)?)/i
  );
  if (followupMatch?.[1]) {
    const unit = followupMatch[1].trim();
    const base = String(publicationTitle || "").replace(/\b(?:s\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{1,3}|cap[ií]tulo\s*#?\d+|episodio\s*#?\d+)\b.*$/i, "").replace(/[\-|–]+$/g, "").trim();
    const combined = base && !/^Video #\d+$/i.test(base) ? `${base.slice(0, 70)} (${unit})` : unit;
    return { matched: true, title: combined, reason: "Continuaci\xF3n de serie/temporada" };
  }
  const phrasePatterns = [
    {
      regex: /(?:^|[.!?,;:\n¿]\s*|(?:por\s+favor|porfa+|xfa|de\s+favor|ojal[aá]|si\s+pueden|te\s+pido\s+que|les\s+pido\s+que|ser[ií]a\s+bueno\s+que|me\s+encantar[ií]a\s+que|puedes|pueden|podr[ií]an|pudieran)\s+)(?:podr[ií]an\s+subir|pudieran\s+subir|pueden\s+subir|puedes\s+subir|subanme|subeme|suban|sube|ser[ií]a\s+posible\s+subir|recomiendo\s+subir|pido\s+que\s+suban)\s+([^.!?\n]{2,115})/i,
      reason: "Solicitud directa de subida"
    },
    {
      regex: /(?:^|[.!?,;:\n¿]\s*|\s)(?:quisiera\s+ver|me\s+gustar[ií]a\s+ver|quiero\s+ver|estoy\s+buscando|alguien\s+tiene|tienen\s+la\s+pel[ií]cula|tienen\s+la\s+serie|solicito\s+|para\s+cuando\s+|cuando\s+suben\s+)([^.!?\n]{2,115})/i,
      reason: "B\xFAsqueda o petici\xF3n de t\xEDtulo"
    }
  ];
  for (const { regex, reason } of phrasePatterns) {
    const m = text.match(regex);
    if (m?.[1]) {
      const fullMatch = m[0] || "";
      if (/\b(?:que|quien|el\s+que|la\s+que|como|cuando)\s+sube\b/i.test(fullMatch)) {
        continue;
      }
      const candidate = cleanExtractedCommentTitle(m[1]);
      const norm = normalizeRequestTitle(candidate);
      if (!isInvalidExtractedCandidate(candidate, norm)) {
        return { matched: true, title: candidate, reason };
      }
    }
  }
  return { matched: false, title: "", reason: "" };
}

// server.ts
dotenv.config();
var PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3e3);
var START_TIME = Date.now();
var K_SERVICE_NAME = String(process.env.K_SERVICE || "");
var IS_AI_STUDIO_DEV_PREVIEW = (K_SERVICE_NAME.startsWith("ais-dev-") || process.cwd() === "/app/applet") && process.env.FORCE_ACTIVE_BOT !== "true";
var IS_PRODUCTION_RUNTIME = !IS_AI_STUDIO_DEV_PREVIEW;
var IS_CLOUD_RUN_SERVICE = !IS_AI_STUDIO_DEV_PREVIEW;
var IS_PREVIEW_INSTANCE = IS_AI_STUDIO_DEV_PREVIEW;
var TMP_UPLOAD_DIR = resolveScratchUploadDir();
var STATE_DIR = "/tmp/picta_bot_state";
var LEGACY_DATA_DIR = path3.resolve(process.cwd(), ".data");
var JOBS_FILE = path3.join(STATE_DIR, "jobs.json");
var PROCESSED_UPDATES_FILE = path3.join(STATE_DIR, "processed_updates.json");
var MTPROTO_SESSION_FILE = path3.join(STATE_DIR, "mtproto_session.json");
var AUTHORIZED_USERS_FILE = path3.join(STATE_DIR, "authorized_users.json");
var USER_SESSIONS_FILE = path3.join(STATE_DIR, "user_sessions.json");
var QUOTA_SETTINGS_FILE = path3.join(STATE_DIR, "quota_settings.json");
var ALERTS_STATE_FILE = path3.join(STATE_DIR, "picta_alerts_state.json");
var PROMO_CHANNELS_FILE = path3.join(STATE_DIR, "promo_channels.json");
var PENDING_PROMOS_FILE = path3.join(STATE_DIR, "pending_promos.json");
var CHANNEL_REQUESTS_FILE = path3.join(STATE_DIR, "channel_requests.json");
var IGNORED_REQUEST_COMMENTS_FILE = path3.join(STATE_DIR, "ignored_comment_requests.json");
var MASTER_ADMIN_CHAT_ID = "1981484200";
var MASTER_PRIVATE_REQUESTS_CHANNEL = {
  targetChannelId: "-1004395450472",
  targetChannelLabel: "Pedidos Multiverso Visual (@multiversovisual)",
  pictaChannelUrl: "https://www.picta.cu/canal/multiverso-visual-440cjfir6jyg4pb7"
};
var PICTA_OFFICIAL_CLIENT_ID = "lBNcdmsTc5Om3N9MTP4Dy9Rnzc6eooPU4QVHVvS5";
var PICTA_AES_KEY = "8A@bIUzA9Yukz!0G";
var FALLBACK_JPEG_BASE64 = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
for (const dir of [TMP_UPLOAD_DIR, STATE_DIR, LEGACY_DATA_DIR]) {
  try {
    if (!fs3.existsSync(dir)) {
      fs3.mkdirSync(dir, { recursive: true });
    }
  } catch {
  }
}
function mirrorFileToLegacyDataDir(stateFilePath, legacyFileName) {
  try {
    if (stateFilePath && fs3.existsSync(stateFilePath)) {
      if (legacyFileName) {
        fs3.copyFileSync(stateFilePath, path3.join(LEGACY_DATA_DIR, legacyFileName));
      }
      const baseName = path3.basename(stateFilePath);
      if (baseName && baseName !== legacyFileName) {
        fs3.copyFileSync(stateFilePath, path3.join(LEGACY_DATA_DIR, baseName));
      }
    }
  } catch {
  }
}
function migrateLegacyStateOnce() {
  try {
    const pairs = [
      [MTPROTO_SESSION_FILE, "mtproto_session_v2.json"],
      [PROCESSED_UPDATES_FILE, "processed_updates.json"],
      [JOBS_FILE, "runtime_jobs_v2.json"],
      [AUTHORIZED_USERS_FILE, "authorized_users.json"],
      [USER_SESSIONS_FILE, "user_sessions.json"],
      [QUOTA_SETTINGS_FILE, "quota_settings.json"],
      [ALERTS_STATE_FILE, "picta_alerts_state.json"],
      [PROMO_CHANNELS_FILE, "promo_channels.json"],
      [PENDING_PROMOS_FILE, "pending_promos.json"],
      [path3.join(STATE_DIR, "pinned_series.json"), "pinned_series.json"],
      [path3.join(STATE_DIR, "channel_series.json"), "channel_series.json"]
    ];
    for (const [stateFile, legacyName] of pairs) {
      const legacyPath = path3.join(LEGACY_DATA_DIR, legacyName);
      if (!fs3.existsSync(stateFile) && fs3.existsSync(legacyPath)) {
        fs3.copyFileSync(legacyPath, stateFile);
      }
    }
  } catch {
  }
}
migrateLegacyStateOnce();
var DEFAULT_FIELD_MAPPING = {
  videoField: "file",
  titleField: "nombre",
  synopsisField: "descripcion",
  categoryField: "tipologia",
  channelField: "canal",
  publishedField: "publicado",
  extraFieldsJson: "{}"
};
var dynamicDetectedPublicUrl = "";
function detectCloudRunUrl() {
  if (dynamicDetectedPublicUrl && dynamicDetectedPublicUrl.startsWith("http")) {
    return dynamicDetectedPublicUrl;
  }
  const envUrl = (process.env.WEBHOOK_DOMAIN || (process.env.TELEGRAM_MODE === "webhook" ? process.env.APP_URL : "") || "").trim();
  if (envUrl && envUrl !== "MY_APP_URL" && envUrl.startsWith("http") && !envUrl.includes("ais-dev-") && !envUrl.includes("ais-pre-") && !envUrl.includes("untitled-3150.ai.studio")) {
    return envUrl.replace(/\/+$/, "");
  }
  return "";
}
var botConfig = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "9195788111:AAGbZxDK5IxhoGm2THlYiAdzMbvXe8nxDAk",
  telegramApiId: process.env.TELEGRAM_API_ID || "23067663",
  telegramApiHash: process.env.TELEGRAM_API_HASH || "8b2aa6c8a7372df2f1a344b541a2aadb",
  telegramLocalApiUrl: process.env.TELEGRAM_LOCAL_API_URL || "",
  webhookUrl: `${detectCloudRunUrl()}/api/telegram/webhook`,
  useWebhook: true,
  allowedChatIds: "",
  pictaUsername: process.env.PICTA_USERNAME || "56942234",
  pictaPassword: process.env.PICTA_PASSWORD || "Ghost.0210",
  pictaClientId: PICTA_OFFICIAL_CLIENT_ID,
  pictaBaseUrl: "https://admin.picta.cu",
  pictaUploadEndpoint: "https://api.picta.cu/v1/publicacion/",
  pictaAuthType: "oauth_password",
  pictaAuthToken: "",
  pictaCookie: "",
  pictaChannelId: "36319",
  // Multiverso Visual (#36319)
  pictaTipologiaId: "8",
  // Audiovisual
  pictaDefaultCategory: "Audiovisual",
  pictaClasificacion: "18+",
  pictaPalabraClaveId: "5476",
  // picta
  channelThemeDescription: "Canal Multiverso Visual \u2014 El Rinc\xF3n Visual: pel\xEDculas, series, videojuegos, tecnolog\xEDa y entretenimiento en Picta Cuba",
  fieldMapping: { ...DEFAULT_FIELD_MAPPING }
};
function cleanSerieDisplayName(rawName) {
  return String(rawName || "").replace(/\s+\b(?:temp(?:orada)?\.?\s*\d+)\s*$/i, "").trim();
}
function sanitizePublicPictaText(rawText) {
  return String(rawText || "").replace(/\s*\(\s*#?\d{3,8}\s*\)/g, "").replace(/\s*\(\s*ID\s*:\s*#?\d+\s*\)/gi, "").replace(/\s*#36319\b/g, "").replace(/\bcanal\s+36319\b/gi, "canal").replace(/\bEl Mentalista\s+Temp(?:orada)?\.?\s*\d+\b/gi, "El Mentalista").replace(/\s{2,}/g, " ").trim();
}
function loadJobsFromDisk() {
  try {
    if (fs3.existsSync(JOBS_FILE)) {
      const parsed = JSON.parse(fs3.readFileSync(JOBS_FILE, "utf-8"));
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch {
  }
  return [];
}
function pruneTransferJobsMemory() {
  const active = [];
  const terminal = [];
  for (const job of transferJobs) {
    if (!job) continue;
    if (job.stage === "completed" || job.stage === "failed" || job.stage === "cancelled") {
      terminal.push(job);
    } else {
      active.push(job);
    }
  }
  if (terminal.length > 100) {
    transferJobs = [...active, ...terminal.slice(0, 100)];
  }
}
function saveJobsToDisk() {
  try {
    pruneTransferJobsMemory();
    const active = transferJobs.filter(
      (j) => j.stage !== "completed" && j.stage !== "failed" && j.stage !== "cancelled"
    );
    const terminal = transferJobs.filter(
      (j) => j.stage === "completed" || j.stage === "failed" || j.stage === "cancelled"
    );
    const toPersist = [...active, ...terminal].slice(0, 60);
    fs3.writeFileSync(JOBS_FILE, JSON.stringify(toPersist, null, 2), "utf-8");
    mirrorFileToLegacyDataDir(JOBS_FILE, "runtime_jobs_v2.json");
  } catch {
  }
}
function loadMtprotoSessionFromDisk() {
  try {
    if (fs3.existsSync(MTPROTO_SESSION_FILE)) {
      const parsed = JSON.parse(fs3.readFileSync(MTPROTO_SESSION_FILE, "utf-8"));
      if (parsed && typeof parsed.session === "string" && parsed.session.trim()) {
        return parsed.session.trim();
      }
    }
  } catch {
  }
  return "";
}
function saveMtprotoSessionToDisk(sessionStr) {
  try {
    if (!sessionStr || !sessionStr.trim()) return;
    fs3.writeFileSync(
      MTPROTO_SESSION_FILE,
      JSON.stringify({ session: sessionStr.trim(), savedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2),
      "utf-8"
    );
    mirrorFileToLegacyDataDir(MTPROTO_SESSION_FILE, "mtproto_session_v2.json");
  } catch {
  }
}
var transferJobs = loadJobsFromDisk();
var liveLogs = [];
var mtprotoDiagLogs = [];
var webhookRegistered = false;
var webhookPendingUpdates = 0;
var lastWebhookError = null;
var lastWakeUpAt = null;
var botProfile = null;
var mtprotoConnected = false;
var mtprotoClient = null;
var mtprotoSessionString = loadMtprotoSessionFromDisk();
var mtprotoFloodWaitUntilMs = 0;
var pictaUser = null;
var pictaTokenExpiresAt = 0;
var pictaChannels = [
  {
    id: 36319,
    nombre: "Multiverso Visual",
    alias: "El Rinc\xF3n Visual \u2013 tu espacio para ver y descubrir"
  }
];
var currentActivity = "En l\xEDnea (@Picta2bot \xB7 MTProto 2GB activo \xB7 Canal Picta: Multiverso Visual #36319)";
var activeJobId = null;
var activeDownloadJobId = null;
var activeUploadJobId = null;
var externalCloudRunWebhookActive = false;
function syncActiveJobId() {
  activeJobId = activeUploadJobId || activeDownloadJobId || null;
}
var pendingManualTitleByChat = /* @__PURE__ */ new Map();
var pendingOnlineCandidatesByJob = /* @__PURE__ */ new Map();
var runningJobIds = /* @__PURE__ */ new Set();
var cancelledJobIds = /* @__PURE__ */ new Set();
var uploadQueue = [];
var processedUpdateIds = /* @__PURE__ */ new Set();
var processedCallbackIds = /* @__PURE__ */ new Set();
var processedMessageKeys = /* @__PURE__ */ new Set();
var lastUpdateOffset = 0;
function addBoundedSetEntry(set, value, maxSize = 1200) {
  set.add(value);
  if (set.size > maxSize) {
    const excess = set.size - maxSize;
    let removed = 0;
    for (const item of set) {
      set.delete(item);
      removed++;
      if (removed >= excess) break;
    }
  }
}
var PINNED_SERIES_FILE = path3.join(STATE_DIR, "pinned_series.json");
var pinnedBatchSerieByChat = /* @__PURE__ */ new Map();
function loadPinnedSeriesFromDisk() {
  try {
    if (fs3.existsSync(PINNED_SERIES_FILE)) {
      const parsed = JSON.parse(fs3.readFileSync(PINNED_SERIES_FILE, "utf-8"));
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          if (v && typeof v === "object") {
            pinnedBatchSerieByChat.set(String(k), v);
          }
        }
      }
    }
  } catch {
  }
}
function savePinnedSeriesToDisk() {
  try {
    const obj = {};
    for (const [k, v] of pinnedBatchSerieByChat.entries()) {
      obj[k] = v;
    }
    fs3.writeFileSync(PINNED_SERIES_FILE, JSON.stringify(obj, null, 2), "utf-8");
    mirrorFileToLegacyDataDir(PINNED_SERIES_FILE);
    scheduleSaveCloudStateToTelegram();
  } catch {
  }
}
loadPinnedSeriesFromDisk();
var authorizedUsers = /* @__PURE__ */ new Map();
function loadAuthorizedUsersFromDisk() {
  try {
    if (fs3.existsSync(AUTHORIZED_USERS_FILE)) {
      const parsed = JSON.parse(fs3.readFileSync(AUTHORIZED_USERS_FILE, "utf-8"));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item?.chatId) {
            authorizedUsers.set(String(item.chatId), item);
          }
        }
      }
    }
  } catch {
  }
  if (!authorizedUsers.has(MASTER_ADMIN_CHAT_ID)) {
    authorizedUsers.set(MASTER_ADMIN_CHAT_ID, {
      chatId: MASTER_ADMIN_CHAT_ID,
      username: "ghosthell0210",
      name: "Ghosthell (Admin)",
      authorizedAt: (/* @__PURE__ */ new Date()).toISOString(),
      authorizedBy: "SYSTEM"
    });
  }
}
function saveAuthorizedUsersToDisk() {
  try {
    const list = Array.from(authorizedUsers.values());
    fs3.writeFileSync(AUTHORIZED_USERS_FILE, JSON.stringify(list, null, 2), "utf-8");
    mirrorFileToLegacyDataDir(AUTHORIZED_USERS_FILE);
    scheduleSaveCloudStateToTelegram();
  } catch {
  }
}
loadAuthorizedUsersFromDisk();
function isUserAuthorized(chatId, username) {
  if (chatId === MASTER_ADMIN_CHAT_ID) return true;
  if (authorizedUsers.has(chatId)) return true;
  if (username) {
    const cleanU = username.toLowerCase().replace(/^@/, "").trim();
    for (const rec of authorizedUsers.values()) {
      if (rec.username && rec.username.toLowerCase().replace(/^@/, "").trim() === cleanU) {
        if (chatId && rec.chatId !== chatId) {
          authorizedUsers.delete(rec.chatId);
          rec.chatId = chatId;
          authorizedUsers.set(chatId, rec);
          saveAuthorizedUsersToDisk();
        }
        return true;
      }
    }
  }
  return false;
}
function authorizeUser(target, adminChatId, targetName) {
  const clean = target.trim().replace(/^@/, "");
  if (!clean) {
    return { success: false, message: "ID o nombre de usuario inv\xE1lido." };
  }
  const isNumeric = /^\d{5,15}$/.test(clean);
  let foundKey = "";
  for (const [k, v] of authorizedUsers.entries()) {
    if (isNumeric && k === clean) {
      foundKey = k;
      break;
    }
    if (!isNumeric && v.username && v.username.toLowerCase().replace(/^@/, "") === clean.toLowerCase()) {
      foundKey = k;
      break;
    }
  }
  const newRecord = {
    chatId: isNumeric ? clean : foundKey || `user_${clean}`,
    username: !isNumeric ? clean : foundKey ? authorizedUsers.get(foundKey)?.username : void 0,
    name: targetName || (!isNumeric ? `@${clean}` : `Usuario ${clean}`),
    authorizedAt: (/* @__PURE__ */ new Date()).toISOString(),
    authorizedBy: adminChatId
  };
  authorizedUsers.set(newRecord.chatId, newRecord);
  saveAuthorizedUsersToDisk();
  return { success: true, record: newRecord, message: `Usuario @${clean} autorizado correctamente.` };
}
function revokeUser(target) {
  const clean = target.trim().replace(/^@/, "");
  if (!clean) {
    return { success: false, message: "ID o usuario no especificado." };
  }
  if (clean === MASTER_ADMIN_CHAT_ID || clean.toLowerCase() === "ghosthell" || clean.toLowerCase() === "ghosthell0210") {
    return { success: false, message: "No se puede revocar al Administrador Principal." };
  }
  let deleted = false;
  for (const [k, v] of authorizedUsers.entries()) {
    if (k === clean || v.username && v.username.toLowerCase().replace(/^@/, "") === clean.toLowerCase()) {
      authorizedUsers.delete(k);
      userSessions.delete(k);
      deleted = true;
      break;
    }
  }
  if (deleted) {
    saveAuthorizedUsersToDisk();
    saveUserSessionsToDisk();
    return { success: true, message: `Usuario ${clean} retirado de la lista blanca y sesi\xF3n de Picta cerrada.` };
  }
  return { success: false, message: `Usuario ${clean} no se encontraba en la lista autorizada.` };
}
var userSessions = /* @__PURE__ */ new Map();
function loadUserSessionsFromDisk() {
  try {
    if (fs3.existsSync(USER_SESSIONS_FILE)) {
      const parsed = JSON.parse(fs3.readFileSync(USER_SESSIONS_FILE, "utf-8"));
      if (Array.isArray(parsed)) {
        let sanitizedAny = false;
        for (const item of parsed) {
          if (item?.chatId) {
            const { session: cleanSess, changed } = sanitizeLeakedUserSession(
              item,
              botConfig.pictaChannelId || "36319"
            );
            if (isMasterAdminChat(cleanSess.chatId) && (!cleanSess.channelId || cleanSess.channelId === "0")) {
              const masterChId = String(botConfig.pictaChannelId || "36319");
              cleanSess.channelId = masterChId;
              cleanSess.channelName = cleanSess.channelName || "Multiverso Visual";
              cleanSess.verifiedChannelOwnership = true;
              if (!Array.isArray(cleanSess.availableChannels)) cleanSess.availableChannels = [];
              if (!cleanSess.availableChannels.some((c) => String(c.id) === masterChId)) {
                cleanSess.availableChannels.unshift({
                  id: Number(masterChId),
                  nombre: cleanSess.channelName
                });
              }
              sanitizedAny = true;
            }
            if (changed) sanitizedAny = true;
            userSessions.set(String(cleanSess.chatId), cleanSess);
          }
        }
        if (sanitizedAny) {
          fs3.writeFileSync(
            USER_SESSIONS_FILE,
            JSON.stringify(Array.from(userSessions.values()), null, 2),
            "utf-8"
          );
          mirrorFileToLegacyDataDir(USER_SESSIONS_FILE);
        }
      }
    }
  } catch {
  }
}
function saveUserSessionsToDisk() {
  try {
    const list = Array.from(userSessions.values());
    fs3.writeFileSync(USER_SESSIONS_FILE, JSON.stringify(list, null, 2), "utf-8");
    mirrorFileToLegacyDataDir(USER_SESSIONS_FILE);
    scheduleSaveCloudStateToTelegram();
  } catch {
  }
}
loadUserSessionsFromDisk();
var userPromoChannels = /* @__PURE__ */ new Map();
var pendingMoviePromos = /* @__PURE__ */ new Map();
function loadUserPromoChannelsFromDisk() {
  try {
    if (fs3.existsSync(PROMO_CHANNELS_FILE)) {
      const parsed = JSON.parse(fs3.readFileSync(PROMO_CHANNELS_FILE, "utf-8"));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item?.chatId) {
            userPromoChannels.set(String(item.chatId), item);
          }
        }
      }
    }
  } catch {
  }
}
function saveUserPromoChannelsToDisk() {
  try {
    const list = Array.from(userPromoChannels.values());
    fs3.writeFileSync(PROMO_CHANNELS_FILE, JSON.stringify(list, null, 2), "utf-8");
    mirrorFileToLegacyDataDir(PROMO_CHANNELS_FILE);
    scheduleSaveCloudStateToTelegram();
  } catch {
  }
}
function loadPendingPromosFromDisk() {
  try {
    if (fs3.existsSync(PENDING_PROMOS_FILE)) {
      const parsed = JSON.parse(fs3.readFileSync(PENDING_PROMOS_FILE, "utf-8"));
      if (Array.isArray(parsed)) {
        for (const item of parsed.slice(-80)) {
          if (item?.promoId) {
            pendingMoviePromos.set(String(item.promoId), item);
          }
        }
      }
    }
  } catch {
  }
}
function savePendingPromosToDisk() {
  try {
    const list = Array.from(pendingMoviePromos.values()).slice(-80);
    if (pendingMoviePromos.size > 80) {
      pendingMoviePromos.clear();
      for (const item of list) {
        pendingMoviePromos.set(item.promoId, item);
      }
    }
    fs3.writeFileSync(PENDING_PROMOS_FILE, JSON.stringify(list, null, 2), "utf-8");
    mirrorFileToLegacyDataDir(PENDING_PROMOS_FILE);
  } catch {
  }
}
loadUserPromoChannelsFromDisk();
loadPendingPromosFromDisk();
var channelMediaRequests = [];
var ignoredRequestCommentIds = /* @__PURE__ */ new Set();
function loadChannelMediaRequestsFromDisk() {
  try {
    if (fs3.existsSync(CHANNEL_REQUESTS_FILE)) {
      const parsed = JSON.parse(fs3.readFileSync(CHANNEL_REQUESTS_FILE, "utf-8"));
      if (Array.isArray(parsed)) {
        channelMediaRequests = parsed.slice(0, 250);
      }
    }
    if (fs3.existsSync(IGNORED_REQUEST_COMMENTS_FILE)) {
      const parsedIgnored = JSON.parse(
        fs3.readFileSync(IGNORED_REQUEST_COMMENTS_FILE, "utf-8")
      );
      if (Array.isArray(parsedIgnored)) {
        ignoredRequestCommentIds = new Set(
          parsedIgnored.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
        );
      }
    }
  } catch {
  }
}
function saveChannelMediaRequestsToDisk() {
  try {
    if (channelMediaRequests.length > 250) {
      channelMediaRequests = channelMediaRequests.slice(0, 250);
    }
    fs3.writeFileSync(
      CHANNEL_REQUESTS_FILE,
      JSON.stringify(channelMediaRequests, null, 2),
      "utf-8"
    );
    mirrorFileToLegacyDataDir(CHANNEL_REQUESTS_FILE);
    fs3.writeFileSync(
      IGNORED_REQUEST_COMMENTS_FILE,
      JSON.stringify(Array.from(ignoredRequestCommentIds).slice(-600), null, 2),
      "utf-8"
    );
    mirrorFileToLegacyDataDir(IGNORED_REQUEST_COMMENTS_FILE);
    scheduleSaveCloudStateToTelegram();
  } catch {
  }
}
loadChannelMediaRequestsFromDisk();
function syncPictaCommentsToChannelRequests(ownerChatId, comments, ownerUsernames = []) {
  const ownerSet = new Set(
    ownerUsernames.map((u) => String(u || "").trim().toLowerCase()).filter(Boolean)
  );
  let added = 0;
  let pruned = 0;
  const commentById = /* @__PURE__ */ new Map();
  for (const c of comments || []) {
    if (c?.id) commentById.set(c.id, c);
  }
  if (commentById.size > 0) {
    const nextList = [];
    for (const req of channelMediaRequests) {
      if (req.ownerChatId === ownerChatId && req.status === "pending" && req.id.startsWith("rq_cm_") && req.commentId && commentById.has(req.commentId)) {
        const cm = commentById.get(req.commentId);
        const recheck = extractMediaRequestFromPictaComment(cm.texto, cm.publicacionNombre);
        if (!recheck.matched || !recheck.title) {
          pruned++;
          continue;
        }
        const newNorm = normalizeRequestTitle(recheck.title);
        if (req.requestedTitle !== recheck.title) {
          req.requestedTitle = recheck.title;
          req.normalizedTitle = newNorm;
          pruned++;
        }
      }
      nextList.push(req);
    }
    if (pruned > 0) {
      channelMediaRequests = nextList;
    }
  }
  for (const c of comments || []) {
    if (!c || !c.id || !c.texto) continue;
    if (ignoredRequestCommentIds.has(c.id)) continue;
    const authorLower = String(c.usuario || "").trim().toLowerCase();
    if (authorLower && ownerSet.has(authorLower)) continue;
    const existingByComment = channelMediaRequests.find(
      (r) => r.ownerChatId === ownerChatId && r.commentId === c.id
    );
    if (existingByComment) continue;
    const detection = extractMediaRequestFromPictaComment(c.texto, c.publicacionNombre);
    if (!detection.matched || !detection.title) continue;
    const norm = normalizeRequestTitle(detection.title);
    if (!norm || norm.length < 2) continue;
    const dupPending = channelMediaRequests.find(
      (r) => r.ownerChatId === ownerChatId && r.status === "pending" && r.normalizedTitle === norm
    );
    if (dupPending) {
      if (!dupPending.commentId && c.id) {
        dupPending.commentId = c.id;
        dupPending.commentPublicationId = c.publicacionId;
        dupPending.commentPublicationTitle = c.publicacionNombre;
      }
      continue;
    }
    const reqId = `rq_cm_${c.id}`;
    channelMediaRequests.unshift({
      id: reqId,
      ownerChatId,
      requestedTitle: detection.title,
      normalizedTitle: norm,
      requestedByName: c.usuario ? `@${c.usuario}` : "Suscriptor Picta",
      ...c.usuario ? { requestedByUsername: c.usuario } : {},
      sourceType: "picta_comment",
      commentId: c.id,
      commentPublicationId: c.publicacionId,
      commentPublicationTitle: c.publicacionNombre,
      status: "pending",
      createdAt: c.fecha && !isNaN(new Date(c.fecha).getTime()) ? new Date(c.fecha).toISOString() : (/* @__PURE__ */ new Date()).toISOString()
    });
    added++;
  }
  if (added > 0 || pruned > 0) {
    saveChannelMediaRequestsToDisk();
  }
  return {
    added,
    pruned,
    requests: channelMediaRequests.filter((r) => r.ownerChatId === ownerChatId)
  };
}
function getTodayCubaDateStr() {
  return getCubaTodayStr();
}
function loadQuotaSettingsFromDisk() {
  const today = getTodayCubaDateStr();
  try {
    if (fs3.existsSync(QUOTA_SETTINGS_FILE)) {
      const parsed = JSON.parse(fs3.readFileSync(QUOTA_SETTINGS_FILE, "utf-8"));
      if (parsed && typeof parsed === "object") {
        const lastDate = String(parsed.lastResetDate || parsed.currentDateCuba || today);
        return {
          maxSeriesPerDay: typeof parsed.maxSeriesPerDay === "number" ? parsed.maxSeriesPerDay : 7,
          seriesUploadedToday: Number(parsed.seriesUploadedToday || 0),
          otherUploadedToday: Number(parsed.otherUploadedToday || 0),
          lastResetDate: lastDate,
          currentDateCuba: lastDate,
          primaryExhaustedDate: parsed.primaryExhaustedDate ? String(parsed.primaryExhaustedDate) : void 0,
          poolAccounts: Array.isArray(parsed.poolAccounts) ? parsed.poolAccounts : []
        };
      }
    }
  } catch {
  }
  return {
    maxSeriesPerDay: 7,
    // Por defecto 7 capítulos de serie + 3 películas/otros por cada bloque de 10
    seriesUploadedToday: 0,
    otherUploadedToday: 0,
    lastResetDate: today,
    currentDateCuba: today,
    poolAccounts: []
  };
}
var quotaSettings = loadQuotaSettingsFromDisk();
function saveQuotaSettingsToDisk() {
  try {
    fs3.writeFileSync(QUOTA_SETTINGS_FILE, JSON.stringify(quotaSettings, null, 2), "utf-8");
    mirrorFileToLegacyDataDir(QUOTA_SETTINGS_FILE);
    scheduleSaveCloudStateToTelegram();
  } catch {
  }
}
function ensureDailyQuotaReset() {
  const today = getTodayCubaDateStr();
  let changed = false;
  if (quotaSettings.lastResetDate !== today || quotaSettings.currentDateCuba !== today) {
    quotaSettings.lastResetDate = today;
    quotaSettings.currentDateCuba = today;
    quotaSettings.seriesUploadedToday = 0;
    quotaSettings.otherUploadedToday = 0;
    quotaSettings.primaryExhaustedDate = void 0;
    changed = true;
  }
  for (const acc of quotaSettings.poolAccounts) {
    if (acc.lastResetDate !== today) {
      acc.lastResetDate = today;
      acc.usedToday = 0;
      acc.uploadedToday = 0;
      acc.exhaustedDate = void 0;
      changed = true;
    }
  }
  let userPoolChanged = false;
  for (const sess of userSessions.values()) {
    if (Array.isArray(sess.poolAccounts)) {
      for (const acc of sess.poolAccounts) {
        if (acc.lastResetDate !== today) {
          acc.lastResetDate = today;
          acc.usedToday = 0;
          acc.uploadedToday = 0;
          acc.exhaustedDate = void 0;
          userPoolChanged = true;
        }
      }
    }
  }
  if (changed) {
    saveQuotaSettingsToDisk();
  }
  if (userPoolChanged) {
    saveUserSessionsToDisk();
  }
}
var pendingPoolAccountByChat = /* @__PURE__ */ new Map();
var pendingPictaSearchByChat = /* @__PURE__ */ new Map();
var lastPictaSearchResultsByChat = /* @__PURE__ */ new Map();
function getPoolAccountsForChat(chatId) {
  if (isMasterAdminChat(chatId)) {
    return quotaSettings.poolAccounts;
  }
  const sess = userSessions.get(chatId);
  return Array.isArray(sess?.poolAccounts) ? sess.poolAccounts : [];
}
function savePoolAccountsForChat(chatId) {
  if (isMasterAdminChat(chatId)) {
    saveQuotaSettingsToDisk();
  } else {
    saveUserSessionsToDisk();
  }
}
function getPrimaryAccountLabelForChat(chatId) {
  const sess = userSessions.get(chatId);
  if (isMasterAdminChat(chatId)) {
    return sess?.userFullName || sess?.username || pictaUser?.username || botConfig.pictaUsername || "Cuenta Principal";
  }
  return sess?.userFullName || sess?.username || "Tu Cuenta Picta";
}
var cloudVaultSaveTimer = null;
var cloudVaultLoadedOnce = false;
function encryptCloudVaultPayload(plainJson) {
  const compressed = zlib.deflateRawSync(Buffer.from(plainJson, "utf-8"));
  const key = crypto.createHash("sha256").update(PICTA_AES_KEY + MASTER_ADMIN_CHAT_ID).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}
function decryptCloudVaultPayload(b64) {
  try {
    const raw = Buffer.from(b64, "base64");
    if (raw.byteLength < 29) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const key = crypto.createHash("sha256").update(PICTA_AES_KEY + MASTER_ADMIN_CHAT_ID).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const compressed = Buffer.concat([decipher.update(enc), decipher.final()]);
    return zlib.inflateRawSync(compressed).toString("utf-8");
  } catch {
    return null;
  }
}
async function saveCloudStateToTelegramNow() {
  try {
    const token = botConfig.telegramBotToken.trim();
    if (!token) return;
    const vaultObj = {
      v: 1,
      u: Array.from(authorizedUsers.values()),
      s: Array.from(userSessions.values()),
      p: Object.fromEntries(pinnedBatchSerieByChat.entries()),
      q: quotaSettings,
      pr: Array.from(userPromoChannels.values()),
      rq: channelMediaRequests.slice(0, 60),
      ir: Array.from(ignoredRequestCommentIds).slice(-150)
    };
    const encryptedB64 = encryptCloudVaultPayload(JSON.stringify(vaultObj));
    const chunks = [];
    for (let i = 0; i < encryptedB64.length; i += 240) {
      chunks.push(encryptedB64.slice(i, i + 240));
    }
    if (chunks.length === 0 || chunks.length > 95) return;
    const commands = chunks.map((chunk, idx) => ({
      command: `v_${idx}`,
      description: chunk
    }));
    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands,
        scope: { type: "chat", chat_id: Number(MASTER_ADMIN_CHAT_ID) },
        language_code: "eo"
      })
    });
  } catch {
  }
}
function scheduleSaveCloudStateToTelegram() {
  if (!cloudVaultLoadedOnce || IS_PREVIEW_INSTANCE) return;
  if (cloudVaultSaveTimer) {
    clearTimeout(cloudVaultSaveTimer);
  }
  cloudVaultSaveTimer = setTimeout(() => {
    void saveCloudStateToTelegramNow();
  }, 800);
}
var cloudVaultLoadPromise = null;
function ensureCloudStateLoadedOnce() {
  if (!cloudVaultLoadPromise) {
    cloudVaultLoadPromise = loadCloudStateFromTelegram();
  }
  return cloudVaultLoadPromise;
}
async function loadCloudStateFromTelegram() {
  try {
    const token = botConfig.telegramBotToken.trim();
    if (!token) {
      cloudVaultLoadedOnce = true;
      return;
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/getMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: { type: "chat", chat_id: Number(MASTER_ADMIN_CHAT_ID) },
        language_code: "eo"
      })
    });
    const data = await res.json();
    if (data?.ok && Array.isArray(data.result) && data.result.length > 0) {
      const sorted = [...data.result].filter((c) => typeof c?.command === "string" && c.command.startsWith("v_")).sort(
        (a, b) => Number(String(a.command).replace("v_", "")) - Number(String(b.command).replace("v_", ""))
      );
      if (sorted.length > 0) {
        const joinedB64 = sorted.map((c) => String(c.description || "")).join("");
        const jsonStr = decryptCloudVaultPayload(joinedB64);
        if (jsonStr) {
          const parsed = JSON.parse(jsonStr);
          let restoredUsers = 0;
          if (Array.isArray(parsed.u)) {
            for (const item of parsed.u) {
              if (item?.chatId && !authorizedUsers.has(String(item.chatId))) {
                authorizedUsers.set(String(item.chatId), item);
                restoredUsers++;
              }
            }
          }
          if (Array.isArray(parsed.s)) {
            for (const sess of parsed.s) {
              if (sess?.chatId && !userSessions.has(String(sess.chatId))) {
                const { session: cleanSess } = sanitizeLeakedUserSession(
                  sess,
                  botConfig.pictaChannelId || "36319"
                );
                if (isMasterAdminChat(cleanSess.chatId) && (!cleanSess.channelId || cleanSess.channelId === "0")) {
                  const masterChId = String(botConfig.pictaChannelId || "36319");
                  cleanSess.channelId = masterChId;
                  cleanSess.channelName = cleanSess.channelName || "Multiverso Visual";
                  cleanSess.verifiedChannelOwnership = true;
                  if (!Array.isArray(cleanSess.availableChannels)) cleanSess.availableChannels = [];
                  if (!cleanSess.availableChannels.some((c) => String(c.id) === masterChId)) {
                    cleanSess.availableChannels.unshift({
                      id: Number(masterChId),
                      nombre: cleanSess.channelName
                    });
                  }
                }
                userSessions.set(String(cleanSess.chatId), cleanSess);
              }
            }
          }
          if (parsed.p && typeof parsed.p === "object") {
            for (const [k, v] of Object.entries(parsed.p)) {
              if (v && typeof v === "object" && !pinnedBatchSerieByChat.has(String(k))) {
                pinnedBatchSerieByChat.set(String(k), v);
              }
            }
          }
          if (parsed.q && typeof parsed.q === "object") {
            const remotePool = Array.isArray(parsed.q.poolAccounts) ? parsed.q.poolAccounts : [];
            if (quotaSettings.poolAccounts.length === 0 && remotePool.length > 0) {
              quotaSettings.poolAccounts = remotePool;
            }
            if (typeof parsed.q.maxSeriesPerDay === "number") {
              quotaSettings.maxSeriesPerDay = parsed.q.maxSeriesPerDay;
            }
            if (parsed.q.lastResetDate === getTodayCubaDateStr()) {
              quotaSettings.seriesUploadedToday = Math.max(
                quotaSettings.seriesUploadedToday,
                Number(parsed.q.seriesUploadedToday || 0)
              );
              quotaSettings.otherUploadedToday = Math.max(
                quotaSettings.otherUploadedToday,
                Number(parsed.q.otherUploadedToday || 0)
              );
            }
          }
          if (Array.isArray(parsed.pr)) {
            for (const cfg of parsed.pr) {
              if (cfg?.chatId && !userPromoChannels.has(String(cfg.chatId))) {
                userPromoChannels.set(String(cfg.chatId), cfg);
              }
            }
          }
          if (Array.isArray(parsed.rq) && channelMediaRequests.length === 0) {
            channelMediaRequests = parsed.rq.slice(0, 250);
          }
          if (Array.isArray(parsed.ir) && ignoredRequestCommentIds.size === 0) {
            for (const cid of parsed.ir) {
              const num = Number(cid);
              if (Number.isFinite(num) && num > 0) ignoredRequestCommentIds.add(num);
            }
          }
          cloudVaultLoadedOnce = true;
          saveAuthorizedUsersToDisk();
          saveUserSessionsToDisk();
          saveUserPromoChannelsToDisk();
          saveChannelMediaRequestsToDisk();
          savePinnedSeriesToDisk();
          saveQuotaSettingsToDisk();
          if (restoredUsers > 0) {
            addLiveLog(
              "system",
              "success",
              `B\xF3veda Cloud restaurada tras reinicio: ${authorizedUsers.size} usuarios autorizados, ${userSessions.size} sesiones y ${quotaSettings.poolAccounts.length + 1} cuenta(s) en Pool.`
            );
          }
          return;
        }
      }
    }
    cloudVaultLoadedOnce = true;
    scheduleSaveCloudStateToTelegram();
    return;
  } catch {
  }
  cloudVaultLoadedOnce = true;
}
var mtprotoVaultSaveTimer = null;
var mtprotoVaultLoadedOnce = false;
async function saveMtprotoVaultToTelegramNow() {
  if (IS_PREVIEW_INSTANCE) return;
  try {
    const token = botConfig.telegramBotToken.trim();
    if (!token) return;
    const auxSessions = loadAuxiliaryBotSessionsFromDisk();
    if (!mtprotoSessionString && auxSessions.every((s) => !s)) return;
    const payloadObj = {
      v: 1,
      m: mtprotoSessionString || "",
      a: auxSessions
    };
    const encryptedB64 = encryptCloudVaultPayload(JSON.stringify(payloadObj));
    const chunks = [];
    for (let i = 0; i < encryptedB64.length; i += 240) {
      chunks.push(encryptedB64.slice(i, i + 240));
    }
    if (chunks.length === 0 || chunks.length > 95) return;
    const commands = chunks.map((chunk, idx) => ({
      command: `m_${idx}`,
      description: chunk
    }));
    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands,
        scope: { type: "chat", chat_id: Number(MASTER_ADMIN_CHAT_ID) },
        language_code: "ia"
      })
    });
  } catch {
  }
}
function scheduleSaveMtprotoVaultToTelegram() {
  if (!mtprotoVaultLoadedOnce || IS_PREVIEW_INSTANCE) return;
  if (mtprotoVaultSaveTimer) clearTimeout(mtprotoVaultSaveTimer);
  mtprotoVaultSaveTimer = setTimeout(() => {
    void saveMtprotoVaultToTelegramNow();
  }, 1e3);
}
async function ensureMtprotoVaultLoadedOnce() {
  if (mtprotoVaultLoadedOnce || IS_PREVIEW_INSTANCE) {
    mtprotoVaultLoadedOnce = true;
    return;
  }
  try {
    const token = botConfig.telegramBotToken.trim();
    if (!token) {
      mtprotoVaultLoadedOnce = true;
      return;
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/getMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: { type: "chat", chat_id: Number(MASTER_ADMIN_CHAT_ID) },
        language_code: "ia"
      })
    });
    const data = await res.json();
    if (data?.ok && Array.isArray(data.result) && data.result.length > 0) {
      const sorted = [...data.result].filter((c) => typeof c?.command === "string" && c.command.startsWith("m_")).sort(
        (a, b) => Number(String(a.command).replace("m_", "")) - Number(String(b.command).replace("m_", ""))
      );
      if (sorted.length > 0) {
        const joinedB64 = sorted.map((c) => String(c.description || "")).join("");
        const jsonStr = decryptCloudVaultPayload(joinedB64);
        if (jsonStr) {
          const parsed = JSON.parse(jsonStr);
          if (typeof parsed?.m === "string" && parsed.m.trim() && !mtprotoSessionString.trim()) {
            mtprotoSessionString = parsed.m.trim();
            saveMtprotoSessionToDisk(mtprotoSessionString);
          }
          if (Array.isArray(parsed?.a)) {
            const cleanedAux = parsed.a.map((s) => String(s || "").trim());
            if (cleanedAux.some(Boolean)) {
              auxiliaryBotSessionsCache = cleanedAux;
              try {
                fs3.writeFileSync(
                  MTPROTO_AUX_SESSIONS_FILE,
                  JSON.stringify({ sessions: cleanedAux, savedAt: (/* @__PURE__ */ new Date()).toISOString() }),
                  "utf-8"
                );
              } catch {
              }
            }
          }
        }
      }
    }
  } catch {
  }
  mtprotoVaultLoadedOnce = true;
}
async function refreshUserPictaSession(chatId) {
  const session = userSessions.get(chatId);
  if (!session) {
    if (!chatId || chatId === MASTER_ADMIN_CHAT_ID) {
      return authenticateWithPicta(false);
    }
    throw new Error("No has vinculado tu cuenta de Picta. Usa /login para iniciar sesi\xF3n.");
  }
  if (!session.password) {
    return session.authToken;
  }
  const form = new FormData();
  form.append("username", session.username);
  form.append("password", session.password);
  form.append("grant_type", "password");
  form.append("client_id", botConfig.pictaClientId || PICTA_OFFICIAL_CLIENT_ID);
  try {
    const tokenRes = await fetchPictaWithRetry("https://api.picta.cu/o/token/", {
      method: "POST",
      headers: {
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      },
      body: form
    });
    if (tokenRes.ok) {
      const data = await tokenRes.json();
      if (data?.access_token) {
        session.authToken = data.access_token;
        session.tokenExpiresAt = Date.now() + (Number(data.expires_in) || 14400) * 1e3;
        session.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        saveUserSessionsToDisk();
        return session.authToken;
      }
    }
  } catch {
  }
  return session.authToken;
}
function getEffectivePictaContext(chatId) {
  const session = userSessions.get(chatId);
  const resolved = resolveGuestOrAdminChannelMeta(
    chatId,
    session,
    botConfig.pictaChannelId || "36319",
    "Multiverso Visual"
  );
  if (session && session.authToken) {
    if (session.tokenExpiresAt > Date.now() + 6e4) {
      return {
        accessTokenPromise: Promise.resolve(session.authToken),
        channelId: resolved.channelId,
        channelName: resolved.channelName,
        isLinked: resolved.isLinked
      };
    }
    return {
      accessTokenPromise: refreshUserPictaSession(chatId),
      channelId: resolved.channelId,
      channelName: resolved.channelName,
      isLinked: resolved.isLinked
    };
  }
  if (resolved.isMaster) {
    return {
      accessTokenPromise: authenticateWithPicta(false),
      channelId: resolved.channelId,
      channelName: resolved.channelName,
      isLinked: true
    };
  }
  const unlinkedPromise = Promise.reject(
    new Error("No has vinculado tu cuenta de Picta. Usa /login primero.")
  );
  unlinkedPromise.catch(() => {
  });
  return {
    accessTokenPromise: unlinkedPromise,
    channelId: "",
    channelName: "Sin vincular",
    isLinked: false
  };
}
var pendingUserLoginByChat = /* @__PURE__ */ new Map();
var lastAutoDiscoveryAttemptByChat = /* @__PURE__ */ new Map();
async function fetchDecryptedPictaMe2(accessToken) {
  try {
    const meRes = await fetchPictaWithRetry("https://api.picta.cu/v2/usuario/me2/", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      }
    });
    if (!meRes.ok) return null;
    const encryptedText = (await meRes.text()).trim().replace(/^"|"$/g, "");
    const decipher = crypto.createDecipheriv(
      "aes-128-ecb",
      Buffer.from(PICTA_AES_KEY, "utf8"),
      null
    );
    let decrypted = decipher.update(encryptedText, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}
async function verifyChannelOwnershipByDetail(channelId, accessToken, ownerIdentity, excludeIds, allowMissingOwnerIfParentVerified = false) {
  if (!channelId || channelId <= 0 || excludeIds.has(String(channelId))) return null;
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    Origin: "https://admin.picta.cu",
    Referer: "https://admin.picta.cu/"
  };
  let fallbackDetail = null;
  for (const url of [
    `https://api.picta.cu/v3/channel/${channelId}/`,
    `https://api.picta.cu/v2/canal/${channelId}/`,
    `https://api.picta.cu/v1/canal/${channelId}/`
  ]) {
    try {
      const res = await fetchPictaWithRetry(url, { headers: authHeaders }, 2);
      if (!res.ok) continue;
      const detail = await res.json().catch(() => null);
      if (!detail || typeof detail !== "object") continue;
      const normalized = {
        id: Number(detail.id || channelId),
        nombre: String(detail.nombre || detail.name || `Canal #${channelId}`).trim(),
        ...detail.alias ? { alias: String(detail.alias) } : {},
        ...detail.slug_url ? { slug_url: String(detail.slug_url) } : {}
      };
      const owned = isChannelOwnedOrAssociatedByUser(detail, ownerIdentity);
      if (owned === false) return null;
      if (owned === true) {
        return normalized;
      }
      if (!fallbackDetail) {
        fallbackDetail = normalized;
      }
    } catch {
    }
  }
  if (allowMissingOwnerIfParentVerified && fallbackDetail) {
    return fallbackDetail;
  }
  return null;
}
async function discoverUserPictaChannels(accessToken, formattedUsername, userFullName, userId, isMaster, profileObj) {
  const masterDefaultChanId = String(botConfig.pictaChannelId || "36319");
  const excludeIds = isMaster ? /* @__PURE__ */ new Set() : /* @__PURE__ */ new Set([masterDefaultChanId]);
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    Origin: "https://admin.picta.cu",
    Referer: "https://admin.picta.cu/"
  };
  const ownerIdentity = {
    ...userId && userId > 0 ? { userId } : {},
    username: String(profileObj?.username || formattedUsername || "").trim(),
    phone: String(profileObj?.phone_number || profileObj?.telefono || formattedUsername || "").trim(),
    fullName: String(userFullName || "").trim(),
    ...profileObj?.email ? { email: String(profileObj.email).trim() } : {}
  };
  const verifiedChannelsById = /* @__PURE__ */ new Map();
  const addVerified = (ch) => {
    if (!ch.id || ch.id <= 0 || excludeIds.has(String(ch.id))) return;
    if (!verifiedChannelsById.has(ch.id)) {
      verifiedChannelsById.set(ch.id, ch);
    }
  };
  const profilePayloads = [];
  if (profileObj && typeof profileObj === "object") {
    profilePayloads.push(profileObj);
  }
  const extraProfileUrls = [
    "https://api.picta.cu/v2/usuario/me/",
    "https://api.picta.cu/v1/usuario/me/",
    ...userId && userId > 0 ? [
      `https://api.picta.cu/v2/usuario/${encodeURIComponent(String(userId))}/`,
      `https://api.picta.cu/v1/usuario/${encodeURIComponent(String(userId))}/`
    ] : []
  ];
  const extraProfileRes = await Promise.all(
    extraProfileUrls.map(async (url) => {
      try {
        const r = await fetchPictaWithRetry(url, { headers: authHeaders }, 1);
        if (!r.ok) return null;
        return await r.json().catch(() => null);
      } catch {
        return null;
      }
    })
  );
  for (const p of extraProfileRes) {
    if (p && typeof p === "object") profilePayloads.push(p);
  }
  for (const pObj of profilePayloads) {
    for (const ch of extractChannelsFromPictaRecords([pObj], excludeIds, ownerIdentity)) {
      addVerified(ch);
    }
    for (const scalarChanId of extractScalarChannelIdsFromRecord(pObj, excludeIds)) {
      if (!verifiedChannelsById.has(scalarChanId)) {
        const verified = await verifyChannelOwnershipByDetail(
          scalarChanId,
          accessToken,
          ownerIdentity,
          excludeIds,
          true
        );
        if (verified) addVerified(verified);
      }
    }
  }
  if (userId && userId > 0 || ownerIdentity.username || ownerIdentity.fullName) {
    const uid = userId && userId > 0 ? encodeURIComponent(String(userId)) : "";
    const directUrls = [
      "https://api.picta.cu/v3/channel/mine/",
      "https://api.picta.cu/v3/channel/?mine=true&page_size=50",
      "https://api.picta.cu/v1/canal/mis_canales/",
      "https://api.picta.cu/v2/canal/mis_canales/"
    ];
    if (uid) {
      directUrls.push(
        `https://api.picta.cu/v3/channel/?propietario=${uid}&page_size=50`,
        `https://api.picta.cu/v3/channel/?propietario_id=${uid}&page_size=50`,
        `https://api.picta.cu/v3/channel/?usuario=${uid}&page_size=50`,
        `https://api.picta.cu/v3/channel/?usuarios_asociados=${uid}&page_size=50`,
        `https://api.picta.cu/v1/canal/?propietario=${uid}&page_size=100`,
        `https://api.picta.cu/v1/canal/?propietario_id=${uid}&page_size=100`,
        `https://api.picta.cu/v1/canal/?usuario=${uid}&page_size=50`,
        `https://api.picta.cu/v1/canal/?usuarios_asociados=${uid}&page_size=50`,
        `https://api.picta.cu/v2/canal/?propietario=${uid}&page_size=100`,
        `https://api.picta.cu/v2/canal/?usuario_id=${uid}&page_size=50`,
        `https://api.picta.cu/v2/canal/?usuarios_asociados=${uid}&page_size=50`,
        `https://api.picta.cu/v2/publicacion/?usuario=${uid}&page_size=25`,
        `https://api.picta.cu/v2/publicacion/?usuario_id=${uid}&page_size=25`,
        `https://api.picta.cu/v1/publicacion/?usuario=${uid}&page_size=25`,
        `https://api.picta.cu/v2/serie/?usuario=${uid}&page_size=25`,
        `https://api.picta.cu/v2/lista_reproduccion_canal/?usuario=${uid}&page_size=25`
      );
    }
    const searchTerms = Array.from(
      new Set(
        [userFullName, ownerIdentity.username, formattedUsername].map((s) => String(s || "").trim()).filter((s) => s.length >= 3 && !/^\+?\d+$/.test(s))
      )
    ).slice(0, 2);
    for (const term of searchTerms) {
      const qTerm = encodeURIComponent(term);
      directUrls.push(
        `https://api.picta.cu/v3/channel/?search=${qTerm}&page_size=20`,
        `https://api.picta.cu/v1/canal/?search=${qTerm}&page_size=20`
      );
    }
    const parentVerifiedIds = /* @__PURE__ */ new Set();
    const unverifiedNestedIds = /* @__PURE__ */ new Set();
    const responses = await Promise.all(
      directUrls.map(async (url) => {
        try {
          const res = await fetchPictaWithRetry(url, { headers: authHeaders }, 2);
          if (!res.ok) return { url, payload: null };
          return { url, payload: await res.json().catch(() => null) };
        } catch {
          return { url, payload: null };
        }
      })
    );
    for (const { url, payload } of responses) {
      if (!payload) continue;
      const list = Array.isArray(payload) ? payload : payload.results || [payload];
      const isMineEndpoint = /\/(?:mine|mis_canales)\/|\?mine=true/i.test(url);
      const isChannelEndpoint = /\/(?:canal|channel)\//.test(url);
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        if (isChannelEndpoint) {
          const owned = isChannelOwnedOrAssociatedByUser(item, ownerIdentity);
          if (owned === true) {
            for (const ch of extractChannelsFromPictaRecords([item], excludeIds, ownerIdentity)) {
              addVerified(ch);
            }
          } else if (owned === false) {
            continue;
          } else {
            const itemId = Number(item.id || item.pk || 0);
            if (itemId > 0 && !excludeIds.has(String(itemId))) {
              if (isMineEndpoint) {
                parentVerifiedIds.add(itemId);
              } else {
                unverifiedNestedIds.add(itemId);
              }
            }
          }
        } else {
          const itemOwner = isChannelOwnedOrAssociatedByUser(item, ownerIdentity);
          if (itemOwner === false) continue;
          const nestedCandidates = extractChannelsFromPictaRecords([item], excludeIds, ownerIdentity);
          for (const cand of nestedCandidates) {
            const nestedOwned = isChannelOwnedOrAssociatedByUser(item.canal || cand, ownerIdentity);
            if (nestedOwned === true || nestedOwned === null && itemOwner === true) {
              addVerified(cand);
            } else if (nestedOwned === null) {
              unverifiedNestedIds.add(cand.id);
            }
          }
          for (const scalarChanId of extractScalarChannelIdsFromRecord(item, excludeIds)) {
            if (verifiedChannelsById.has(scalarChanId)) continue;
            if (itemOwner === true) {
              parentVerifiedIds.add(scalarChanId);
            } else {
              unverifiedNestedIds.add(scalarChanId);
            }
          }
        }
      }
    }
    const priorityCandidates = [
      ...Array.from(parentVerifiedIds).map((id) => ({ id, allowParent: true })),
      ...Array.from(unverifiedNestedIds).filter((id) => !parentVerifiedIds.has(id)).slice(0, 12).map((id) => ({ id, allowParent: false }))
    ];
    for (let i = 0; i < priorityCandidates.length; i += 5) {
      const batch = priorityCandidates.slice(i, i + 5);
      await Promise.all(
        batch.map(async (cand) => {
          if (verifiedChannelsById.has(cand.id)) return;
          const verified = await verifyChannelOwnershipByDetail(
            cand.id,
            accessToken,
            ownerIdentity,
            excludeIds,
            cand.allowParent
          );
          if (verified) addVerified(verified);
        })
      );
    }
    if (verifiedChannelsById.size === 0) {
      for (const baseEndpoint of [
        "https://api.picta.cu/v3/channel/",
        "https://api.picta.cu/v1/canal/"
      ]) {
        const firstRes = await fetchPictaWithRetry(
          `${baseEndpoint}?page=1&page_size=100`,
          { headers: authHeaders },
          2
        ).catch(() => null);
        if (!firstRes || !firstRes.ok) continue;
        const firstData = await firstRes.json().catch(() => null);
        if (!firstData) continue;
        const firstList = Array.isArray(firstData) ? firstData : firstData.results || [];
        let sawOwnershipMetadata = false;
        const processPageList = (list) => {
          for (const item of list) {
            if (!item || typeof item !== "object") continue;
            const owned = isChannelOwnedOrAssociatedByUser(item, ownerIdentity);
            if (owned !== null) sawOwnershipMetadata = true;
            if (owned === true) {
              for (const ch of extractChannelsFromPictaRecords([item], excludeIds, ownerIdentity)) {
                addVerified(ch);
              }
            }
          }
        };
        if (Array.isArray(firstList)) {
          processPageList(firstList);
        }
        if (verifiedChannelsById.size > 0) break;
        const totalCount = Number(firstData.count || 0);
        const totalPages = totalCount > 100 ? Math.min(15, Math.ceil(totalCount / 100)) : firstData.next ? 10 : 1;
        if (totalPages > 1 && sawOwnershipMetadata) {
          const remainingPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
          for (let i = 0; i < remainingPages.length; i += 4) {
            const batchPages = remainingPages.slice(i, i + 4);
            const batchPayloads = await Promise.all(
              batchPages.map(async (p) => {
                try {
                  const r = await fetchPictaWithRetry(
                    `${baseEndpoint}?page=${p}&page_size=100`,
                    { headers: authHeaders },
                    2
                  );
                  if (!r.ok) return null;
                  return await r.json().catch(() => null);
                } catch {
                  return null;
                }
              })
            );
            let hitEnd = false;
            for (const pData of batchPayloads) {
              if (!pData) continue;
              const pList = Array.isArray(pData) ? pData : pData.results || [];
              if (!Array.isArray(pList) || pList.length === 0) {
                hitEnd = true;
                continue;
              }
              processPageList(pList);
            }
            if (verifiedChannelsById.size > 0 || hitEnd) break;
          }
        }
        if (verifiedChannelsById.size > 0) break;
      }
    }
  }
  return Array.from(verifiedChannelsById.values());
}
async function ensureGuestSessionChannelDiscovered(chatId, forceRefresh = false) {
  const session = userSessions.get(chatId);
  if (!session || isMasterAdminChat(chatId)) return session;
  if (!forceRefresh && session.channelId && session.verifiedChannelOwnership && session.hasChannelAdminRole !== void 0) {
    return session;
  }
  const lastTry = lastAutoDiscoveryAttemptByChat.get(chatId) || 0;
  if (!forceRefresh && Date.now() - lastTry < 6e4) {
    return session;
  }
  lastAutoDiscoveryAttemptByChat.set(chatId, Date.now());
  try {
    const token = session.tokenExpiresAt > Date.now() + 6e4 ? session.authToken : await refreshUserPictaSession(chatId);
    if (!token) return session;
    let profileObj = null;
    if (!session.userId || forceRefresh || session.hasChannelAdminRole === void 0) {
      profileObj = await fetchDecryptedPictaMe2(token);
      if (profileObj?.id) {
        session.userId = Number(profileObj.id);
        const fullName = `${profileObj.first_name || ""} ${profileObj.last_name || ""}`.trim();
        if (fullName) session.userFullName = fullName;
        const grp = extractPictaGroupSummary(profileObj);
        session.pictaGroups = grp.groupNames;
        session.hasChannelAdminRole = grp.hasChannelAdminRole;
      }
    }
    const discovered = await discoverUserPictaChannels(
      token,
      session.username,
      session.userFullName || session.username,
      session.userId,
      false,
      profileObj
    );
    if (discovered.length > 0) {
      session.availableChannels = discovered;
      if (!session.channelId || !discovered.some((d) => String(d.id) === String(session.channelId))) {
        session.channelId = String(discovered[0].id);
        session.channelName = discovered[0].nombre;
      }
      session.verifiedChannelOwnership = true;
    }
    session.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    saveUserSessionsToDisk();
  } catch {
  }
  return session;
}
async function performUserPictaLogin(chatId, rawUsername, rawPassword) {
  const formattedUsername = rawUsername.replace(/\D/g, "").length === 8 ? `+53${rawUsername.replace(/\D/g, "")}` : rawUsername.trim();
  const form = new FormData();
  form.append("username", formattedUsername);
  form.append("password", rawPassword.trim());
  form.append("grant_type", "password");
  form.append("client_id", botConfig.pictaClientId || PICTA_OFFICIAL_CLIENT_ID);
  try {
    const tokenRes = await fetchPictaWithRetry("https://api.picta.cu/o/token/", {
      method: "POST",
      headers: {
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      },
      body: form
    });
    if (!tokenRes.ok) {
      return {
        success: false,
        message: "No se pudo autenticar en Picta. Por favor verifica que tu usuario (o tel\xE9fono +53...) y contrase\xF1a sean correctos."
      };
    }
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return { success: false, message: "Picta no devolvi\xF3 un token de acceso v\xE1lido." };
    }
    const userProfileObj = await fetchDecryptedPictaMe2(accessToken);
    const userId = userProfileObj?.id ? Number(userProfileObj.id) : void 0;
    const groupSummary = extractPictaGroupSummary(userProfileObj);
    const userFullName = userProfileObj && `${userProfileObj.first_name || ""} ${userProfileObj.last_name || ""}`.trim() || userProfileObj?.username || formattedUsername;
    const isMaster = isMasterAdminChat(chatId);
    const masterDefaultChanId = botConfig.pictaChannelId || "36319";
    const channels = await discoverUserPictaChannels(
      accessToken,
      formattedUsername,
      userFullName,
      userId,
      isMaster,
      userProfileObj
    );
    if (isMaster && !channels.some((x) => String(x.id) === String(masterDefaultChanId))) {
      try {
        const chkRes = await fetchPictaWithRetry(
          `https://api.picta.cu/v1/canal/${masterDefaultChanId}/`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Origin: "https://admin.picta.cu",
              Referer: "https://admin.picta.cu/"
            }
          }
        );
        if (chkRes.ok) {
          const chanData = await chkRes.json();
          channels.unshift({
            id: Number(masterDefaultChanId),
            nombre: String(chanData?.nombre || "Multiverso Visual"),
            alias: chanData?.alias ? String(chanData.alias) : void 0
          });
        }
      } catch {
      }
    }
    const selectedChannel = channels.length > 0 ? channels[0] : isMaster ? { id: Number(masterDefaultChanId), nombre: "Multiverso Visual" } : { id: 0, nombre: "Sin canal asignado" };
    if (selectedChannel.id > 0 && !channels.some((x) => x.id === selectedChannel.id)) {
      channels.unshift(selectedChannel);
    }
    const hasChan = selectedChannel.id > 0;
    addLiveLog(
      "picta",
      hasChan ? "success" : "warn",
      `Login Picta chat ${chatId} (userId=${userId || "N/A"}, grupos=[${groupSummary.groupNames.join(", ")}]): ${channels.length} canal(es) propio(s) detectado(s).`
    );
    const newSession = {
      chatId,
      username: formattedUsername,
      password: rawPassword.trim(),
      authToken: accessToken,
      tokenExpiresAt: Date.now() + (Number(tokenData.expires_in) || 14400) * 1e3,
      userId,
      userFullName,
      channelId: hasChan ? String(selectedChannel.id) : "",
      channelName: selectedChannel.nombre,
      availableChannels: channels,
      verifiedChannelOwnership: hasChan,
      pictaGroups: groupSummary.groupNames,
      hasChannelAdminRole: groupSummary.hasChannelAdminRole,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    userSessions.set(chatId, newSession);
    saveUserSessionsToDisk();
    const roleWarn = !groupSummary.hasChannelAdminRole && groupSummary.groupNames.length > 0 ? `

${buildPictaRoleDiagnosticLines({
      username: String(userProfileObj?.username || formattedUsername),
      groupNames: groupSummary.groupNames,
      hasChannelAdminRole: groupSummary.hasChannelAdminRole,
      channelName: hasChan ? selectedChannel.nombre : void 0,
      channelId: hasChan ? String(selectedChannel.id) : void 0
    })}` : "";
    return {
      success: true,
      message: (hasChan ? `\xA1Sesi\xF3n iniciada con \xE9xito en Picta!
\u{1F4FA} Canal propio detectado autom\xE1ticamente: <b>${escapeHtml(selectedChannel.nombre)}</b> (<code>#${selectedChannel.id}</code>)` + (channels.length > 1 ? `

<i>Tambi\xE9n tienes ${channels.length - 1} canal(es) propio(s) adicional(es). Usa /canales si quieres cambiar entre los tuyos.</i>` : "") : `\xA1Sesi\xF3n iniciada con \xE9xito en Picta!

\u26A0\uFE0F Tu cuenta a\xFAn no report\xF3 ning\xFAn canal aprobado o asignado en <code>admin.picta.cu</code>.
Si ya tienes un canal aprobado y conoces su enlace, puedes vincularlo directo con:
<code>/canal https://www.picta.cu/canal/tu-canal</code>`) + roleWarn,
      session: newSession
    };
  } catch (err) {
    return {
      success: false,
      message: `Error de conexi\xF3n con Picta: ${err?.message || "Error de red"}`
    };
  }
}
async function findPictaChannel(rawQuery, authToken, chatId) {
  const query = rawQuery.trim();
  if (!query) return [];
  const isMaster = isMasterAdminChat(chatId);
  const masterChanId = String(botConfig.pictaChannelId || "36319");
  const excludeIds = isMaster ? /* @__PURE__ */ new Set() : /* @__PURE__ */ new Set([masterChanId]);
  const session = chatId ? userSessions.get(chatId) : void 0;
  let userId = session?.userId;
  let meObj = null;
  if (!isMaster && (!userId || !session?.username)) {
    meObj = await fetchDecryptedPictaMe2(authToken);
    if (meObj?.id) {
      userId = Number(meObj.id);
      if (session) {
        session.userId = userId;
        saveUserSessionsToDisk();
      }
    }
  }
  const ownerIdentity = {
    ...userId && userId > 0 ? { userId } : {},
    ...session?.username ? { username: session.username, phone: session.username } : {},
    ...meObj?.username ? { username: String(meObj.username) } : {},
    ...meObj?.phone_number ? { phone: String(meObj.phone_number) } : {},
    ...meObj?.email ? { email: String(meObj.email) } : {}
  };
  const cleanedUrlQuery = query.split(/[?#]/)[0];
  const urlMatch = cleanedUrlQuery.match(
    /(?:canal|canales|channel|channels)\/(?:edit\/)?([a-zA-Z0-9_\-]+)/i
  );
  const effectiveQuery = (urlMatch ? urlMatch[1] : query).trim();
  if (/^\d+$/.test(effectiveQuery)) {
    if (!isMaster && effectiveQuery === masterChanId) {
      return [];
    }
    if (isMaster) {
      try {
        const res = await fetchPictaWithRetry(`https://api.picta.cu/v1/canal/${effectiveQuery}/`, {
          headers: {
            Authorization: `Bearer ${authToken}`,
            Origin: "https://admin.picta.cu",
            Referer: "https://admin.picta.cu/"
          }
        });
        if (res.ok) {
          const data = await res.json();
          return [
            {
              id: Number(effectiveQuery),
              nombre: String(data?.nombre || `Canal #${effectiveQuery}`),
              alias: data?.alias ? String(data.alias) : void 0,
              slug_url: data?.slug_url ? String(data.slug_url) : void 0
            }
          ];
        }
      } catch {
      }
    } else {
      const verified = await verifyChannelOwnershipByDetail(
        Number(effectiveQuery),
        authToken,
        ownerIdentity,
        excludeIds
      );
      return verified ? [verified] : [];
    }
  }
  let ownedChannels = session?.availableChannels || [];
  if (!isMaster && ownedChannels.length === 0 && session) {
    ownedChannels = await discoverUserPictaChannels(
      authToken,
      session.username,
      session.userFullName || session.username,
      userId,
      false,
      meObj
    );
    if (ownedChannels.length > 0) {
      session.availableChannels = ownedChannels;
      if (!session.channelId) {
        session.channelId = String(ownedChannels[0].id);
        session.channelName = ownedChannels[0].nombre;
        session.verifiedChannelOwnership = true;
      }
      saveUserSessionsToDisk();
    }
  }
  const ownedMatches = filterMatchingOwnedChannels(
    ownedChannels,
    effectiveQuery,
    ownerIdentity,
    excludeIds,
    true
  );
  if (ownedMatches.length > 0) {
    return ownedMatches;
  }
  const searchEndpoints = [
    `https://api.picta.cu/v1/canal/?slug_url=${encodeURIComponent(effectiveQuery)}`,
    `https://api.picta.cu/v3/channel/?slug_url=${encodeURIComponent(effectiveQuery)}`,
    `https://api.picta.cu/v1/canal/?search=${encodeURIComponent(effectiveQuery)}&page_size=20`,
    `https://api.picta.cu/v3/channel/?search=${encodeURIComponent(effectiveQuery)}&page_size=20`,
    `https://api.picta.cu/v2/canal/?search=${encodeURIComponent(effectiveQuery)}&page_size=20`
  ];
  const verifiedMatchesById = /* @__PURE__ */ new Map();
  const rawCandidates = [];
  await Promise.all(
    searchEndpoints.map(async (ep) => {
      try {
        const res = await fetchPictaWithRetry(ep, {
          headers: {
            Authorization: `Bearer ${authToken}`,
            Origin: "https://admin.picta.cu",
            Referer: "https://admin.picta.cu/"
          }
        });
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (!data) return;
        const list = data.results || (Array.isArray(data) ? data : []);
        const matches = filterMatchingOwnedChannels(
          list,
          effectiveQuery,
          isMaster ? void 0 : ownerIdentity,
          excludeIds,
          true
        );
        for (const m of matches) {
          rawCandidates.push(m);
        }
      } catch {
      }
    })
  );
  const uniqueIds = Array.from(new Set(rawCandidates.map((c) => c.id))).slice(0, 6);
  for (const candId of uniqueIds) {
    const cand = rawCandidates.find((c) => c.id === candId);
    if (isMaster) {
      verifiedMatchesById.set(candId, cand);
    } else {
      const verified = await verifyChannelOwnershipByDetail(
        candId,
        authToken,
        ownerIdentity,
        excludeIds
      );
      if (verified) verifiedMatchesById.set(candId, verified);
    }
  }
  return Array.from(verifiedMatchesById.values());
}
var PICTA_TMDB_API_KEY = "02b60a5f22f7a8f94cd9500a494f98e8";
async function translateTextToSpanishIfNeeded(rawText) {
  const clean = String(rawText || "").trim();
  if (!clean) return "";
  if (!isLikelyEnglishText(clean)) return clean;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=es&dt=t&q=${encodeURIComponent(
      clean
    )}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.[0])) {
        const translated = data[0].map((seg) => Array.isArray(seg) ? String(seg[0] || "") : "").join("").trim();
        if (translated && !isLikelyEnglishText(translated)) {
          return translated;
        }
      }
    }
  } catch {
  }
  return "";
}
async function fetchJsonWithTimeout(url, init, timeoutMs = 5500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init || {}, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function fetchTmdbDetailsForId(mediaType, tmdbId, fallbackTitle, effectiveSeason = 0, effectiveEp = 0) {
  const d = await fetchJsonWithTimeout(
    `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${PICTA_TMDB_API_KEY}&language=es-MX&append_to_response=credits,external_ids`
  );
  if (!d) return {};
  let overviewEs = String(d.overview || "").trim();
  if (!overviewEs || isLikelyEnglishText(overviewEs)) {
    const dEs = await fetchJsonWithTimeout(
      `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${PICTA_TMDB_API_KEY}&language=es-ES`
    );
    if (dEs?.overview && !isLikelyEnglishText(String(dEs.overview))) {
      overviewEs = String(dEs.overview).trim();
    } else if (!overviewEs && dEs?.overview) {
      overviewEs = String(dEs.overview).trim();
    }
  }
  if (!overviewEs) {
    const dEn = await fetchJsonWithTimeout(
      `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${PICTA_TMDB_API_KEY}&language=en-US`
    );
    if (dEn?.overview) overviewEs = String(dEn.overview).trim();
  }
  overviewEs = await translateTextToSpanishIfNeeded(overviewEs);
  const yr = String(d.first_air_date || d.release_date || "").slice(0, 4);
  const genres = Array.isArray(d.genres) ? d.genres.map((g) => g.name).filter(Boolean).join(", ") : "";
  const country = Array.isArray(d.production_countries) && d.production_countries[0]?.name ? String(d.production_countries[0].name) : Array.isArray(d.origin_country) && d.origin_country[0] ? String(d.origin_country[0]) : "";
  const studio = Array.isArray(d.production_companies) && d.production_companies[0]?.name ? String(d.production_companies[0].name) : Array.isArray(d.networks) && d.networks[0]?.name ? String(d.networks[0].name) : "";
  const tmdbImgs = buildTmdbImageUrls(d.poster_path, d.backdrop_path);
  const posterUrl = tmdbImgs.imageUrl;
  const crew = Array.isArray(d.credits?.crew) ? d.credits.crew : [];
  const cast = Array.isArray(d.credits?.cast) ? d.credits.cast : [];
  const directors = crew.filter((c) => c.job === "Director" || c.department === "Directing").slice(0, 2).map((c) => c.name);
  const creators = Array.isArray(d.created_by) ? d.created_by.slice(0, 2).map((c) => c.name) : [];
  const writers = crew.filter((c) => c.department === "Writing").slice(0, 2).map((c) => c.name);
  const composers = crew.filter((c) => c.job?.includes("Music") || c.department === "Sound").slice(0, 1).map((c) => c.name);
  const dop = crew.filter((c) => c.job?.includes("Photography") || c.department === "Camera").slice(0, 1).map((c) => c.name);
  const topCast = cast.slice(0, 4).map((c) => c.name);
  let epTitleEs = "";
  let epSynopsisEs = "";
  if (mediaType === "tv" && effectiveSeason > 0 && effectiveEp > 0) {
    for (const lang of ["es-MX", "es-ES", "en-US"]) {
      const epData = await fetchJsonWithTimeout(
        `https://api.themoviedb.org/3/tv/${tmdbId}/season/${effectiveSeason}/episode/${effectiveEp}?api_key=${PICTA_TMDB_API_KEY}&language=${lang}`
      );
      if (epData) {
        if (!epTitleEs && epData?.name && !/^(?:Episodio|Episode)\s+\d+$/i.test(String(epData.name))) {
          epTitleEs = String(epData.name).trim();
        }
        if (!epSynopsisEs && epData?.overview) {
          const candSyn = await translateTextToSpanishIfNeeded(String(epData.overview));
          if (candSyn) {
            epSynopsisEs = candSyn;
            break;
          }
        }
      }
    }
  }
  const tmdbRating = Number(d.vote_average) > 0 ? Number(d.vote_average).toFixed(1) : "";
  return {
    title: String(d.name || d.title || fallbackTitle),
    originalTitle: String(d.original_name || d.original_title || d.name || d.title || fallbackTitle),
    ...yr ? { year: yr } : {},
    ...tmdbRating ? { rating: tmdbRating } : {},
    ...directors.length > 0 || creators.length > 0 ? { director: (directors.length > 0 ? directors : creators).join(", ") } : {},
    ...writers.length > 0 ? { guion: writers.join(", ") } : {},
    ...studio ? { productora: studio } : {},
    ...topCast.length > 0 ? { reparto: topCast.join(", ") } : {},
    ...country ? { pais: country } : {},
    ...genres ? { genero: genres } : {},
    ...composers.length > 0 ? { musica: composers.join(", ") } : {},
    ...dop.length > 0 ? { fotografia: dop.join(", ") } : {},
    ...overviewEs ? { synopsis: overviewEs } : {},
    ...epSynopsisEs ? { episodeSynopsis: epSynopsisEs } : {},
    ...epTitleEs ? { episodeTitle: epTitleEs } : {},
    ...posterUrl ? { imageUrl: posterUrl } : {},
    ...tmdbImgs.posterUrl ? { posterUrl: tmdbImgs.posterUrl } : {},
    ...tmdbImgs.backdropUrl ? { backdropUrl: tmdbImgs.backdropUrl } : {},
    found: true
  };
}
async function searchMediaCandidatesOnline(rawQuery, tipId, seasonNum, epNum) {
  const seExtract = parseSingleSeriesCandidate(rawQuery);
  const effectiveSeason = Number(seasonNum || (seExtract.hasExplicitNumbers ? seExtract.temporada : 0));
  const effectiveEp = Number(epNum || (seExtract.hasExplicitNumbers ? seExtract.numero : 0));
  const titleAnalysis = cleanMediaTitleForSearch(rawQuery);
  const cleanQuery = titleAnalysis.cleanQuery;
  const releaseYear = titleAnalysis.year;
  const simplified = titleAnalysis.simplifiedTitle;
  if (!cleanQuery || cleanQuery.length < 1 || isRandomOrCrypticFilename(cleanQuery)) {
    return {
      disambiguation: { confidentWinner: null, topCandidates: [], needsDisambiguation: false },
      cleanQuery,
      releaseYear,
      effectiveSeason,
      effectiveEp
    };
  }
  const isExplicitSerie = tipId === 5 || seExtract.hasExplicitNumbers;
  const isExplicitMovie = tipId === 1 && !seExtract.hasExplicitNumbers;
  const primaryEndpoint = isExplicitSerie ? "tv" : isExplicitMovie ? "movie" : "multi";
  const queryVariants = [];
  const seenQueries = /* @__PURE__ */ new Set();
  const pushQuery = (q, yr) => {
    const t = String(q || "").trim();
    if (!t || t.length < 1) return;
    const key = `${t.toLowerCase()}::${yr || ""}`;
    if (seenQueries.has(key)) return;
    seenQueries.add(key);
    queryVariants.push({ q: t, year: yr });
  };
  if (titleAnalysis.subtitleQuery && titleAnalysis.subtitleQuery.length >= 3 && !/^\s*episodio\s*[ivx0-9]+\s*$/i.test(titleAnalysis.subtitleQuery)) {
    if (titleAnalysis.franchise && titleAnalysis.franchise.length >= 3) {
      pushQuery(`${titleAnalysis.franchise} ${titleAnalysis.subtitleQuery}`, isExplicitSerie ? void 0 : releaseYear);
    }
    pushQuery(titleAnalysis.subtitleQuery, isExplicitSerie ? void 0 : releaseYear);
  }
  pushQuery(cleanQuery, isExplicitSerie ? void 0 : releaseYear);
  if (releaseYear) pushQuery(cleanQuery, void 0);
  const deAccented = cleanQuery.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (deAccented.toLowerCase() !== cleanQuery.toLowerCase()) {
    pushQuery(deAccented, void 0);
  }
  if (simplified && simplified.length >= 4 && !/^(star|guerra|movie|film|el|la|los|the)$/i.test(simplified) && simplified.toLowerCase() !== cleanQuery.toLowerCase()) {
    pushQuery(simplified, isExplicitSerie ? void 0 : releaseYear);
  }
  const collected = [];
  const collectTmdbItems = (items, defaultType) => {
    for (const item of items) {
      const mType = item.media_type === "tv" || item.media_type === "movie" ? item.media_type : defaultType;
      if (item.media_type === "person") continue;
      const candTitle = String(item.name || item.title || "").trim();
      const candOriginal = String(item.original_name || item.original_title || candTitle).trim();
      const candYear = String(item.first_air_date || item.release_date || "").slice(0, 4);
      if (!candTitle) continue;
      let score = scoreCandidateMatch(
        cleanQuery,
        candTitle,
        candOriginal,
        candYear,
        releaseYear,
        titleAnalysis.subtitleQuery,
        Number(item.popularity || 0)
      );
      if (isExplicitSerie && mType === "tv") score += 8;
      if (isExplicitMovie && mType === "movie") score += 8;
      const imgs = buildTmdbImageUrls(item.poster_path, item.backdrop_path);
      collected.push({
        id: `tmdb:${mType}:${item.id}`,
        source: "tmdb",
        mediaType: mType,
        tmdbId: Number(item.id),
        title: candTitle,
        originalTitle: candOriginal,
        year: candYear || void 0,
        overview: String(item.overview || "").trim() || void 0,
        posterUrl: imgs.posterUrl || void 0,
        backdropUrl: imgs.backdropUrl || void 0,
        popularity: Number(item.popularity || 0),
        score
      });
    }
  };
  const primaryAttempt = queryVariants[0] || { q: cleanQuery, year: releaseYear };
  const tmdbUrls = [
    {
      url: `https://api.themoviedb.org/3/search/${primaryEndpoint}?api_key=${PICTA_TMDB_API_KEY}&language=es-MX&query=${encodeURIComponent(primaryAttempt.q)}&page=1` + (primaryAttempt.year && primaryEndpoint === "movie" ? `&primary_release_year=${encodeURIComponent(primaryAttempt.year)}` : ""),
      defType: primaryEndpoint === "tv" ? "tv" : "movie"
    },
    {
      url: `https://api.themoviedb.org/3/search/${primaryEndpoint}?api_key=${PICTA_TMDB_API_KEY}&language=en-US&query=${encodeURIComponent(cleanQuery)}&page=1`,
      defType: primaryEndpoint === "tv" ? "tv" : "movie"
    }
  ];
  if (primaryAttempt.year && primaryEndpoint === "movie") {
    tmdbUrls.push({
      url: `https://api.themoviedb.org/3/search/movie?api_key=${PICTA_TMDB_API_KEY}&language=es-ES&query=${encodeURIComponent(cleanQuery)}&page=1`,
      defType: "movie"
    });
  }
  const imdbQueryClean = cleanQuery.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const imdbUrl = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(imdbQueryClean || cleanQuery)}.json`;
  const [tmdbResList, imdbData] = await Promise.all([
    Promise.all(
      tmdbUrls.map(async (entry) => ({
        defType: entry.defType,
        data: await fetchJsonWithTimeout(entry.url, void 0, 5e3)
      }))
    ),
    fetchJsonWithTimeout(
      imdbUrl,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; PictaBot/2.0)" } },
      5e3
    )
  ]);
  for (const r of tmdbResList) {
    if (Array.isArray(r.data?.results)) {
      collectTmdbItems(r.data.results, r.defType);
    }
  }
  const currentMaxScore = collected.reduce((m, c) => Math.max(m, c.score), -999);
  if (currentMaxScore < 45 && queryVariants.length > 1) {
    for (const attempt of queryVariants.slice(1, 4)) {
      const url = `https://api.themoviedb.org/3/search/${primaryEndpoint}?api_key=${PICTA_TMDB_API_KEY}&language=es-MX&query=${encodeURIComponent(attempt.q)}&page=1`;
      const extraData = await fetchJsonWithTimeout(url, void 0, 4500);
      if (Array.isArray(extraData?.results)) {
        collectTmdbItems(extraData.results, primaryEndpoint === "tv" ? "tv" : "movie");
      }
    }
  }
  if (collected.filter((c) => c.score >= 25).length === 0 && primaryEndpoint !== "multi") {
    const multiData = await fetchJsonWithTimeout(
      `https://api.themoviedb.org/3/search/multi?api_key=${PICTA_TMDB_API_KEY}&language=es-MX&query=${encodeURIComponent(cleanQuery)}&page=1`,
      void 0,
      4500
    );
    if (Array.isArray(multiData?.results)) {
      collectTmdbItems(multiData.results, "movie");
    }
  }
  const rawImdbItems = Array.isArray(imdbData?.d) ? imdbData.d : [];
  const validImdbItems = rawImdbItems.filter(
    (it) => it && typeof it.id === "string" && it.id.startsWith("tt") && ["movie", "tvSeries", "tvMiniSeries", "tvMovie", "feature"].includes(String(it.qid || ""))
  ).slice(0, 6);
  if (validImdbItems.length > 0) {
    const scoredImdb = validImdbItems.map((it) => {
      const mType = it.qid === "tvSeries" || it.qid === "tvMiniSeries" ? "tv" : "movie";
      const yr = it.y ? String(it.y) : void 0;
      let sc = scoreCandidateMatch(
        cleanQuery,
        String(it.l || ""),
        String(it.l || ""),
        yr,
        releaseYear,
        titleAnalysis.subtitleQuery,
        it.rank ? Math.max(5, 80 / Math.log10(Number(it.rank) + 10)) : 12
      );
      if (isExplicitSerie && mType === "tv") sc += 8;
      if (isExplicitMovie && mType === "movie") sc += 8;
      return { it, mType, yr, sc };
    }).filter((x) => x.sc >= 15).sort((a, b) => b.sc - a.sc).slice(0, 3);
    await Promise.all(
      scoredImdb.map(async ({ it, mType, yr, sc }) => {
        const imdbId = String(it.id);
        const findData = await fetchJsonWithTimeout(
          `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${PICTA_TMDB_API_KEY}&external_source=imdb_id&language=es-MX`,
          void 0,
          4500
        );
        const movieMatch = Array.isArray(findData?.movie_results) ? findData.movie_results[0] : null;
        const tvMatch = Array.isArray(findData?.tv_results) ? findData.tv_results[0] : null;
        const resolved = mType === "tv" ? tvMatch || movieMatch : movieMatch || tvMatch;
        if (resolved && resolved.id) {
          const resolvedType = tvMatch && resolved === tvMatch ? "tv" : "movie";
          const candTitle = String(resolved.name || resolved.title || it.l || "").trim();
          const candOrig = String(resolved.original_name || resolved.original_title || it.l || candTitle).trim();
          const candYr = String(resolved.first_air_date || resolved.release_date || yr || "").slice(0, 4);
          const imgs = buildTmdbImageUrls(resolved.poster_path, resolved.backdrop_path);
          let bridgeScore = scoreCandidateMatch(
            cleanQuery,
            candTitle,
            candOrig,
            candYr,
            releaseYear,
            titleAnalysis.subtitleQuery,
            Number(resolved.popularity || 15)
          );
          if (isExplicitSerie && resolvedType === "tv") bridgeScore += 8;
          if (isExplicitMovie && resolvedType === "movie") bridgeScore += 8;
          collected.push({
            id: `tmdb:${resolvedType}:${resolved.id}`,
            source: "tmdb",
            mediaType: resolvedType,
            tmdbId: Number(resolved.id),
            imdbId,
            title: candTitle,
            originalTitle: candOrig,
            year: candYr || void 0,
            overview: String(resolved.overview || "").trim() || void 0,
            posterUrl: imgs.posterUrl || it.i?.imageUrl || void 0,
            backdropUrl: imgs.backdropUrl || void 0,
            popularity: Number(resolved.popularity || 15),
            score: Math.max(bridgeScore, sc) + 4
          });
        } else {
          collected.push({
            id: `imdb:${mType}:${imdbId}`,
            source: "imdb",
            mediaType: mType,
            imdbId,
            title: String(it.l || "").trim(),
            originalTitle: String(it.l || "").trim(),
            year: yr,
            posterUrl: typeof it.i?.imageUrl === "string" ? it.i.imageUrl : void 0,
            popularity: 10,
            score: sc
          });
        }
      })
    );
  }
  const disambiguation = decideBestOrTop3Candidates(cleanQuery, collected, releaseYear);
  return {
    disambiguation,
    cleanQuery,
    releaseYear,
    effectiveSeason,
    effectiveEp
  };
}
async function fetchOnlineMediaDetailsByCandidate(cand, effectiveSeason = 0, effectiveEp = 0) {
  if (cand.tmdbId) {
    const details = await fetchTmdbDetailsForId(
      cand.mediaType,
      cand.tmdbId,
      cand.title,
      effectiveSeason,
      effectiveEp
    );
    if (details.found) {
      return {
        title: details.title || cand.title,
        originalTitle: details.originalTitle || cand.originalTitle || cand.title,
        year: details.year || cand.year,
        rating: details.rating,
        director: details.director,
        guion: details.guion,
        productora: details.productora,
        reparto: details.reparto,
        pais: details.pais,
        genero: details.genero,
        musica: details.musica,
        fotografia: details.fotografia,
        synopsis: details.synopsis || "",
        episodeSynopsis: details.episodeSynopsis,
        episodeTitle: details.episodeTitle,
        imageUrl: details.imageUrl || cand.posterUrl,
        posterUrl: details.posterUrl || cand.posterUrl,
        backdropUrl: details.backdropUrl || cand.backdropUrl,
        found: true
      };
    }
  }
  return {
    title: cand.title,
    originalTitle: cand.originalTitle || cand.title,
    ...cand.year ? { year: cand.year } : {},
    ...cand.overview ? { synopsis: await translateTextToSpanishIfNeeded(cand.overview) } : {},
    ...cand.posterUrl ? { imageUrl: cand.posterUrl, posterUrl: cand.posterUrl } : {},
    found: true
  };
}
async function searchMovieOrSeriesInfoOnline(rawQuery, tipId, seasonNum, epNum) {
  try {
    const discovery = await searchMediaCandidatesOnline(rawQuery, tipId, seasonNum, epNum);
    const { disambiguation, cleanQuery, effectiveSeason, effectiveEp } = discovery;
    if (!cleanQuery || cleanQuery.length < 1 || isRandomOrCrypticFilename(cleanQuery)) return null;
    let primaryInfo = {};
    const bestCand = disambiguation.confidentWinner || disambiguation.topCandidates[0] || null;
    if (bestCand) {
      const fetched = await fetchOnlineMediaDetailsByCandidate(bestCand, effectiveSeason, effectiveEp);
      if (fetched && fetched.found) {
        primaryInfo = fetched;
      }
    }
    let tvMazeInfo = {};
    if (!primaryInfo.found && (tipId === 5 || effectiveEp > 0)) {
      const tvm = await fetchJsonWithTimeout(
        `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(cleanQuery)}&embed=episodes`,
        { headers: { "User-Agent": "PictaBotCataloger/2.0 (multiversovisual.cuba@gmail.com)" } },
        4500
      );
      if (tvm && tvm.name && isTitleMatchStrict(cleanQuery, String(tvm.name), String(tvm.name))) {
        const rawSum = await translateTextToSpanishIfNeeded(
          String(tvm.summary || "").replace(/<[^>]+>/g, "").trim()
        );
        const yr = String(tvm.premiered || "").slice(0, 4);
        const genres = Array.isArray(tvm.genres) ? tvm.genres.join(", ") : "";
        const country = tvm.network?.country?.name || tvm.webChannel?.country?.name || "";
        const studio = tvm.network?.name || tvm.webChannel?.name || "";
        const img = String(tvm.image?.original || tvm.image?.medium || "").trim();
        let epSynopsis = "";
        let epTitle = "";
        const epList = tvm._embedded?.episodes;
        if (Array.isArray(epList) && effectiveSeason > 0 && effectiveEp > 0) {
          const epMatch = epList.find(
            (e) => Number(e.season) === effectiveSeason && Number(e.number) === effectiveEp
          );
          if (epMatch) {
            epTitle = String(epMatch.name || "").trim();
            epSynopsis = await translateTextToSpanishIfNeeded(
              String(epMatch.summary || "").replace(/<[^>]+>/g, "").trim()
            );
          }
        }
        const tvmRating = Number(tvm.rating?.average) > 0 ? Number(tvm.rating.average).toFixed(1) : "";
        tvMazeInfo = {
          title: String(tvm.name),
          originalTitle: String(tvm.name),
          ...yr ? { year: yr } : {},
          ...tvmRating ? { rating: tvmRating } : {},
          ...genres ? { genero: genres } : {},
          ...country ? { pais: country } : {},
          ...studio ? { productora: studio } : {},
          ...rawSum ? { synopsis: rawSum } : {},
          ...epSynopsis ? { episodeSynopsis: epSynopsis } : {},
          ...epTitle ? { episodeTitle: epTitle } : {},
          ...img ? { imageUrl: img, posterUrl: img } : {},
          found: true
        };
      }
    }
    const queryWikipedia = async (lang) => {
      try {
        const suffix = lang === "es" ? tipId === 1 && !/\b(pelicula|película|film|movie)\b/i.test(cleanQuery) ? " pel\xEDcula" : tipId === 5 && !/\b(serie|show|tv)\b/i.test(cleanQuery) ? " serie de televisi\xF3n" : "" : tipId === 1 ? " film" : tipId === 5 ? " TV series" : "";
        const searchQ = `${cleanQuery}${suffix}`.trim();
        const data = await fetchJsonWithTimeout(
          `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchQ)}&utf8=&format=json`,
          { headers: { "User-Agent": "PictaBotCataloger/2.0 (multiversovisual.cuba@gmail.com; film scraper)" } },
          4500
        );
        if (!data) return null;
        const hits = data.query?.search || [];
        const stripWikiTitle = (t) => String(t || "").replace(/\s*\(película.*?\)\s*$/i, "").replace(/\s*\(serie.*?\)\s*$/i, "").replace(/\s*\(.*?film.*?\)\s*$/i, "").replace(/\s*\(.*?series.*?\)\s*$/i, "").replace(/\s*\(.*?\)\s*$/, "").trim();
        const strictHits = hits.filter(
          (h) => isTitleMatchStrict(cleanQuery, stripWikiTitle(h.title))
        );
        const hit = strictHits.find(
          (h) => tipId === 1 ? /película|pelicula|film/i.test(h.title) : tipId === 5 ? /serie|series|television|televisión/i.test(h.title) : false
        ) || strictHits[0];
        if (!hit || !hit.pageid) return null;
        const pageId = hit.pageid;
        const dData = await fetchJsonWithTimeout(
          `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts|revisions|pageimages&exintro&explaintext&rvprop=content&rvsection=0&pithumbsize=1000&pageids=${pageId}&format=json`,
          { headers: { "User-Agent": "PictaBotCataloger/2.0 (multiversovisual.cuba@gmail.com; film scraper)" } },
          4500
        );
        const page = dData?.query?.pages?.[pageId];
        if (!page) return null;
        const extract = String(page.extract || "").trim();
        const wikitext = String(page.revisions?.[0]?.["*"] || "");
        const thumbUrl = String(page.thumbnail?.source || "").trim();
        const matchProp = (...names) => {
          for (const name of names) {
            const regex = new RegExp(`\\|\\s*${name}\\s*=\\s*([^\\n|]+)`, "i");
            const m = wikitext.match(regex);
            if (m && m[1]) {
              const cleaned = m[1].replace(/\{\{[^|]+\|/g, "").replace(/\}\}/g, "").replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, "$1").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\|/g, ", ").replace(/\s{2,}/g, " ").trim();
              if (cleaned) return cleaned;
            }
          }
          return "";
        };
        const cleanTitle = stripWikiTitle(hit.title);
        const origTitle = matchProp("t\xEDtulo original", "native_name") || cleanTitle;
        if (!isTitleMatchStrict(cleanQuery, cleanTitle, origTitle)) {
          return null;
        }
        const yearMatch = wikitext.match(/\b(19\d\d|20\d\d)\b/) || extract.match(/\b(19\d\d|20\d\d)\b/);
        const year = yearMatch ? yearMatch[1] : void 0;
        const director = matchProp("direcci\xF3n", "director", "creador", "creator", "created_by");
        const guion = matchProp("guion", "gui\xF3n", "screenplay", "writer");
        const productora = matchProp("productora", "estudio", "distribuci\xF3n", "studio", "network", "company");
        const protagonistas = matchProp("protagonistas", "reparto", "actores", "starring");
        const pais = matchProp("pa\xEDs", "pais", "country");
        const genero = matchProp("g\xE9nero", "genero", "genre");
        const musica = matchProp("m\xFAsica", "musica", "music", "composer");
        const fotografia = matchProp("fotograf\xEDa", "fotografia", "cinematography");
        const rawParagraph = extract.split("\n\n")[0]?.slice(0, 500) || "";
        const spanishSynopsis = lang === "es" ? rawParagraph : await translateTextToSpanishIfNeeded(rawParagraph);
        return {
          title: cleanTitle,
          originalTitle: origTitle,
          year,
          director,
          guion,
          productora,
          reparto: protagonistas,
          pais,
          genero,
          musica,
          fotografia,
          synopsis: spanishSynopsis,
          ...thumbUrl ? { imageUrl: thumbUrl } : {},
          found: true
        };
      } catch {
        return null;
      }
    };
    const wikiEs = !primaryInfo.found || !primaryInfo.synopsis ? await queryWikipedia("es") : null;
    const wikiEn = !primaryInfo.found && (!wikiEs || !wikiEs.synopsis) ? await queryWikipedia("en") : null;
    const wiki = wikiEs || wikiEn;
    if (!primaryInfo.found && !wiki && !tvMazeInfo.found) return null;
    return {
      title: primaryInfo.title || wikiEs?.title || tvMazeInfo.title || wikiEn?.title || cleanQuery,
      originalTitle: primaryInfo.originalTitle || tvMazeInfo.originalTitle || wiki?.originalTitle || cleanQuery,
      year: primaryInfo.year || wiki?.year || tvMazeInfo.year,
      rating: primaryInfo.rating || tvMazeInfo.rating,
      director: primaryInfo.director || wiki?.director || wikiEn?.director,
      guion: primaryInfo.guion || wiki?.guion || wikiEn?.guion,
      productora: primaryInfo.productora || wiki?.productora || tvMazeInfo.productora || wikiEn?.productora,
      reparto: primaryInfo.reparto || wiki?.reparto || wikiEn?.reparto,
      pais: primaryInfo.pais || wiki?.pais || tvMazeInfo.pais || wikiEn?.pais,
      genero: primaryInfo.genero || wiki?.genero || tvMazeInfo.genero || wikiEn?.genero,
      musica: primaryInfo.musica || wiki?.musica || wikiEn?.musica,
      fotografia: primaryInfo.fotografia || wiki?.fotografia || wikiEn?.fotografia,
      synopsis: primaryInfo.synopsis || wikiEs?.synopsis || tvMazeInfo.synopsis || wikiEn?.synopsis || "",
      episodeSynopsis: primaryInfo.episodeSynopsis || tvMazeInfo.episodeSynopsis,
      episodeTitle: primaryInfo.episodeTitle || tvMazeInfo.episodeTitle,
      imageUrl: primaryInfo.imageUrl || tvMazeInfo.imageUrl || wikiEs?.imageUrl || wikiEn?.imageUrl,
      ...primaryInfo.posterUrl || tvMazeInfo.posterUrl ? { posterUrl: primaryInfo.posterUrl || tvMazeInfo.posterUrl } : {},
      ...primaryInfo.backdropUrl ? { backdropUrl: primaryInfo.backdropUrl } : {},
      found: true
    };
  } catch {
    return null;
  }
}
function loadProcessedUpdatesFromDisk() {
  try {
    if (fs3.existsSync(PROCESSED_UPDATES_FILE)) {
      const parsed = JSON.parse(fs3.readFileSync(PROCESSED_UPDATES_FILE, "utf-8"));
      if (Array.isArray(parsed.updateIds)) {
        for (const id of parsed.updateIds) processedUpdateIds.add(Number(id));
      }
      if (Array.isArray(parsed.callbackIds)) {
        for (const id of parsed.callbackIds) processedCallbackIds.add(String(id));
      }
      if (Array.isArray(parsed.messageKeys)) {
        for (const k of parsed.messageKeys) processedMessageKeys.add(String(k));
      }
      if (typeof parsed.lastOffset === "number" && parsed.lastOffset > 0) {
        lastUpdateOffset = parsed.lastOffset;
      }
    }
  } catch {
  }
}
var processedUpdatesSaveTimer = null;
function flushProcessedUpdatesToDiskNow() {
  if (processedUpdatesSaveTimer) {
    clearTimeout(processedUpdatesSaveTimer);
    processedUpdatesSaveTimer = null;
  }
  try {
    const payload = {
      lastOffset: lastUpdateOffset,
      updateIds: Array.from(processedUpdateIds).slice(-500),
      callbackIds: Array.from(processedCallbackIds).slice(-500),
      messageKeys: Array.from(processedMessageKeys).slice(-500)
    };
    fs3.writeFileSync(PROCESSED_UPDATES_FILE, JSON.stringify(payload), "utf-8");
    mirrorFileToLegacyDataDir(PROCESSED_UPDATES_FILE);
  } catch {
  }
}
function saveProcessedUpdatesToDisk() {
  if (processedUpdatesSaveTimer) return;
  processedUpdatesSaveTimer = setTimeout(() => {
    flushProcessedUpdatesToDiskNow();
  }, 1500);
  if (typeof processedUpdatesSaveTimer.unref === "function") {
    processedUpdatesSaveTimer.unref();
  }
}
loadProcessedUpdatesFromDisk();
function addLiveLog(source, level, message) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    source,
    level,
    message
  };
  liveLogs.unshift(entry);
  if (liveLogs.length > 300) {
    liveLogs = liveLogs.slice(0, 300);
  }
}
function addMtprotoDiagLog(input) {
  const { skipLiveLog, ...rest } = input;
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    ...rest
  };
  mtprotoDiagLogs.unshift(entry);
  if (mtprotoDiagLogs.length > 150) {
    mtprotoDiagLogs = mtprotoDiagLogs.slice(0, 150);
  }
  if (!skipLiveLog) {
    addLiveLog("mtproto", input.level, input.message);
  }
}
function formatBytes(bytes) {
  if (bytes <= 0) return "0 B";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  return `${mb.toFixed(2)} MB`;
}
async function fetchPictaWithRetry(url, init, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
async function authenticateWithPicta(forceRefresh = false) {
  if (!forceRefresh && botConfig.pictaAuthToken && pictaTokenExpiresAt > Date.now() + 6e4) {
    return botConfig.pictaAuthToken;
  }
  const rawUser = botConfig.pictaUsername.trim();
  const rawPass = botConfig.pictaPassword.trim();
  const formattedUsername = /^\d{8}$/.test(rawUser) ? `+53${rawUser}` : /^53\d{8}$/.test(rawUser) ? `+${rawUser}` : rawUser;
  const form = new FormData();
  form.append("username", formattedUsername);
  form.append("password", rawPass);
  form.append("grant_type", "password");
  form.append("client_id", botConfig.pictaClientId || PICTA_OFFICIAL_CLIENT_ID);
  const tokenRes = await fetchPictaWithRetry("https://api.picta.cu/o/token/", {
    method: "POST",
    headers: {
      Origin: "https://admin.picta.cu",
      Referer: "https://admin.picta.cu/"
    },
    body: form
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(
      tokenData.error_description || tokenData.error || `Error HTTP ${tokenRes.status} al iniciar sesi\xF3n en Picta`
    );
  }
  const accessToken = tokenData.access_token;
  botConfig.pictaAuthToken = accessToken;
  pictaTokenExpiresAt = Date.now() + (Number(tokenData.expires_in) || 14400) * 1e3;
  if (!pictaUser) {
    void (async () => {
      try {
        const meRes = await fetchPictaWithRetry("https://api.picta.cu/v2/usuario/me2/", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Origin: "https://admin.picta.cu",
            Referer: "https://admin.picta.cu/"
          }
        });
        if (meRes.ok) {
          const encryptedText = (await meRes.text()).trim().replace(/^"|"$/g, "");
          const decipher = crypto.createDecipheriv(
            "aes-128-ecb",
            Buffer.from(PICTA_AES_KEY, "utf8"),
            null
          );
          let decrypted = decipher.update(encryptedText, "base64", "utf8");
          decrypted += decipher.final("utf8");
          const userObj = JSON.parse(decrypted);
          pictaUser = {
            id: userObj.id,
            username: userObj.username,
            firstName: userObj.first_name || "",
            lastName: userObj.last_name || "",
            phoneNumber: userObj.phone_number || formattedUsername,
            roles: (userObj.groups || []).map((g) => g.name)
          };
          addLiveLog(
            "picta",
            "success",
            `Sesi\xF3n activa en admin.picta.cu: @${pictaUser.username} (${pictaUser.firstName} ${pictaUser.lastName}) \xB7 Canal: Multiverso Visual (ID: 36319)`
          );
        }
      } catch {
      }
    })();
  }
  return accessToken;
}
var PICTA_OFFICIAL_GENRES = [
  { id: 5, nombre: "Acci\xF3n", keywords: ["accion", "acci\xF3n", "action"] },
  { id: 17, nombre: "Ciencia ficci\xF3n", keywords: ["ciencia ficcion", "ciencia ficci\xF3n", "sci-fi", "scifi", "ficcion"] },
  { id: 6, nombre: "Aventura", keywords: ["aventura", "adventure"] },
  { id: 12, nombre: "Drama", keywords: ["drama", "dram\xE1tico", "dramatico"] },
  { id: 11, nombre: "Comedia", keywords: ["comedia", "comedy", "humor"] },
  { id: 42, nombre: "Terror", keywords: ["terror", "horror", "miedo"] },
  { id: 19, nombre: "Animaci\xF3n", keywords: ["animacion", "animaci\xF3n", "animation", "dibujos", "animada"] },
  { id: 23, nombre: "Suspenso", keywords: ["suspenso", "thriller", "misterio"] },
  { id: 92, nombre: "Anime", keywords: ["anime", "manga", "otaku"] },
  { id: 26, nombre: "Fantas\xEDa", keywords: ["fantasia", "fantas\xEDa", "fantasy"] },
  { id: 14, nombre: "Crimen / Policial", keywords: ["crimen", "policial", "policiaco", "mafia"] },
  { id: 24, nombre: "Romance", keywords: ["romance", "romantica", "rom\xE1ntica", "amor"] },
  { id: 18, nombre: "Familiar", keywords: ["familiar", "infantil", "ni\xF1os", "kids"] },
  { id: 15, nombre: "B\xE9lico", keywords: ["belico", "b\xE9lico", "guerra", "war"] },
  { id: 10, nombre: "Documental", keywords: ["documental", "documentary"] },
  { id: 22, nombre: "Musical", keywords: ["musical", "musica", "m\xFAsica"] },
  { id: 20, nombre: "Hist\xF3rico", keywords: ["historico", "hist\xF3rico", "historia"] },
  { id: 28, nombre: "Western", keywords: ["western", "vaqueros"] }
];
function resolveGenreIds(input) {
  if (Array.isArray(input)) {
    const valid = input.map(Number).filter((n) => !isNaN(n) && n > 0);
    if (valid.length > 0) return valid;
  }
  if (typeof input === "number" && input > 0) {
    return [input];
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (/^\d+$/.test(trimmed)) {
      return [Number(trimmed)];
    }
    const lower = trimmed.toLowerCase();
    for (const g of PICTA_OFFICIAL_GENRES) {
      if (g.keywords.some((kw) => lower.includes(kw))) {
        return [g.id];
      }
    }
  }
  return [5];
}
async function resolvePersonaIds(token, names, defaultId = 1022) {
  const ids = [];
  for (const rawName of names) {
    const clean = rawName.trim();
    if (!clean || clean.length < 2) continue;
    try {
      const res = await fetch(`https://api.picta.cu/v2/persona/?search=${encodeURIComponent(clean)}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://admin.picta.cu",
          Referer: "https://admin.picta.cu/"
        }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.results && data.results.length > 0) {
          const exact = data.results.find((r) => r.nombre.trim().toLowerCase() === clean.toLowerCase());
          if (exact) {
            ids.push(exact.id);
            continue;
          }
          const partial = data.results.find((r) => r.nombre.toLowerCase().includes(clean.toLowerCase()));
          if (partial) {
            ids.push(partial.id);
            continue;
          }
          ids.push(data.results[0].id);
        }
      }
    } catch {
    }
  }
  if (ids.length === 0) {
    ids.push(defaultId);
  }
  return ids;
}
async function resolveProductoraId(token, name) {
  const clean = name.trim();
  if (clean && clean.length > 2) {
    try {
      const res = await fetch(`https://api.picta.cu/v2/extra/?tipo=productora&search=${encodeURIComponent(clean)}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://admin.picta.cu",
          Referer: "https://admin.picta.cu/"
        }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.results && data.results.length > 0) {
          const exact = data.results.find((r) => r.nombre.trim().toLowerCase() === clean.toLowerCase());
          if (exact) return exact.id;
          return data.results[0].id;
        }
      }
    } catch {
    }
  }
  return 679;
}
async function resolvePremioId(token, name) {
  const clean = (name || "").trim();
  if (clean && clean.length > 2 && !/^(ninguno|sin|no|none)$/i.test(clean)) {
    try {
      const res = await fetch(`https://api.picta.cu/v2/extra/?tipo=premio&search=${encodeURIComponent(clean)}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://admin.picta.cu",
          Referer: "https://admin.picta.cu/"
        }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.results && data.results.length > 0) {
          return data.results[0].id;
        }
      }
    } catch {
    }
  }
  return 469;
}
function formatPictaError(status, rawResponseText) {
  try {
    const json = JSON.parse(rawResponseText);
    if (Array.isArray(json?.error) && json.error.length > 0) {
      return `Error HTTP ${status} en Picta: ${json.error.join(", ")}`;
    }
    const detailsObj = json?.error?.details || json?.details || (typeof json === "object" && !json.detail && !json.message && !json.error ? json : null);
    if (detailsObj && typeof detailsObj === "object") {
      const lines = [];
      const summary = json?.error?.message || json?.message || "Error de validaci\xF3n en Picta";
      lines.push(`Error HTTP ${status} (${summary}):`);
      for (const [field, messages] of Object.entries(detailsObj)) {
        if (field === "error" || field === "code" || field === "message") continue;
        const msgText = Array.isArray(messages) ? messages.join(", ") : String(messages);
        lines.push(`\u2022 ${field}: ${msgText}`);
      }
      if (lines.length > 1) {
        return lines.join("\n");
      }
    }
    if (json?.detail) {
      return `Error HTTP ${status}: ${json.detail}`;
    }
    if (json?.error?.message) {
      return `Error HTTP ${status}: ${json.error.message}`;
    }
  } catch {
  }
  return `Error HTTP ${status}: ${rawResponseText}`;
}
var CHANNEL_SERIES_FILE = path3.join(STATE_DIR, "channel_series.json");
var DEFAULT_MENTALISTA_SERIE = {
  pelser_id: 4054,
  nombre: "El Mentalista",
  canal_id: 36319,
  coverUrl: "https://www.picta.cu/imagen/poster_L6utIgf.jpeg",
  seasons: [{ id: 2772, numero: 1, nombre: "Temporada 1" }],
  chapters: [
    {
      pubId: 63695,
      numero: 1,
      temporada: 1,
      temporadaId: 2772,
      nombre: "El Mentalista - T1:E01 - Pilot | Piloto",
      descripcion: 'Cap\xEDtulo 1 de la Temporada 1 de la serie El Mentalista titulado "Pilot | Piloto", disponible en el canal Multiverso Visual.',
      publicado: true,
      convertido: true,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    },
    {
      pubId: 63696,
      numero: 2,
      temporada: 1,
      temporadaId: 2772,
      nombre: "El Mentalista - T1:E02 - Red Hair And Silver Tape | Pelo rojo y cinta plateada",
      descripcion: 'Cap\xEDtulo 2 de la Temporada 1 de la serie El Mentalista titulado "Red Hair And Silver Tape | Pelo rojo y cinta plateada", disponible en el canal Multiverso Visual.',
      publicado: true,
      convertido: true,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    },
    {
      pubId: 63697,
      numero: 3,
      temporada: 1,
      temporadaId: 2772,
      nombre: "El Mentalista - T1:E03 - Red Tide | Pacto rojo",
      descripcion: 'Cap\xEDtulo 3 de la Temporada 1 de la serie El Mentalista titulado "Red Tide | Pacto rojo", disponible en el canal Multiverso Visual.',
      minioKey: "4684e7dea3084119b24c4d08f8af0441",
      publicado: true,
      convertido: false,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    }
  ],
  updatedAt: (/* @__PURE__ */ new Date()).toISOString()
};
function loadChannelSeriesFromDisk() {
  try {
    if (fs3.existsSync(CHANNEL_SERIES_FILE)) {
      const parsed = JSON.parse(fs3.readFileSync(CHANNEL_SERIES_FILE, "utf-8"));
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {
  }
  return [DEFAULT_MENTALISTA_SERIE];
}
function saveChannelSeriesToDisk(list) {
  try {
    fs3.writeFileSync(CHANNEL_SERIES_FILE, JSON.stringify(list.slice(0, 100), null, 2), "utf-8");
    mirrorFileToLegacyDataDir(CHANNEL_SERIES_FILE);
  } catch {
  }
}
var channelSeriesCache = loadChannelSeriesFromDisk();
function upsertChannelSerieRecord(pelserId, nombre, season, extra, chapter) {
  const cleanName = cleanSerieDisplayName(nombre) || nombre.trim() || `Serie #${pelserId}`;
  const effectiveCanalId = Number(extra?.canalId || botConfig.pictaChannelId || 36319);
  let record = channelSeriesCache.find(
    (s) => Number(s.canal_id || 0) === effectiveCanalId && (pelserId > 0 && Number(s.pelser_id) === Number(pelserId) || cleanSerieDisplayName(s.nombre).toLowerCase() === cleanName.toLowerCase())
  );
  if (!record) {
    record = {
      pelser_id: Number(pelserId),
      nombre: cleanName,
      canal_id: effectiveCanalId,
      seasons: [],
      chapters: [],
      ...extra?.coverUrl ? { coverUrl: extra.coverUrl } : {},
      ...extra?.customCoverFileId ? { customCoverFileId: extra.customCoverFileId } : {},
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    channelSeriesCache.unshift(record);
  } else {
    if (pelserId > 0) record.pelser_id = Number(pelserId);
    record.canal_id = effectiveCanalId;
    if (cleanName && !isGenericOrInvalidSerieName(cleanName)) {
      record.nombre = cleanName;
    }
    if (!Array.isArray(record.chapters)) {
      record.chapters = [];
    }
    if (extra?.coverUrl) record.coverUrl = extra.coverUrl;
    if (extra?.customCoverFileId) record.customCoverFileId = extra.customCoverFileId;
    record.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  if (season && season.id > 0) {
    const existingSeason = record.seasons.find(
      (st) => Number(st.id) === Number(season.id) || Number(st.numero) === Number(season.numero)
    );
    if (existingSeason) {
      existingSeason.id = Number(season.id);
      existingSeason.numero = Number(season.numero);
      existingSeason.nombre = season.nombre || `Temporada ${season.numero}`;
    } else {
      record.seasons.push({
        id: Number(season.id),
        numero: Number(season.numero),
        nombre: season.nombre || `Temporada ${season.numero}`
      });
      record.seasons.sort((a, b) => a.numero - b.numero);
    }
  }
  if (chapter && chapter.pubId > 0) {
    if (!Array.isArray(record.chapters)) {
      record.chapters = [];
    }
    const existingCap = record.chapters.find(
      (c) => Number(c.pubId) === Number(chapter.pubId) || Number(c.temporada) === Number(chapter.temporada) && Number(c.numero) === Number(chapter.numero)
    );
    if (existingCap) {
      existingCap.pubId = Number(chapter.pubId);
      existingCap.numero = Number(chapter.numero || existingCap.numero || 1);
      existingCap.temporada = Number(chapter.temporada || existingCap.temporada || 1);
      if (chapter.temporadaId) existingCap.temporadaId = Number(chapter.temporadaId);
      if (chapter.nombre) existingCap.nombre = chapter.nombre;
      if (chapter.descripcion) existingCap.descripcion = sanitizePublicPictaText(chapter.descripcion);
      if (chapter.minioKey) existingCap.minioKey = chapter.minioKey;
      if (typeof chapter.publicado === "boolean") existingCap.publicado = chapter.publicado;
      if (typeof chapter.convertido === "boolean") existingCap.convertido = chapter.convertido;
      existingCap.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    } else {
      record.chapters.push({
        ...chapter,
        descripcion: chapter.descripcion ? sanitizePublicPictaText(chapter.descripcion) : void 0,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    record.chapters.sort(
      (a, b) => a.temporada !== b.temporada ? a.temporada - b.temporada : a.numero - b.numero
    );
  }
  saveChannelSeriesToDisk(channelSeriesCache);
  return record;
}
function findUserChannelSerie(pelserId, chatId) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const ctx = getEffectivePictaContext(effectiveChatId);
  if (!ctx.isLinked || !ctx.channelId) return void 0;
  const scoped = filterSeriesForChannel(
    channelSeriesCache,
    ctx.channelId,
    isMasterAdminChat(effectiveChatId),
    botConfig.pictaChannelId || "36319"
  );
  return scoped.find((s) => Number(s.pelser_id) === Number(pelserId));
}
function findUserChannelChapter(pubId, chatId) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const ctx = getEffectivePictaContext(effectiveChatId);
  if (!ctx.isLinked || !ctx.channelId) return void 0;
  const scoped = filterSeriesForChannel(
    channelSeriesCache,
    ctx.channelId,
    isMasterAdminChat(effectiveChatId),
    botConfig.pictaChannelId || "36319"
  );
  for (const s of scoped) {
    const ch = (s.chapters || []).find((c) => Number(c.pubId) === Number(pubId));
    if (ch) return { serie: s, chapter: ch };
  }
  return void 0;
}
function resolveSeriesStyleForChannel(chatId, pelserId, serieName) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const ctx = getEffectivePictaContext(effectiveChatId);
  const targetChId = ctx.channelId || "";
  const isMaster = isMasterAdminChat(effectiveChatId);
  const masterChanId = botConfig.pictaChannelId || "36319";
  const scoped = filterSeriesForChannel(channelSeriesCache, targetChId, isMaster, masterChanId);
  const normSerie = String(serieName || "").trim().toLowerCase();
  const matchedSerie = (pelserId && pelserId > 0 ? scoped.find((s) => Number(s.pelser_id) === Number(pelserId)) : void 0) || (normSerie ? scoped.find((s) => s.nombre.toLowerCase().trim() === normSerie) : void 0);
  const chapterTitles = [];
  if (matchedSerie && Array.isArray(matchedSerie.chapters)) {
    for (const ch of matchedSerie.chapters) {
      if (ch?.nombre && String(ch.nombre).trim()) {
        chapterTitles.push(String(ch.nombre).trim());
      }
    }
  }
  for (const j of transferJobs) {
    if (j.tipologiaId !== 5 || j.stage !== "completed") continue;
    if (!isMaster && j.telegramChatId !== effectiveChatId) continue;
    if (targetChId && j.targetChannelId && String(j.targetChannelId) !== String(targetChId)) continue;
    const jPelser = Number(j.modelMetadata?.serie_pelser_id || 0);
    const jSerieName = String(j.modelMetadata?.serie || "").toLowerCase().trim();
    const sameSerie = pelserId && pelserId > 0 && jPelser === Number(pelserId) || normSerie && jSerieName === normSerie;
    if (sameSerie && j.title && !chapterTitles.includes(j.title.trim())) {
      chapterTitles.push(j.title.trim());
    }
  }
  return detectDominantSeriesTitleStyle(
    chapterTitles,
    matchedSerie?.nombre || serieName
  );
}
for (const cap of DEFAULT_MENTALISTA_SERIE.chapters || []) {
  upsertChannelSerieRecord(
    DEFAULT_MENTALISTA_SERIE.pelser_id,
    DEFAULT_MENTALISTA_SERIE.nombre,
    DEFAULT_MENTALISTA_SERIE.seasons[0],
    { coverUrl: DEFAULT_MENTALISTA_SERIE.coverUrl, canalId: 36319 },
    cap
  );
}
async function syncAndGetChannelSeries(chatId) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const isMaster = isMasterAdminChat(effectiveChatId);
  const ctx = getEffectivePictaContext(effectiveChatId);
  const masterChanId = botConfig.pictaChannelId || "36319";
  if (!ctx.isLinked || !ctx.channelId) {
    return [];
  }
  const channelId = ctx.channelId;
  const channelNum = Number(channelId);
  try {
    const token = await ctx.accessTokenPromise;
    const headers = {
      Authorization: `Bearer ${token}`,
      Origin: "https://admin.picta.cu",
      Referer: "https://admin.picta.cu/"
    };
    const [serieRes, tempRes, pubRes] = await Promise.all([
      fetchPictaWithRetry(
        `https://api.picta.cu/v2/serie/?canal_id=${encodeURIComponent(channelId)}&page_size=50`,
        { headers },
        2
      ).catch(() => null),
      fetchPictaWithRetry(
        `https://api.picta.cu/v2/temporada/?canal_id=${encodeURIComponent(channelId)}&page_size=100`,
        { headers },
        2
      ).catch(() => null),
      fetchPictaWithRetry(
        `https://api.picta.cu/v2/publicacion/?canal_id=${encodeURIComponent(channelId)}&page_size=100`,
        { headers },
        2
      ).catch(() => null)
    ]);
    if (serieRes && serieRes.ok) {
      const sData = await serieRes.json();
      const sList = Array.isArray(sData) ? sData : sData.results || [];
      for (const s of sList) {
        const pid = Number(s.pelser_id || s.id || 0);
        if (pid > 0 && s.nombre) {
          const sCover = String(s.url_imagen || s.imagen_secundaria || "").trim();
          upsertChannelSerieRecord(pid, String(s.nombre), void 0, {
            ...sCover ? { coverUrl: sCover } : {},
            canalId: channelNum
          });
        }
      }
    }
    if (tempRes && tempRes.ok) {
      const tData = await tempRes.json();
      const tList = Array.isArray(tData) ? tData : tData.results || [];
      for (const t of tList) {
        const sObj = typeof t.serie === "object" && t.serie ? t.serie : null;
        const pid = Number(sObj?.pelser_id || sObj?.id || (typeof t.serie === "number" ? t.serie : 0));
        const sName = String(sObj?.nombre || "");
        const sCover = String(sObj?.url_imagen || sObj?.imagen_secundaria || "").trim();
        if (pid > 0 && sName && t.id) {
          upsertChannelSerieRecord(
            pid,
            sName,
            {
              id: Number(t.id),
              numero: Number(t.numero || 1),
              nombre: String(t.nombre || `Temporada ${t.numero || 1}`)
            },
            { ...sCover ? { coverUrl: sCover } : {}, canalId: channelNum }
          );
        }
      }
    }
    for (const j of transferJobs) {
      if (!isMaster && j.telegramChatId !== effectiveChatId) continue;
      if (j.targetChannelId && String(j.targetChannelId) !== String(channelId)) continue;
      if (!j.targetChannelId && !isMaster) continue;
      if (j.tipologiaId === 5 && j.stage === "completed") {
        let jPubId = Number(j.pictaPublicationId || 0);
        if (!jPubId && j.pictaResponseText) {
          try {
            const parsedResp = JSON.parse(j.pictaResponseText);
            if (parsedResp?.id) jPubId = Number(parsedResp.id);
          } catch {
          }
        }
        if (jPubId > 0) {
          j.pictaPublicationId = jPubId;
          const sPelser = Number(j.modelMetadata?.serie_pelser_id || 0);
          const sName = cleanSerieDisplayName(
            String(
              j.modelMetadata?.serie || extractSeriesInfoFromText(j.fileName, j.caption).serieName || (isMaster ? "El Mentalista" : "Serie")
            )
          );
          const sTemp = Number(j.modelMetadata?.temporada || 1) || 1;
          const sTempId = Number(j.modelMetadata?.temporada_id || 0);
          const sEp = Number(j.modelMetadata?.numero || extractSeriesInfoFromText(j.title).numero || 1) || 1;
          upsertChannelSerieRecord(
            sPelser,
            sName,
            sTempId > 0 ? { id: sTempId, numero: sTemp, nombre: `Temporada ${sTemp}` } : void 0,
            { canalId: channelNum },
            {
              pubId: jPubId,
              numero: sEp,
              temporada: sTemp,
              ...sTempId > 0 ? { temporadaId: sTempId } : {},
              nombre: j.title,
              descripcion: sanitizePublicPictaText(j.synopsis),
              minioKey: j.minioKey,
              publicado: true,
              updatedAt: j.updatedAt || (/* @__PURE__ */ new Date()).toISOString()
            }
          );
        }
      }
    }
    if (pubRes && pubRes.ok) {
      const pData = await pubRes.json();
      const pList = Array.isArray(pData) ? pData : pData.results || [];
      const candidateSerieNames = /* @__PURE__ */ new Set();
      for (const p of pList) {
        const capObj = p?.categoria?.capitulo;
        const capTemp = capObj?.temporada;
        const capSerie = capTemp?.serie;
        const rawTitle = String(p.nombre || "");
        const titleMatch = rawTitle.match(/^(.+?)\s*[-–]\s*T(\d{1,2})\s*:\s*E(\d{1,3})/i);
        if (capSerie && (capSerie.pelser_id || capSerie.id) && capSerie.nombre) {
          const pid = Number(capSerie.pelser_id || capSerie.id);
          const sName = cleanSerieDisplayName(String(capSerie.nombre));
          const tId = Number(capTemp?.id || 0);
          const tNumMatch = String(capTemp?.nombre || "").match(/(\d+)/);
          const tNum = Number(
            capTemp?.numero || (titleMatch ? titleMatch[2] : tNumMatch ? tNumMatch[1] : 1)
          );
          const epNum = Number(capObj?.numero || (titleMatch ? titleMatch[3] : 1));
          const sCover = String(
            capSerie.url_imagen || capSerie.imagen_secundaria || p.url_imagen || ""
          ).trim();
          upsertChannelSerieRecord(
            pid,
            sName,
            tId > 0 ? {
              id: tId,
              numero: tNum,
              nombre: String(capTemp?.nombre || `Temporada ${tNum}`)
            } : void 0,
            { ...sCover ? { coverUrl: sCover } : {}, canalId: channelNum },
            p.id ? {
              pubId: Number(p.id),
              numero: epNum,
              temporada: tNum,
              ...tId > 0 ? { temporadaId: tId } : {},
              nombre: rawTitle || `${sName} - T${tNum}:E${String(epNum).padStart(2, "0")}`,
              descripcion: sanitizePublicPictaText(p.descripcion),
              publicado: p.publicado !== false,
              convertido: Boolean(p.convertido),
              updatedAt: (/* @__PURE__ */ new Date()).toISOString()
            } : void 0
          );
        }
        if (titleMatch && titleMatch[1] && !isGenericOrInvalidSerieName(titleMatch[1])) {
          candidateSerieNames.add(cleanSerieDisplayName(titleMatch[1]));
        }
      }
      const currentScoped = filterSeriesForChannel(
        channelSeriesCache,
        channelId,
        isMaster,
        masterChanId
      );
      for (const candName of candidateSerieNames) {
        const alreadyKnown = currentScoped.some(
          (c) => cleanSerieDisplayName(c.nombre).toLowerCase().includes(candName.toLowerCase())
        );
        if (!alreadyKnown) {
          const searchRes = await fetchPictaWithRetry(
            `https://api.picta.cu/v2/temporada/?canal_id=${encodeURIComponent(channelId)}&search=${encodeURIComponent(candName)}`,
            { headers },
            2
          ).catch(() => null);
          if (searchRes && searchRes.ok) {
            const stData = await searchRes.json();
            const stList = Array.isArray(stData) ? stData : stData.results || [];
            for (const t of stList) {
              const sObj = typeof t.serie === "object" && t.serie ? t.serie : null;
              const sName = cleanSerieDisplayName(String(sObj?.nombre || candName));
              const pid = Number(
                sObj?.pelser_id || sObj?.id || (typeof t.serie === "number" ? t.serie : 0)
              );
              if (sName.toLowerCase().includes(candName.toLowerCase()) && t.id) {
                upsertChannelSerieRecord(
                  pid || Number(t.id),
                  sName,
                  {
                    id: Number(t.id),
                    numero: Number(t.numero || 1),
                    nombre: String(t.nombre || `Temporada ${t.numero || 1}`)
                  },
                  { canalId: channelNum }
                );
              }
            }
          }
        }
      }
    }
  } catch {
  }
  return filterSeriesForChannel(channelSeriesCache, channelId, isMaster, masterChanId);
}
async function ensureSerieAndTemporadaId(token, serieName, temporadaRaw, meta = {}, coverBuffer, targetChannelId, targetChannelName, isMaster = true) {
  const effectiveChanId = String(targetChannelId || "").trim();
  if (!effectiveChanId) {
    throw new Error("No hay un canal vinculado para registrar la serie en Picta.");
  }
  const effectiveChanNum = Number(effectiveChanId);
  const effectiveChanLabel = targetChannelName && targetChannelName.trim() || `Canal #${effectiveChanId}`;
  const numStr = String(temporadaRaw || "1").replace(/\D/g, "") || "1";
  const targetNum = Number(numStr) || 1;
  const cleanSerieName = serieName.trim() || `Serie ${effectiveChanLabel}`;
  if (meta.temporada_id && Number(meta.temporada_id) > 0) {
    return Number(meta.temporada_id);
  }
  if (typeof temporadaRaw === "number" && temporadaRaw > 50) {
    return temporadaRaw;
  }
  if (typeof temporadaRaw === "string" && /^\d{3,6}$/.test(temporadaRaw.trim())) {
    return Number(temporadaRaw.trim());
  }
  const scopedSeries = filterSeriesForChannel(
    channelSeriesCache,
    effectiveChanId,
    isMaster,
    botConfig.pictaChannelId || "36319"
  );
  const cachedSerie = scopedSeries.find(
    (s) => meta.serie_pelser_id && Number(s.pelser_id) === Number(meta.serie_pelser_id) || s.nombre.toLowerCase().trim() === cleanSerieName.toLowerCase()
  );
  if (cachedSerie) {
    const cachedSeason = cachedSerie.seasons.find((st) => Number(st.numero) === targetNum);
    if (cachedSeason && cachedSeason.id > 0) {
      return cachedSeason.id;
    }
  }
  try {
    const searchUrl = `https://api.picta.cu/v2/temporada/?canal_id=${encodeURIComponent(effectiveChanId)}&search=${encodeURIComponent(cleanSerieName)}`;
    const res = await fetchPictaWithRetry(searchUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu"
      }
    });
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.results || [];
      if (list.length > 0) {
        const exactSeasonMatch = list.find(
          (t) => t.serie?.nombre && t.serie.nombre.toLowerCase().trim() === cleanSerieName.toLowerCase() && Number(t.numero) === targetNum
        );
        const match = exactSeasonMatch || list.find(
          (t) => t.serie?.nombre && t.serie.nombre.toLowerCase().includes(cleanSerieName.toLowerCase()) && Number(t.numero) === targetNum
        );
        if (match?.id) {
          const pid = Number(match.serie?.pelser_id || match.serie?.id || meta.serie_pelser_id || match.id);
          upsertChannelSerieRecord(
            pid,
            match.serie?.nombre || cleanSerieName,
            {
              id: Number(match.id),
              numero: Number(match.numero || targetNum),
              nombre: String(match.nombre || `Temporada ${targetNum}`)
            },
            { canalId: effectiveChanNum }
          );
          addLiveLog(
            "picta",
            "info",
            `Temporada vinculada para serie "${cleanSerieName}": Temporada ${match.numero || targetNum} (ID: ${match.id})`
          );
          return Number(match.id);
        }
      }
    }
  } catch {
  }
  let pelserId = meta.serie_pelser_id && Number(meta.serie_pelser_id) > 0 ? Number(meta.serie_pelser_id) : cachedSerie?.pelser_id || null;
  if (!pelserId) {
    try {
      const sRes = await fetchPictaWithRetry(
        `https://api.picta.cu/v2/serie/?canal_id=${encodeURIComponent(effectiveChanId)}&search=${encodeURIComponent(cleanSerieName)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: "https://admin.picta.cu"
          }
        }
      );
      if (sRes.ok) {
        const sData = await sRes.json();
        const sList = Array.isArray(sData) ? sData : sData.results || [];
        const sMatch = sList.find(
          (s) => s.nombre && s.nombre.toLowerCase().trim() === cleanSerieName.toLowerCase().trim()
        );
        if (sMatch?.pelser_id) {
          pelserId = Number(sMatch.pelser_id);
        }
      }
    } catch {
    }
  }
  if (!pelserId) {
    addLiveLog(
      "picta",
      "info",
      `Creando Serie "${cleanSerieName}" en canal ${effectiveChanLabel} (#${effectiveChanId})...`
    );
    const onlineSerie = await searchMovieOrSeriesInfoOnline(cleanSerieName, 5).catch(() => null);
    let finalSerieCoverBuf = coverBuffer;
    let finalSeriePosterBuf = coverBuffer;
    let finalSerieCoverUrl = "";
    const hasCustomSerieBuf = Boolean(coverBuffer && coverBuffer.byteLength > 200);
    const seriePortadaUrl = selectOnlineImageForSlot(onlineSerie, "portada");
    const seriePosterUrl = selectOnlineImageForSlot(onlineSerie, "poster");
    if (!hasCustomSerieBuf && seriePortadaUrl) {
      try {
        const imgRes = await fetch(seriePortadaUrl);
        if (imgRes.ok) {
          const arr = await imgRes.arrayBuffer();
          if (arr.byteLength > 200) {
            finalSerieCoverBuf = Buffer.from(arr);
            finalSerieCoverUrl = seriePortadaUrl;
          }
        }
      } catch {
      }
    }
    if (!hasCustomSerieBuf && seriePosterUrl) {
      if (seriePosterUrl === seriePortadaUrl && finalSerieCoverBuf.byteLength > 200) {
        finalSeriePosterBuf = finalSerieCoverBuf;
      } else {
        try {
          const pRes = await fetch(seriePosterUrl);
          if (pRes.ok) {
            const pArr = await pRes.arrayBuffer();
            if (pArr.byteLength > 200) {
              finalSeriePosterBuf = Buffer.from(pArr);
              if (!finalSerieCoverUrl) finalSerieCoverUrl = seriePosterUrl;
            }
          }
        } catch {
          finalSeriePosterBuf = finalSerieCoverBuf;
        }
      }
    }
    if (!finalSeriePosterBuf || finalSeriePosterBuf.byteLength < 200) {
      finalSeriePosterBuf = finalSerieCoverBuf;
    }
    const genreIds = resolveGenreIds(
      meta.genero_ids || meta.genero_id || meta.genero || onlineSerie?.genero
    );
    const primaryGenre = genreIds[0] || 5;
    const serieSynopsis = sanitizePublicPictaText(
      String(
        meta.sinopsis && !isGenericAutoSynopsis(String(meta.sinopsis)) ? meta.sinopsis : onlineSerie?.synopsis || `Serie ${cleanSerieDisplayName(cleanSerieName)} disponible en ${effectiveChanLabel}.`
      )
    );
    const sForm = new FormData();
    sForm.append("nombre", cleanSerieName);
    sForm.append("canal", effectiveChanId);
    sForm.append("sinopsis", serieSynopsis);
    sForm.append("clasificacion", botConfig.pictaClasificacion || "18+");
    sForm.append("ano", String(meta.ano || onlineSerie?.year || (/* @__PURE__ */ new Date()).getFullYear()));
    sForm.append("pais", String(meta.pais || onlineSerie?.pais || "Estados Unidos"));
    sForm.append("genero", String(primaryGenre));
    sForm.append("director", "1022");
    sForm.append("reparto", "646");
    sForm.append("productora", "679");
    sForm.append("cantidad_temporadas", String(Math.max(1, targetNum)));
    sForm.append("cantidad_capitulos", "10");
    sForm.append(
      "url_imagen",
      new Blob([new Uint8Array(finalSerieCoverBuf)], { type: "image/jpeg" }),
      `cover_serie_${Date.now()}.jpg`
    );
    sForm.append(
      "imagen_secundaria",
      new Blob([new Uint8Array(finalSeriePosterBuf)], { type: "image/jpeg" }),
      `poster_serie_${Date.now()}.jpg`
    );
    const createSerieRes = await fetchPictaWithRetry("https://api.picta.cu/v1/serie/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      },
      body: sForm
    });
    if (!createSerieRes.ok) {
      const errText = await createSerieRes.text();
      throw new Error(
        `Fallo al registrar la serie "${cleanSerieName}" en Picta: ${formatPictaError(
          createSerieRes.status,
          errText
        )}`
      );
    }
    const createdSerieData = await createSerieRes.json();
    pelserId = Number(createdSerieData.pelser_id || createdSerieData.id);
    const createdCoverUrl = String(
      createdSerieData.url_imagen || createdSerieData.imagen_secundaria || finalSerieCoverUrl || ""
    ).trim();
    upsertChannelSerieRecord(pelserId, cleanSerieName, void 0, {
      ...createdCoverUrl ? { coverUrl: createdCoverUrl } : {},
      canalId: effectiveChanNum
    });
    addLiveLog(
      "picta",
      "success",
      `Serie "${cleanSerieName}" creada exitosamente en canal #${effectiveChanId} (ID: ${pelserId}).`
    );
  }
  addLiveLog(
    "picta",
    "info",
    `Creando Temporada ${targetNum} para serie "${cleanSerieName}" (pelser_id: ${pelserId})...`
  );
  const tForm = new FormData();
  tForm.append("nombre", `Temporada ${targetNum}`);
  tForm.append("numero", String(targetNum));
  tForm.append("serie", String(pelserId));
  tForm.append("canal", effectiveChanId);
  tForm.append("cantidad_capitulos", "10");
  const createTempRes = await fetchPictaWithRetry("https://api.picta.cu/v1/temporada/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://admin.picta.cu",
      Referer: "https://admin.picta.cu/"
    },
    body: tForm
  });
  if (!createTempRes.ok) {
    const errText = await createTempRes.text();
    throw new Error(
      `Fallo al crear la Temporada ${targetNum} en Picta: ${formatPictaError(
        createTempRes.status,
        errText
      )}`
    );
  }
  const createdTempData = await createTempRes.json();
  const newTempId = Number(createdTempData.id);
  upsertChannelSerieRecord(
    pelserId,
    cleanSerieName,
    {
      id: newTempId,
      numero: targetNum,
      nombre: `Temporada ${targetNum}`
    },
    { canalId: effectiveChanNum }
  );
  addLiveLog(
    "picta",
    "success",
    `Temporada ${targetNum} creada exitosamente (ID: ${newTempId}) para la serie "${cleanSerieName}".`
  );
  return newTempId;
}
function parseUserManualMetadata(text, tipId) {
  const meta = {};
  let title = "";
  let synopsis = "";
  const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const kvLines = lines.filter((l) => /^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]+:\s*.+$/.test(l));
  if (kvLines.length >= 2 || lines.length === 1 && /^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]+:\s*.+$/.test(lines[0])) {
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const rawKey = norm(line.slice(0, idx));
      const val = line.slice(idx + 1).trim();
      if (!val) continue;
      if (rawKey === "titulo" || rawKey === "title" || rawKey === "nombre") title = val;
      else if (rawKey === "sinopsis" || rawKey === "descripcion") synopsis = val;
      else if (rawKey === "ano" || rawKey === "year" || rawKey === "estreno") meta.ano = val;
      else if (rawKey === "genero" || rawKey === "genre") meta.genero = val;
      else if (rawKey === "director" || rawKey === "direccion") meta.director = val;
      else if (rawKey === "pais" || rawKey === "country") meta.pais = val;
      else if (rawKey === "guion") meta.guion = val;
      else if (rawKey === "reparto" || rawKey === "actores") meta.reparto = val;
      else if (rawKey === "musica") meta.musica = val;
      else if (rawKey === "fotografia") meta.fotografia = val;
      else if (rawKey === "productora" || rawKey === "estudio") meta.productora = val;
      else if (rawKey === "premio" || rawKey === "premios") meta.premio = val;
      else if (rawKey === "serie") meta.serie = val;
      else if (rawKey === "temporada") meta.temporada = val;
      else if (rawKey === "capitulo" || rawKey === "numero" || rawKey === "episodio") meta.numero = val;
      else if (rawKey === "interprete" || rawKey === "artista") meta.interprete = val;
      else if (rawKey === "productor") meta.productor = val;
      else if (rawKey === "sello") meta.sello = val;
      else if (rawKey === "autor") meta.autor = val;
      else meta[rawKey] = val;
    }
    if (tipId === 5 && (meta.serie || title)) {
      title = formatSerieEpisodeTitle(meta.serie || title, meta.temporada, meta.numero);
    }
    return { title, synopsis: synopsis || void 0, meta };
  }
  if (text.includes("|")) {
    const parts = text.split("|").map((s) => s.trim()).filter(Boolean);
    if (tipId === 5) {
      if (parts.length >= 2 && /^\d{1,2}$/.test(parts[1])) {
        title = parts[0] || text;
        meta.temporada = parts[1];
        if (parts[2] && /^\d{1,3}$/.test(parts[2])) {
          meta.numero = parts[2];
        }
        meta.serie = title;
        title = formatSerieEpisodeTitle(meta.serie, meta.temporada, meta.numero);
        return { title, synopsis: void 0, meta };
      }
      return { title: text.trim(), synopsis: void 0, meta };
    } else {
      title = parts[0] || text;
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        const np = norm(p);
        if (/^\d{4}$/.test(p)) {
          meta.ano = p;
        } else if (/^(accion|aventura|ciencia ficcion|sci-fi|drama|comedia|terror|animacion|suspenso|fantasia|documental|crimen|romance|belico|musical)$/.test(
          np
        )) {
          meta.genero = p;
        } else if (/^(cuba|estados unidos|ee\.uu\.|eeuu|espana|mexico|japon|francia|reino unido|italia|alemania|canada|internacional)$/.test(
          np
        )) {
          meta.pais = p;
        } else if (!meta.director) {
          meta.director = p;
        } else if (!meta.pais) {
          meta.pais = p;
        } else if (!meta.reparto) {
          meta.reparto = p;
        }
      }
    }
    return { title, synopsis: void 0, meta };
  }
  return { title: text.trim(), synopsis: void 0, meta };
}
function resolveGeminiApiKey() {
  for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "API_KEY", "VITE_GEMINI_API_KEY"]) {
    const raw = String(process.env[k] || "").trim().replace(/^["']+|["']+$/g, "").trim();
    if (raw && raw !== "MY_GEMINI_API_KEY" && raw !== "YOUR_API_KEY") {
      return raw;
    }
  }
  try {
    const envPath = path3.resolve(process.cwd(), ".env");
    if (fs3.existsSync(envPath)) {
      const parsed = dotenv.parse(fs3.readFileSync(envPath, "utf-8"));
      for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "API_KEY", "VITE_GEMINI_API_KEY"]) {
        const raw = String(parsed[k] || "").trim().replace(/^["']+|["']+$/g, "").trim();
        if (raw && raw !== "MY_GEMINI_API_KEY" && raw !== "YOUR_API_KEY") {
          process.env.GEMINI_API_KEY = raw;
          return raw;
        }
      }
    }
  } catch {
  }
  return "";
}
function getGeminiClient() {
  const apiKey = resolveGeminiApiKey();
  return new GoogleGenAI({
    apiKey: apiKey || process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: { "User-Agent": "aistudio-build" }
    }
  });
}
var FREE_GEMINI_MODELS = [
  "gemini-4-hydrogen",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite"
];
async function generateGeminiContentWithFallback(contents, config) {
  const customModel = String(process.env.GEMINI_MODEL || "").trim();
  const models = [
    ...(customModel ? [customModel] : []),
    ...FREE_GEMINI_MODELS
  ];
  const client = getGeminiClient();
  let lastErr = null;
  for (const modelName of models) {
    try {
      return await client.models.generateContent({
        model: modelName,
        contents,
        config
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("No se pudo conectar con Gemini IA");
}
async function generateVideoMetadataWithAI(fileName, caption, customTitle, categoryName, tipologiaId, channelName, knownSerieContext) {
  const analyzedNaming = analyzeVideoTitleAndSynopsis(fileName, caption);
  const cleanName = analyzedNaming.initialTitle || (!analyzedNaming.filenameIsRandom ? cleanGeneralVideoTitle(fileName) : "");
  const cat = categoryName || "Audiovisual";
  const tipId = Number(tipologiaId || 8);
  const effectiveChannelName = channelName && channelName.trim() || "tu canal de Picta";
  const yearMatch = (customTitle || cleanName || caption).match(/\b(19\d\d|20\d\d)\b/);
  const fallbackYear = yearMatch ? yearMatch[1] : String((/* @__PURE__ */ new Date()).getFullYear());
  const parsedFromText = analyzedNaming.seriesInfo;
  const overrideSerie = String(knownSerieContext?.serieName || "").trim();
  const mergedSerieName = !isGenericOrInvalidSerieName(overrideSerie) ? overrideSerie : parsedFromText.serieName;
  const mergedTemp = String(knownSerieContext?.temporada || parsedFromText.temporada || "1").replace(/\D/g, "") || "1";
  const mergedEp = String(knownSerieContext?.numero || parsedFromText.numero || "1").replace(/\D/g, "") || "1";
  const mergedSub = String(knownSerieContext?.episodeSubtitle || parsedFromText.episodeSubtitle || "").trim() || void 0;
  const inheritedStyle = knownSerieContext?.inheritedStyle || null;
  const extractedSerie = {
    serieName: mergedSerieName,
    temporada: mergedTemp,
    numero: mergedEp,
    episodeSubtitle: mergedSub,
    missingSerieName: isGenericOrInvalidSerieName(mergedSerieName),
    formattedTitle: inheritedStyle ? formatEpisodeWithSeriesStyle(inheritedStyle, {
      serieName: mergedSerieName,
      temporada: mergedTemp,
      numero: mergedEp,
      episodeSubtitle: mergedSub
    }) : formatSerieEpisodeTitle(mergedSerieName, mergedTemp, mergedEp, mergedSub)
  };
  const queryBase = tipId === 5 && !extractedSerie.missingSerieName ? extractedSerie.serieName : customTitle || cleanName;
  const onlineInfo = knownSerieContext?.preResolvedOnlineInfo ? knownSerieContext.preResolvedOnlineInfo : queryBase && !isRandomOrCrypticFilename(queryBase) ? await searchMovieOrSeriesInfoOnline(
    queryBase,
    tipId,
    extractedSerie.temporada,
    extractedSerie.numero
  ).catch(() => null) : null;
  try {
    const ai = getGeminiClient();
    let extraPrompt = "";
    if (onlineInfo && onlineInfo.found) {
      extraPrompt += `
INFORMACI\xD3N REAL VERIFICADA EN INTERNET:
- T\xEDtulo Oficial: ${onlineInfo.title}
${onlineInfo.originalTitle ? `- T\xEDtulo Original: ${onlineInfo.originalTitle}` : ""}
${onlineInfo.year ? `- A\xF1o: ${onlineInfo.year}` : ""}
${onlineInfo.director ? `- Director / Realizador: ${onlineInfo.director}` : ""}
${onlineInfo.guion ? `- Gui\xF3n / Escritor: ${onlineInfo.guion}` : ""}
${onlineInfo.productora ? `- Productora / Estudio: ${onlineInfo.productora}` : ""}
${onlineInfo.reparto ? `- Reparto / Actores: ${onlineInfo.reparto}` : ""}
${onlineInfo.pais ? `- Pa\xEDs: ${onlineInfo.pais}` : ""}
${onlineInfo.genero ? `- G\xE9nero: ${onlineInfo.genero}` : ""}
${onlineInfo.musica ? `- M\xFAsica: ${onlineInfo.musica}` : ""}
${onlineInfo.fotografia ? `- Fotograf\xEDa: ${onlineInfo.fotografia}` : ""}
${onlineInfo.episodeTitle ? `- T\xEDtulo del episodio (T${extractedSerie.temporada}:E${extractedSerie.numero}): ${onlineInfo.episodeTitle}` : ""}
${onlineInfo.episodeSynopsis ? `- Sinopsis real del episodio: ${onlineInfo.episodeSynopsis}` : ""}
${onlineInfo.synopsis ? `- Sinopsis general de la obra: ${onlineInfo.synopsis}` : ""}
IMPORTANTE: Usa obligatoriamente estos datos can\xF3nicos verificados en internet para redactar una sinopsis en espa\xF1ol fiel y completar la ficha t\xE9cnica con exactitud.`;
    }
    let responseSchemaProperties = {
      title: { type: Type.STRING },
      synopsis: { type: Type.STRING },
      tags: { type: Type.ARRAY, items: { type: Type.STRING } }
    };
    let requiredFields = ["title", "synopsis", "tags"];
    if (tipId === 1) {
      extraPrompt += `
IMPORTANTE - FICHA CINEMATOGR\xC1FICA OBLIGATORIA (Picta exige estos 10 campos estrictos):
1. ano: a\xF1o de estreno de la pel\xEDcula (ej: "${onlineInfo?.year || fallbackYear}").
2. pais: pa\xEDs de origen (ej: "Estados Unidos", "Jap\xF3n", "Espa\xF1a", "Cuba").
3. genero: g\xE9neros principales separados por coma (ej: "Aventura, Acci\xF3n, Fantas\xEDa").
4. productora: estudio productor o distribuidor (ej: "Warner Bros", "Marvel Studios").
5. director: realizador o director principal.
6. guion: guionista o autor de la historia.
7. musica: compositor o banda sonora.
8. fotografia: cinematograf\xEDa / direcci\xF3n de fotograf\xEDa.
9. reparto: actores principales destacados.
10. premio: premios notables o "Ninguno".`;
      responseSchemaProperties = {
        ...responseSchemaProperties,
        ano: { type: Type.STRING },
        pais: { type: Type.STRING },
        genero: { type: Type.STRING },
        productora: { type: Type.STRING },
        director: { type: Type.STRING },
        guion: { type: Type.STRING },
        musica: { type: Type.STRING },
        fotografia: { type: Type.STRING },
        reparto: { type: Type.STRING },
        premio: { type: Type.STRING }
      };
      requiredFields = [
        ...requiredFields,
        "ano",
        "pais",
        "genero",
        "productora",
        "director",
        "guion",
        "musica",
        "fotografia",
        "reparto",
        "premio"
      ];
    } else if (tipId === 2) {
      extraPrompt += `
IMPORTANTE - FICHA DOCUMENTAL (Picta exige estos campos):
1. pais: pa\xEDs de origen del documental.
2. productora: productora del documental o instituci\xF3n realizadora.`;
      responseSchemaProperties = {
        ...responseSchemaProperties,
        pais: { type: Type.STRING },
        productora: { type: Type.STRING }
      };
      requiredFields = [...requiredFields, "pais", "productora"];
    } else if (tipId === 5) {
      extraPrompt += `
IMPORTANTE - FICHA DE SERIE (Picta exige estos campos):
1. serie: nombre de la serie general (sin n\xFAmero de cap\xEDtulo).
2. temporada: n\xFAmero de temporada como n\xFAmero entero en texto (ej: "${extractedSerie.temporada || "1"}").
3. numero: n\xFAmero de cap\xEDtulo o episodio como n\xFAmero entero en texto (ej: "${extractedSerie.numero || "1"}").
4. synopsis: redacta en espa\xF1ol la sinopsis real de este episodio o de la serie (NUNCA escribas solo "Cap\xEDtulo X de la Temporada Y disponible en ${effectiveChannelName}", escribe de qu\xE9 trata realmente la trama).`;
      responseSchemaProperties = {
        ...responseSchemaProperties,
        serie: { type: Type.STRING },
        temporada: { type: Type.STRING },
        numero: { type: Type.STRING }
      };
      requiredFields = [...requiredFields, "serie", "temporada", "numero"];
    } else if (tipId === 3 || tipId === 14) {
      extraPrompt += `
IMPORTANTE - FICHA DE ${tipId === 14 ? "DEPORTE" : "VIDEO MUSICAL"} (Picta exige estos campos):
1. ano: a\xF1o del video o evento deportivo (ej: "${fallbackYear}").
2. genero: g\xE9nero musical o disciplina deportiva (ej: "${tipId === 14 ? "F\xFAtbol, Deporte" : "Pop, M\xFAsica"}").
3. interprete: int\xE9rprete principal, banda o deportistas/equipos destacados.
4. director: realizador o director audiovisual.
5. productor: productor o canal productor.`;
      responseSchemaProperties = {
        ...responseSchemaProperties,
        ano: { type: Type.STRING },
        genero: { type: Type.STRING },
        interprete: { type: Type.STRING },
        director: { type: Type.STRING },
        productor: { type: Type.STRING }
      };
      requiredFields = [...requiredFields, "ano", "genero", "interprete", "director", "productor"];
    } else if (tipId === 11) {
      const todayYmd = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      extraPrompt += `
IMPORTANTE - FICHA DE VIDEOCLIP (Picta exige estos campos):
1. ano: a\xF1o de lanzamiento (ej: "${fallbackYear}").
2. genero: g\xE9nero musical del tema.
3. interprete: cantante, grupo o artista musical principal.
4. director: realizador o director del videoclip.
5. release_date: fecha de estreno en formato YYYY-MM-DD (ej: "${todayYmd}").
6. sale_start_date: fecha de venta en formato YYYY-MM-DD (ej: "${todayYmd}").
7. sello: sello discogr\xE1fico o "Independiente".`;
      responseSchemaProperties = {
        ...responseSchemaProperties,
        ano: { type: Type.STRING },
        genero: { type: Type.STRING },
        interprete: { type: Type.STRING },
        director: { type: Type.STRING },
        release_date: { type: Type.STRING },
        sale_start_date: { type: Type.STRING },
        sello: { type: Type.STRING }
      };
      requiredFields = [
        ...requiredFields,
        "ano",
        "genero",
        "interprete",
        "director",
        "release_date",
        "sale_start_date",
        "sello"
      ];
    } else if (tipId === 6) {
      extraPrompt += `
IMPORTANTE - FICHA DE CURSO (Picta exige estos campos):
1. temporada: n\xFAmero de m\xF3dulo, nivel o temporada del curso como n\xFAmero en texto (ej: "1").`;
      responseSchemaProperties = {
        ...responseSchemaProperties,
        temporada: { type: Type.STRING }
      };
      requiredFields = [...requiredFields, "temporada"];
    }
    const prompt = customTitle ? `El usuario va a subir un video a su canal ${effectiveChannelName} en Picta con el t\xEDtulo: "${customTitle}".
Categor\xEDa seleccionada: "${cat}" (Tipolog\xEDa ID: ${tipId}).
Archivo: "${fileName}". Notas adicionales: "${caption || "Ninguna"}".
Busca tu conocimiento sobre esta pel\xEDcula/serie/video y usa la informaci\xF3n verificada en l\xEDnea para generar una sinopsis real y atractiva en espa\xF1ol (entre 160 y 480 caracteres) y de 3 a 5 etiquetas relevantes.${extraPrompt}` : `El usuario envi\xF3 un video por Telegram para su canal ${effectiveChannelName} en Picta y pidi\xF3 autorrellenar sus datos.
Categor\xEDa seleccionada: "${cat}" (Tipolog\xEDa ID: ${tipId}).
Archivo: "${fileName}" (${cleanName}). Notas adicionales: "${caption || "Sin descripci\xF3n"}".
Usa tu conocimiento y la informaci\xF3n verificada en internet para generar el t\xEDtulo oficial en espa\xF1ol, una sinopsis real y atractiva en espa\xF1ol (entre 160 y 480 caracteres) y de 3 a 5 etiquetas.${extraPrompt}`;
    const response = await Promise.race([
      generateGeminiContentWithFallback(prompt, {
          systemInstruction: `Eres un asistente editorial y catalogador experto en cine, series y televisi\xF3n para el canal ${effectiveChannelName} en Picta (Cuba). Conoces a fondo las pel\xEDculas, series, actores, directores y argumentos reales, as\xED como las reglas de metadatos de Picta. Responde siempre con JSON estricto 100% en espa\xF1ol (jam\xE1s en ingl\xE9s) completando todos los campos requeridos con datos ver\xEDdicos.`,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: responseSchemaProperties,
            required: requiredFields
          }
        }),
      new Promise(
        (_, reject) => setTimeout(() => reject(new Error("Timeout IA 12s")), 12e3)
      )
    ]);
    const parsed = JSON.parse((response.text ?? "{}").trim());
    let resultTitle = customTitle || parsed.title || onlineInfo?.title || cleanName || `Video en ${effectiveChannelName} (${cat})`;
    if (tipId === 5 && !customTitle) {
      const sName = String(
        !extractedSerie.missingSerieName ? extractedSerie.serieName : !isGenericOrInvalidSerieName(parsed.serie) ? parsed.serie : onlineInfo?.title || "Serie"
      );
      const sSeason = String(extractedSerie.temporada || parsed.temporada || "1");
      const sEp = String(extractedSerie.numero || parsed.numero || "1");
      const sSub = extractedSerie.episodeSubtitle || onlineInfo?.episodeTitle;
      resultTitle = inheritedStyle ? formatEpisodeWithSeriesStyle(inheritedStyle, {
        serieName: sName,
        temporada: sSeason,
        numero: sEp,
        episodeSubtitle: sSub
      }) : formatSerieEpisodeTitle(sName, sSeason, sEp, sSub);
    }
    const aiSpanishSynopsis = parsed.synopsis ? await translateTextToSpanishIfNeeded(String(parsed.synopsis)) : "";
    const resultSynopsis = sanitizePublicPictaText(
      aiSpanishSynopsis || onlineInfo?.episodeSynopsis || onlineInfo?.synopsis || (tipId === 5 ? `Cap\xEDtulo ${extractedSerie.numero} de la Temporada ${extractedSerie.temporada} de la serie ${cleanSerieDisplayName(extractedSerie.serieName) || "la serie"}${extractedSerie.episodeSubtitle ? ` ("${extractedSerie.episodeSubtitle}")` : ""}, disponible en el canal ${effectiveChannelName}.` : `${resultTitle}. Publicado en la categor\xEDa ${cat} del canal ${effectiveChannelName} en Picta.`)
    ).slice(0, 580);
    const resultTags = Array.isArray(parsed.tags) && parsed.tags.length > 0 ? parsed.tags.slice(0, 5) : ["Picta", cat, effectiveChannelName];
    const modelMetadata = {};
    if (tipId === 1) {
      modelMetadata.ano = String(parsed.ano || onlineInfo?.year || fallbackYear);
      if (onlineInfo?.rating) {
        modelMetadata.calificacion = String(onlineInfo.rating);
      }
      modelMetadata.pais = String(parsed.pais || onlineInfo?.pais || "Internacional");
      const rawGenreStr = String(parsed.genero || onlineInfo?.genero || "Acci\xF3n, Aventura");
      modelMetadata.genero_ids = resolveGenreIds(rawGenreStr);
      modelMetadata.genero = rawGenreStr;
      modelMetadata.productora = String(parsed.productora || onlineInfo?.productora || "Producci\xF3n Audiovisual");
      modelMetadata.director = String(parsed.director || onlineInfo?.director || "Direcci\xF3n General");
      modelMetadata.guion = String(parsed.guion || onlineInfo?.guion || parsed.director || "Gui\xF3n Original");
      modelMetadata.musica = String(parsed.musica || onlineInfo?.musica || "Banda Sonora Original");
      modelMetadata.fotografia = String(parsed.fotografia || onlineInfo?.fotografia || "Cinematograf\xEDa Digital");
      modelMetadata.reparto = String(parsed.reparto || onlineInfo?.reparto || "Elenco Principal");
    } else if (tipId === 2) {
      modelMetadata.pais = String(parsed.pais || onlineInfo?.pais || "Cuba / Internacional");
      modelMetadata.productora = String(parsed.productora || onlineInfo?.productora || effectiveChannelName);
    } else if (tipId === 5) {
      modelMetadata.serie = String(
        !extractedSerie.missingSerieName ? extractedSerie.serieName : !isGenericOrInvalidSerieName(parsed.serie) ? parsed.serie : onlineInfo?.title || "Serie"
      );
      modelMetadata.temporada = String(extractedSerie.temporada || parsed.temporada || "1");
      modelMetadata.numero = String(extractedSerie.numero || parsed.numero || "1");
      if (extractedSerie.episodeSubtitle || onlineInfo?.episodeTitle) {
        modelMetadata.episodeSubtitle = String(extractedSerie.episodeSubtitle || onlineInfo?.episodeTitle);
      }
    } else if (tipId === 3 || tipId === 14) {
      modelMetadata.ano = String(parsed.ano || onlineInfo?.year || fallbackYear);
      modelMetadata.genero = String(parsed.genero || onlineInfo?.genero || (tipId === 14 ? "Deporte" : "M\xFAsica"));
      modelMetadata.interprete = String(parsed.interprete || onlineInfo?.reparto || (tipId === 14 ? "Deportistas" : "Artista Principal"));
      modelMetadata.director = String(parsed.director || onlineInfo?.director || "Direcci\xF3n Audiovisual");
      modelMetadata.productor = String(parsed.productor || onlineInfo?.productora || `Producci\xF3n ${effectiveChannelName}`);
    } else if (tipId === 11) {
      const todayYmd = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      modelMetadata.ano = String(parsed.ano || onlineInfo?.year || fallbackYear);
      modelMetadata.genero = String(parsed.genero || onlineInfo?.genero || "M\xFAsica, Videoclip");
      modelMetadata.interprete = String(parsed.interprete || onlineInfo?.reparto || "Artista");
      modelMetadata.director = String(parsed.director || onlineInfo?.director || "Direcci\xF3n de Videoclip");
      modelMetadata.release_date = String(parsed.release_date || todayYmd);
      modelMetadata.sale_start_date = String(parsed.sale_start_date || todayYmd);
      modelMetadata.sello = String(parsed.sello || onlineInfo?.productora || "Independiente");
    } else if (tipId === 6) {
      modelMetadata.temporada = String(parsed.temporada || "1");
    }
    if (onlineInfo?.imageUrl) {
      modelMetadata.onlineCoverUrl = onlineInfo.imageUrl;
    }
    if (onlineInfo?.posterUrl) {
      modelMetadata.onlinePosterUrl = onlineInfo.posterUrl;
    }
    if (onlineInfo?.backdropUrl) {
      modelMetadata.onlineBackdropUrl = onlineInfo.backdropUrl;
    }
    return {
      title: resultTitle,
      synopsis: resultSynopsis,
      tags: resultTags,
      modelMetadata: Object.keys(modelMetadata).length > 0 ? modelMetadata : void 0
    };
  } catch {
    let fallbackTitle = customTitle || (cleanName && !/^(VID|MOV|DOC|video)[_\-\d]*$/i.test(cleanName) ? cleanName.charAt(0).toUpperCase() + cleanName.slice(1) : `Estreno en ${effectiveChannelName} (${cat}) \u2014 ${(/* @__PURE__ */ new Date()).toLocaleDateString("es-CU")}`);
    if (tipId === 5 && !customTitle) {
      const cleanSerie = !extractedSerie.missingSerieName ? extractedSerie.serieName : onlineInfo?.title || "Serie";
      const sSub = extractedSerie.episodeSubtitle || onlineInfo?.episodeTitle;
      fallbackTitle = inheritedStyle ? formatEpisodeWithSeriesStyle(inheritedStyle, {
        serieName: cleanSerie,
        temporada: extractedSerie.temporada,
        numero: extractedSerie.numero,
        episodeSubtitle: sSub
      }) : formatSerieEpisodeTitle(
        cleanSerie,
        extractedSerie.temporada,
        extractedSerie.numero,
        sSub
      );
    }
    const fallbackMeta = {};
    const todayYmd = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    if (tipId === 1) {
      fallbackMeta.ano = onlineInfo && onlineInfo.year || fallbackYear;
      if (onlineInfo?.rating) {
        fallbackMeta.calificacion = String(onlineInfo.rating);
      }
      fallbackMeta.pais = onlineInfo && onlineInfo.pais || "Internacional";
      const rawGen = onlineInfo && onlineInfo.genero || "Acci\xF3n, Aventura, Fantas\xEDa";
      fallbackMeta.genero = rawGen;
      fallbackMeta.genero_ids = resolveGenreIds(rawGen);
      fallbackMeta.productora = onlineInfo && onlineInfo.productora || "Producci\xF3n Audiovisual";
      fallbackMeta.director = onlineInfo && onlineInfo.director || "Direcci\xF3n General";
      fallbackMeta.guion = onlineInfo && (onlineInfo.guion || onlineInfo.director) || "Gui\xF3n Original";
      fallbackMeta.musica = onlineInfo && onlineInfo.musica || "Banda Sonora Original";
      fallbackMeta.fotografia = onlineInfo && onlineInfo.fotografia || "Cinematograf\xEDa Digital";
      fallbackMeta.reparto = onlineInfo && onlineInfo.reparto || "Elenco Principal / Doblaje";
    } else if (tipId === 2) {
      fallbackMeta.pais = onlineInfo && onlineInfo.pais || "Internacional";
      fallbackMeta.productora = onlineInfo && onlineInfo.productora || `${effectiveChannelName} Producciones`;
    } else if (tipId === 5) {
      fallbackMeta.serie = !extractedSerie.missingSerieName ? extractedSerie.serieName : onlineInfo?.title || "Serie";
      fallbackMeta.temporada = extractedSerie.temporada || "1";
      fallbackMeta.numero = extractedSerie.numero || "1";
      if (extractedSerie.episodeSubtitle || onlineInfo?.episodeTitle) {
        fallbackMeta.episodeSubtitle = String(extractedSerie.episodeSubtitle || onlineInfo?.episodeTitle);
      }
    } else if (tipId === 3 || tipId === 14) {
      fallbackMeta.ano = onlineInfo && onlineInfo.year || fallbackYear;
      fallbackMeta.genero = onlineInfo && onlineInfo.genero || (tipId === 14 ? "Deporte" : "M\xFAsica");
      fallbackMeta.interprete = onlineInfo && onlineInfo.reparto || (tipId === 14 ? "Deportistas" : "Artista Principal");
      fallbackMeta.director = onlineInfo && onlineInfo.director || "Direcci\xF3n Audiovisual";
      fallbackMeta.productor = onlineInfo && onlineInfo.productora || `Producci\xF3n ${effectiveChannelName}`;
    } else if (tipId === 11) {
      fallbackMeta.ano = onlineInfo && onlineInfo.year || fallbackYear;
      fallbackMeta.genero = onlineInfo && onlineInfo.genero || "M\xFAsica, Videoclip";
      fallbackMeta.interprete = onlineInfo && onlineInfo.reparto || "Artista";
      fallbackMeta.director = onlineInfo && onlineInfo.director || "Direcci\xF3n de Videoclip";
      fallbackMeta.release_date = todayYmd;
      fallbackMeta.sale_start_date = todayYmd;
      fallbackMeta.sello = onlineInfo && onlineInfo.productora || "Independiente";
    } else if (tipId === 6) {
      fallbackMeta.temporada = "1";
    }
    if (onlineInfo?.imageUrl) {
      fallbackMeta.onlineCoverUrl = onlineInfo.imageUrl;
    }
    if (onlineInfo?.posterUrl) {
      fallbackMeta.onlinePosterUrl = onlineInfo.posterUrl;
    }
    if (onlineInfo?.backdropUrl) {
      fallbackMeta.onlineBackdropUrl = onlineInfo.backdropUrl;
    }
    const fallbackSynopsis = sanitizePublicPictaText(
      onlineInfo?.episodeSynopsis ? onlineInfo.episodeSynopsis : onlineInfo?.synopsis ? onlineInfo.synopsis : tipId === 5 ? `Cap\xEDtulo ${extractedSerie.numero || "1"} de la Temporada ${extractedSerie.temporada || "1"} de la serie ${!extractedSerie.missingSerieName ? cleanSerieDisplayName(extractedSerie.serieName) : "en emisi\xF3n"}${extractedSerie.episodeSubtitle ? ` titulado "${extractedSerie.episodeSubtitle}"` : ""}, disponible completo en el canal ${effectiveChannelName}.` : `${fallbackTitle}. Contenido de ${cat} completo publicado en el canal ${effectiveChannelName} de Picta.`
    );
    return {
      title: onlineInfo && onlineInfo.title && !customTitle && tipId !== 5 ? onlineInfo.title : fallbackTitle,
      synopsis: fallbackSynopsis.slice(0, 580),
      tags: ["Picta", effectiveChannelName, cat],
      modelMetadata: Object.keys(fallbackMeta).length > 0 ? fallbackMeta : void 0
    };
  }
}
async function callTelegramBotApi(method, payload = {}) {
  const token = botConfig.telegramBotToken.trim();
  const timeoutMs = method === "getUpdates" ? 25e3 : 15e3;
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || `Error en Telegram API (${method})`);
  }
  return data.result;
}
function stripTelegramHtmlForFallback(htmlText) {
  return String(htmlText || "").replace(/<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|a|tg-spoiler)(?:\s+[^>]*)?>/gi, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").slice(0, 3950);
}
async function sendTelegramStatusMessage(chatId, text, replyToMessageId, inlineKeyboard) {
  try {
    const payload = {
      chat_id: chatId,
      text: text.length > 4090 ? `${text.slice(0, 4050)}...` : text,
      parse_mode: "HTML"
    };
    if (replyToMessageId) {
      payload.reply_to_message_id = replyToMessageId;
    }
    if (inlineKeyboard) {
      payload.reply_markup = { inline_keyboard: inlineKeyboard };
    }
    const sent = await callTelegramBotApi("sendMessage", payload);
    return sent?.message_id || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addLiveLog("telegram", "warn", `Aviso enviando mensaje a Telegram: ${msg}`);
    if (/can't parse entities|parse_mode|too long/i.test(msg)) {
      try {
        const fallbackPayload = {
          chat_id: chatId,
          text: stripTelegramHtmlForFallback(text)
        };
        if (replyToMessageId) fallbackPayload.reply_to_message_id = replyToMessageId;
        if (inlineKeyboard) fallbackPayload.reply_markup = { inline_keyboard: inlineKeyboard };
        const sentFallback = await callTelegramBotApi("sendMessage", fallbackPayload);
        return sentFallback?.message_id || null;
      } catch {
      }
    }
    return null;
  }
}
var lastTelegramEditTime = 0;
async function editTelegramStatusMessage(chatId, messageId, text, inlineKeyboard, force = false) {
  if (!messageId) return;
  const now = Date.now();
  if (!force && now - lastTelegramEditTime < 2500) {
    return;
  }
  lastTelegramEditTime = now;
  try {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text: text.length > 4090 ? `${text.slice(0, 4050)}...` : text,
      parse_mode: "HTML"
    };
    if (inlineKeyboard) {
      payload.reply_markup = { inline_keyboard: inlineKeyboard };
    }
    await callTelegramBotApi("editMessageText", payload);
  } catch (err) {
    const msg = err?.message || String(err);
    if (!msg.includes("message is not modified")) {
      addLiveLog("telegram", "warn", `Aviso editando mensaje #${messageId}: ${msg}`);
      if (/can't parse entities|parse_mode|too long/i.test(msg)) {
        try {
          const fallbackPayload = {
            chat_id: chatId,
            message_id: messageId,
            text: stripTelegramHtmlForFallback(text)
          };
          if (inlineKeyboard) fallbackPayload.reply_markup = { inline_keyboard: inlineKeyboard };
          await callTelegramBotApi("editMessageText", fallbackPayload);
        } catch {
        }
      }
    }
  }
}
async function sendTelegramPhotoWithKeyboard(params) {
  const token = botConfig.telegramBotToken.trim();
  if (!token) return { ok: false, messageId: null, error: "Bot token vac\xEDo" };
  const replyMarkup = params.inlineKeyboard ? { inline_keyboard: params.inlineKeyboard } : void 0;
  const safeCaption = params.captionHtml.length > 1024 ? params.captionHtml.slice(0, 1020) : params.captionHtml;
  if (params.photoUrl && /^https?:\/\//i.test(params.photoUrl)) {
    try {
      const payload = {
        chat_id: params.targetChatId,
        photo: params.photoUrl,
        caption: safeCaption,
        parse_mode: "HTML"
      };
      if (replyMarkup) payload.reply_markup = replyMarkup;
      const sent = await callTelegramBotApi("sendPhoto", payload);
      return { ok: true, messageId: sent?.message_id || null };
    } catch {
    }
  }
  let buf = params.photoBuffer || null;
  if (!buf && params.photoUrl && /^https?:\/\//i.test(params.photoUrl)) {
    try {
      const r = await fetch(params.photoUrl, { signal: AbortSignal.timeout(8e3) });
      if (r.ok) {
        const arr = await r.arrayBuffer();
        if (arr.byteLength > 200) buf = Buffer.from(arr);
      }
    } catch {
    }
  }
  if (buf && buf.byteLength > 200) {
    try {
      const form = new FormData();
      form.append("chat_id", params.targetChatId);
      form.append("photo", new Blob([new Uint8Array(buf)], { type: "image/jpeg" }), "poster.jpg");
      form.append("caption", safeCaption);
      form.append("parse_mode", "HTML");
      if (replyMarkup) {
        form.append("reply_markup", JSON.stringify(replyMarkup));
      }
      const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(2e4)
      });
      const json = await res.json();
      if (json?.ok) {
        return { ok: true, messageId: json.result?.message_id || null };
      }
    } catch {
    }
  }
  try {
    const msgId = await sendTelegramStatusMessage(
      params.targetChatId,
      params.fallbackTextHtml,
      void 0,
      params.inlineKeyboard
    );
    if (msgId) {
      return { ok: true, messageId: msgId, viaFallbackText: true };
    }
    return { ok: false, messageId: null, error: "Telegram no permiti\xF3 enviar el mensaje al canal." };
  } catch (err) {
    return {
      ok: false,
      messageId: null,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
var mtprotoConnectingPromise = null;
async function ensureMtprotoClient() {
  const token = botConfig.telegramBotToken.trim();
  const apiId = Number(botConfig.telegramApiId.trim());
  const apiHash = botConfig.telegramApiHash.trim();
  if (!token || !apiId || !apiHash || Number.isNaN(apiId)) {
    mtprotoConnected = false;
    return null;
  }
  if (mtprotoClient && mtprotoConnected) {
    return mtprotoClient;
  }
  if (mtprotoFloodWaitUntilMs > Date.now()) {
    return null;
  }
  if (mtprotoConnectingPromise) {
    return mtprotoConnectingPromise;
  }
  mtprotoConnectingPromise = (async () => {
    try {
      await ensureMtprotoVaultLoadedOnce();
      if (!mtprotoSessionString) {
        mtprotoSessionString = loadMtprotoSessionFromDisk();
      }
      let client = null;
      let connectedSuccessfully = false;
      const hasSavedSession = Boolean(mtprotoSessionString.trim());
      if (hasSavedSession) {
        try {
          const session = new StringSession(mtprotoSessionString);
          const savedClient = new TelegramClient(session, apiId, apiHash, {
            connectionRetries: 5,
            networkSocket: FastPromisedNetSockets
          });
          await savedClient.connect();
          const authorized = await savedClient.isUserAuthorized();
          if (!authorized) {
            await savedClient.start({ botAuthToken: token });
          }
          client = savedClient;
          connectedSuccessfully = true;
        } catch (savedErr) {
          addLiveLog(
            "mtproto",
            "warn",
            `Sesi\xF3n MTProto previa no v\xE1lida (${savedErr instanceof Error ? savedErr.message : String(savedErr)}). Creando sesi\xF3n limpia con botAuthToken...`
          );
          mtprotoSessionString = "";
          try {
            const sPath = path3.join(STATE_DIR, "mtproto_session.txt");
            if (fs3.existsSync(sPath)) fs3.unlinkSync(sPath);
          } catch {
          }
        }
      }
      if (!connectedSuccessfully || !client) {
        const freshSession = new StringSession("");
        const freshClient = new TelegramClient(freshSession, apiId, apiHash, {
          connectionRetries: 5,
          networkSocket: FastPromisedNetSockets
        });
        await freshClient.start({ botAuthToken: token });
        client = freshClient;
      }
      const savedStr = client.session.save() || "";
      if (savedStr) {
        mtprotoSessionString = savedStr;
        saveMtprotoSessionToDisk(savedStr);
        scheduleSaveMtprotoVaultToTelegram();
      }
      mtprotoClient = client;
      mtprotoConnected = true;
      mtprotoFloodWaitUntilMs = 0;
      addMtprotoDiagLog({
        level: "success",
        dcId: Number(client.session?.dcId) || void 0,
        message: "Cliente MTProto 4 GB conectado y listo para transferencias a m\xE1xima velocidad."
      });
      if (!IS_PREVIEW_INSTANCE) {
        void prewarmAuxiliaryBotClientsInBackground();
      }
      return client;
    } catch (err) {
      mtprotoConnected = false;
      const msg = err instanceof Error ? err.message : String(err);
      const waitMatch = msg.match(/wait of (\d+) seconds/i);
      if (waitMatch) {
        const waitSec = Number(waitMatch[1]) || 60;
        mtprotoFloodWaitUntilMs = Date.now() + (waitSec + 2) * 1e3;
        addLiveLog(
          "mtproto",
          "warn",
          `Telegram DC solicit\xF3 esperar ${waitSec}s antes de abrir sesi\xF3n MTProto.`
        );
      } else {
        addLiveLog("mtproto", "error", `Error conectando MTProto 2 GB: ${msg}`);
      }
      return null;
    } finally {
      mtprotoConnectingPromise = null;
    }
  })();
  return mtprotoConnectingPromise;
}
var MTPROTO_AUX_SESSIONS_FILE = path3.join(STATE_DIR, "mtproto_aux_sessions.json");
var auxiliaryBotClients = /* @__PURE__ */ new Map();
var auxiliaryBotConnecting = /* @__PURE__ */ new Map();
var auxiliaryBotSessionsCache = null;
var mtprotoAuxFloodWaitUntilMs = 0;
function loadAuxiliaryBotSessionsFromDisk() {
  if (auxiliaryBotSessionsCache) return auxiliaryBotSessionsCache;
  try {
    if (fs3.existsSync(MTPROTO_AUX_SESSIONS_FILE)) {
      const parsed = JSON.parse(fs3.readFileSync(MTPROTO_AUX_SESSIONS_FILE, "utf-8"));
      if (Array.isArray(parsed?.sessions)) {
        const loaded = parsed.sessions.map((s) => String(s || "").trim());
        auxiliaryBotSessionsCache = loaded;
        return loaded;
      }
    }
  } catch {
  }
  const empty = [];
  auxiliaryBotSessionsCache = empty;
  return empty;
}
function saveAuxiliaryBotSessionToDisk(slotIndex, sessionStr) {
  if (!sessionStr || !sessionStr.trim() || slotIndex < 1) return;
  try {
    const arr = [...loadAuxiliaryBotSessionsFromDisk()];
    const changed = arr[slotIndex - 1] !== sessionStr.trim();
    arr[slotIndex - 1] = sessionStr.trim();
    auxiliaryBotSessionsCache = arr;
    fs3.writeFileSync(
      MTPROTO_AUX_SESSIONS_FILE,
      JSON.stringify({ sessions: arr, savedAt: (/* @__PURE__ */ new Date()).toISOString() }),
      "utf-8"
    );
    if (changed) {
      scheduleSaveMtprotoVaultToTelegram();
    }
  } catch {
  }
}
async function disconnectAuxiliaryBotClients(clearSaved = false) {
  const entries = Array.from(auxiliaryBotClients.entries());
  auxiliaryBotClients.clear();
  for (const [, auxClient] of entries) {
    await auxClient.disconnect().catch(() => {
    });
  }
  if (clearSaved) {
    auxiliaryBotSessionsCache = [];
    try {
      if (fs3.existsSync(MTPROTO_AUX_SESSIONS_FILE)) {
        fs3.unlinkSync(MTPROTO_AUX_SESSIONS_FILE);
      }
    } catch {
    }
    scheduleSaveMtprotoVaultToTelegram();
  }
}
async function getOrCreateAuxiliaryBotClient(slotIndex) {
  if (slotIndex < 1 || slotIndex >= MTPROTO_TCP_POOL_SIZE) return null;
  const existing = auxiliaryBotClients.get(slotIndex);
  if (existing && existing.connected) {
    return existing;
  }
  const inflight = auxiliaryBotConnecting.get(slotIndex);
  if (inflight) return inflight;
  const token = botConfig.telegramBotToken.trim();
  const apiId = Number(botConfig.telegramApiId.trim());
  const apiHash = botConfig.telegramApiHash.trim();
  if (!token || !apiId || !apiHash || Number.isNaN(apiId)) return null;
  const connectPromise = (async () => {
    try {
      await ensureMtprotoVaultLoadedOnce();
      if (existing) {
        await existing.disconnect().catch(() => {
        });
        auxiliaryBotClients.delete(slotIndex);
      }
      const savedList = loadAuxiliaryBotSessionsFromDisk();
      const savedStr = String(savedList[slotIndex - 1] || "").trim();
      let auxClient = null;
      if (savedStr) {
        try {
          const candidate = new TelegramClient(new StringSession(savedStr), apiId, apiHash, {
            connectionRetries: 3,
            networkSocket: FastPromisedNetSockets
          });
          await candidate.connect();
          const authorized = await candidate.isUserAuthorized();
          if (authorized) {
            auxClient = candidate;
          } else {
            await candidate.disconnect().catch(() => {
            });
          }
        } catch {
        }
      }
      if (!auxClient) {
        if (mtprotoAuxFloodWaitUntilMs > Date.now()) {
          return null;
        }
        await new Promise((r) => setTimeout(r, (slotIndex - 1) * 350));
        if (mtprotoAuxFloodWaitUntilMs > Date.now()) {
          return null;
        }
        const freshClient = new TelegramClient(new StringSession(""), apiId, apiHash, {
          connectionRetries: 3,
          networkSocket: FastPromisedNetSockets
        });
        await freshClient.start({ botAuthToken: token });
        auxClient = freshClient;
      }
      const persisted = auxClient.session.save() || "";
      if (persisted) {
        saveAuxiliaryBotSessionToDisk(slotIndex, persisted);
      }
      auxiliaryBotClients.set(slotIndex, auxClient);
      return auxClient;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const waitMatch = msg.match(/(?:FLOOD_WAIT_|wait of )(\d+)/i);
      if (waitMatch) {
        const waitSec = Math.max(5, Number(waitMatch[1]) || 30);
        mtprotoAuxFloodWaitUntilMs = Date.now() + (waitSec + 2) * 1e3;
        addMtprotoDiagLog({
          level: "warn",
          message: `Sesi\xF3n auxiliar #${slotIndex} en enfriamiento Telegram (${waitSec}s); el resto de sockets contin\xFAan descargando.`
        });
      } else {
        addMtprotoDiagLog({
          level: "warn",
          message: `No se pudo abrir sesi\xF3n auxiliar #${slotIndex}: ${msg.slice(0, 140)}`
        });
      }
      return null;
    } finally {
      auxiliaryBotConnecting.delete(slotIndex);
    }
  })();
  auxiliaryBotConnecting.set(slotIndex, connectPromise);
  return connectPromise;
}
var auxPrewarmPromise = null;
async function prewarmAuxiliaryBotClientsInBackground() {
  if (auxPrewarmPromise) return auxPrewarmPromise;
  auxPrewarmPromise = (async () => {
    try {
      const auxCount = Math.max(0, MTPROTO_TCP_POOL_SIZE - 1);
      if (auxCount <= 0) return;
      await Promise.all(
        Array.from(
          { length: auxCount },
          (_, idx) => getOrCreateAuxiliaryBotClient(idx + 1).catch(() => null)
        )
      );
    } finally {
      auxPrewarmPromise = null;
    }
  })();
  return auxPrewarmPromise;
}
async function resetAndReconnectMtprotoClient(reason) {
  addLiveLog(
    "mtproto",
    "warn",
    `Regenerando sesi\xF3n MTProto 2 GB autom\xE1ticamente (${reason})...`
  );
  await disconnectAuxiliaryBotClients(true);
  try {
    if (mtprotoClient) {
      await mtprotoClient.disconnect().catch(() => {
      });
    }
  } catch {
  }
  mtprotoClient = null;
  mtprotoConnected = false;
  mtprotoSessionString = "";
  try {
    if (fs3.existsSync(MTPROTO_SESSION_FILE)) {
      fs3.unlinkSync(MTPROTO_SESSION_FILE);
    }
    const legacyFile = path3.join(LEGACY_DATA_DIR, "mtproto_session_v2.json");
    if (fs3.existsSync(legacyFile)) {
      fs3.unlinkSync(legacyFile);
    }
  } catch {
  }
  return ensureMtprotoClient();
}
async function downloadDocumentFast(client, doc, outputFilePath, totalBytes, onProgress, jobId, peerId, messageId) {
  const CHUNK_TIMEOUT_MS = 22e3;
  const fileHandle = await fs3.promises.open(outputFilePath, "w+");
  if (totalBytes > 0) {
    await fileHandle.truncate(totalBytes).catch(() => {
    });
  }
  let currentDcId = Number(doc.dcId) || 1;
  let currentFileReference = Buffer.isBuffer(doc.fileReference) ? doc.fileReference : Buffer.from(doc.fileReference || []);
  let force512KbMode = false;
  const pendingQueue = buildDirectDownloadChunks(
    totalBytes,
    MTPROTO_TURBO_CHUNK_BYTES
  );
  const initialQueueLen = pendingQueue.length;
  let downloadedBytes = 0;
  let fatalError = null;
  let reconnectingPromise = null;
  let refreshingFileRefPromise = null;
  const cancelAbort = new AbortController();
  const cancelMonitor = jobId ? setInterval(() => {
    if (cancelledJobIds.has(jobId)) {
      fatalError = new Error("SUBIDA_CANCELADA_POR_USUARIO");
      cancelAbort.abort();
    }
  }, 350) : null;
  const desiredTotalSockets = computePoolWarmupCount(totalBytes, MTPROTO_TCP_POOL_SIZE);
  const slotClients = [client];
  const senderSlots = [null];
  const inFlightCounts = [0];
  const healthyFlags = [true];
  const slotDisabled = [false];
  const slotConsecutiveErrors = [0];
  const slotChunkCounts = [0];
  const slotLoggedFirstError = [false];
  let roundRobinCounter = 0;
  let completedChunks = 0;
  let totalChunkLatencyMs = 0;
  let lastReturnedChunkBytes = 0;
  let chunkErrorsCount = 0;
  let leaseKeepaliveTimer = null;
  let telemetryTimer = null;
  const downloadStartTimeMs = Date.now();
  let lastWindowTimeMs = downloadStartTimeMs;
  let lastWindowBytes = 0;
  let lastCpuUsage = process.cpuUsage();
  const getActiveSocketCount = () => {
    let active = 0;
    for (let i = 0; i < senderSlots.length; i++) {
      if (!slotDisabled[i] && healthyFlags[i] && senderSlots[i]) active++;
    }
    return Math.max(1, active);
  };
  const emitTelemetrySnapshot = (label) => {
    const now = Date.now();
    const dtSec = Math.max(0.25, (now - lastWindowTimeMs) / 1e3);
    const dBytes = Math.max(0, downloadedBytes - lastWindowBytes);
    const windowMBpsNum = Number((dBytes / (1024 * 1024) / dtSec).toFixed(2));
    const totalSec = Math.max(0.25, (now - downloadStartTimeMs) / 1e3);
    const avgTotalMBpsNum = Number((downloadedBytes / (1024 * 1024) / totalSec).toFixed(2));
    const cpuDelta = process.cpuUsage(lastCpuUsage);
    lastCpuUsage = process.cpuUsage();
    const cpuPct = Math.round((cpuDelta.user + cpuDelta.system) / 1e3 / (dtSec * 1e3) * 100);
    lastWindowTimeMs = now;
    lastWindowBytes = downloadedBytes;
    const avgMs = completedChunks > 0 ? Math.round(totalChunkLatencyMs / completedChunks) : 0;
    const activeSocketsNow = getActiveSocketCount();
    const distStr = slotChunkCounts.map((c, idx) => slotDisabled[idx] ? `s${idx}:${c}(off)` : `s${idx}:${c}`).join(" ");
    addMtprotoDiagLog({
      level: chunkErrorsCount > 25 && activeSocketsNow <= 1 ? "warn" : "info",
      dcId: currentDcId,
      activeSockets: activeSocketsNow,
      maxSockets: desiredTotalSockets,
      windowMBps: windowMBpsNum,
      avgMBps: avgTotalMBpsNum,
      cpuPct,
      avgLatencyMs: avgMs,
      errorCount: chunkErrorsCount,
      reparto: distStr,
      message: `${label} DC #${currentDcId}: ${activeSocketsNow}/${desiredTotalSockets} sockets \xB7 ventana=${windowMBpsNum.toFixed(2)} MB/s (total ${avgTotalMBpsNum.toFixed(2)} MB/s) \xB7 CPU=${cpuPct}% \xB7 bloque=${Math.round(lastReturnedChunkBytes / 1024)} KB \xB7 latencia=${avgMs} ms/chunk \xB7 errores=${chunkErrorsCount} \xB7 reparto=[${distStr}]`
    });
  };
  const clearExportedSenderReleaseTimer = (targetClient, dcId) => {
    const timers = targetClient?._exportedSenderReleaseTimeouts;
    if (timers && typeof timers.get === "function") {
      const existingTimer = timers.get(dcId);
      if (existingTimer) {
        clearTimeout(existingTimer);
        timers.delete(dcId);
      }
    }
  };
  try {
    const resolveClientSenderForDc = async (targetClient, targetDcId) => {
      const homeDcId = Number(targetClient.session?.dcId) || void 0;
      if (shouldUseMainClientSenderForPrimarySlot(targetDcId, homeDcId)) {
        return targetClient._sender || await targetClient.getSender(void 0);
      }
      const exported = await targetClient.getSender(targetDcId);
      clearExportedSenderReleaseTimer(targetClient, targetDcId);
      return exported;
    };
    senderSlots[0] = await resolveClientSenderForDc(client, currentDcId);
    healthyFlags[0] = Boolean(senderSlots[0]);
    leaseKeepaliveTimer = setInterval(() => {
      for (let i = 0; i < slotClients.length; i++) {
        if (slotClients[i] && !slotDisabled[i]) {
          clearExportedSenderReleaseTimer(slotClients[i], currentDcId);
        }
      }
    }, 1e4);
    telemetryTimer = setInterval(() => {
      if (!cancelAbort.signal.aborted && !fatalError && completedChunks > 0) {
        emitTelemetrySnapshot("Telemetr\xEDa");
      }
    }, 1e4);
    const warmAuxiliarySlots = async () => {
      if (desiredTotalSockets <= 1) return;
      const poolDcSnapshot = currentDcId;
      await Promise.all(
        Array.from({ length: desiredTotalSockets - 1 }, async (_, idx) => {
          const slotNum = idx + 1;
          if (cancelAbort.signal.aborted || fatalError || currentDcId !== poolDcSnapshot) return;
          try {
            const auxClient = await getOrCreateAuxiliaryBotClient(slotNum);
            if (!auxClient) return;
            if (cancelAbort.signal.aborted || fatalError || currentDcId !== poolDcSnapshot) return;
            const auxSender = await resolveClientSenderForDc(auxClient, poolDcSnapshot);
            if (!auxSender) return;
            if (cancelAbort.signal.aborted || fatalError || currentDcId !== poolDcSnapshot) return;
            slotClients.push(auxClient);
            senderSlots.push(auxSender);
            inFlightCounts.push(0);
            healthyFlags.push(true);
            slotDisabled.push(false);
            slotConsecutiveErrors.push(0);
            slotChunkCounts.push(0);
            slotLoggedFirstError.push(false);
          } catch (auxErr) {
            addMtprotoDiagLog({
              level: "warn",
              dcId: poolDcSnapshot,
              message: `Socket auxiliar #${slotNum} no pudo conectarse a DC #${poolDcSnapshot}: ${auxErr instanceof Error ? auxErr.message.slice(0, 120) : String(auxErr)}`
            });
          }
        })
      );
      if (!cancelAbort.signal.aborted && !fatalError) {
        const activeNow = getActiveSocketCount();
        addMtprotoDiagLog({
          level: activeNow > 1 ? "success" : "warn",
          dcId: currentDcId,
          activeSockets: activeNow,
          maxSockets: desiredTotalSockets,
          message: `Pool MTProto DC #${currentDcId}: ${activeNow}/${desiredTotalSockets} sesiones TCP independientes activas (${Math.min(MTPROTO_SAFE_PARALLEL_WORKERS, Math.max(1, initialQueueLen))} hilos x 1 MB \xB7 FastSocket).`
        });
      }
    };
    await Promise.race([
      warmAuxiliarySlots(),
      new Promise((resolve) => setTimeout(resolve, 1500))
    ]);
    const renewPrimaryDcSender = async (forceReconnect = false) => {
      const homeDcId = Number(client.session?.dcId) || void 0;
      const isHomeDc = shouldUseMainClientSenderForPrimarySlot(currentDcId, homeDcId);
      const primary = senderSlots[0];
      if (!forceReconnect && primary && primary.isConnected?.()) {
        if (isHomeDc) {
          return primary;
        }
        try {
          senderSlots[0] = await client.getSender(currentDcId);
          healthyFlags[0] = true;
          return senderSlots[0];
        } catch {
        }
      }
      if (reconnectingPromise) {
        return reconnectingPromise;
      }
      reconnectingPromise = (async () => {
        try {
          senderSlots[0] = await resolveClientSenderForDc(client, currentDcId);
          healthyFlags[0] = Boolean(senderSlots[0]);
          return senderSlots[0];
        } catch {
          return senderSlots[0];
        } finally {
          reconnectingPromise = null;
        }
      })();
      return reconnectingPromise;
    };
    const refreshFileReferenceSafe = async () => {
      if (!peerId || !messageId) return;
      if (refreshingFileRefPromise) {
        return refreshingFileRefPromise;
      }
      refreshingFileRefPromise = (async () => {
        try {
          const freshMsgs = await client.getMessages(peerId, { ids: [messageId] });
          const freshMedia = freshMsgs?.[0]?.media;
          const freshDoc = freshMedia?.document || freshMedia?.photo;
          if (freshDoc?.fileReference) {
            currentFileReference = Buffer.isBuffer(freshDoc.fileReference) ? freshDoc.fileReference : Buffer.from(freshDoc.fileReference);
          }
        } catch {
        } finally {
          refreshingFileRefPromise = null;
        }
      })();
      return refreshingFileRefPromise;
    };
    const buildInputLocation = () => {
      if (doc.isPhoto) {
        return new Api.InputPhotoFileLocation({
          id: typeof doc.id === "bigint" || typeof doc.id === "string" || typeof doc.id === "number" ? bigInt(String(doc.id)) : doc.id,
          accessHash: typeof doc.accessHash === "bigint" || typeof doc.accessHash === "string" || typeof doc.accessHash === "number" ? bigInt(String(doc.accessHash)) : doc.accessHash,
          fileReference: currentFileReference,
          thumbSize: doc.thumbSize || ""
        });
      }
      return new Api.InputDocumentFileLocation({
        id: typeof doc.id === "bigint" || typeof doc.id === "string" || typeof doc.id === "number" ? bigInt(String(doc.id)) : doc.id,
        accessHash: typeof doc.accessHash === "bigint" || typeof doc.accessHash === "string" || typeof doc.accessHash === "number" ? bigInt(String(doc.accessHash)) : doc.accessHash,
        fileReference: currentFileReference,
        thumbSize: doc.thumbSize || ""
      });
    };
    const worker = async () => {
      while (true) {
        if (fatalError || cancelAbort.signal.aborted) break;
        if (jobId && cancelledJobIds.has(jobId)) {
          fatalError = new Error("SUBIDA_CANCELADA_POR_USUARIO");
          cancelAbort.abort();
          break;
        }
        const rawChunk = pendingQueue.shift();
        if (!rawChunk) break;
        if (force512KbMode && rawChunk.requestLimit > MTPROTO_FALLBACK_CHUNK_BYTES) {
          const splitParts = splitChunkInto512KbParts(rawChunk, totalBytes);
          pendingQueue.unshift(...splitParts);
          continue;
        }
        const chunk = rawChunk;
        if (chunk.expectedBytes <= 0) continue;
        let attempt = 0;
        let success = false;
        while (attempt < 10 && !success && !fatalError && !cancelAbort.signal.aborted) {
          if (jobId && cancelledJobIds.has(jobId)) {
            fatalError = new Error("SUBIDA_CANCELADA_POR_USUARIO");
            cancelAbort.abort();
            break;
          }
          attempt++;
          let timeoutHandle = null;
          let onAbortHandler = null;
          let chosenSlotIdx = 0;
          try {
            for (let sIdx = 1; sIdx < senderSlots.length; sIdx++) {
              if (slotDisabled[sIdx]) {
                healthyFlags[sIdx] = false;
                continue;
              }
              const sObj = senderSlots[sIdx];
              const sClient = slotClients[sIdx];
              const transportUp = sObj?._connection ? sObj._connection.isConnected?.() !== false : true;
              healthyFlags[sIdx] = Boolean(
                sObj && sClient && sObj.isConnected?.() && !sObj.isReconnecting && transportUp
              );
            }
            chosenSlotIdx = selectLeastBusySenderSlot(
              inFlightCounts,
              healthyFlags,
              roundRobinCounter++
            );
            let slotClient = slotClients[chosenSlotIdx] || client;
            let sender = senderSlots[chosenSlotIdx];
            if (chosenSlotIdx === 0 || slotDisabled[chosenSlotIdx] || !sender || !sender.isConnected?.()) {
              chosenSlotIdx = 0;
              slotClient = client;
              sender = await renewPrimaryDcSender(false);
            }
            inFlightCounts[chosenSlotIdx] = (inFlightCounts[chosenSlotIdx] || 0) + 1;
            const req = new Api.upload.GetFile({
              location: buildInputLocation(),
              offset: bigInt(chunk.offset),
              limit: chunk.requestLimit
            });
            const timeoutPromise = new Promise((_, reject) => {
              timeoutHandle = setTimeout(() => {
                reject(new Error(`CHUNK_TIMEOUT_${CHUNK_TIMEOUT_MS}MS`));
              }, CHUNK_TIMEOUT_MS);
            });
            const abortPromise = new Promise((_, reject) => {
              if (cancelAbort.signal.aborted) {
                reject(new Error("SUBIDA_CANCELADA_POR_USUARIO"));
                return;
              }
              onAbortHandler = () => reject(new Error("SUBIDA_CANCELADA_POR_USUARIO"));
              cancelAbort.signal.addEventListener("abort", onAbortHandler, { once: true });
            });
            const chunkStartMs = Date.now();
            const res = await Promise.race([
              slotClient.invokeWithSender(req, sender),
              timeoutPromise,
              abortPromise
            ]);
            if (res && res.bytes) {
              const buf = Buffer.isBuffer(res.bytes) ? res.bytes : Buffer.from(res.bytes);
              if (buf.length === 0) {
                throw new Error("Respuesta de bytes vac\xEDa de Telegram");
              }
              await fileHandle.write(buf, 0, buf.length, chunk.offset);
              downloadedBytes += buf.length;
              slotChunkCounts[chosenSlotIdx] = (slotChunkCounts[chosenSlotIdx] || 0) + 1;
              slotConsecutiveErrors[chosenSlotIdx] = 0;
              completedChunks++;
              totalChunkLatencyMs += Math.max(1, Date.now() - chunkStartMs);
              lastReturnedChunkBytes = buf.length;
              onProgress(Math.min(downloadedBytes, totalBytes), totalBytes, {
                dcId: currentDcId,
                activeSockets: getActiveSocketCount(),
                maxSockets: desiredTotalSockets
              });
              if (buf.length < chunk.expectedBytes && buf.length % 4096 === 0) {
                const remOffset = chunk.offset + buf.length;
                const remExpected = chunk.expectedBytes - buf.length;
                if (remExpected > 0) {
                  pendingQueue.unshift({
                    index: chunk.index,
                    offset: remOffset,
                    requestLimit: MTPROTO_FALLBACK_CHUNK_BYTES,
                    expectedBytes: remExpected
                  });
                }
              }
              success = true;
            } else {
              throw new Error("Respuesta de bytes vac\xEDa de Telegram");
            }
          } catch (err) {
            chunkErrorsCount++;
            slotConsecutiveErrors[chosenSlotIdx] = (slotConsecutiveErrors[chosenSlotIdx] || 0) + 1;
            const rawErrMsg = String(err?.errorMessage || err?.message || err || "Error desconocido").slice(0, 160);
            const classified = classifyMtprotoDownloadError(err);
            if (classified.kind === "cancelled" || jobId && cancelledJobIds.has(jobId)) {
              fatalError = new Error("SUBIDA_CANCELADA_POR_USUARIO");
              cancelAbort.abort();
              break;
            }
            if (!slotLoggedFirstError[chosenSlotIdx]) {
              slotLoggedFirstError[chosenSlotIdx] = true;
              addMtprotoDiagLog({
                level: "warn",
                dcId: currentDcId,
                activeSockets: getActiveSocketCount(),
                maxSockets: desiredTotalSockets,
                message: `Socket s${chosenSlotIdx} error en DC #${currentDcId} (${classified.kind}): ${rawErrMsg}`
              });
            }
            if (chosenSlotIdx > 0 && (classified.kind === "fatal_auth" || slotConsecutiveErrors[chosenSlotIdx] >= 3)) {
              if (!slotDisabled[chosenSlotIdx]) {
                slotDisabled[chosenSlotIdx] = true;
                healthyFlags[chosenSlotIdx] = false;
                const badClient = slotClients[chosenSlotIdx];
                if (classified.kind === "fatal_auth") {
                  auxiliaryBotClients.delete(chosenSlotIdx);
                  if (badClient) {
                    void badClient.disconnect().catch(() => {
                    });
                  }
                }
                addMtprotoDiagLog({
                  level: "warn",
                  dcId: currentDcId,
                  activeSockets: getActiveSocketCount(),
                  maxSockets: desiredTotalSockets,
                  message: `Socket s${chosenSlotIdx} aislado tras ${slotConsecutiveErrors[chosenSlotIdx]} fallos (${rawErrMsg}); los restantes ${getActiveSocketCount()} socket(s) contin\xFAan.`
                });
                onProgress(Math.min(downloadedBytes, totalBytes), totalBytes, {
                  dcId: currentDcId,
                  activeSockets: getActiveSocketCount(),
                  maxSockets: desiredTotalSockets
                });
              }
              attempt = Math.max(0, attempt - 1);
              continue;
            }
            if (classified.kind === "fatal_auth") {
              fatalError = new Error(classified.message);
              break;
            }
            if (classified.kind === "flood_wait") {
              if (classified.waitSeconds <= MTPROTO_SLEEP_THRESHOLD_SECONDS) {
                attempt = Math.max(0, attempt - 1);
                await new Promise((r) => setTimeout(r, (classified.waitSeconds + 1) * 1e3));
                continue;
              }
              fatalError = new Error(classified.message);
              break;
            }
            if (classified.kind === "file_migrate") {
              currentDcId = classified.newDcId;
              for (let sIdx = 1; sIdx < senderSlots.length; sIdx++) {
                if (slotDisabled[sIdx]) continue;
                try {
                  const auxC = slotClients[sIdx];
                  if (auxC && auxC.connected) {
                    senderSlots[sIdx] = await resolveClientSenderForDc(auxC, currentDcId);
                    healthyFlags[sIdx] = Boolean(senderSlots[sIdx]);
                  } else {
                    healthyFlags[sIdx] = false;
                  }
                } catch {
                  healthyFlags[sIdx] = false;
                }
              }
              attempt = Math.max(0, attempt - 1);
              await renewPrimaryDcSender(true);
              continue;
            }
            if (classified.kind === "limit_invalid" && chunk.requestLimit > MTPROTO_FALLBACK_CHUNK_BYTES) {
              force512KbMode = true;
              const splitParts = splitChunkInto512KbParts(chunk, totalBytes);
              pendingQueue.unshift(...splitParts);
              success = true;
              break;
            }
            if (classified.kind === "file_reference_expired") {
              await refreshFileReferenceSafe();
            }
            if (classified.kind === "transient_network") {
              if (chosenSlotIdx > 0) {
                healthyFlags[chosenSlotIdx] = false;
              } else {
                await renewPrimaryDcSender(true);
              }
            }
            if (attempt >= 10) {
              fatalError = err instanceof Error ? err : new Error(classified.message);
              break;
            }
            await new Promise((r) => setTimeout(r, Math.min(3e3, 500 * attempt)));
          } finally {
            inFlightCounts[chosenSlotIdx] = Math.max(0, (inFlightCounts[chosenSlotIdx] || 1) - 1);
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (onAbortHandler) {
              cancelAbort.signal.removeEventListener("abort", onAbortHandler);
            }
          }
        }
      }
    };
    const workerCount = Math.min(MTPROTO_SAFE_PARALLEL_WORKERS, Math.max(1, initialQueueLen));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (fatalError) {
      throw fatalError;
    }
  } finally {
    if (completedChunks > 0) {
      emitTelemetrySnapshot(fatalError ? "Resumen (interrumpido)" : "Resumen");
    }
    if (telemetryTimer) clearInterval(telemetryTimer);
    if (leaseKeepaliveTimer) clearInterval(leaseKeepaliveTimer);
    if (cancelMonitor) clearInterval(cancelMonitor);
    await fileHandle.close().catch(() => {
    });
  }
}
async function downloadFullVideoFromTelegram(job, statusMsgId) {
  const safeExt = path3.extname(job.fileName) || ".mp4";
  const targetFilePath = path3.join(TMP_UPLOAD_DIR, `${job.id}${safeExt}`);
  job.tempFilePath = targetFilePath;
  if (job.expectedBytes > 0 && fs3.existsSync(targetFilePath) && fs3.statSync(targetFilePath).size === job.expectedBytes) {
    job.downloadedBytes = job.expectedBytes;
    job.diskVerifiedBytes = job.expectedBytes;
    job.integrityVerified = true;
    job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    saveJobsToDisk();
    addLiveLog(
      "system",
      "info",
      `Archivo "${job.fileName}" (${formatBytes(job.expectedBytes)}) ya verificado al 100% en disco scratch (${TMP_UPLOAD_DIR}). Pasando directo a S3 MinIO.`
    );
    return targetFilePath;
  }
  const spaceCheck = ensureScratchSpaceForFile(
    TMP_UPLOAD_DIR,
    job.expectedBytes,
    getProtectedScratchPaths(job.id)
  );
  if (spaceCheck.deletedFiles.length > 0) {
    addLiveLog(
      "system",
      "info",
      `Limpieza LRU en disco scratch (${TMP_UPLOAD_DIR}): liberados ${formatBytes(spaceCheck.freedBytes)} (${spaceCheck.deletedFiles.length} archivo(s) antiguo(s)).`
    );
  }
  if (!spaceCheck.ok) {
    throw new Error(
      `Espacio insuficiente en el disco temporal (${TMP_UPLOAD_DIR}): se requieren ${formatBytes(job.expectedBytes)} y hay ${formatBytes(spaceCheck.freeBytesAfter)} disponibles.`
    );
  }
  job.stage = "downloading_mtproto";
  job.downloadedBytes = 0;
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  let lastTelegramEdit = 0;
  if (job.sourceType === "http_url" && job.sourceUrl) {
    const startTimeHttp = Date.now();
    const controller = new AbortController();
    const cancelWatch = setInterval(() => {
      if (cancelledJobIds.has(job.id)) {
        controller.abort();
      }
    }, 350);
    const outStream = fs3.createWriteStream(targetFilePath);
    try {
      const res = await fetch(job.sourceUrl, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"
        }
      });
      if (!res.ok || !res.body) {
        throw new Error(`El enlace devolvi\xF3 HTTP ${res.status}`);
      }
      const headerLen = Number(res.headers.get("content-length") || 0);
      if (headerLen > 0) {
        job.expectedBytes = headerLen;
        if (headerLen > PICTA_S3_MAX_OBJECT_BYTES) {
          throw new Error(
            `El archivo (${formatBytes(headerLen)}) supera el l\xEDmite m\xE1ximo de 5 GB de Picta.`
          );
        }
      }
      const reader = res.body.getReader();
      let downloaded = 0;
      while (true) {
        if (cancelledJobIds.has(job.id)) {
          throw new Error("SUBIDA_CANCELADA_POR_USUARIO");
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          downloaded += value.byteLength;
          if (downloaded > PICTA_S3_MAX_OBJECT_BYTES) {
            throw new Error("La descarga super\xF3 el l\xEDmite m\xE1ximo de 5 GB de Picta.");
          }
          if (!outStream.write(value)) {
            await new Promise((resolve) => outStream.once("drain", resolve));
          }
          job.downloadedBytes = downloaded;
          const elapsed = Math.max(0.5, (Date.now() - startTimeHttp) / 1e3);
          job.speedMBps = Number((downloaded / (1024 * 1024) / elapsed).toFixed(2));
          const totalNum = job.expectedBytes || downloaded;
          const pct = totalNum > 0 ? Math.min(100, Math.round(downloaded / totalNum * 100)) : 0;
          currentActivity = `Descargando desde enlace HTTP (${job.speedMBps} MB/s): ${job.fileName} \u2014 ${formatBytes(downloaded)}`;
          const now = Date.now();
          if (now - lastTelegramEdit > 3e3) {
            lastTelegramEdit = now;
            void editTelegramStatusMessage(
              job.telegramChatId,
              statusMsgId,
              `${hudHeader("FASE 1/4 \xB7 DESCARGA DESDE URL DIRECTA")}
` + hudBox([
                `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}`,
                `\u{1F4CA} <b>Progreso:</b> <code>${renderVisualBar(pct)}</code>`,
                `\u{1F4E6} <b>Transferido:</b> ${formatBytes(downloaded)}${job.expectedBytes > 0 ? ` / ${formatBytes(job.expectedBytes)}` : ""}`,
                `\u26A1 <b>Velocidad:</b> ${job.speedMBps} MB/s`
              ]),
              [[{ text: "\u{1F6D1} Cancelar subida", callback_data: `cancel_job:${job.id}` }]]
            );
          }
        }
      }
      await new Promise((resolve, reject) => {
        outStream.end(() => resolve());
        outStream.on("error", reject);
      });
      const finalStat = fs3.statSync(targetFilePath);
      if (job.expectedBytes <= 0) {
        job.expectedBytes = finalStat.size;
      }
      job.downloadedBytes = finalStat.size;
      job.diskVerifiedBytes = finalStat.size;
      const totalDur = Math.max(0.5, (Date.now() - startTimeHttp) / 1e3);
      job.speedMBps = Number((finalStat.size / (1024 * 1024) / totalDur).toFixed(2));
      await editTelegramStatusMessage(
        job.telegramChatId,
        statusMsgId,
        `${hudHeader("FASE 1/4 \xB7 DESCARGA HTTP COMPLETADA")}
` + hudBox([
          `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}`,
          `\u{1F4CA} <b>Progreso:</b> <code>${renderVisualBar(100)}</code>`,
          `\u{1F4E6} <b>Descargado:</b> ${formatBytes(job.downloadedBytes)}`,
          `\u26A1 <b>Velocidad media:</b> ${job.speedMBps} MB/s`
        ]) + `
\u23F3 <i>Verificando integridad en disco antes de transmitir a Picta...</i>`,
        void 0,
        true
      );
      return targetFilePath;
    } catch (err) {
      outStream.destroy();
      try {
        if (fs3.existsSync(targetFilePath)) fs3.unlinkSync(targetFilePath);
      } catch {
      }
      if (cancelledJobIds.has(job.id) || err instanceof Error && err.name === "AbortError") {
        throw new Error("SUBIDA_CANCELADA_POR_USUARIO");
      }
      throw err;
    } finally {
      clearInterval(cancelWatch);
    }
  }
  let client = await ensureMtprotoClient();
  for (let retry = 0; !client && retry < 3; retry++) {
    addLiveLog(
      "mtproto",
      "warn",
      `Reintentando conectar MTProto 2 GB (intento ${retry + 1}/3)...`
    );
    await new Promise((r) => setTimeout(r, 2e3));
    client = await ensureMtprotoClient();
  }
  while (!client && mtprotoFloodWaitUntilMs > Date.now()) {
    const remainingSec = Math.max(
      1,
      Math.ceil((mtprotoFloodWaitUntilMs - Date.now()) / 1e3)
    );
    currentActivity = `Esperando ${remainingSec}s de enfriamiento en Telegram MTProto para descargar "${job.title}"...`;
    await new Promise((r) => setTimeout(r, Math.min(5e3, remainingSec * 1e3)));
    if (Date.now() >= mtprotoFloodWaitUntilMs) {
      client = await ensureMtprotoClient();
    }
  }
  if (!client) {
    if (job.expectedBytes > 0 && job.expectedBytes <= 20 * 1024 * 1024 && job.fileId) {
      addLiveLog(
        "telegram",
        "info",
        `MTProto temporalmente no disponible; usando Bot API est\xE1ndar para archivo de ${formatBytes(job.expectedBytes)}...`
      );
      const buf = await downloadTelegramThumbnailBuffer(job.fileId);
      if (buf && buf.byteLength > 0) {
        fs3.writeFileSync(targetFilePath, buf);
        job.downloadedBytes = buf.byteLength;
        job.diskVerifiedBytes = buf.byteLength;
        job.integrityVerified = true;
        job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        saveJobsToDisk();
        return targetFilePath;
      }
    }
    throw new Error(
      "No se pudo conectar el cliente MTProto 2 GB con Telegram tras 3 intentos. Por favor pulsa Reintentar abajo."
    );
  }
  const isTelegramLinkSource = job.sourceType === "telegram_link" && Boolean(job.sourcePeerRef) && Number(job.sourceMessageId || 0) > 0;
  const resolvedLinkPeer = isTelegramLinkSource ? /^-?\d+$/.test(String(job.sourcePeerRef)) ? Number(job.sourcePeerRef) : String(job.sourcePeerRef) : Number(job.telegramChatId);
  const resolvedMsgIdForMtproto = isTelegramLinkSource ? Number(job.sourceMessageId) : job.telegramMessageId;
  const peerId = Number(job.telegramChatId);
  const startTime = Date.now();
  let lastNetTelemetry = {
    dcId: 1,
    activeSockets: 1,
    maxSockets: computePoolWarmupCount(job.expectedBytes, MTPROTO_TCP_POOL_SIZE)
  };
  const onProgress = (downNum, totalNum, telemetry) => {
    if (telemetry) {
      lastNetTelemetry = telemetry;
    }
    job.downloadedBytes = downNum;
    const elapsedSec = Math.max(0.5, (Date.now() - startTime) / 1e3);
    job.speedMBps = Number((downNum / (1024 * 1024) / elapsedSec).toFixed(2));
    const pct = totalNum > 0 ? Math.min(100, Math.round(downNum / totalNum * 100)) : 0;
    const netHud = formatMtprotoDownloadHudLine({
      dcId: lastNetTelemetry.dcId,
      activeSockets: lastNetTelemetry.activeSockets,
      maxSockets: lastNetTelemetry.maxSockets,
      speedMBps: job.speedMBps
    });
    currentActivity = `Descargando de Telegram (${netHud}): ${job.fileName} \u2014 ${formatBytes(downNum)} / ${formatBytes(totalNum)} (${pct}%)`;
    const now = Date.now();
    if (now - lastTelegramEdit > 3e3) {
      lastTelegramEdit = now;
      const qCount = uploadQueue.length;
      const remainingBytes = Math.max(0, totalNum - downNum);
      const etaSec = job.speedMBps > 0.1 ? Math.round(remainingBytes / (job.speedMBps * 1024 * 1024)) : 0;
      const etaLabel = etaSec > 0 ? etaSec >= 60 ? `${Math.floor(etaSec / 60)}m ${etaSec % 60}s` : `${etaSec}s` : "calculando...";
      void editTelegramStatusMessage(
        job.telegramChatId,
        statusMsgId,
        `${hudHeader("FASE 1/4 \xB7 DESCARGA MTPROTO 4 GB")}
` + hudBox([
          `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}`,
          `\u{1F4CA} <b>Progreso:</b> <code>${renderVisualBar(pct)}</code>`,
          `\u{1F4E6} <b>Transferido:</b> ${formatBytes(downNum)} / ${formatBytes(totalNum)}`,
          `\u{1F310} <b>Red MTProto:</b> ${escapeHtml(`DC #${lastNetTelemetry.dcId} \xB7 ${lastNetTelemetry.activeSockets}/${lastNetTelemetry.maxSockets} sockets TCP`)}`,
          `\u26A1 <b>Velocidad:</b> ${job.speedMBps} MB/s \xB7 \u23F1\uFE0F ETA ~${etaLabel}`,
          qCount > 0 ? `\u23F3 <b>En cola despu\xE9s:</b> ${qCount} video(s)` : null
        ]),
        [[{ text: "\u{1F6D1} Cancelar subida", callback_data: `cancel_job:${job.id}` }]]
      );
    }
  };
  const decodedFid = job.fileId ? decodeTelegramBotFileId(job.fileId) : null;
  let fastDownloadDone = false;
  if (decodedFid && decodedFid.valid && job.expectedBytes > 0) {
    lastNetTelemetry.dcId = decodedFid.dcId;
    try {
      addLiveLog(
        "mtproto",
        "info",
        `Iniciando descarga directa DC #${decodedFid.dcId} (${lastNetTelemetry.maxSockets} sesiones TCP \xB7 ${MTPROTO_SAFE_PARALLEL_WORKERS} hilos x 1 MB desde file_id): "${job.fileName}" (${formatBytes(job.expectedBytes)})`
      );
      await downloadDocumentFast(
        client,
        {
          dcId: decodedFid.dcId,
          id: bigInt(decodedFid.mediaId),
          accessHash: bigInt(decodedFid.accessHash),
          fileReference: decodedFid.fileReference,
          isPhoto: decodedFid.isPhoto,
          thumbSize: ""
        },
        targetFilePath,
        job.expectedBytes,
        onProgress,
        job.id,
        peerId,
        job.telegramMessageId
      );
      fastDownloadDone = true;
    } catch (directFidErr) {
      const fidErrMsg = directFidErr instanceof Error ? directFidErr.message : String(directFidErr);
      if (fidErrMsg.includes("SUBIDA_CANCELADA_POR_USUARIO") || cancelledJobIds.has(job.id)) {
        throw new Error("SUBIDA_CANCELADA_POR_USUARIO");
      }
      addLiveLog(
        "mtproto",
        "warn",
        `Aviso en descarga directa por file_id (${fidErrMsg}). Resolviendo mensaje #${job.telegramMessageId} para refrescar referencia...`
      );
      if (/AUTH_KEY_DUPLICATED|AUTH_KEY_UNREGISTERED|SESSION_REVOKED/i.test(fidErrMsg)) {
        const freshClient = await resetAndReconnectMtprotoClient(fidErrMsg);
        if (freshClient) {
          client = freshClient;
        }
      }
    }
  }
  if (!fastDownloadDone) {
    let messages;
    try {
      messages = await client.getMessages(resolvedLinkPeer, { ids: [resolvedMsgIdForMtproto] });
    } catch (getMsgErr) {
      const gmErrStr = getMsgErr instanceof Error ? getMsgErr.message : String(getMsgErr);
      if (/AUTH_KEY_DUPLICATED|AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED/i.test(gmErrStr)) {
        const freshClient = await resetAndReconnectMtprotoClient(gmErrStr);
        if (!freshClient) {
          throw new Error("No se pudo reconectar la sesi\xF3n MTProto 2 GB tras regenerar la clave.");
        }
        client = freshClient;
        messages = await client.getMessages(resolvedLinkPeer, { ids: [resolvedMsgIdForMtproto] });
      } else {
        throw getMsgErr;
      }
    }
    let msg = messages?.[0];
    if (!msg || !msg.media) {
      if (!isTelegramLinkSource) {
        try {
          const recentMsgs = await client.getMessages(peerId, { limit: 15 });
          msg = recentMsgs.find((m) => m?.media);
        } catch {
        }
      }
    }
    if (!msg || !msg.media) {
      throw new Error(`No se encontr\xF3 el archivo multimedia en el mensaje #${resolvedMsgIdForMtproto}.`);
    }
    const doc = msg.media?.document || (msg.media instanceof Api.Document ? msg.media : null);
    const rawDocSize = doc?.size !== void 0 && doc?.size !== null ? Number(String(doc.size)) : 0;
    const docSize = rawDocSize > 0 ? rawDocSize : job.expectedBytes;
    if (docSize > 0 && job.expectedBytes !== docSize) {
      job.expectedBytes = docSize;
    }
    if (doc && doc.id && doc.accessHash && docSize > 0) {
      lastNetTelemetry.dcId = Number(doc.dcId) || lastNetTelemetry.dcId;
      try {
        addLiveLog(
          "mtproto",
          "info",
          `Iniciando descarga turbo MTProto 4 GB (${lastNetTelemetry.maxSockets} sesiones TCP \xB7 ${MTPROTO_SAFE_PARALLEL_WORKERS} hilos x 1 MB en DC #${doc.dcId}): "${job.fileName}" (${formatBytes(docSize)})`
        );
        await downloadDocumentFast(
          client,
          doc,
          targetFilePath,
          docSize,
          onProgress,
          job.id,
          resolvedLinkPeer,
          resolvedMsgIdForMtproto
        );
      } catch (turboErr) {
        const errMsg = turboErr instanceof Error ? turboErr.message : String(turboErr);
        if (errMsg.includes("SUBIDA_CANCELADA_POR_USUARIO") || cancelledJobIds.has(job.id)) {
          throw new Error("SUBIDA_CANCELADA_POR_USUARIO");
        }
        addLiveLog(
          "mtproto",
          "warn",
          `Aviso en descarga turbo MTProto: ${errMsg}. Reintentando con m\xE9todo GramJS est\xE1ndar...`
        );
        if (/AUTH_KEY_DUPLICATED|AUTH_KEY_UNREGISTERED|SESSION_REVOKED/i.test(errMsg)) {
          const freshClient = await resetAndReconnectMtprotoClient(errMsg);
          if (freshClient) {
            client = freshClient;
            const freshMessages = await client.getMessages(resolvedLinkPeer, {
              ids: [resolvedMsgIdForMtproto]
            });
            if (freshMessages?.[0]?.media) {
              msg = freshMessages[0];
            }
          }
        }
        await client.downloadMedia(msg.media, {
          outputFile: targetFilePath,
          progressCallback: (downloaded, total) => {
            if (cancelledJobIds.has(job.id)) {
              throw new Error("SUBIDA_CANCELADA_POR_USUARIO");
            }
            onProgress(Number(downloaded), Number(total) || job.expectedBytes);
          }
        });
      }
    } else {
      await client.downloadMedia(msg.media, {
        outputFile: targetFilePath,
        progressCallback: (downloaded, total) => {
          onProgress(Number(downloaded), Number(total) || job.expectedBytes);
        }
      });
    }
  }
  if (fs3.existsSync(targetFilePath)) {
    const finalSize = fs3.statSync(targetFilePath).size;
    job.downloadedBytes = finalSize;
    job.diskVerifiedBytes = finalSize;
  }
  const totalDurationSec = Math.max(0.5, (Date.now() - startTime) / 1e3);
  const avgSpeed = Number((job.downloadedBytes / (1024 * 1024) / totalDurationSec).toFixed(2));
  job.speedMBps = avgSpeed;
  await editTelegramStatusMessage(
    job.telegramChatId,
    statusMsgId,
    `${hudHeader("FASE 1/4 \xB7 DESCARGA COMPLETADA")}
` + hudBox([
      `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}`,
      `\u{1F4CA} <b>Progreso:</b> <code>${renderVisualBar(100)}</code>`,
      `\u{1F4E6} <b>Descargado:</b> ${formatBytes(job.downloadedBytes)}`,
      `\u{1F310} <b>Red MTProto:</b> ${escapeHtml(`DC #${lastNetTelemetry.dcId} \xB7 ${lastNetTelemetry.activeSockets}/${lastNetTelemetry.maxSockets} sockets TCP`)}`,
      `\u26A1 <b>Velocidad media:</b> ${avgSpeed} MB/s`
    ]) + `
\u23F3 <i>Verificando integridad en disco antes de transmitir a Picta...</i>`,
    void 0,
    true
  );
  return targetFilePath;
}
function verifyCompleteFileOnDisk(job, filePath) {
  job.stage = "verifying_integrity";
  if (!fs3.existsSync(filePath)) {
    throw new Error(`El archivo descargado no existe en el disco scratch (${TMP_UPLOAD_DIR}).`);
  }
  const stat = fs3.statSync(filePath);
  job.diskVerifiedBytes = stat.size;
  job.downloadedBytes = stat.size;
  if (stat.size === 0 || job.expectedBytes > 0 && stat.size !== job.expectedBytes) {
    throw new Error(
      `Verificaci\xF3n de integridad fallida: se esperaban ${job.expectedBytes} bytes y en disco hay ${stat.size} bytes.`
    );
  }
  job.integrityVerified = true;
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  saveJobsToDisk();
}
function isDailyLimitErrorText(errText) {
  const txt = String(errText || "");
  return /l[ií]mite diario de \d+ publicaciones alcanzado/i.test(txt) || /QUOTA_DAILY_LIMIT_REACHED/i.test(txt);
}
async function authenticatePoolPictaAccount(acc, forceRefresh = false) {
  if (!forceRefresh && acc.accessToken && acc.tokenExpiresAt && acc.tokenExpiresAt > Date.now() + 6e4) {
    return { token: acc.accessToken, userId: acc.userId };
  }
  const rawUser = acc.username.trim();
  const formattedUsername = /^\d{8}$/.test(rawUser) ? `+53${rawUser}` : /^53\d{8}$/.test(rawUser) ? `+${rawUser}` : rawUser;
  const form = new FormData();
  form.append("username", formattedUsername);
  form.append("password", acc.password.trim());
  form.append("grant_type", "password");
  form.append("client_id", botConfig.pictaClientId || PICTA_OFFICIAL_CLIENT_ID);
  const tokenRes = await fetchPictaWithRetry("https://api.picta.cu/o/token/", {
    method: "POST",
    headers: {
      Origin: "https://admin.picta.cu",
      Referer: "https://admin.picta.cu/"
    },
    body: form
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(
      tokenData.error_description || tokenData.error || `Error HTTP ${tokenRes.status} al autenticar cuenta secundaria (${formattedUsername})`
    );
  }
  acc.accessToken = String(tokenData.access_token);
  acc.tokenExpiresAt = Date.now() + (Number(tokenData.expires_in) || 14400) * 1e3;
  try {
    const meRes = await fetchPictaWithRetry("https://api.picta.cu/v2/usuario/me2/", {
      headers: {
        Authorization: `Bearer ${acc.accessToken}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      }
    });
    if (meRes.ok) {
      const encryptedText = (await meRes.text()).trim().replace(/^"|"$/g, "");
      const decipher = crypto.createDecipheriv(
        "aes-128-ecb",
        Buffer.from(PICTA_AES_KEY, "utf8"),
        null
      );
      let decrypted = decipher.update(encryptedText, "base64", "utf8");
      decrypted += decipher.final("utf8");
      const userObj = JSON.parse(decrypted);
      if (userObj?.id) {
        acc.userId = Number(userObj.id);
      }
      if (userObj?.username || userObj?.first_name) {
        acc.displayName = String(userObj.username || userObj.first_name).trim();
      }
      const roles = Array.isArray(userObj?.groups) ? userObj.groups.map((g) => String(g?.name || "")).filter(Boolean) : [];
      acc.roles = roles;
      acc.canPublishDirectly = roles.some((r) => /jefe|editor|admin|productor/i.test(r));
    }
  } catch {
  }
  saveQuotaSettingsToDisk();
  return { token: acc.accessToken, userId: acc.userId };
}
async function ensurePoolAccountAssociatedWithChannel(primaryToken, channelId, secondaryUserId) {
  if (!secondaryUserId || secondaryUserId <= 0 || !primaryToken || !channelId) return;
  try {
    let activeToken = primaryToken;
    let endpointBase = `https://api.picta.cu/v3/channel/${encodeURIComponent(channelId)}/`;
    let chRes = await fetchPictaWithRetry(endpointBase, {
      headers: {
        Authorization: `Bearer ${activeToken}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      }
    });
    if (chRes.status === 401) {
      activeToken = await authenticateWithPicta(true);
      chRes = await fetchPictaWithRetry(endpointBase, {
        headers: {
          Authorization: `Bearer ${activeToken}`,
          Origin: "https://admin.picta.cu",
          Referer: "https://admin.picta.cu/"
        }
      });
    }
    if (chRes.status === 404 || chRes.status === 405) {
      endpointBase = `https://api.picta.cu/v1/canal/${encodeURIComponent(channelId)}/`;
      chRes = await fetchPictaWithRetry(endpointBase, {
        headers: {
          Authorization: `Bearer ${activeToken}`,
          Origin: "https://admin.picta.cu",
          Referer: "https://admin.picta.cu/"
        }
      });
    }
    if (!chRes.ok) return;
    const chData = await chRes.json();
    const rawAssoc = Array.isArray(chData?.usuarios_asociados) ? chData.usuarios_asociados : [];
    const existingIds = new Set(
      rawAssoc.map((u) => Number(typeof u === "object" ? u?.id : u)).filter((n) => Number.isFinite(n) && n > 0)
    );
    const ownerId = Number(
      typeof chData?.propietario === "object" ? chData.propietario?.id : chData?.propietario || 212033
    );
    if (Number.isFinite(ownerId) && ownerId > 0) {
      existingIds.add(ownerId);
    }
    if (existingIds.has(secondaryUserId)) return;
    existingIds.add(secondaryUserId);
    let patchRes = await fetchPictaWithRetry(endpointBase, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${activeToken}`,
        "Content-Type": "application/json",
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      },
      body: JSON.stringify({ usuarios_asociados: Array.from(existingIds) })
    });
    if (patchRes.status === 401) {
      activeToken = await authenticateWithPicta(true);
      patchRes = await fetchPictaWithRetry(endpointBase, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${activeToken}`,
          "Content-Type": "application/json",
          Origin: "https://admin.picta.cu",
          Referer: "https://admin.picta.cu/"
        },
        body: JSON.stringify({ usuarios_asociados: Array.from(existingIds) })
      });
    }
    if ((patchRes.status === 404 || patchRes.status === 405) && endpointBase.includes("/v3/channel/")) {
      patchRes = await fetchPictaWithRetry(
        `https://api.picta.cu/v1/canal/${encodeURIComponent(channelId)}/`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${activeToken}`,
            "Content-Type": "application/json",
            Origin: "https://admin.picta.cu",
            Referer: "https://admin.picta.cu/"
          },
          body: JSON.stringify({ usuarios_asociados: Array.from(existingIds) })
        }
      );
    }
    if (patchRes.ok) {
      addLiveLog(
        "picta",
        "success",
        `Cuenta secundaria (ID #${secondaryUserId}) asociada autom\xE1ticamente como gestor en el canal #${channelId}.`
      );
    }
  } catch {
  }
}
async function resolveUploadTokenWithQuotaPool(chatId, tipId, targetChannelId, excludedTokens, preferredAccountKey) {
  ensureDailyQuotaReset();
  const isMaster = isMasterAdminChat(chatId);
  const userContext = getEffectivePictaContext(chatId);
  const chatPoolAccounts = getPoolAccountsForChat(chatId);
  const todayCuba = getTodayCubaDateStr();
  const primaryLabel = getPrimaryAccountLabelForChat(chatId);
  if (preferredAccountKey && preferredAccountKey.startsWith("pool:")) {
    const targetKey = preferredAccountKey.toLowerCase();
    const chosenAcc = chatPoolAccounts.find(
      (a) => `pool:${String(a.username || "").trim().toLowerCase()}` === targetKey
    );
    if (!chosenAcc) {
      throw new Error(
        "La cuenta colaboradora elegida ya no se encuentra en tu Pool (/cuota). Selecciona otra cuenta para reintentar."
      );
    }
    const { token: poolToken, userId } = await authenticatePoolPictaAccount(chosenAcc, false);
    if (excludedTokens.has(poolToken)) {
      throw new Error(
        `La cuenta colaboradora ${chosenAcc.displayName || chosenAcc.username} alcanz\xF3 su l\xEDmite o fue rechazada por Picta. Cambia de cuenta manualmente para reintentar.`
      );
    }
    const chanStr = String(targetChannelId || "");
    if (chanStr && (!Array.isArray(chosenAcc.associatedChannelIds) || !chosenAcc.associatedChannelIds.includes(chanStr))) {
      const primaryTokenOpt = await userContext.accessTokenPromise.catch(() => "");
      if (primaryTokenOpt) {
        await ensurePoolAccountAssociatedWithChannel(primaryTokenOpt, chanStr, userId).catch(() => {
        });
      }
      chosenAcc.associatedChannelIds = Array.from(
        /* @__PURE__ */ new Set([...chosenAcc.associatedChannelIds || [], chanStr])
      );
      savePoolAccountsForChat(chatId);
    }
    return {
      token: poolToken,
      accountLabel: chosenAcc.displayName || chosenAcc.username,
      poolAccount: chosenAcc
    };
  }
  const primaryToken = await userContext.accessTokenPromise;
  if (preferredAccountKey === "primary") {
    if (excludedTokens.has(primaryToken)) {
      throw new Error(
        `La cuenta principal (${primaryLabel}) fue rechazada o alcanz\xF3 su l\xEDmite en Picta. Cambia manualmente a una cuenta colaboradora para subir en el canal #${targetChannelId}.`
      );
    }
    return {
      token: primaryToken,
      accountLabel: primaryLabel
    };
  }
  if (!isMaster) {
    if (!excludedTokens.has(primaryToken)) {
      return {
        token: primaryToken,
        accountLabel: primaryLabel
      };
    }
    throw new Error(
      `QUOTA_DAILY_LIMIT_REACHED: Se alcanz\xF3 el l\xEDmite diario de 10 publicaciones por cuenta en Picta para tu usuario en el canal #${targetChannelId}. El video queda guardado en tu cola para reanudarse ma\xF1ana con 1 clic.`
    );
  }
  const publishablePoolAccounts = chatPoolAccounts.filter(
    (a) => a.canPublishDirectly !== false
  );
  const totalAccounts = 1 + publishablePoolAccounts.length;
  const effectiveSeriesCap = quotaSettings.maxSeriesPerDay > 0 ? quotaSettings.maxSeriesPerDay + publishablePoolAccounts.length * 10 : totalAccounts * 10;
  if (tipId === 5 && quotaSettings.maxSeriesPerDay > 0 && quotaSettings.seriesUploadedToday >= effectiveSeriesCap) {
    throw new Error(
      `QUOTA_SERIE_RESERVED_REACHED: Se alcanz\xF3 el cupo diario asignado a cap\xEDtulos de Series (${quotaSettings.seriesUploadedToday}/${effectiveSeriesCap} hoy). Los cupos restantes del d\xEDa est\xE1n reservados para pel\xEDculas u otros videos. Puedes liberar la reserva con 1 clic o a\xF1adir otra cuenta al Pool Multi-Cuenta en /cuota.`
    );
  }
  if (quotaSettings.primaryExhaustedDate !== todayCuba && !excludedTokens.has(primaryToken)) {
    return {
      token: primaryToken,
      accountLabel: primaryLabel
    };
  }
  for (const acc of publishablePoolAccounts) {
    if ((acc.uploadedToday || 0) >= 10 || acc.exhaustedDate === todayCuba) continue;
    try {
      const { token: poolToken, userId } = await authenticatePoolPictaAccount(acc, false);
      if (acc.canPublishDirectly === false) {
        savePoolAccountsForChat(chatId);
        addLiveLog(
          "picta",
          "warn",
          `Omitiendo cuenta secundaria ${acc.username} porque tiene rol "Usuario com\xFAn" (requiere "Jefe de canal" para publicar directamente).`
        );
        continue;
      }
      if (excludedTokens.has(poolToken)) continue;
      await ensurePoolAccountAssociatedWithChannel(primaryToken, targetChannelId, userId);
      return {
        token: poolToken,
        accountLabel: acc.displayName || acc.username,
        poolAccount: acc
      };
    } catch (poolErr) {
      addLiveLog(
        "picta",
        "warn",
        `No se pudo usar la cuenta secundaria ${acc.username} del Pool: ${poolErr instanceof Error ? poolErr.message : String(poolErr)}`
      );
    }
  }
  const commonOnlyCount = chatPoolAccounts.filter(
    (a) => a.canPublishDirectly === false
  ).length;
  const roleHint = commonOnlyCount > 0 ? ` (${commonOnlyCount} cuenta(s) secundaria(s) omitida(s) por rol "Usuario com\xFAn" sin permiso "Jefe de canal")` : "";
  throw new Error(
    `QUOTA_DAILY_LIMIT_REACHED: Se alcanz\xF3 el l\xEDmite diario de 10 publicaciones por cuenta en Picta (${totalAccounts} cuenta(s) con rol Jefe de canal agotadas hoy${roleHint}). A\xF1ade otra cuenta con rol Jefe de canal en /cuota (+10 subidas diarias reales al canal #${targetChannelId}) o reanuda la cola ma\xF1ana con 1 clic.`
  );
}
async function uploadSubtitleBufferToMinioS3(token, subBuf, fileName) {
  try {
    const credRes = await fetchPictaWithRetry(
      "https://api.picta.cu/v2/publicacion/devolver_url_minio/",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://admin.picta.cu",
          Referer: "https://admin.picta.cu/"
        }
      }
    );
    if (!credRes.ok) return null;
    const credData = await credRes.json();
    const s3Endpoint = credData?.url_minio?.[0];
    const s3Fields = credData?.url_minio?.[1];
    if (!s3Endpoint || !s3Fields?.key) return null;
    const s3Form = new FormData();
    for (const [k, v] of Object.entries(s3Fields)) {
      s3Form.append(k, v);
    }
    const cleanName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "subtitulo.srt";
    s3Form.append(
      "file",
      new Blob([new Uint8Array(subBuf)], { type: "text/plain" }),
      cleanName
    );
    const s3Res = await fetch(s3Endpoint, {
      method: "POST",
      body: s3Form
    });
    if (!s3Res.ok && s3Res.status !== 204) {
      return null;
    }
    const cleanEndpoint = s3Endpoint.replace(/\/+$/, "");
    return `${cleanEndpoint}/${s3Fields.key}`;
  } catch (err) {
    addLiveLog(
      "picta",
      "warn",
      `Error al subir archivo de subt\xEDtulos a MinIO S3: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
async function uploadFullVerifiedFileToPicta(job, filePath, statusMsgId) {
  const isMaster = isMasterAdminChat(job.telegramChatId);
  const userContext = getEffectivePictaContext(job.telegramChatId);
  if (!userContext.isLinked || !userContext.channelId) {
    throw new Error(
      "Tu cuenta de Picta no tiene un canal vinculado. Usa /login para iniciar sesi\xF3n y conectar tu propio canal."
    );
  }
  const masterChanId = botConfig.pictaChannelId || "36319";
  const targetChannelId = job.targetChannelId && (isMaster || job.targetChannelId !== masterChanId) ? job.targetChannelId : userContext.channelId;
  const targetChannelName = job.targetChannelName || userContext.channelName || "Mi Canal";
  const tipId = Number(job.tipologiaId || botConfig.pictaTipologiaId || 8);
  const excludedTokens = /* @__PURE__ */ new Set();
  let activeAuth = await resolveUploadTokenWithQuotaPool(
    job.telegramChatId,
    tipId,
    targetChannelId,
    excludedTokens,
    job.preferredUploadAccountKey
  );
  let accessToken = activeAuth.token;
  job.preferredUploadAccountLabel = activeAuth.accountLabel;
  saveJobsToDisk();
  const fileSize = filePath && fs3.existsSync(filePath) ? fs3.statSync(filePath).size : job.diskVerifiedBytes || job.expectedBytes;
  const maxS3Attempts = 8;
  let finalMinioKey = job.minioKey || "";
  if (finalMinioKey) {
    addLiveLog(
      "picta",
      "info",
      `El video "${job.fileName}" ya se encuentra 100% alojado en S3 MinIO (key=${finalMinioKey}). Reutilizando archivo y pasando directo a creaci\xF3n de publicaci\xF3n.`
    );
  } else {
    for (let attempt = 1; attempt <= maxS3Attempts; attempt++) {
      try {
        const minioCredRes = await fetchPictaWithRetry(
          "https://api.picta.cu/v2/publicacion/devolver_url_minio/",
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Origin: "https://admin.picta.cu",
              Referer: "https://admin.picta.cu/"
            }
          }
        );
        if (!minioCredRes.ok) {
          const errTxt = await minioCredRes.text();
          if (!job.preferredUploadAccountKey && isDailyLimitErrorText(errTxt)) {
            excludedTokens.add(accessToken);
            if (isMaster) {
              const todayCuba = getTodayCubaDateStr();
              if (activeAuth.poolAccount) {
                activeAuth.poolAccount.uploadedToday = 10;
                activeAuth.poolAccount.exhaustedDate = todayCuba;
              } else {
                quotaSettings.primaryExhaustedDate = todayCuba;
              }
              saveQuotaSettingsToDisk();
            }
            activeAuth = await resolveUploadTokenWithQuotaPool(
              job.telegramChatId,
              tipId,
              targetChannelId,
              excludedTokens,
              job.preferredUploadAccountKey
            );
            accessToken = activeAuth.token;
            addLiveLog(
              "picta",
              "info",
              `\u{1F504} L\xEDmite diario de 10 videos alcanzado en cuenta anterior. Rotando autom\xE1ticamente a cuenta del Pool: ${activeAuth.accountLabel}`
            );
            attempt--;
            continue;
          }
          throw new Error(
            `Error HTTP ${minioCredRes.status} en devolver_url_minio (${activeAuth.accountLabel}): ${errTxt.slice(0, 180)}`
          );
        }
        const minioData = await minioCredRes.json();
        const s3Endpoint = minioData?.url_minio?.[0];
        const s3Fields = minioData?.url_minio?.[1];
        if (!s3Endpoint || !s3Fields || !s3Fields.key) {
          throw new Error("Respuesta inv\xE1lida de devolver_url_minio.");
        }
        finalMinioKey = s3Fields.key;
        job.minioKey = s3Fields.key;
        job.stage = "uploading_full_file_to_picta";
        job.uploadedBytes = 0;
        job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        saveJobsToDisk();
        await editTelegramStatusMessage(
          job.telegramChatId,
          statusMsgId,
          `${hudHeader("FASE 3/4 \xB7 CONECTANDO CON S3 PICTA")}
` + hudBox([
            `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}`,
            `\u{1F511} <b>Manifiesto MinIO:</b> <code>${finalMinioKey}</code>`,
            `\u{1F4E4} <b>Tama\xF1o a enviar:</b> ${formatBytes(fileSize)}`
          ]) + `
\u23F3 <i>Iniciando transmisi\xF3n directa hacia videos.picta.cu...</i>`,
          void 0,
          true
        );
        addLiveLog(
          "picta",
          "info",
          `Subiendo archivo 100% entero (${formatBytes(fileSize)}) a S3 MinIO (${s3Endpoint}, key: ${s3Fields.key}, intento ${attempt}/${maxS3Attempts})...`
        );
        const boundary = `----PictaMinioS3Boundary${Date.now().toString(16)}`;
        const crlf = "\r\n";
        const orderedS3Keys = [
          "bucket",
          "key",
          "Content-Type",
          "policy",
          "x-amz-algorithm",
          "x-amz-credential",
          "x-amz-date",
          "x-amz-signature"
        ];
        let prologueStr = "";
        for (const k of orderedS3Keys) {
          if (s3Fields[k] !== void 0) {
            prologueStr += `--${boundary}${crlf}`;
            prologueStr += `Content-Disposition: form-data; name="${k}"${crlf}${crlf}`;
            prologueStr += `${s3Fields[k]}${crlf}`;
          }
        }
        const safeFileName = path3.basename(job.fileName).replace(/"/g, "");
        prologueStr += `--${boundary}${crlf}`;
        prologueStr += `Content-Disposition: form-data; name="file"; filename="${safeFileName}"${crlf}`;
        prologueStr += `Content-Type: ${job.mimeType || "video/mp4"}${crlf}${crlf}`;
        const epilogueStr = `${crlf}--${boundary}--${crlf}`;
        const prologueBuf = Buffer.from(prologueStr, "utf-8");
        const epilogueBuf = Buffer.from(epilogueStr, "utf-8");
        const totalContentLength = prologueBuf.byteLength + fileSize + epilogueBuf.byteLength;
        const parsedS3Url = new URL2(s3Endpoint);
        const isHttps = parsedS3Url.protocol === "https:";
        const transport = isHttps ? https : http;
        const startTime = Date.now();
        let lastTelegramEdit = 0;
        await new Promise((resolve, reject) => {
          let settled = false;
          const failOnce = (err) => {
            if (settled) return;
            settled = true;
            reject(err);
          };
          const req = transport.request(
            {
              protocol: parsedS3Url.protocol,
              hostname: parsedS3Url.hostname,
              port: parsedS3Url.port || (isHttps ? 443 : 80),
              path: parsedS3Url.pathname + parsedS3Url.search,
              method: "POST",
              headers: {
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Content-Length": totalContentLength,
                Origin: "https://admin.picta.cu",
                Referer: "https://admin.picta.cu/"
              }
            },
            (res) => {
              const chunks = [];
              res.on("data", (d) => chunks.push(Buffer.from(d)));
              res.on("end", () => {
                if (settled) return;
                settled = true;
                const bodyText = Buffer.concat(chunks).toString("utf-8");
                job.pictaResponseCode = res.statusCode || 0;
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                  job.uploadedBytes = fileSize;
                  resolve();
                } else {
                  reject(
                    new Error(
                      `Error S3 MinIO HTTP ${res.statusCode}: ${bodyText.slice(0, 220) || res.statusMessage}`
                    )
                  );
                }
              });
            }
          );
          req.on("socket", (sock) => {
            sock.setNoDelay?.(true);
            sock.setKeepAlive?.(true, 1e4);
          });
          req.setTimeout(6e5, () => {
            req.destroy(new Error("Timeout de red (10 minutos sin respuesta de videos.picta.cu)"));
          });
          const readStream = fs3.createReadStream(filePath, {
            highWaterMark: S3_UPLOAD_HIGH_WATER_MARK_BYTES
            // 256 KB strict lean RAM profile on Ephemeral Disk
          });
          req.on("error", (err) => {
            readStream.destroy();
            const detail = err?.message || err?.code || (Array.isArray(err?.errors) ? err.errors.map((e) => e?.message || e?.code).join(", ") : "Conexi\xF3n reiniciada por videos.picta.cu");
            failOnce(new Error(`Error de red en S3 Picta: ${detail}`));
          });
          readStream.on("error", (err) => {
            req.destroy(err);
            failOnce(err);
          });
          void (async () => {
            try {
              if (!req.write(prologueBuf)) {
                await new Promise((r) => req.once("drain", r));
              }
              for await (const chunk of readStream) {
                if (settled) break;
                if (cancelledJobIds.has(job.id)) {
                  req.destroy(new Error("SUBIDA_CANCELADA_POR_USUARIO"));
                  failOnce(new Error("SUBIDA_CANCELADA_POR_USUARIO"));
                  break;
                }
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                if (!req.write(buf)) {
                  await new Promise((r) => req.once("drain", r));
                }
                job.uploadedBytes += buf.byteLength;
                const elapsedSec = Math.max(0.5, (Date.now() - startTime) / 1e3);
                job.speedMBps = Number(
                  (job.uploadedBytes / (1024 * 1024) / elapsedSec).toFixed(2)
                );
                const pct = Math.min(100, Math.round(job.uploadedBytes / fileSize * 100));
                currentActivity = `Subiendo archivo entero a S3 Picta (${s3Fields.key}): ${formatBytes(job.uploadedBytes)} / ${formatBytes(fileSize)} (${pct}%) a ${job.speedMBps} MB/s`;
                const now = Date.now();
                if (now - lastTelegramEdit > 4e3) {
                  lastTelegramEdit = now;
                  const qCount = uploadQueue.length;
                  void editTelegramStatusMessage(
                    job.telegramChatId,
                    statusMsgId,
                    `${hudHeader("FASE 3/4 \xB7 TRANSMITIENDO A S3 PICTA")}
` + hudBox([
                      `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}`,
                      `\u{1F511} <b>Manifiesto:</b> <code>${s3Fields.key}</code>`,
                      `\u{1F4CA} <b>Progreso:</b> <code>${renderVisualBar(pct)}</code>`,
                      `\u{1F4E4} <b>Enviado:</b> ${formatBytes(job.uploadedBytes)} / ${formatBytes(fileSize)}`,
                      `\u26A1 <b>Velocidad:</b> ${job.speedMBps} MB/s`,
                      qCount > 0 ? `\u23F3 <b>En cola despu\xE9s:</b> ${qCount} video(s)` : null
                    ]) + `
<i>Esperando confirmaci\xF3n 100% antes de crear la ficha en Picta.</i>`,
                    [[{ text: "\u{1F6D1} Cancelar subida", callback_data: `cancel_job:${job.id}` }]]
                  );
                }
              }
              if (!settled) {
                req.end(epilogueBuf);
              }
            } catch (streamErr) {
              if (!settled) {
                failOnce(
                  streamErr instanceof Error ? streamErr : new Error(String(streamErr))
                );
              }
            }
          })();
        });
        break;
      } catch (s3Err) {
        const errMsg = s3Err instanceof Error ? s3Err.message : String(s3Err);
        if (errMsg.includes("SUBIDA_CANCELADA_POR_USUARIO") || errMsg.includes("QUOTA_") || cancelledJobIds.has(job.id)) {
          throw s3Err instanceof Error ? s3Err : new Error(errMsg);
        }
        if (attempt < maxS3Attempts) {
          const backoffSec = Math.min(20, attempt * 4);
          addLiveLog(
            "picta",
            "warn",
            `Reintentando subida S3 MinIO (${attempt}/${maxS3Attempts}) en ${backoffSec}s tras: ${errMsg.slice(0, 110)}`
          );
          await new Promise((r) => setTimeout(r, backoffSec * 1e3));
        } else {
          throw s3Err;
        }
      }
    }
  }
  if (cancelledJobIds.has(job.id)) {
    throw new Error("SUBIDA_CANCELADA_POR_USUARIO");
  }
  addLiveLog(
    "picta",
    "success",
    `Archivo 100% verificado en S3 MinIO (key=${finalMinioKey}, ${fileSize.toLocaleString()} bytes). Creando publicaci\xF3n en ${targetChannelName} (#${targetChannelId})...`
  );
  job.stage = "creating_picta_publication";
  currentActivity = `Creando publicaci\xF3n "${job.title}" (${job.category || "Audiovisual"}) en ${targetChannelName}...`;
  saveJobsToDisk();
  await editTelegramStatusMessage(
    job.telegramChatId,
    statusMsgId,
    `${hudHeader(`FASE 4/4 \xB7 PUBLICANDO EN ${targetChannelName}`)}
` + hudBox([
      `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}`,
      `\u{1F4C2} <b>Categor\xEDa:</b> ${escapeHtml(job.category || "Audiovisual")}`,
      `\u{1F511} <b>Manifiesto:</b> <code>${finalMinioKey}</code>`
    ]) + `
\u23F3 <i>Registrando ficha t\xE9cnica, portada y reparto en Picta...</i>`
  );
  const meta = job.modelMetadata || {};
  const parsedSerieInfo = extractSeriesInfoFromText(job.fileName, job.caption);
  const fallbackBuf = Buffer.from(FALLBACK_JPEG_BASE64, "base64");
  let customCoverBuf = null;
  let customPosterBuf = null;
  let onlineBackdropBuf = null;
  let onlinePosterBuf = null;
  let videoFrameBuf = null;
  if (job.customCoverFileId) {
    const downloadedCustom = await downloadTelegramThumbnailBuffer(job.customCoverFileId);
    if (downloadedCustom && downloadedCustom.byteLength > 100) {
      customCoverBuf = downloadedCustom;
    }
  }
  if (job.customPosterFileId) {
    const downloadedPoster = await downloadTelegramThumbnailBuffer(job.customPosterFileId);
    if (downloadedPoster && downloadedPoster.byteLength > 100) {
      customPosterBuf = downloadedPoster;
    }
  }
  if (!customCoverBuf && tipId === 5) {
    const pinnedForChat = pinnedBatchSerieByChat.get(job.telegramChatId);
    const sPelserId = Number(meta.serie_pelser_id || pinnedForChat?.pelserId || 0);
    const sNameLookup = String(
      meta.serie || pinnedForChat?.serieName || parsedSerieInfo.serieName || ""
    ).trim();
    const serieRec = findUserChannelSerie(sPelserId, job.telegramChatId) || filterSeriesForChannel(channelSeriesCache, targetChannelId, isMaster).find(
      (s) => sNameLookup && cleanSerieDisplayName(s.nombre).toLowerCase() === cleanSerieDisplayName(sNameLookup).toLowerCase()
    );
    const customSerieCoverFileId = pinnedForChat?.customCoverFileId || serieRec?.customCoverFileId;
    if (customSerieCoverFileId) {
      const tgSerieCover = await downloadTelegramThumbnailBuffer(customSerieCoverFileId);
      if (tgSerieCover && tgSerieCover.byteLength > 100) {
        customCoverBuf = tgSerieCover;
        addLiveLog(
          "picta",
          "info",
          `Portada personalizada de la serie "${sNameLookup || serieRec?.nombre || "Serie"}" aplicada autom\xE1ticamente a "${job.title}".`
        );
      }
    }
    let officialSerieCoverUrl = pinnedForChat?.coverUrl || serieRec?.coverUrl || (isMaster && (sPelserId === 4054 || /mentalista/i.test(sNameLookup)) ? "https://www.picta.cu/imagen/poster_L6utIgf.jpeg" : "") || String(meta.onlineBackdropUrl || meta.onlineCoverUrl || "");
    if (!officialSerieCoverUrl && sPelserId > 0) {
      try {
        const sDetailRes = await fetchPictaWithRetry(
          `https://api.picta.cu/v1/serie/${sPelserId}/`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Origin: "https://admin.picta.cu",
              Referer: "https://admin.picta.cu/"
            }
          }
        );
        if (sDetailRes.ok) {
          const sDetail = await sDetailRes.json();
          const fetchedUrl = String(sDetail?.url_imagen || sDetail?.imagen_secundaria || "").trim();
          if (fetchedUrl) {
            officialSerieCoverUrl = fetchedUrl;
            upsertChannelSerieRecord(sPelserId, sDetail?.nombre || sNameLookup, void 0, {
              canalId: Number(targetChannelId),
              coverUrl: fetchedUrl
            });
          }
        }
      } catch {
      }
    }
    if (!customCoverBuf && officialSerieCoverUrl) {
      try {
        const imgRes = await fetch(officialSerieCoverUrl);
        if (imgRes.ok) {
          const arr = await imgRes.arrayBuffer();
          if (arr.byteLength > 100) {
            onlineBackdropBuf = Buffer.from(arr);
            addLiveLog(
              "picta",
              "info",
              `Portada oficial de la serie "${serieRec?.nombre || sNameLookup || "Serie"}" (${officialSerieCoverUrl}) reutilizada autom\xE1ticamente para "${job.title}".`
            );
          }
        }
      } catch {
      }
    }
  }
  if (meta.preferVideoFrameCover !== "true") {
    const backdropUrl = String(meta.onlineBackdropUrl || "").trim();
    const posterUrl = String(meta.onlinePosterUrl || meta.onlineCoverUrl || "").trim();
    if (!customCoverBuf && !onlineBackdropBuf && backdropUrl) {
      try {
        const bRes = await fetch(backdropUrl);
        if (bRes.ok) {
          const arr = await bRes.arrayBuffer();
          if (arr.byteLength > 200) {
            onlineBackdropBuf = Buffer.from(arr);
          }
        }
      } catch {
      }
    }
    if (!customPosterBuf && posterUrl) {
      if (posterUrl === backdropUrl && onlineBackdropBuf) {
        onlinePosterBuf = onlineBackdropBuf;
      } else {
        try {
          const pRes = await fetch(posterUrl);
          if (pRes.ok) {
            const arr = await pRes.arrayBuffer();
            if (arr.byteLength > 200) {
              onlinePosterBuf = Buffer.from(arr);
              if (!customCoverBuf && !onlineBackdropBuf) {
                addLiveLog(
                  "picta",
                  "info",
                  `Car\xE1tula oficial HD (TMDB/IMDb) aplicada autom\xE1ticamente para "${job.title}".`
                );
              }
            }
          }
        } catch {
        }
      }
    }
  }
  if (!customCoverBuf && !onlineBackdropBuf && !onlinePosterBuf && job.thumbnailFileId) {
    const downloadedThumb = await downloadTelegramThumbnailBuffer(job.thumbnailFileId);
    if (downloadedThumb && downloadedThumb.byteLength > 100) {
      videoFrameBuf = downloadedThumb;
    }
  }
  const { urlImagenBuf: coverBuffer, imagenSecundariaBuf: posterBuffer } = selectUploadPairBuffers({
    customCoverBuf,
    customPosterBuf,
    onlineBackdropBuf,
    onlinePosterBuf,
    videoFrameBuf,
    preferVideoFrameCover: meta.preferVideoFrameCover === "true",
    fallbackBuf
  });
  if (tipId === 5 && job.customCoverFileId) {
    const sPelserId = Number(meta.serie_pelser_id || 0);
    const sNameLookup = String(meta.serie || parsedSerieInfo.serieName || "").trim();
    if (sPelserId > 0 || sNameLookup) {
      upsertChannelSerieRecord(sPelserId, sNameLookup, void 0, {
        canalId: Number(targetChannelId),
        customCoverFileId: job.customCoverFileId
      });
    }
  }
  if (tipId === 5) {
    const metaSerieStr = String(meta.serie || "");
    const sName = String(
      (!isGenericOrInvalidSerieName(metaSerieStr) ? metaSerieStr : "") || parsedSerieInfo.serieName || `Serie ${targetChannelName}`
    );
    const sSeason = String(
      (Array.isArray(meta.temporada) ? meta.temporada[0] : meta.temporada) || parsedSerieInfo.temporada || "1"
    );
    const metaEp = Array.isArray(meta.numero) ? meta.numero[0] : meta.numero;
    const sEp = String(
      metaEp && !(String(metaEp) === "1" && Number(parsedSerieInfo.numero) > 1) ? metaEp : parsedSerieInfo.numero || "1"
    );
    const epSub = String(meta.episodeSubtitle || parsedSerieInfo.episodeSubtitle || "").trim();
    if (!job.title || /^Serie\s*-\s*T\d+:E\d+$/i.test(job.title.trim()) || job.titleMode !== "manual") {
      job.title = formatSerieEpisodeTitle(sName, sSeason, sEp, epSub);
    }
    const cleanSName = cleanSerieDisplayName(sName) || sName;
    if (isLikelyEnglishText(job.synopsis)) {
      job.synopsis = await translateTextToSpanishIfNeeded(job.synopsis);
    }
    if (isStaleOrGenericSerieSynopsis(job.synopsis, job.caption, sEp) || isLikelyEnglishText(job.synopsis)) {
      const candidateEpSyn = String(meta.episodeSynopsis || "").trim();
      const spanishEpSyn = candidateEpSyn ? await translateTextToSpanishIfNeeded(candidateEpSyn) : "";
      job.synopsis = spanishEpSyn || `Cap\xEDtulo ${sEp} de la Temporada ${sSeason} de la serie ${cleanSName}${epSub ? ` titulado "${epSub}"` : ""}, disponible en el canal ${targetChannelName}.`;
    }
    job.synopsis = sanitizePublicPictaText(job.synopsis);
  } else {
    if (isLikelyEnglishText(job.synopsis)) {
      const translated = await translateTextToSpanishIfNeeded(job.synopsis);
      job.synopsis = translated || `${job.title}. Publicado en la categor\xEDa ${job.category || "Audiovisual"} del canal ${targetChannelName} en Picta.`;
    }
    job.synopsis = sanitizePublicPictaText(job.synopsis || job.title);
  }
  const catalogAdminToken = activeAuth.poolAccount ? accessToken : await userContext.accessTokenPromise.catch(() => "") || accessToken;
  const pubForm = new FormData();
  pubForm.append("tipo", "publicacion");
  pubForm.append("tipologia", String(tipId));
  pubForm.append("nombre", sanitizePublicPictaText(job.title));
  pubForm.append("descripcion", sanitizePublicPictaText(job.synopsis || job.title));
  pubForm.append("canal", targetChannelId);
  pubForm.append("url_manifiesto", finalMinioKey);
  pubForm.append("publicado", "true");
  pubForm.append("descargable", "true");
  pubForm.append("mostrar_comentarios", "true");
  pubForm.append("mostrar_chat", "false");
  pubForm.append("internacional", "false");
  pubForm.append("es_exclusivo", "false");
  pubForm.append("clasificacion", botConfig.pictaClasificacion || "18+");
  pubForm.append("palabraClave", botConfig.pictaPalabraClaveId || "5476");
  if (tipId === 1) {
    const releaseYear = String(meta.ano || (job.title.match(/\b(19\d\d|20\d\d)\b/) || [])[1] || "2024");
    pubForm.append("ano", releaseYear);
    pubForm.append("pais", String(meta.pais || "Internacional"));
    const genreIds = resolveGenreIds(meta.genero_ids || meta.genero_id || meta.genero);
    for (const gid of genreIds) {
      pubForm.append("genero", String(gid));
    }
    const prodId = await resolveProductoraId(catalogAdminToken, String(meta.productora || ""));
    pubForm.append("productora", String(prodId));
    const directorNames = String(meta.director || "Direcci\xF3n General").split(/[,/|]/);
    const directorIds = await resolvePersonaIds(catalogAdminToken, directorNames, 1022);
    for (const did of directorIds) {
      pubForm.append("director", String(did));
    }
    const guionNames = String(meta.guion || meta.director || "Gui\xF3n Original").split(/[,/|]/);
    const guionIds = await resolvePersonaIds(catalogAdminToken, guionNames, 1022);
    for (const gid of guionIds) {
      pubForm.append("guion", String(gid));
    }
    const repartoNames = String(meta.reparto || "Elenco Principal").split(/[,/|]/);
    const repartoIds = await resolvePersonaIds(catalogAdminToken, repartoNames, 646);
    for (const rid of repartoIds) {
      pubForm.append("reparto", String(rid));
    }
    const fotoNames = String(meta.fotografia || "Cinematograf\xEDa").split(/[,/|]/);
    const fotoIds = await resolvePersonaIds(catalogAdminToken, fotoNames, 1022);
    for (const fid of fotoIds) {
      pubForm.append("fotografia", String(fid));
    }
    const musicaNames = String(meta.musica || "Banda Sonora").split(/[,/|]/);
    const musicaIds = await resolvePersonaIds(catalogAdminToken, musicaNames, 1022);
    for (const mid of musicaIds) {
      pubForm.append("musica", String(mid));
    }
    const premioVal = meta.premio_id ? String(meta.premio_id) : meta.premio ? String(meta.premio) : void 0;
    const premioId = await resolvePremioId(catalogAdminToken, premioVal);
    pubForm.append("premio", String(premioId || 469));
  } else if (tipId === 2) {
    pubForm.append("pais", String(meta.pais || "Cuba / Internacional"));
    const prodId = await resolveProductoraId(catalogAdminToken, String(meta.productora || ""));
    pubForm.append("productora", String(prodId || 679));
  } else if (tipId === 5) {
    const metaSerieStr = String(meta.serie || "");
    const cleanSerie = String(
      (!isGenericOrInvalidSerieName(metaSerieStr) ? metaSerieStr : "") || parsedSerieInfo.serieName || `Serie ${targetChannelName}`
    );
    const seasonInput = Array.isArray(meta.temporada) ? meta.temporada[0] : meta.temporada || parsedSerieInfo.temporada;
    const metaEp = Array.isArray(meta.numero) ? meta.numero[0] : meta.numero;
    const epInput = metaEp && !(String(metaEp) === "1" && Number(parsedSerieInfo.numero) > 1) ? metaEp : parsedSerieInfo.numero;
    const resolvedTempId = await ensureSerieAndTemporadaId(
      catalogAdminToken,
      cleanSerie,
      seasonInput,
      meta,
      coverBuffer,
      targetChannelId,
      targetChannelName,
      isMaster
    );
    pubForm.append("temporada", String(resolvedTempId));
    pubForm.append("numero", String(epInput || "1"));
  } else if (tipId === 3 || tipId === 14) {
    const releaseYear = String(meta.ano || (job.title.match(/\b(19\d\d|20\d\d)\b/) || [])[1] || "2024");
    pubForm.append("ano", releaseYear);
    const genreIds = resolveGenreIds(meta.genero_ids || meta.genero_id || meta.genero);
    for (const gid of genreIds) {
      pubForm.append("genero", String(gid));
    }
    const interpreteIds = await resolvePersonaIds(catalogAdminToken, String(meta.interprete || "Artista Principal").split(/[,/|]/), 1022);
    for (const iid of interpreteIds) pubForm.append("interprete", String(iid));
    const directorIds = await resolvePersonaIds(catalogAdminToken, String(meta.director || "Direcci\xF3n Audiovisual").split(/[,/|]/), 1022);
    for (const did of directorIds) pubForm.append("director", String(did));
    const productorIds = await resolvePersonaIds(catalogAdminToken, String(meta.productor || "Producci\xF3n Audiovisual").split(/[,/|]/), 1022);
    for (const pid of productorIds) pubForm.append("productor", String(pid));
  } else if (tipId === 11) {
    const releaseYear = String(meta.ano || (job.title.match(/\b(19\d\d|20\d\d)\b/) || [])[1] || "2024");
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    pubForm.append("ano", releaseYear);
    const genreIds = resolveGenreIds(meta.genero_ids || meta.genero_id || meta.genero);
    for (const gid of genreIds) {
      pubForm.append("genero", String(gid));
    }
    const interpreteIds = await resolvePersonaIds(catalogAdminToken, String(meta.interprete || "Artista").split(/[,/|]/), 1022);
    for (const iid of interpreteIds) pubForm.append("interprete", String(iid));
    const directorIds = await resolvePersonaIds(catalogAdminToken, String(meta.director || "Direcci\xF3n de Videoclip").split(/[,/|]/), 1022);
    for (const did of directorIds) pubForm.append("director", String(did));
    const fotoIds = await resolvePersonaIds(catalogAdminToken, String(meta.director_fotografico || meta.fotografia || "Cinematograf\xEDa").split(/[,/|]/), 1022);
    for (const fid of fotoIds) pubForm.append("director_fotografico", String(fid));
    const guionIds = await resolvePersonaIds(catalogAdminToken, String(meta.guionista || meta.guion || "Guion").split(/[,/|]/), 1022);
    for (const gid of guionIds) pubForm.append("guionista", String(gid));
    pubForm.append("release_date", String(meta.release_date || nowIso));
    pubForm.append("sale_start_date", String(meta.sale_start_date || nowIso));
    pubForm.append("sello", String(meta.sello || "Independiente"));
  } else if (tipId === 6) {
    const autorIds = await resolvePersonaIds(catalogAdminToken, String(meta.autor || "Profesor").split(/[,/|]/), 1022);
    for (const aid of autorIds) pubForm.append("autor", String(aid));
    pubForm.append("temporada", String(meta.temporada || "1"));
  }
  pubForm.append(
    "url_imagen",
    new Blob([new Uint8Array(coverBuffer)], { type: "image/jpeg" }),
    `portada_${Date.now()}.jpg`
  );
  if (tipId === 1 || job.customPosterFileId) {
    pubForm.append(
      "imagen_secundaria",
      new Blob([new Uint8Array(posterBuffer)], { type: "image/jpeg" }),
      `poster_secundario_${Date.now()}.jpg`
    );
  }
  if (job.subtitleFileId) {
    try {
      const subBuf = await downloadTelegramThumbnailBuffer(job.subtitleFileId);
      if (subBuf && subBuf.byteLength > 0) {
        const subName = job.subtitleFileName || `subtitulos_${Date.now()}.srt`;
        const subUrl = await uploadSubtitleBufferToMinioS3(accessToken, subBuf, subName);
        if (subUrl) {
          pubForm.append("url_subtitulo", subUrl);
          addLiveLog(
            "picta",
            "info",
            `Subt\xEDtulos subidos a MinIO S3 y adjuntados a la publicaci\xF3n: "${subName}" (${subUrl})`
          );
        } else {
          addLiveLog(
            "picta",
            "warn",
            `No se pudo subir subt\xEDtulo a MinIO S3. Continuando publicaci\xF3n sin subt\xEDtulos para no bloquear la subida.`
          );
        }
      }
    } catch (subErr) {
      addLiveLog(
        "picta",
        "warn",
        `No se pudo descargar el archivo de subt\xEDtulos opcional: ${subErr instanceof Error ? subErr.message : String(subErr)}`
      );
    }
  }
  let createText = "";
  let sawPoolForbidden = false;
  let lastPoolForbiddenLabel = "";
  const maxPubAttempts = !job.preferredUploadAccountKey && isMaster ? getPoolAccountsForChat(job.telegramChatId).length + 1 : 0;
  for (let pubAttempt = 0; pubAttempt <= maxPubAttempts; pubAttempt++) {
    try {
      const valRes = await fetchPictaWithRetry(
        "https://api.picta.cu/v1/publicacion/validar_campos/",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Origin: "https://admin.picta.cu",
            Referer: "https://admin.picta.cu/"
          },
          body: pubForm
        }
      );
      if (!valRes.ok) {
        const valText = await valRes.text();
        const isForbiddenPool = isMaster && valRes.status === 403 && Boolean(activeAuth.poolAccount) && /permiso|forbidden/i.test(valText);
        if (!job.preferredUploadAccountKey && (isDailyLimitErrorText(valText) || isForbiddenPool)) {
          excludedTokens.add(accessToken);
          if (isForbiddenPool && activeAuth.poolAccount) {
            sawPoolForbidden = true;
            lastPoolForbiddenLabel = activeAuth.accountLabel;
            activeAuth.poolAccount.canPublishDirectly = false;
            saveQuotaSettingsToDisk();
            addLiveLog(
              "picta",
              "warn",
              `La cuenta secundaria ${activeAuth.accountLabel} subi\xF3 el archivo 100% a S3 MinIO (${finalMinioKey}), pero tiene rol "Usuario com\xFAn" (sin permiso directo de publicaci\xF3n). Probando con otra cuenta...`
            );
          } else if (isMaster) {
            const todayCuba = getTodayCubaDateStr();
            if (activeAuth.poolAccount) {
              activeAuth.poolAccount.uploadedToday = 10;
              activeAuth.poolAccount.exhaustedDate = todayCuba;
            } else {
              quotaSettings.primaryExhaustedDate = todayCuba;
            }
            saveQuotaSettingsToDisk();
          }
          try {
            activeAuth = await resolveUploadTokenWithQuotaPool(
              job.telegramChatId,
              tipId,
              targetChannelId,
              excludedTokens
            );
            accessToken = activeAuth.token;
          } catch (rotErr) {
            if (sawPoolForbidden && isMaster) {
              throw new Error(
                `QUOTA_S3_PREUPLOADED_WAITING_SLOT: \xA1El archivo de video (${formatBytes(fileSize)}) YA qued\xF3 100% subido y asegurado en el servidor S3 de Picta (ID MinIO: ${finalMinioKey}) gracias a tu cuenta secundaria ${lastPoolForbiddenLabel}! Sin embargo, esa cuenta secundaria es de tipo "Usuario com\xFAn" (sin rol de Jefe de canal en Picta) y tu cuenta principal ya cumpli\xF3 sus 10 publicaciones de hoy. El cap\xEDtulo queda guardado en cola con su video ya subido al 100% para publicarse en 1 segundo (sin volver a subir los megas) apenas se reinicie la cuota o pulses Reintentar.`
              );
            }
            throw rotErr;
          }
          continue;
        }
        if (valRes.status === 400 && valText.includes("Ya existe Contenido con este nombre")) {
          const curName = sanitizePublicPictaText(job.title);
          const yearSuffix = meta.ano || (job.title.match(/\b(19\d\d|20\d\d)\b/) || [])[1] || "HD";
          const resolvedName = curName.includes("(") ? `${curName} \xB7 v2` : `${curName} (${yearSuffix})`;
          addLiveLog(
            "picta",
            "warn",
            `Picta validar_campos detect\xF3 t\xEDtulo repetido ("${curName}"). Auto-resolviendo a "${resolvedName}" con archivo S3 ya subido...`
          );
          pubForm.set("nombre", resolvedName);
          job.title = resolvedName;
        } else {
          const formattedErr = formatPictaError(valRes.status, valText);
          job.pictaResponseCode = valRes.status;
          job.pictaResponseText = valText;
          addLiveLog("picta", "error", `Fallo de validaci\xF3n en Picta:
${formattedErr}`);
          throw new Error(formattedErr);
        }
      }
    } catch (valErr) {
      if (valErr instanceof Error && (valErr.message.includes("Error HTTP") || valErr.message.includes("QUOTA_"))) {
        throw valErr;
      }
    }
    const createRes = await fetchPictaWithRetry("https://api.picta.cu/v1/publicacion/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      },
      body: pubForm
    });
    createText = await createRes.text();
    job.pictaResponseCode = createRes.status;
    job.pictaResponseText = createText;
    if (!createRes.ok) {
      const isForbiddenPool = isMaster && createRes.status === 403 && Boolean(activeAuth.poolAccount) && /permiso|forbidden/i.test(createText);
      if (!job.preferredUploadAccountKey && (isDailyLimitErrorText(createText) || isForbiddenPool)) {
        excludedTokens.add(accessToken);
        if (isForbiddenPool && activeAuth.poolAccount) {
          sawPoolForbidden = true;
          lastPoolForbiddenLabel = activeAuth.accountLabel;
          activeAuth.poolAccount.canPublishDirectly = false;
          saveQuotaSettingsToDisk();
        } else if (isMaster) {
          const todayCuba = getTodayCubaDateStr();
          if (activeAuth.poolAccount) {
            activeAuth.poolAccount.uploadedToday = 10;
            activeAuth.poolAccount.exhaustedDate = todayCuba;
          } else {
            quotaSettings.primaryExhaustedDate = todayCuba;
          }
          saveQuotaSettingsToDisk();
        }
        try {
          activeAuth = await resolveUploadTokenWithQuotaPool(
            job.telegramChatId,
            tipId,
            targetChannelId,
            excludedTokens
          );
          accessToken = activeAuth.token;
        } catch (rotErr) {
          if (sawPoolForbidden && isMaster) {
            throw new Error(
              `QUOTA_S3_PREUPLOADED_WAITING_SLOT: \xA1El archivo de video (${formatBytes(fileSize)}) YA qued\xF3 100% subido y asegurado en el servidor S3 de Picta (ID MinIO: ${finalMinioKey}) gracias a tu cuenta secundaria ${lastPoolForbiddenLabel}! Sin embargo, esa cuenta secundaria es de tipo "Usuario com\xFAn" (sin rol de Jefe de canal en Picta) y tu cuenta principal ya cumpli\xF3 sus 10 publicaciones de hoy. El cap\xEDtulo queda guardado en cola con su video ya subido al 100% para publicarse en 1 segundo (sin volver a subir los megas) apenas se reinicie la cuota o pulses Reintentar.`
            );
          }
          throw rotErr;
        }
        continue;
      }
      if (createRes.status === 400 && createText.includes("Ya existe Contenido con este nombre")) {
        const curName = sanitizePublicPictaText(job.title);
        const resolvedName = curName.includes("(") ? `${curName} (v2)` : `${curName} (${meta.ano || (job.title.match(/\b(19\d\d|20\d\d)\b/) || [])[1] || "2024"})`;
        addLiveLog(
          "picta",
          "warn",
          `Picta detect\xF3 t\xEDtulo repetido ("${curName}"). Auto-resolviendo a "${resolvedName}" y registrando con archivo S3 ya subido...`
        );
        pubForm.set("nombre", resolvedName);
        const retryRes = await fetchPictaWithRetry("https://api.picta.cu/v1/publicacion/", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Origin: "https://admin.picta.cu",
            Referer: "https://admin.picta.cu/"
          },
          body: pubForm
        });
        if (retryRes.ok) {
          createText = await retryRes.text();
          job.pictaResponseCode = retryRes.status;
          job.pictaResponseText = createText;
          break;
        }
      }
      const formattedErr = formatPictaError(createRes.status, createText);
      addLiveLog("picta", "error", `Fallo al registrar publicaci\xF3n en Picta:
${formattedErr}`);
      throw new Error(formattedErr);
    }
    break;
  }
  ensureDailyQuotaReset();
  if (activeAuth.poolAccount) {
    activeAuth.poolAccount.uploadedToday = (activeAuth.poolAccount.uploadedToday || 0) + 1;
    savePoolAccountsForChat(job.telegramChatId);
  }
  if (isMaster) {
    if (tipId === 5) {
      quotaSettings.seriesUploadedToday = (quotaSettings.seriesUploadedToday || 0) + 1;
    } else {
      quotaSettings.otherUploadedToday = (quotaSettings.otherUploadedToday || 0) + 1;
    }
    saveQuotaSettingsToDisk();
  }
  invalidateChannelCatalogSnapshotCache(targetChannelId);
  try {
    const createdObj = JSON.parse(createText);
    if (createdObj && createdObj.id) {
      job.pictaPublicationId = Number(createdObj.id);
      if (createdObj.slug_url) {
        job.modelMetadata = {
          ...job.modelMetadata || {},
          pictaSlugUrl: String(createdObj.slug_url).trim()
        };
      }
      if (tipId === 5) {
        const sPelser = Number(meta.serie_pelser_id || 0);
        const sName = cleanSerieDisplayName(
          String(meta.serie || parsedSerieInfo.serieName || "Serie")
        );
        const sTemp = Number(meta.temporada || parsedSerieInfo.temporada || 1) || 1;
        const sTempId = Number(meta.temporada_id || 0);
        const sEp = Number(meta.numero || parsedSerieInfo.numero || 1) || 1;
        upsertChannelSerieRecord(
          sPelser,
          sName,
          sTempId > 0 ? { id: sTempId, numero: sTemp, nombre: `Temporada ${sTemp}` } : void 0,
          {
            canalId: Number(targetChannelId)
          },
          {
            pubId: job.pictaPublicationId,
            numero: sEp,
            temporada: sTemp,
            ...sTempId > 0 ? { temporadaId: sTempId } : {},
            nombre: sanitizePublicPictaText(job.title),
            descripcion: sanitizePublicPictaText(job.synopsis),
            minioKey: finalMinioKey,
            publicado: true,
            convertido: false,
            updatedAt: (/* @__PURE__ */ new Date()).toISOString()
          }
        );
      }
    }
  } catch {
  }
  try {
    const convForm = new FormData();
    convForm.append("action", "convert");
    convForm.append("minio_id", finalMinioKey);
    convForm.append("descargable", "true");
    await fetchPictaWithRetry("https://api.picta.cu/v2/publicacion/proxy_nomad/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      },
      body: convForm
    });
    addLiveLog(
      "picta",
      "success",
      `Conversi\xF3n Nomad iniciada en ${targetChannelName} (#${targetChannelId}, minio_id: ${finalMinioKey}).`
    );
  } catch {
  }
}
var keepAliveActive = false;
function getProtectedScratchPaths(excludeJobId) {
  const protectedSet = /* @__PURE__ */ new Set();
  const protectedIds = /* @__PURE__ */ new Set();
  if (activeDownloadJobId && activeDownloadJobId !== excludeJobId) protectedIds.add(activeDownloadJobId);
  if (activeUploadJobId && activeUploadJobId !== excludeJobId) protectedIds.add(activeUploadJobId);
  if (activeJobId && activeJobId !== excludeJobId) protectedIds.add(activeJobId);
  for (const id of runningJobIds) {
    if (id !== excludeJobId) protectedIds.add(id);
  }
  for (const j of transferJobs) {
    if (!j || !j.tempFilePath || j.id === excludeJobId) continue;
    const isStagedQueued = j.stage === "queued" && !j.minioKey && Boolean(j.integrityVerified) && (j.expectedBytes === 0 || j.diskVerifiedBytes === j.expectedBytes);
    if (protectedIds.has(j.id) || isStagedQueued) {
      protectedSet.add(j.tempFilePath);
    }
  }
  return protectedSet;
}
function buildPipelineJobsMap() {
  const map = /* @__PURE__ */ new Map();
  for (const j of transferJobs) {
    if (!j) continue;
    const fileExistsOnDisk = Boolean(j.tempFilePath && fs3.existsSync(j.tempFilePath));
    const isQuotaPaused = j.stage === "queued" && Boolean(
      j.errorDetails && (j.errorDetails.includes("QUOTA_") || isDailyLimitErrorText(j.errorDetails))
    );
    const isEncoderPaused = isEncoderJobPausedInQueue(j);
    map.set(j.id, {
      id: j.id,
      telegramChatId: j.telegramChatId,
      stage: isQuotaPaused ? "quota_paused" : isEncoderPaused ? "encoder_paused" : j.stage,
      expectedBytes: j.expectedBytes,
      diskVerifiedBytes: j.diskVerifiedBytes,
      integrityVerified: j.integrityVerified,
      minioKey: j.minioKey,
      tempFilePath: j.tempFilePath,
      fileExistsOnDisk
    });
  }
  return map;
}
function removeJobFromUploadQueue(jobId) {
  let idx = uploadQueue.indexOf(jobId);
  while (idx !== -1) {
    uploadQueue.splice(idx, 1);
    idx = uploadQueue.indexOf(jobId);
  }
}
function startCloudRunCpuKeepAlive() {
  if (keepAliveActive) return;
  const targetUrl = detectCloudRunUrl();
  if (!targetUrl || !targetUrl.startsWith("http")) return;
  keepAliveActive = true;
  const hasActiveWork = () => Boolean(activeDownloadJobId || activeUploadJobId || activeJobId || uploadQueue.length > 0 || runningJobIds.size > 0);
  const holdLoop = async (workerIdx) => {
    while (keepAliveActive && hasActiveWork()) {
      try {
        await fetch(`${targetUrl}/api/cloudrun-keepalive?hold=1&w=${workerIdx}&t=${Date.now()}`, {
          headers: { "User-Agent": `CloudRun-CPU-Lease-${workerIdx}` }
        });
      } catch {
      }
      if (keepAliveActive && hasActiveWork()) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  };
  void holdLoop(1);
  setTimeout(() => {
    if (keepAliveActive && hasActiveWork()) {
      void holdLoop(2);
    }
  }, 1500);
}
function stopCloudRunCpuKeepAlive() {
  if (!activeDownloadJobId && !activeUploadJobId && uploadQueue.length === 0 && runningJobIds.size === 0) {
    keepAliveActive = false;
  }
}
function resolveJobTargetChannelInfo(job) {
  const isMaster = isMasterAdminChat(job.telegramChatId);
  const ctx = getEffectivePictaContext(job.telegramChatId);
  const masterDefaultId = botConfig.pictaChannelId || "36319";
  const channelId = job.targetChannelId && (isMaster || job.targetChannelId !== masterDefaultId) ? job.targetChannelId : ctx.channelId;
  const channelName = job.targetChannelName || ctx.channelName || "Mi Canal";
  if (channelId && !job.targetChannelId) job.targetChannelId = channelId;
  if (channelName && !job.targetChannelName) job.targetChannelName = channelName;
  return { channelId, channelName, isMaster };
}
async function prepareJobMetadataBeforeTransfer(job, customTitle) {
  const { channelName } = resolveJobTargetChannelInfo(job);
  const ctx = getEffectivePictaContext(job.telegramChatId);
  const prevMeta = job.modelMetadata || {};
  const analyzedFromJob = analyzeVideoTitleAndSynopsis(job.fileName, job.caption);
  const parsedFromJob = analyzedFromJob.seriesInfo;
  const knownSerieName = !isGenericOrInvalidSerieName(String(prevMeta.serie || "")) ? String(prevMeta.serie) : parsedFromJob.serieName;
  const knownTemp = String(prevMeta.temporada || parsedFromJob.temporada || "1");
  const knownEp = String(prevMeta.numero || parsedFromJob.numero || "1");
  const knownSub = String(prevMeta.episodeSubtitle || parsedFromJob.episodeSubtitle || "").trim();
  const knownPelser = Number(prevMeta.serie_pelser_id || 0);
  const inheritedStyle = job.tipologiaId === 5 ? resolveSeriesStyleForChannel(job.telegramChatId, knownPelser, knownSerieName) : null;
  const [generated] = await Promise.all([
    generateVideoMetadataWithAI(
      job.fileName,
      job.caption,
      customTitle ? String(customTitle) : job.titleMode === "manual" ? job.title : void 0,
      job.category,
      job.tipologiaId,
      channelName,
      job.tipologiaId === 5 ? {
        serieName: knownSerieName,
        temporada: knownTemp,
        numero: knownEp,
        episodeSubtitle: knownSub,
        inheritedStyle
      } : void 0
    ),
    ctx.accessTokenPromise.catch(() => ""),
    ensureMtprotoClient().catch(() => null)
  ]);
  if (generated.modelMetadata) {
    job.modelMetadata = { ...generated.modelMetadata, ...job.modelMetadata || {} };
    if (job.tipologiaId === 5) {
      if (knownSerieName && !isGenericOrInvalidSerieName(knownSerieName)) {
        job.modelMetadata.serie = knownSerieName;
      }
      if (knownTemp) job.modelMetadata.temporada = knownTemp;
      if (knownEp) job.modelMetadata.numero = knownEp;
      if (knownSub) job.modelMetadata.episodeSubtitle = knownSub;
    }
  }
  if (customTitle && customTitle.trim()) {
    job.title = customTitle.trim();
  } else if (job.titleMode === "manual" && job.title) {
  } else if (job.tipologiaId === 5 && job.modelMetadata?.serie && !isGenericOrInvalidSerieName(String(job.modelMetadata.serie))) {
    const fSerie = String(job.modelMetadata.serie);
    const fTemp = String(job.modelMetadata.temporada || knownTemp || "1");
    const fEp = String(job.modelMetadata.numero || knownEp || "1");
    const fSub = String(job.modelMetadata.episodeSubtitle || knownSub || "");
    job.title = inheritedStyle ? formatEpisodeWithSeriesStyle(inheritedStyle, {
      serieName: fSerie,
      temporada: fTemp,
      numero: fEp,
      episodeSubtitle: fSub
    }) : formatSerieEpisodeTitle(fSerie, fTemp, fEp, fSub);
  } else {
    job.title = generated.title;
  }
  const shouldReplaceSynopsis = job.tipologiaId === 5 ? isStaleOrGenericSerieSynopsis(
    job.synopsis,
    job.caption,
    String(job.modelMetadata?.numero || knownEp || "")
  ) || isLikelyEnglishText(job.synopsis) : isGenericAutoSynopsis(job.synopsis, job.caption) || isLikelyEnglishText(job.synopsis);
  if (shouldReplaceSynopsis) {
    job.synopsis = generated.synopsis;
  }
  if (!job.tags || job.tags.length === 0) {
    job.tags = generated.tags;
  }
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  saveJobsToDisk();
}
async function handleJobPipelineFailure(job, statusMsgId, err) {
  const errMsg = err instanceof Error ? err.message : String(err);
  if (errMsg.includes("SUBIDA_CANCELADA_POR_USUARIO") || cancelledJobIds.has(job.id)) {
    removeJobFromUploadQueue(job.id);
    job.stage = "cancelled";
    job.errorDetails = "Subida cancelada por el usuario desde Telegram.";
    job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    currentActivity = `Subida cancelada por usuario: "${job.title}"`;
    saveJobsToDisk();
    if (job.tempFilePath && fs3.existsSync(job.tempFilePath)) {
      try {
        fs3.unlinkSync(job.tempFilePath);
      } catch {
      }
    }
    addLiveLog("system", "warn", `Subida cancelada por usuario: "${job.title}"`);
    if (statusMsgId) {
      const cancelKb = [
        [
          {
            text: "\u{1F504} Reanudar / Reintentar Subida",
            callback_data: `retry:${job.id}`
          }
        ]
      ];
      if (getPoolAccountsForChat(job.telegramChatId).length > 0) {
        cancelKb.push([
          {
            text: "\u{1F91D} Elegir Cuenta y Reintentar",
            callback_data: `retry_acct:${job.id}`
          }
        ]);
      }
      await editTelegramStatusMessage(
        job.telegramChatId,
        statusMsgId,
        `\u{1F6D1} <b>SUBIDA CANCELADA POR EL USUARIO</b>
<blockquote>\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}
\u{1F4C4} <b>Archivo:</b> <code>${escapeHtml(job.fileName)}</code></blockquote>
<i>La transferencia se ha detenido y el espacio temporal en servidor fue liberado.</i>`,
        cancelKb,
        true
      );
    }
    return;
  }
  if (errMsg.includes("QUOTA_SERIE_RESERVED_REACHED") || errMsg.includes("QUOTA_DAILY_LIMIT_REACHED") || errMsg.includes("QUOTA_S3_PREUPLOADED_WAITING_SLOT") || isDailyLimitErrorText(errMsg)) {
    const isMaster = isMasterAdminChat(job.telegramChatId);
    job.stage = "queued";
    job.errorDetails = errMsg;
    job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    if (!uploadQueue.includes(job.id)) {
      uploadQueue.push(job.id);
    }
    saveJobsToDisk();
    if (job.minioKey && job.tempFilePath && fs3.existsSync(job.tempFilePath)) {
      try {
        fs3.unlinkSync(job.tempFilePath);
      } catch {
      }
    }
    const isReservePause = errMsg.includes("QUOTA_SERIE_RESERVED_REACHED");
    const isS3Preuploaded = Boolean(job.minioKey);
    const userQueueCount = filterJobsForUser(
      uploadQueue.map((id) => transferJobs.find((j) => j.id === id)).filter((j) => Boolean(j)),
      job.telegramChatId,
      MASTER_ADMIN_CHAT_ID
    ).length;
    addLiveLog(
      "picta",
      "warn",
      `Cola en pausa inteligente por gesti\xF3n de cuota diaria: "${job.title}" (${errMsg})`
    );
    if (statusMsgId) {
      const quotaKb = [];
      if (isMaster && isReservePause) {
        quotaKb.push([
          {
            text: "\u{1F513} Usar cupos restantes para esta serie ahora",
            callback_data: `quota_unlock_and_retry:${job.id}`
          }
        ]);
      }
      if (isMaster) {
        quotaKb.push([
          {
            text: "\u2795 A\xF1adir Cuenta Secundaria al Pool (+10 videos/d\xEDa)",
            callback_data: "quota_add_account"
          }
        ]);
      }
      quotaKb.push([
        {
          text: "\u2696\uFE0F Ver Cuota Diaria (/cuota)",
          callback_data: "quota_menu"
        },
        {
          text: isS3Preuploaded ? "\u26A1 Publicar Ficha (Ya en S3)" : "\u{1F504} Reintentar Subida",
          callback_data: `retry:${job.id}`
        }
      ]);
      if (getPoolAccountsForChat(job.telegramChatId).length > 0) {
        quotaKb.push([
          {
            text: "\u{1F91D} Cambiar Cuenta y Reintentar",
            callback_data: `retry_acct:${job.id}`
          }
        ]);
      }
      await editTelegramStatusMessage(
        job.telegramChatId,
        statusMsgId,
        (isS3Preuploaded ? `\u2705 <b>VIDEO 100% SUBIDO A S3 PICTA \xB7 EN ESPERA DE CUPO DE PUBLICACI\xD3N</b>
` : `\u23F8\uFE0F <b>SUBIDA EN PAUSA POR GESTI\xD3N DE CUOTA DIARIA</b>
`) + `<blockquote>\u{1F3AC} <b>Video en espera:</b> ${escapeHtml(job.title)}
\u{1F4DD} <b>Sinopsis (Espa\xF1ol):</b> ${escapeHtml(job.synopsis)}
` + (job.minioKey ? `\u{1F511} <b>Manifiesto S3 Listo:</b> <code>${escapeHtml(job.minioKey)}</code> (100% en servidor Picta)
` : "") + `\u{1F4E6} <b>Tu cola protegida:</b> ${userQueueCount} video(s) guardado(s)</blockquote>
\u{1F4A1} <b>Detalle:</b> ${escapeHtml(errMsg.replace(/^QUOTA_[A-Z0-9_]+:\s*/, ""))}`,
        quotaKb,
        true
      );
    }
    return;
  }
  const isEncoderServerErr = isPictaEncoderOrTransientServerError(
    errMsg,
    job.pictaResponseCode
  );
  const safeErrBlock = `<pre>${errMsg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
  if (isEncoderServerErr && job.minioKey) {
    const shouldAutoRetryInQueue = Boolean(
      job.encoderRetryActive || job.encoderManualRetryTriggered
    );
    if (shouldAutoRetryInQueue) {
      const decision = computeNextEncoderRetryState(job.encoderRetryCount || 0, Date.now());
      if (decision.shouldContinue) {
        job.stage = "queued";
        job.encoderRetryActive = true;
        job.encoderRetryCount = decision.nextAttemptCount;
        job.encoderRetryNextAt = decision.nextRetryAtMs;
        job.encoderRetryLastError = errMsg;
        job.encoderManualRetryTriggered = false;
        job.errorDetails = errMsg;
        job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        if (!uploadQueue.includes(job.id)) {
          uploadQueue.push(job.id);
        }
        currentActivity = `Esperando codificador de Picta para "${job.title}" (reintento ${decision.nextAttemptCount}/${MAX_ENCODER_AUTO_RETRIES} en ${decision.waitMinutes} min)...`;
        saveJobsToDisk();
        startCloudRunCpuKeepAlive();
        addLiveLog(
          "picta",
          "warn",
          `Codificador de Picta a\xFAn detenido para "${job.title}". Reintento autom\xE1tico ${decision.nextAttemptCount}/${MAX_ENCODER_AUTO_RETRIES} programado en ${decision.waitMinutes} min (Manifiesto S3: ${job.minioKey}).`
        );
        if (statusMsgId) {
          await editTelegramStatusMessage(
            job.telegramChatId,
            statusMsgId,
            `${hudHeader("CODIFICADOR OCUPADO \xB7 AUTO-REINTENTO")}
` + hudBox([
              `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}`,
              `\u{1F4C2} <b>Categor\xEDa:</b> ${escapeHtml(job.category || "Audiovisual")}`,
              `\u{1F511} <b>Manifiesto S3:</b> <code>${escapeHtml(job.minioKey)}</code> \xB7 100% seguro`,
              `\u23F1\uFE0F <b>Pr\xF3ximo intento:</b> en ${decision.waitMinutes} min (${decision.nextAttemptCount}/${MAX_ENCODER_AUTO_RETRIES})`
            ]) + `
\u{1F4A1} <b>Motivo:</b> ${escapeHtml(extractShortEncoderErrorReason(errMsg))}
<i>Tus dem\xE1s videos siguen subiendo normalmente; te avisar\xE9 al publicarse.</i>`,
            [
              [{ text: "\u{1F504} Reintentar Ahora", callback_data: `retry:${job.id}` }],
              [{ text: "\u{1F6D1} Detener Auto-Reintento", callback_data: `encoder_stop_retry:${job.id}` }]
            ],
            true
          );
        }
        return;
      }
    }
    removeJobFromUploadQueue(job.id);
    const exhaustedAutoRetries = Boolean(
      job.encoderRetryActive && (job.encoderRetryCount || 0) >= MAX_ENCODER_AUTO_RETRIES
    );
    job.stage = "failed";
    job.encoderRetryActive = false;
    job.encoderRetryNextAt = void 0;
    job.encoderManualRetryTriggered = false;
    job.encoderRetryLastError = errMsg;
    job.errorDetails = errMsg;
    job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    currentActivity = `Codificador Picta detenido en "${job.title}": ${errMsg.slice(0, 90)}`;
    saveJobsToDisk();
    addLiveLog(
      "picta",
      "error",
      `Fallo temporal del codificador de Picta en "${job.fileName}" (S3 key intacto: ${job.minioKey}): ${errMsg}`
    );
    if (statusMsgId) {
      const encoderKeyboard = [
        [
          {
            text: "\u{1F504} Reintentar Publicaci\xF3n Ahora",
            callback_data: `retry:${job.id}`
          }
        ],
        [
          {
            text: exhaustedAutoRetries ? "\u23F1\uFE0F Reactivar Auto-Reintento (cada 2 min)" : "\u23F1\uFE0F Auto-Reintentar en Cola (cada 2 min)",
            callback_data: `encoder_auto_queue:${job.id}`
          }
        ],
        [
          {
            text: "\u270D\uFE0F Editar T\xEDtulo / Datos",
            callback_data: `retry_manual:${job.id}`
          }
        ]
      ];
      await editTelegramStatusMessage(
        job.telegramChatId,
        statusMsgId,
        `${hudHeader(
          exhaustedAutoRetries ? `CODIFICADOR DETENIDO (${MAX_ENCODER_AUTO_RETRIES} INTENTOS)` : "CODIFICADOR TEMPORALMENTE DETENIDO"
        )}
` + hudBox([
          `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}`,
          `\u{1F4C2} <b>Categor\xEDa:</b> ${escapeHtml(job.category || "Audiovisual")}`,
          `\u{1F511} <b>Manifiesto S3:</b> <code>${escapeHtml(job.minioKey)}</code> \xB7 100% subido`
        ]) + `
\u{1F4A1} <b>Estado:</b> ${escapeHtml(extractShortEncoderErrorReason(errMsg))} <i>(0 MB por re-subir)</i>

${hudSection("Respuesta t\xE9cnica de Picta")}
${safeErrBlock}

<i>Elige c\xF3mo continuar:</i>`,
        encoderKeyboard,
        true
      );
    }
    return;
  }
  const isForbiddenErr = isPictaForbiddenResponse(job.pictaResponseCode, errMsg);
  let roleDiagnosticNote = "";
  if (isForbiddenErr) {
    try {
      const ctx = getEffectivePictaContext(job.telegramChatId);
      const tok = await ctx.accessTokenPromise;
      const meObj = await fetchDecryptedPictaMe2(tok);
      const grp = extractPictaGroupSummary(meObj);
      const sess = userSessions.get(job.telegramChatId);
      if (sess && grp.groupNames.length > 0) {
        sess.pictaGroups = grp.groupNames;
        sess.hasChannelAdminRole = grp.hasChannelAdminRole;
        saveUserSessionsToDisk();
      }
      if (!grp.hasChannelAdminRole && grp.groupNames.length > 0) {
        roleDiagnosticNote = buildPictaRoleDiagnosticLines({
          username: String(meObj?.username || sess?.username || "tu cuenta"),
          groupNames: grp.groupNames,
          hasChannelAdminRole: grp.hasChannelAdminRole,
          channelName: ctx.channelName,
          channelId: ctx.channelId
        });
      }
    } catch {
    }
  }
  removeJobFromUploadQueue(job.id);
  job.stage = "failed";
  job.encoderRetryActive = false;
  job.encoderRetryNextAt = void 0;
  job.encoderManualRetryTriggered = false;
  job.errorDetails = errMsg;
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  currentActivity = `Error en "${job.fileName}": ${errMsg.slice(0, 90)}`;
  saveJobsToDisk();
  addLiveLog("picta", "error", `Fallo en "${job.fileName}": ${errMsg}`);
  if (statusMsgId) {
    const hasChatPool = getPoolAccountsForChat(job.telegramChatId).length > 0;
    const retryKeyboard = isForbiddenErr && roleDiagnosticNote ? [
      [{ text: "\u{1F6E1}\uFE0F Verificar Cuenta (/cuenta)", callback_data: "cmd_cuenta" }],
      [{ text: "\u{1F504} Reintentar cuando soporte reactive el rol", callback_data: `retry:${job.id}` }]
    ] : [
      [
        {
          text: "\u{1F504} Reintentar Publicaci\xF3n Directa",
          callback_data: `retry:${job.id}`
        }
      ],
      [
        {
          text: "\u270D\uFE0F Rellenar / Corregir Datos en Telegram",
          callback_data: `retry_manual:${job.id}`
        }
      ]
    ];
    if (hasChatPool) {
      retryKeyboard.unshift([
        {
          text: "\u{1F91D} Cambiar Cuenta y Reintentar",
          callback_data: `retry_acct:${job.id}`
        }
      ]);
    }
    await editTelegramStatusMessage(
      job.telegramChatId,
      statusMsgId,
      `${hudHeader("PUBLICACI\xD3N INTERRUMPIDA")}
` + hudBox([
        `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}`,
        `\u{1F4C2} <b>Categor\xEDa:</b> ${escapeHtml(job.category || "Audiovisual")}`,
        job.preferredUploadAccountLabel ? `\u{1F464} <b>Cuenta usada:</b> ${escapeHtml(job.preferredUploadAccountLabel)}` : void 0,
        `\u{1F511} <b>Manifiesto S3:</b> <code>${escapeHtml(job.minioKey || "Pendiente")}</code>`
      ]) + `
` + (roleDiagnosticNote ? `${roleDiagnosticNote}

` : isEncoderServerErr ? `\u{1F4A1} <b>Nota:</b> ${escapeHtml(extractShortEncoderErrorReason(errMsg))}

` : "") + `${hudSection("Detalle del error")}
${safeErrBlock}

` + (roleDiagnosticNote ? `\u{1F4A1} <i>Tu video qued\xF3 guardado en S3 MinIO. Apenas soporte reactive el rol <b>Jefe de canal</b>, pulsa Reintentar.</i>` : job.minioKey ? `\u{1F4A1} <i>El video ya est\xE1 subido al 100% en S3 MinIO. Usa "Reintentar" o "Rellenar / Corregir Datos".</i>` : `\u{1F4A1} <i>Puedes reintentar el proceso con los botones inferiores.</i>`),
      retryKeyboard,
      true
    );
  }
}
async function runDownloadStage(job) {
  if (activeDownloadJobId || runningJobIds.has(job.id)) return;
  activeDownloadJobId = job.id;
  syncActiveJobId();
  runningJobIds.add(job.id);
  startCloudRunCpuKeepAlive();
  const { channelId, channelName } = resolveJobTargetChannelInfo(job);
  let statusMsgId = job.statusMessageId || null;
  try {
    await prepareJobMetadataBeforeTransfer(job);
    if (cancelledJobIds.has(job.id)) {
      throw new Error("SUBIDA_CANCELADA_POR_USUARIO");
    }
    const chLabel = channelId ? `${escapeHtml(channelName)} (#${escapeHtml(channelId)})` : escapeHtml(channelName);
    const initialStatusText = `${hudHeader("INICIANDO TRANSFERENCIA")}
` + hudBox([
      `\u{1F4FA} <b>Destino:</b> ${chLabel}`,
      `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}`,
      `\u{1F4E6} <b>Tama\xF1o:</b> ${formatBytes(job.expectedBytes)}`,
      `\u{1F4DD} <b>Sinopsis:</b> ${escapeHtml(job.synopsis.slice(0, 110))}`
    ]) + `
\u23F3 <i>Descargando v\xEDa MTProto 2 GB Turbo al disco scratch...</i>`;
    if (statusMsgId) {
      await editTelegramStatusMessage(job.telegramChatId, statusMsgId, initialStatusText);
    } else {
      statusMsgId = await sendTelegramStatusMessage(
        job.telegramChatId,
        initialStatusText,
        job.telegramMessageId
      );
      if (statusMsgId) {
        job.statusMessageId = statusMsgId;
        saveJobsToDisk();
      }
    }
    if (!job.minioKey) {
      const localFilePath = await downloadFullVideoFromTelegram(job, statusMsgId);
      verifyCompleteFileOnDisk(job, localFilePath);
      await editTelegramStatusMessage(
        job.telegramChatId,
        statusMsgId,
        `${hudHeader("FASE 2/4 \xB7 INTEGRIDAD VERIFICADA 100%")}
` + hudBox([
          `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}`,
          `\u{1F4CA} <b>Estado:</b> <code>${renderVisualBar(100)}</code>`,
          `\u{1F4E6} <b>Archivo \xEDntegro:</b> ${formatBytes(job.diskVerifiedBytes)}`
        ]) + `
\u23F3 <i>Listo para transmitir a Picta${activeUploadJobId ? " (esperando turno S3)" : ""}...</i>`,
        void 0,
        true
      );
    }
    if (!cancelledJobIds.has(job.id)) {
      job.stage = "queued";
      job.errorDetails = void 0;
      if (!uploadQueue.includes(job.id)) {
        uploadQueue.push(job.id);
      }
      job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      saveJobsToDisk();
    }
  } catch (err) {
    await handleJobPipelineFailure(job, statusMsgId, err);
  } finally {
    runningJobIds.delete(job.id);
    if (activeDownloadJobId === job.id) {
      activeDownloadJobId = null;
    }
    syncActiveJobId();
    stopCloudRunCpuKeepAlive();
    setTimeout(() => {
      void scheduleTransferPipeline();
    }, 50);
  }
}
async function runUploadStage(job) {
  if (activeUploadJobId || runningJobIds.has(job.id)) return;
  activeUploadJobId = job.id;
  syncActiveJobId();
  runningJobIds.add(job.id);
  startCloudRunCpuKeepAlive();
  const { channelId, channelName } = resolveJobTargetChannelInfo(job);
  const chLabel = channelId ? `${escapeHtml(channelName)} (#${escapeHtml(channelId)})` : escapeHtml(channelName);
  let statusMsgId = job.statusMessageId || null;
  try {
    if (!job.tags || job.tags.length === 0 || isGenericAutoSynopsis(job.synopsis, job.caption)) {
      await prepareJobMetadataBeforeTransfer(job);
    }
    if (cancelledJobIds.has(job.id)) {
      throw new Error("SUBIDA_CANCELADA_POR_USUARIO");
    }
    let localFilePath = job.tempFilePath || "";
    if (job.minioKey) {
      const autoRetryBadge = job.encoderRetryActive ? ` (Auto-reintento #${Math.max(1, job.encoderRetryCount || 1)}/${MAX_ENCODER_AUTO_RETRIES})` : "";
      const s3ReadyMsg = `${hudHeader("RETOMANDO DESDE S3 MINIO")}
` + hudBox([
        `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}`,
        `\u{1F4C2} <b>Categor\xEDa:</b> ${escapeHtml(job.category || "Pel\xEDcula")}`,
        `\u{1F511} <b>Manifiesto:</b> <code>${escapeHtml(job.minioKey)}</code>`
      ]) + `
\u23F3 <i>Publicando ficha t\xE9cnica en ${chLabel}${autoRetryBadge}...</i>`;
      if (statusMsgId) {
        await editTelegramStatusMessage(job.telegramChatId, statusMsgId, s3ReadyMsg, void 0, true);
      } else {
        statusMsgId = await sendTelegramStatusMessage(job.telegramChatId, s3ReadyMsg, job.telegramMessageId);
        if (statusMsgId) {
          job.statusMessageId = statusMsgId;
          saveJobsToDisk();
        }
      }
    } else if (!localFilePath || !fs3.existsSync(localFilePath) || job.expectedBytes > 0 && fs3.statSync(localFilePath).size !== job.expectedBytes) {
      localFilePath = await downloadFullVideoFromTelegram(job, statusMsgId);
      verifyCompleteFileOnDisk(job, localFilePath);
    }
    await uploadFullVerifiedFileToPicta(job, localFilePath, statusMsgId);
    removeJobFromUploadQueue(job.id);
    job.stage = "completed";
    job.errorDetails = void 0;
    job.encoderRetryActive = false;
    job.encoderRetryCount = void 0;
    job.encoderRetryNextAt = void 0;
    job.encoderRetryLastError = void 0;
    job.encoderManualRetryTriggered = false;
    job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    currentActivity = `\xDAltima subida completada en ${channelName} (#${channelId}): "${job.title}" (${formatBytes(job.diskVerifiedBytes || job.expectedBytes)})`;
    saveJobsToDisk();
    pruneTransferJobsMemory();
    addLiveLog(
      "picta",
      "success",
      `\xA1Completado! "${job.title}" (${formatBytes(job.diskVerifiedBytes || job.expectedBytes)}) publicado en ${channelName} (#${channelId}).`
    );
    const remainingUserQueue = filterJobsForUser(
      uploadQueue.map((id) => transferJobs.find((j) => j.id === id)).filter((j) => Boolean(j && j.id !== job.id)),
      job.telegramChatId,
      MASTER_ADMIN_CHAT_ID
    ).length;
    const compKeyboard = [];
    if (job.pictaPublicationId) {
      const slug = String(job.modelMetadata?.pictaSlugUrl || "").trim();
      compKeyboard.push([
        {
          text: "\u{1F6AA} Enlace Directo",
          callback_data: `pub_direct_dl:${job.pictaPublicationId}`
        },
        {
          text: "\u{1F310} Ver en Picta Web",
          url: slug ? `https://www.picta.cu/medias/${encodeURIComponent(slug)}` : `https://www.picta.cu/medias/${job.pictaPublicationId}`
        }
      ]);
    }
    await editTelegramStatusMessage(
      job.telegramChatId,
      statusMsgId,
      `${hudHeader("PUBLICACI\xD3N COMPLETADA 100%")}
` + hudBox([
        `\u{1F4FA} <b>Canal:</b> ${chLabel}`,
        job.preferredUploadAccountLabel ? `\u{1F464} <b>Publicado por:</b> ${escapeHtml(job.preferredUploadAccountLabel)}` : void 0,
        `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}`,
        `\u{1F4C2} <b>Categor\xEDa:</b> ${escapeHtml(job.category || "Audiovisual")}`,
        `\u{1F4E6} <b>Tama\xF1o \xEDntegro:</b> ${formatBytes(job.diskVerifiedBytes || job.expectedBytes)}`,
        `\u{1F511} <b>Manifiesto S3:</b> <code>${escapeHtml(job.minioKey || "OK")}</code>`
      ]) + `
\u{1F4DD} <i>${escapeHtml(job.synopsis.slice(0, 220))}</i>` + (remainingUserQueue > 0 ? `

\u23ED\uFE0F <i>Iniciando siguiente video en cola (${remainingUserQueue} restante(s))...</i>` : ""),
      compKeyboard,
      true
    );
    try {
      await handlePostUploadRequestFulfillment(job);
    } catch {
    }
    try {
      await handlePostUploadMoviePromoConfirmation(job);
    } catch {
    }
    if (job.tempFilePath && fs3.existsSync(job.tempFilePath)) {
      try {
        fs3.unlinkSync(job.tempFilePath);
      } catch {
      }
    }
  } catch (err) {
    await handleJobPipelineFailure(job, statusMsgId, err);
  } finally {
    runningJobIds.delete(job.id);
    if (activeUploadJobId === job.id) {
      activeUploadJobId = null;
    }
    syncActiveJobId();
    stopCloudRunCpuKeepAlive();
    setTimeout(() => {
      void scheduleTransferPipeline();
    }, 50);
  }
}
var schedulerRunning = false;
async function scheduleTransferPipeline() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    for (let i = uploadQueue.length - 1; i >= 0; i--) {
      const qId = uploadQueue[i];
      const qJob = transferJobs.find((j) => j.id === qId);
      if (!qJob || cancelledJobIds.has(qId) || qJob.stage === "cancelled" || qJob.stage === "completed") {
        uploadQueue.splice(i, 1);
      }
    }
    const jobsMap = buildPipelineJobsMap();
    if (!activeUploadJobId) {
      const nextUpload = selectNextUploadJob(
        uploadQueue,
        jobsMap,
        activeUploadJobId,
        activeDownloadJobId
      );
      if (nextUpload) {
        const jobObj = transferJobs.find((j) => j.id === nextUpload.id);
        if (jobObj && !runningJobIds.has(jobObj.id)) {
          void runUploadStage(jobObj);
        }
      }
    }
    if (!activeDownloadJobId) {
      const freshMap = buildPipelineJobsMap();
      const nextDownload = selectNextDownloadJob(
        uploadQueue,
        freshMap,
        activeDownloadJobId,
        activeUploadJobId,
        MAX_PREFETCH_LOOKAHEAD
      );
      if (nextDownload) {
        const jobObj = transferJobs.find((j) => j.id === nextDownload.id);
        if (jobObj && !runningJobIds.has(jobObj.id)) {
          void runDownloadStage(jobObj);
        }
      }
    }
  } finally {
    schedulerRunning = false;
  }
}
async function cancelTransferJob(jobId, chatId, messageId) {
  cancelledJobIds.add(jobId);
  removeJobFromUploadQueue(jobId);
  const job = transferJobs.find((j) => j.id === jobId);
  if (!job) return false;
  const wasQueued = job.stage === "queued" || !runningJobIds.has(jobId);
  if (activeDownloadJobId === jobId) activeDownloadJobId = null;
  if (activeUploadJobId === jobId) activeUploadJobId = null;
  syncActiveJobId();
  runningJobIds.delete(jobId);
  job.stage = "cancelled";
  job.errorDetails = "Cancelado por el usuario desde Telegram.";
  job.encoderRetryActive = false;
  job.encoderRetryNextAt = void 0;
  job.encoderManualRetryTriggered = false;
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  saveJobsToDisk();
  if (job.tempFilePath && fs3.existsSync(job.tempFilePath)) {
    try {
      fs3.unlinkSync(job.tempFilePath);
    } catch {
    }
  }
  const targetMsgId = messageId || job.statusMessageId;
  if (targetMsgId) {
    await editTelegramStatusMessage(
      chatId || job.telegramChatId,
      targetMsgId,
      `${hudHeader(wasQueued ? "RETIRADO DE LA COLA" : "TRANSFERENCIA DETENIDA")}
` + hudBox([
        `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}`,
        `\u{1F4C4} <b>Archivo:</b> <code>${escapeHtml(job.fileName)}</code>`
      ]) + `
<i>Transferencia detenida. Puedes reanudarla cuando quieras con 1 clic.</i>`,
      [
        [
          {
            text: "\u{1F504} Reanudar Subida",
            callback_data: `retry:${job.id}`
          }
        ]
      ],
      true
    );
  }
  void scheduleTransferPipeline();
  return true;
}
async function sendOrEditQueueManagerInTelegram(chatId, messageId, replyToMessageId, notice) {
  const isMaster = isMasterAdminChat(chatId);
  const session = userSessions.get(chatId);
  if (!isMaster && !session?.channelId) {
    const text2 = `${hudHeader("COLA DE SUBIDA \xB7 ACCESO REQUERIDO")}
` + hudBox([
      `\u{1F512} <b>Estado:</b> Cuenta de Picta sin vincular`,
      `\u{1F449} Inicia sesi\xF3n con /login para gestionar tu cola personal.`
    ]);
    const keyboard2 = [
      [{ text: "\u{1F511} Iniciar Sesi\xF3n (/login)", callback_data: "cmd_login" }],
      [{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]
    ];
    if (messageId) {
      await editTelegramStatusMessage(chatId, messageId, text2, keyboard2, true);
    } else {
      await sendTelegramStatusMessage(chatId, text2, replyToMessageId, keyboard2);
    }
    return;
  }
  const activeUploadJob = activeUploadJobId ? transferJobs.find((j) => Boolean(j) && j.id === activeUploadJobId && (isMaster || j.telegramChatId === chatId)) : null;
  const activeDownloadJob = activeDownloadJobId && activeDownloadJobId !== activeUploadJobId ? transferJobs.find((j) => Boolean(j) && j.id === activeDownloadJobId && (isMaster || j.telegramChatId === chatId)) : null;
  const activeJob = activeUploadJob || activeDownloadJob;
  const queuedJobs = uploadQueue.filter((id) => id !== activeUploadJobId && id !== activeDownloadJobId).map((id) => transferJobs.find((j) => Boolean(j) && j.id === id)).filter((j) => Boolean(j)).filter((j) => isMaster || j.telegramChatId === chatId);
  const encoderWaitingJobs = queuedJobs.filter((j) => Boolean(j.encoderRetryActive));
  const normalQueuedJobs = queuedJobs.filter((j) => !j.encoderRetryActive);
  const pinned = pinnedBatchSerieByChat.get(chatId);
  const channelTag = isMaster ? "MULTIVERSO VISUAL (#36319)" : escapeHtml((session?.channelName || "MI CANAL").toUpperCase());
  let activeBlock = "";
  if (activeUploadJob) {
    activeBlock += `${hudSection("Subiendo a S3 Picta")}
` + hudBox([
      `\u{1F3AC} <b>${escapeHtml(activeUploadJob.title)}</b>`,
      `\u{1F4C2} ${escapeHtml(activeUploadJob.category)} \xB7 \u{1F4E6} ${formatBytes(activeUploadJob.expectedBytes)}`,
      `\u26A1 <b>Velocidad:</b> ${activeUploadJob.speedMBps || 0} MB/s`
    ]) + `
`;
  }
  if (activeDownloadJob) {
    activeBlock += `${hudSection("Pre-descargando (Scratch)")}
` + hudBox([
      `\u{1F3AC} <b>${escapeHtml(activeDownloadJob.title)}</b>`,
      `\u{1F4C2} ${escapeHtml(activeDownloadJob.category)} \xB7 \u{1F4E6} ${formatBytes(activeDownloadJob.expectedBytes)}`,
      `\u26A1 <b>Velocidad:</b> ${activeDownloadJob.speedMBps || 0} MB/s`
    ]) + `
`;
  }
  if (!activeBlock) {
    activeBlock = `\u{1F7E2} <b>Estado del motor:</b> <i>En reposo (listo para recibir videos).</i>

`;
  }
  const encoderBlock = encoderWaitingJobs.length > 0 ? `${hudSection(`Esperando codificador (${encoderWaitingJobs.length})`)}
` + encoderWaitingJobs.slice(0, 6).map((j, idx) => {
    const remMin = Math.max(
      0,
      Math.ceil((Number(j.encoderRetryNextAt || 0) - Date.now()) / 6e4)
    );
    return `<b>${idx + 1}.</b> \u23F1\uFE0F ${escapeHtml(j.title)} \xB7 <code>${j.encoderRetryCount || 1}/${MAX_ENCODER_AUTO_RETRIES}</code>${remMin > 0 ? ` (~${remMin}m)` : " (pronto)"}`;
  }).join("\n") + `

` : "";
  const queueBlock = normalQueuedJobs.length > 0 ? `${hudSection(`En cola de espera (${normalQueuedJobs.length})`)}
` + normalQueuedJobs.slice(0, 10).map(
    (j, idx) => `<b>${idx + 1}.</b> \u{1F3AC} ${escapeHtml(j.title)} \xB7 <code>${formatBytes(j.expectedBytes)}</code>`
  ).join("\n") + `

` : encoderWaitingJobs.length === 0 ? `\u{1F4ED} <b>Cola de espera:</b> <i>Vac\xEDa (0 videos pendientes).</i>

` : "";
  const pinnedBlock = pinned ? `${hudSection("Modo Serie Fija (R\xE1faga)")} \xB7 \u{1F7E2} <b>ACTIVO</b>
` + hudBox([
    `\u{1F4FA} <b>Serie:</b> ${escapeHtml(pinned.serieName)} \xB7 <b>T${escapeHtml(pinned.seasonNum)}</b>`,
    `\u{1F5BC}\uFE0F <b>Portada:</b> Autom\xE1tica de la serie en cada cap\xEDtulo`,
    `\u26A1 <i>Todo video reenviado entra directo a cola sin preguntas.</i>`
  ]) : `${hudSection("Modo Serie Fija (R\xE1faga)")} \xB7 \u26AA <i>Inactivo</i>
<i>(Act\xEDvalo desde /series para subir r\xE1fagas de cap\xEDtulos en autom\xE1tico)</i>`;
  const text = (notice ? `${notice}

` : "") + `${hudHeader(`COLA Y MODO R\xC1FAGA \xB7 ${channelTag}`)}

${activeBlock}${encoderBlock}${queueBlock}${pinnedBlock}`;
  const keyboard = [];
  if (activeUploadJob) {
    keyboard.push([
      {
        text: `\u{1F6D1} Cancelar subida: "${activeUploadJob.title.slice(0, 22)}"`,
        callback_data: `cancel_job:${activeUploadJob.id}`
      }
    ]);
  }
  if (activeDownloadJob) {
    keyboard.push([
      {
        text: `\u{1F6D1} Cancelar descarga: "${activeDownloadJob.title.slice(0, 20)}"`,
        callback_data: `cancel_job:${activeDownloadJob.id}`
      }
    ]);
  }
  for (const eJob of encoderWaitingJobs.slice(0, 4)) {
    keyboard.push([
      {
        text: `\u{1F504} Reintentar Ya: "${eJob.title.slice(0, 16)}"`,
        callback_data: `retry:${eJob.id}`
      },
      {
        text: `\u{1F6D1} Parar`,
        callback_data: `encoder_stop_retry:${eJob.id}`
      }
    ]);
  }
  for (const qJob of normalQueuedJobs.slice(0, 5)) {
    keyboard.push([
      {
        text: `\u274C Quitar: "${qJob.title.slice(0, 24)}"`,
        callback_data: `cancel_job:${qJob.id}`
      }
    ]);
  }
  if (pinned) {
    keyboard.push([
      {
        text: `\u{1F513} Desactivar Serie Fija (${pinned.serieName.slice(0, 18)})`,
        callback_data: "unpin_serie"
      }
    ]);
  } else {
    keyboard.push([
      {
        text: "\u{1F4CC} Elegir Serie para Modo R\xE1faga",
        callback_data: "my_series:0"
      }
    ]);
  }
  keyboard.push([
    { text: "\u{1F9E9} Unir Partes (/unir)", callback_data: "multipart_join:open" },
    { text: "\u26A1 Cuota Diaria", callback_data: "quota_menu" }
  ]);
  keyboard.push([
    { text: "\u{1F504} Actualizar Cola", callback_data: "queue_view" },
    { text: "\u{1F4CA} Videos (/stats)", callback_data: "dash_refresh:views:0" }
  ]);
  keyboard.push([{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    await sendTelegramStatusMessage(chatId, text, replyToMessageId, keyboard);
  }
}
async function sendOrEditQuotaMenuInTelegram(chatId, messageId, replyToMessageId, notice) {
  ensureDailyQuotaReset();
  const isMaster = isMasterAdminChat(chatId);
  const session = userSessions.get(chatId);
  if (!isMaster) {
    if (!session?.channelId) {
      const text3 = `${hudHeader("CUOTA DIARIA \xB7 ACCESO REQUERIDO")}
` + hudBox([
        `\u{1F512} <b>Estado:</b> Cuenta de Picta sin vincular`,
        `\u{1F449} Usa /login para ver el cupo diario de tu canal.`
      ]);
      const keyboard3 = [
        [{ text: "\u{1F511} Iniciar Sesi\xF3n (/login)", callback_data: "cmd_login" }],
        [{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]
      ];
      if (messageId) {
        await editTelegramStatusMessage(chatId, messageId, text3, keyboard3, true);
      } else {
        await sendTelegramStatusMessage(chatId, text3, replyToMessageId, keyboard3);
      }
      return;
    }
    const userPool = getPoolAccountsForChat(chatId);
    const publishableUserPool = userPool.filter((acc) => acc.canPublishDirectly !== false);
    const myUploaded = transferJobs.filter(
      (j) => j.telegramChatId === chatId && j.stage === "completed" && toCubaDateStr(j.updatedAt || j.createdAt) === quotaSettings.currentDateCuba
    ).length;
    const totalDailyCapacity2 = (1 + publishableUserPool.length) * 10;
    const myRemaining = Math.max(0, totalDailyCapacity2 - myUploaded);
    const quotaPct = totalDailyCapacity2 > 0 ? Math.round(myUploaded / totalDailyCapacity2 * 100) : 0;
    const userPoolLines = userPool.length > 0 ? userPool.map((acc, i) => {
      const roleTag = acc.canPublishDirectly === false ? " <i>(Usuario com\xFAn)</i>" : acc.canPublishDirectly === true ? " <i>(Jefe de canal \xB7 Colaborador)</i>" : "";
      return `<b>${i + 1}.</b> \u{1F91D} <code>${escapeHtml(acc.displayName || acc.username)}</code> \xB7 <b>${acc.uploadedToday || 0}/10</b>${roleTag}`;
    }).join("\n") : `<i>Ning\xFAn colaborador a\xF1adido (capacidad base: 10 videos/d\xEDa).</i>`;
    const text2 = (notice ? `${notice}

` : "") + `${hudHeader(`CUOTA DIARIA \xB7 ${session.channelName}`)}
` + hudBox([
      `\u{1F464} <b>Principal:</b> <code>@${escapeHtml(session.userFullName || session.username)}</code>`,
      `\u{1F4FA} <b>Canal:</b> ${escapeHtml(session.channelName)} \xB7 <code>#${escapeHtml(session.channelId)}</code>`,
      `\u26A1 <b>Uso hoy:</b> <code>${hudSegmentedBar(quotaPct, 10)}</code> (<b>${myUploaded}/${totalDailyCapacity2}</b> \xB7 ${myRemaining} libres)`,
      `\u{1F4C5} <b>Fecha (Cuba):</b> ${escapeHtml(quotaSettings.currentDateCuba)}`
    ]) + `
${hudSection(`Cuentas Colaboradoras en Pool (${userPool.length})`)}
${userPoolLines}

\u{1F4A1} <i>Si tienes colaboradores en el Pool, te preguntar\xE9 con qu\xE9 cuenta subir antes de cada video.</i>`;
    const keyboard2 = [
      [{ text: "\u2795 A\xF1adir Colaborador al Pool (+10/d\xEDa)", callback_data: "quota_add_account" }]
    ];
    for (let i = 0; i < Math.min(4, userPool.length); i++) {
      const acc = userPool[i];
      keyboard2.push([
        {
          text: `\u{1F5D1}\uFE0F Quitar Pool: ${acc.displayName || acc.username}`,
          callback_data: `quota_del_account:${i}`
        }
      ]);
    }
    keyboard2.push([{ text: "\u{1F504} Actualizar Cuota", callback_data: "cmd_cuota" }]);
    keyboard2.push([{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]);
    if (messageId) {
      await editTelegramStatusMessage(chatId, messageId, text2, keyboard2, true);
    } else {
      await sendTelegramStatusMessage(chatId, text2, replyToMessageId, keyboard2);
    }
    return;
  }
  const publishablePoolAccounts = quotaSettings.poolAccounts.filter(
    (acc) => acc.canPublishDirectly !== false
  );
  const totalAccounts = 1 + publishablePoolAccounts.length;
  const totalDailyCapacity = totalAccounts * 10;
  const usedToday = (quotaSettings.seriesUploadedToday || 0) + (quotaSettings.otherUploadedToday || 0);
  const remainingToday = Math.max(0, totalDailyCapacity - usedToday);
  const totalPct = totalDailyCapacity > 0 ? Math.round(usedToday / totalDailyCapacity * 100) : 0;
  const splitDesc = quotaSettings.maxSeriesPerDay > 0 ? `<b>${quotaSettings.maxSeriesPerDay} Series</b> \xB7 <b>${Math.max(0, 10 - quotaSettings.maxSeriesPerDay)} Pel\xEDculas/Otros</b>` : `<b>Sin restricci\xF3n (100% libre)</b>`;
  const poolLines = quotaSettings.poolAccounts.length > 0 ? quotaSettings.poolAccounts.map((acc, i) => {
    const roleTag = acc.canPublishDirectly === false ? " <i>(Acelerador S3 \xB7 Usuario com\xFAn)</i>" : acc.canPublishDirectly === true ? " <i>(Jefe de canal \xB7 Publicaci\xF3n directa)</i>" : "";
    return `<b>${i + 1}.</b> \u{1F464} <code>${escapeHtml(acc.displayName || acc.username)}</code> \xB7 <b>${acc.uploadedToday || 0}/10</b>${roleTag}`;
  }).join("\n") : `<i>Ninguna cuenta secundaria a\xF1adida (capacidad base: 10 videos/d\xEDa).</i>`;
  const text = (notice ? `${notice}

` : "") + `${hudHeader("CUOTA DIARIA Y POOL MULTI-CUENTA")}
` + hudBox([
    `\u{1F4C5} <b>Fecha (Cuba):</b> ${escapeHtml(quotaSettings.currentDateCuba)}`,
    `\u26A1 <b>Capacidad hoy:</b> <code>${hudSegmentedBar(totalPct, 10)}</code> (<b>${usedToday}/${totalDailyCapacity}</b> \xB7 ${remainingToday} libres)`,
    `\u{1F4FA} <b>Series:</b> ${quotaSettings.seriesUploadedToday || 0} \xB7 \u{1F3AC} <b>Pel\xEDculas/Otros:</b> ${quotaSettings.otherUploadedToday || 0}`,
    `\u2696\uFE0F <b>Divisi\xF3n:</b> ${splitDesc}`
  ]) + `
${hudSection("Pool de Aceleraci\xF3n S3 / Cuota")}
<i>Cada cuenta a\xF1adida suma +10 cupos diarios al canal <b>Multiverso Visual (#36319)</b> o pre-sube archivos pesados a S3.</i>

${hudSection(`Cuentas secundarias (${quotaSettings.poolAccounts.length})`)}
${poolLines}`;
  const curMax = quotaSettings.maxSeriesPerDay;
  const keyboard = [
    [
      {
        text: `${curMax === 5 ? "\u2705 " : ""}5 Series / 5 Pel\xEDculas`,
        callback_data: "quota_split:5"
      },
      {
        text: `${curMax === 7 ? "\u2705 " : ""}7 Series / 3 Pel\xEDculas`,
        callback_data: "quota_split:7"
      }
    ],
    [
      {
        text: `${curMax === 8 ? "\u2705 " : ""}8 Series / 2 Pel\xEDculas`,
        callback_data: "quota_split:8"
      },
      {
        text: `${curMax === 0 ? "\u2705 " : ""}10/10 Sin Reserva`,
        callback_data: "quota_split:0"
      }
    ],
    [
      {
        text: "\u2795 A\xF1adir Cuenta al Pool (+10/d\xEDa)",
        callback_data: "quota_add_account"
      }
    ]
  ];
  for (let i = 0; i < Math.min(4, quotaSettings.poolAccounts.length); i++) {
    const acc = quotaSettings.poolAccounts[i];
    keyboard.push([
      {
        text: `\u{1F5D1}\uFE0F Quitar Pool: ${acc.displayName || acc.username}`,
        callback_data: `quota_del_account:${i}`
      }
    ]);
  }
  if (uploadQueue.length > 0 && !isTransferJobRunningOrProcessing()) {
    keyboard.push([
      {
        text: `\u25B6\uFE0F Reanudar Cola (${uploadQueue.length} en espera)`,
        callback_data: "quota_resume_queue"
      }
    ]);
  }
  keyboard.push([
    { text: "\u{1F4CB} Cola (/cola)", callback_data: "queue_view" },
    { text: "\u{1F4CA} Videos (/stats)", callback_data: "dash_refresh:views:0" }
  ]);
  keyboard.push([{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    await sendTelegramStatusMessage(chatId, text, replyToMessageId, keyboard);
  }
}
function buildAdminUsersSummaryData() {
  ensureDailyQuotaReset();
  const sessionsMap = /* @__PURE__ */ new Map();
  for (const [cid, s] of userSessions.entries()) {
    sessionsMap.set(String(cid), {
      chatId: String(cid),
      username: s.username,
      userFullName: s.userFullName,
      channelId: s.channelId,
      channelName: s.channelName,
      availableChannelsCount: Array.isArray(s.availableChannels) ? s.availableChannels.length : 0,
      hasAuthToken: Boolean(s.authToken),
      hasPassword: Boolean(s.password),
      tokenExpiresAt: s.tokenExpiresAt,
      updatedAt: s.updatedAt
    });
  }
  const pinnedMap = /* @__PURE__ */ new Map();
  for (const [cid, p] of pinnedBatchSerieByChat.entries()) {
    pinnedMap.set(String(cid), {
      serieName: p.serieName,
      seasonNum: p.seasonNum
    });
  }
  const promoMap = /* @__PURE__ */ new Map();
  for (const [cid, pr] of userPromoChannels.entries()) {
    if (!pr.disabled && pr.targetChannelLabel) {
      promoMap.set(String(cid), {
        telegramChannelDisplay: pr.targetChannelLabel,
        pictaChannelUrl: pr.customPictaChannelUrl
      });
    }
  }
  if (!promoMap.has(MASTER_ADMIN_CHAT_ID)) {
    const masterPromo = resolveRequestsChannelForChat(
      MASTER_ADMIN_CHAT_ID,
      MASTER_ADMIN_CHAT_ID,
      userPromoChannels,
      MASTER_PRIVATE_REQUESTS_CHANNEL
    );
    if (masterPromo.configured) {
      promoMap.set(MASTER_ADMIN_CHAT_ID, {
        telegramChannelDisplay: masterPromo.targetChannelLabel,
        pictaChannelUrl: masterPromo.customPictaChannelUrl
      });
    }
  }
  const masterDailyCap = (1 + quotaSettings.poolAccounts.filter((a) => a.canPublishDirectly !== false).length) * 10;
  const masterSeriesToday = Number(quotaSettings.seriesUploadedToday || 0);
  const masterOtherToday = Number(quotaSettings.otherUploadedToday || 0);
  return computeEnrichedAdminUsersSummary({
    currentDateCuba: quotaSettings.currentDateCuba,
    masterAdminChatId: MASTER_ADMIN_CHAT_ID,
    masterAdminPictaUsername: pictaUser?.username || "Ghosthell",
    masterAdminChannelId: botConfig.pictaChannelId || "36319",
    masterAdminChannelName: "Multiverso Visual",
    masterAdminDailyCapacity: masterDailyCap,
    masterAdminSeriesToday: masterSeriesToday,
    masterAdminOtherToday: masterOtherToday,
    authorizedUsers: Array.from(authorizedUsers.values()),
    sessionsByChatId: sessionsMap,
    pinnedByChatId: pinnedMap,
    promoByChatId: promoMap,
    jobs: transferJobs,
    toCubaDateStr
  });
}
function formatCubaShortDateTime(iso) {
  if (!iso) return "Sin registros";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "Sin registros";
    return d.toLocaleString("es-CU", {
      timeZone: "America/Havana",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    });
  } catch {
    return iso.slice(0, 16);
  }
}
async function sendOrEditAdminUsersDashboardInTelegram(chatId, messageId, page = 0, replyToMessageId, notice) {
  if (!isMasterAdminChat(chatId)) {
    await sendTelegramStatusMessage(
      chatId,
      `\u26D4 <i>Solo el Administrador Principal (@ghosthell0210) puede consultar el panel de usuarios.</i>`,
      replyToMessageId
    );
    return;
  }
  const summary = buildAdminUsersSummaryData();
  const PAGE_SIZE = 5;
  const totalPages = Math.max(1, Math.ceil(summary.users.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(totalPages - 1, page));
  const pageUsers = summary.users.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const globalHeaderLines = [
    `\u{1F4C5} <b>Fecha (Cuba):</b> ${escapeHtml(summary.currentDateCuba)} \xB7 \u{1F465} <b>Usuarios:</b> ${summary.totalAuthorizedUsers} (\u{1F7E2} ${summary.linkedPictaUsers} vinculados \xB7 \u26AA ${summary.unlinkedPictaUsers} sin vincular)`,
    `\u26A1 <b>Subidos Hoy (Global):</b> <b>${summary.totalUploadedTodayAllUsers} video(s)</b> (\u{1F3AC} ${summary.totalMoviesTodayAllUsers} Pelis/Otros \xB7 \u{1F4FA} ${summary.totalSeriesTodayAllUsers} Series)${summary.totalBytesTodayAllUsers > 0 ? ` \xB7 <code>${formatBytes(summary.totalBytesTodayAllUsers)}</code>` : ""}`,
    `\u{1F4CA} <b>Hist\xF3rico Total:</b> <b>${summary.totalCompletedHistoricalAllUsers}</b> publicados \xB7 <code>${formatBytes(summary.totalBytesHistoricalAllUsers)}</code>${summary.totalActiveOrQueuedAllUsers > 0 ? ` \xB7 \u23F3 <b>${summary.totalActiveOrQueuedAllUsers} en cola/activos</b>` : ""}`
  ];
  const userBlocks = pageUsers.map((u, idx) => {
    const globalNum = safePage * PAGE_SIZE + idx + 1;
    const roleIcon = u.isMasterAdmin ? "\u{1F451}" : u.pictaLinked ? "\u{1F7E2}" : "\u26AA";
    const roleBadge = u.isMasterAdmin ? " <b>(Admin Principal)</b>" : "";
    const quotaStatusIcon = u.uploadedTodayCount >= u.dailyQuotaLimit ? "\u{1F534} L\xEDmite alcanzado" : u.uploadedTodayCount > 0 ? "\u26A1 Activo hoy" : "\u{1F7E2} Cupo intacto";
    const splitTodayStr = u.uploadedTodayCount > 0 ? ` \xB7 (\u{1F3AC} ${u.moviesUploadedTodayCount} \xB7 \u{1F4FA} ${u.seriesUploadedTodayCount})` : "";
    const queueLine = u.activeJobsCount > 0 || u.queuedJobsCount > 0 ? `
\u251C \u23F3 <b>Cola ahora:</b> ${u.activeJobsCount} subiendo \xB7 ${u.queuedJobsCount} en espera${u.activeJobTitle ? ` (<i>"${escapeHtml(u.activeJobTitle.slice(0, 26))}"</i>)` : ""}` : "";
    const pinnedLine = u.pinnedSerie ? `
\u251C \u{1F4CC} <b>Modo R\xE1faga:</b> ${escapeHtml(u.pinnedSerie.serieName)} (T${escapeHtml(u.pinnedSerie.seasonNum)})` : "";
    const promoLine = u.promoChannel?.telegramChannelDisplay ? `
\u251C \u{1F4E2} <b>Canal Pedidos:</b> ${escapeHtml(u.promoChannel.telegramChannelDisplay)}` : "";
    const lastUploadLine = u.lastUploadTitle ? `
\u2514 \u{1F552} <b>\xDAltimo:</b> <i>"${escapeHtml(u.lastUploadTitle.slice(0, 32))}"</i> (${escapeHtml(formatCubaShortDateTime(u.lastUploadAt))})` : `
\u2514 \u{1F552} <b>\xDAltimo:</b> <i>Sin subidas registradas en el bot</i>`;
    return `<b>${globalNum}. ${roleIcon} ${escapeHtml(u.displayName)}</b>${roleBadge}
\u251C \u{1F194} <code>${escapeHtml(u.chatId)}</code>${u.username ? ` \xB7 @${escapeHtml(u.username)}` : ""} \xB7 \u{1F4C5} Alta: ${new Date(u.authorizedAt).toLocaleDateString("es-CU")}
\u251C \u{1F4FA} <b>Picta:</b> ${escapeHtml(u.pictaChannelLabel)} \xB7 <code>${escapeHtml(u.pictaAccountLabel)}</code>
\u251C \u{1F510} <b>Sesi\xF3n:</b> ${u.sessionStatusLabel}
\u251C \u26A1 <b>Cuota Hoy:</b> <code>${hudSegmentedBar(u.quotaPercent, 10)}</code> <b>${u.uploadedTodayCount}/${u.dailyQuotaLimit}</b> (${u.remainingTodayCount} libres \xB7 ${quotaStatusIcon})${splitTodayStr}
\u251C \u{1F4CA} <b>Hist\xF3rico:</b> <b>${u.totalCompletedCount}</b> subidos (${formatBytes(u.totalBytesUploaded)})${u.totalFailedCount > 0 ? ` \xB7 \u274C ${u.totalFailedCount} fallidos` : ""}${u.avgSpeedMBps > 0 ? ` \xB7 \u{1F680} ${u.avgSpeedMBps} MB/s` : ""}${queueLine}${pinnedLine}${promoLine}${lastUploadLine}`;
  }).join("\n\n");
  const text = (notice ? `${notice}

` : "") + `${hudHeader(`PANEL DE USUARIOS Y CUOTAS (${summary.totalAuthorizedUsers})`)}
` + hudBox(globalHeaderLines) + `
${hudSection(`Actividad y Cupo Diario por Usuario (P\xE1g. ${safePage + 1}/${totalPages})`)}
${userBlocks}

\u{1F4A1} <i>Toca el nombre de cualquier usuario debajo para inspeccionar su historial de videos subidos hoy, velocidades y opciones de acceso, o usa <code>/autorizar &lt;ID o @user&gt;</code> y <code>/quitar &lt;ID o @user&gt;</code>.</i>`;
  const keyboard = [];
  for (let i = 0; i < pageUsers.length; i += 2) {
    const row = [];
    for (const u of pageUsers.slice(i, i + 2)) {
      const shortName = (u.username ? `@${u.username}` : u.displayName).slice(0, 14);
      row.push({
        text: `\u{1F50D} ${shortName} (${u.uploadedTodayCount}/${u.dailyQuotaLimit})`,
        callback_data: `admin_user_detail:${u.chatId}:${safePage}`
      });
    }
    keyboard.push(row);
  }
  if (totalPages > 1) {
    const navRow = [];
    if (safePage > 0) {
      navRow.push({
        text: "\u2B05\uFE0F Anterior",
        callback_data: `admin_users_list:${safePage - 1}`
      });
    }
    navRow.push({
      text: `\u{1F4C4} ${safePage + 1}/${totalPages}`,
      callback_data: `admin_users_list:${safePage}`
    });
    if (safePage < totalPages - 1) {
      navRow.push({
        text: "Siguiente \u27A1\uFE0F",
        callback_data: `admin_users_list:${safePage + 1}`
      });
    }
    keyboard.push(navRow);
  }
  keyboard.push([
    { text: "\u{1F504} Actualizar (/usuarios)", callback_data: `admin_users_list:${safePage}` },
    { text: "\u26A1 Pool y Cuota", callback_data: "quota_menu" }
  ]);
  keyboard.push([{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    await sendTelegramStatusMessage(chatId, text, replyToMessageId, keyboard);
  }
}
async function sendOrEditAdminUserDetailInTelegram(chatId, messageId, targetUserChatId, returnPage = 0, notice) {
  if (!isMasterAdminChat(chatId)) return;
  const summary = buildAdminUsersSummaryData();
  const u = summary.users.find((item) => String(item.chatId) === String(targetUserChatId));
  if (!u) {
    await sendOrEditAdminUsersDashboardInTelegram(
      chatId,
      messageId,
      returnPage,
      void 0,
      `\u26A0\uFE0F <b>El usuario <code>${escapeHtml(targetUserChatId)}</code> ya no se encuentra en la lista.</b>`
    );
    return;
  }
  const stageLabel = (st) => {
    if (st === "completed") return "\u2705 Publicado";
    if (st === "failed") return "\u274C Fallido";
    if (st === "cancelled") return "\u{1F6D1} Cancelado";
    if (st === "queued") return "\u23F3 En cola";
    return "\u{1F680} Subiendo";
  };
  const recentJobsBlock = u.recentJobs.length > 0 ? u.recentJobs.map((j, idx) => {
    const dayTag = j.isToday ? "\u{1F7E2} <b>HOY</b>" : escapeHtml(formatCubaShortDateTime(j.updatedAt));
    const pubTag = j.pictaPublicationId ? ` \xB7 <code>#${j.pictaPublicationId}</code>` : "";
    const speedTag = j.speedMBps > 0 ? ` \xB7 ${j.speedMBps} MB/s` : "";
    return `<b>${idx + 1}.</b> ${stageLabel(j.stage)} \xB7 <b>${escapeHtml(j.title.slice(0, 34))}</b>
   \u2514 ${dayTag} \xB7 ${escapeHtml(j.category)} \xB7 <code>${formatBytes(j.bytes)}</code>${speedTag}${pubTag}`;
  }).join("\n") : `<i>Este usuario a\xFAn no registra transferencias en el historial del bot.</i>`;
  const text = (notice ? `${notice}

` : "") + `${hudHeader(`FICHA DE USUARIO \xB7 ${u.displayName}`)}
` + hudBox([
    `\u{1F464} <b>Usuario:</b> ${escapeHtml(u.displayName)}${u.username ? ` (@${escapeHtml(u.username)})` : ""} \xB7 <code>${escapeHtml(u.chatId)}</code>`,
    `\u{1F4C5} <b>Autorizado:</b> ${new Date(u.authorizedAt).toLocaleString("es-CU")}`,
    `\u{1F4FA} <b>Canal Picta:</b> ${escapeHtml(u.pictaChannelLabel)}${u.availableChannelsCount > 1 ? ` (+${u.availableChannelsCount - 1} canales m\xE1s)` : ""}`,
    `\u{1F511} <b>Cuenta Picta:</b> <code>${escapeHtml(u.pictaAccountLabel)}</code> \xB7 ${u.sessionStatusLabel}`,
    u.promoChannel?.telegramChannelDisplay ? `\u{1F4E2} <b>Canal de Pedidos:</b> ${escapeHtml(u.promoChannel.telegramChannelDisplay)}` : null,
    u.pinnedSerie ? `\u{1F4CC} <b>Modo R\xE1faga Activo:</b> ${escapeHtml(u.pinnedSerie.serieName)} (Temporada ${escapeHtml(u.pinnedSerie.seasonNum)})` : null
  ]) + `
${hudSection(`Uso de Cuota Diaria (${summary.currentDateCuba})`)}
` + hudBox([
    `\u26A1 <b>Subidos Hoy:</b> <code>${hudSegmentedBar(u.quotaPercent, 10)}</code> <b>${u.uploadedTodayCount}/${u.dailyQuotaLimit}</b> (${u.remainingTodayCount} cupos libres)`,
    `\u{1F3AC} <b>Pel\xEDculas / Otros Hoy:</b> <b>${u.moviesUploadedTodayCount}</b> \xB7 \u{1F4FA} <b>Cap\xEDtulos de Serie Hoy:</b> <b>${u.seriesUploadedTodayCount}</b>`,
    `\u{1F4E6} <b>Tr\xE1fico Hoy:</b> <code>${formatBytes(u.bytesUploadedToday)}</code>${u.failedTodayCount > 0 ? ` \xB7 \u26A0\uFE0F ${u.failedTodayCount} intento(s) fallido(s) hoy` : ""}`,
    `\u{1F4CA} <b>Acumulado Hist\xF3rico:</b> <b>${u.totalCompletedCount}</b> publicados (<code>${formatBytes(u.totalBytesUploaded)}</code>)${u.avgSpeedMBps > 0 ? ` \xB7 Velocidad media: <b>${u.avgSpeedMBps} MB/s</b>` : ""}`
  ]) + `
${hudSection(`\xDAltimos Videos del Usuario (${u.recentJobs.length})`)}
${recentJobsBlock}`;
  const keyboard = [
    [
      {
        text: "\u{1F504} Actualizar Ficha",
        callback_data: `admin_user_detail:${u.chatId}:${returnPage}`
      }
    ]
  ];
  if (!u.isMasterAdmin) {
    keyboard.push([
      {
        text: `\u{1F6AB} Revocar Acceso a ${u.displayName.slice(0, 18)}`,
        callback_data: `admin_user_revoke_prompt:${u.chatId}:${returnPage}`
      }
    ]);
  }
  keyboard.push([
    {
      text: "\u2B05\uFE0F Volver a Lista de Usuarios (/usuarios)",
      callback_data: `admin_users_list:${returnPage}`
    }
  ]);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    await sendTelegramStatusMessage(chatId, text, void 0, keyboard);
  }
}
var pendingMultiPartByChat = /* @__PURE__ */ new Map();
async function sendOrEditMultiPartMenuInTelegram(chatId, messageId, replyToMessageId, notice) {
  let session = pendingMultiPartByChat.get(chatId);
  if (!session) {
    session = {
      chatId,
      statusMessageId: messageId,
      parts: []
    };
    pendingMultiPartByChat.set(chatId, session);
  } else if (messageId) {
    session.statusMessageId = messageId;
  }
  const totalBytes = session.parts.reduce((acc, p) => acc + Math.max(0, p.sizeBytes), 0);
  const partsListHtml = session.parts.length > 0 ? session.parts.map(
    (p, idx) => `<b>Parte ${idx + 1}:</b> <code>${escapeHtml(p.fileName)}</code> \xB7 <b>${formatBytes(p.sizeBytes)}</b>`
  ).join("\n") : `<i>A\xFAn no has enviado partes. Reenv\xEDa o sube ahora la Parte 1, Parte 2, etc.</i>`;
  const text = (notice ? `${notice}

` : "") + `${hudHeader("UNI\xD3N Y DESCOMPRESI\xD3N EN DISCO EF\xCDMERO (/unir)")}
` + hudBox([
    `\u{1F4BF} <b>Almacenamiento:</b> Disco Ef\xEDmero (<code>${escapeHtml(TMP_UPLOAD_DIR)}</code>)`,
    `\u{1F9E0} <b>Perfil de RAM:</b> Ultra-Bajo (<code>256 KB</code> buffer \xB7 0 sobrecarga)`,
    `\u{1F4E6} <b>Partes en lista:</b> <b>${session.parts.length}</b> \xB7 <b>Total:</b> <code>${formatBytes(totalBytes)}</code> (M\xE1x. 5.00 GB S3)`
  ]) + `
${hudSection("Partes Recibidas en Orden")}
${partsListHtml}

\u{1F4A1} <i>Soporta partes cortadas (<code>.001/.002</code>, <code>.part1</code>), archivos comprimidos (<code>.zip</code>, <code>.tar</code>) o partes de video (<code>Parte1.mp4 + Parte2.mp4</code>). Cuando hayas enviado todas las partes, pulsa <b>Unir / Descomprimir en Disco y Subir</b>.</i>`;
  const keyboard = [];
  if (session.parts.length >= 1 && !session.assembling) {
    keyboard.push([
      {
        text: `\u{1F680} Unir / Descomprimir en Disco y Subir (${session.parts.length} parte${session.parts.length === 1 ? "" : "s"})`,
        callback_data: "multipart_join:confirm"
      }
    ]);
    keyboard.push([
      {
        text: "\u{1F9F9} Vaciar Lista de Partes",
        callback_data: "multipart_join:clear"
      }
    ]);
  }
  keyboard.push([
    {
      text: "\u274C Salir del Modo /unir",
      callback_data: "multipart_join:cancel"
    },
    {
      text: "\u25C8 Men\xFA Principal",
      callback_data: "cmd_start"
    }
  ]);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    const sentId = await sendTelegramStatusMessage(chatId, text, replyToMessageId, keyboard);
    if (sentId) {
      session.statusMessageId = sentId;
    }
  }
}
async function executeMultiPartJoinAndCreateJobInTelegram(chatId, messageId) {
  const session = pendingMultiPartByChat.get(chatId);
  if (!session || session.parts.length === 0) {
    await sendOrEditMultiPartMenuInTelegram(
      chatId,
      messageId,
      void 0,
      `\u26A0\uFE0F <b>Primero env\xEDa al menos una parte o archivo comprimido al chat.</b>`
    );
    return;
  }
  if (session.assembling) return;
  const totalExpected = session.parts.reduce((acc, p) => acc + Math.max(0, p.sizeBytes), 0);
  if (totalExpected > PICTA_S3_MAX_OBJECT_BYTES) {
    await sendOrEditMultiPartMenuInTelegram(
      chatId,
      messageId,
      void 0,
      `\u26D4 <b>El peso combinado (${formatBytes(totalExpected)}) supera el tope de 5.00 GB de MinIO S3 en Picta.</b>`
    );
    return;
  }
  session.assembling = true;
  const userChannelCtx = getEffectivePictaContext(chatId);
  const masterJobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const downloadedDescriptors = [];
  try {
    for (let i = 0; i < session.parts.length; i++) {
      const p = session.parts[i];
      await editTelegramStatusMessage(
        chatId,
        messageId || session.statusMessageId,
        `${hudHeader(`DESCARGANDO PARTE ${i + 1}/${session.parts.length} AL DISCO EF\xCDMERO`)}
` + hudBox([
          `\u{1F4C4} <b>Archivo:</b> <code>${escapeHtml(p.fileName)}</code>`,
          `\u{1F4E6} <b>Tama\xF1o:</b> ${formatBytes(p.sizeBytes)}`,
          `\u{1F4BF} <b>Destino:</b> <code>${escapeHtml(TMP_UPLOAD_DIR)}</code>`
        ]) + `
\u23F3 <i>Descargando v\xEDa Pool MTProto 4 GB...</i>`,
        void 0,
        true
      );
      const partTempJob = {
        id: `${masterJobId}_part${i + 1}`,
        telegramMessageId: p.telegramMessageId,
        statusMessageId: messageId || session.statusMessageId,
        telegramChatId: chatId,
        senderName: "MultiPart",
        fileId: p.fileId,
        fileUniqueId: p.fileUniqueId,
        fileName: p.fileName,
        mimeType: p.mimeType || "application/octet-stream",
        caption: p.caption || "",
        expectedBytes: p.sizeBytes,
        downloadedBytes: 0,
        integrityVerified: false,
        diskVerifiedBytes: 0,
        uploadedBytes: 0,
        stage: "downloading_mtproto",
        title: `Parte ${i + 1}/${session.parts.length} \xB7 ${p.fileName}`,
        titleMode: "manual",
        synopsis: "",
        category: "Pel\xEDcula",
        tipologiaId: 1,
        tags: [],
        speedMBps: 0,
        targetChannelId: userChannelCtx.channelId,
        targetChannelName: userChannelCtx.channelName,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      const partFilePath = await downloadFullVideoFromTelegram(
        partTempJob,
        messageId || session.statusMessageId
      );
      const actualSize = fs3.existsSync(partFilePath) ? fs3.statSync(partFilePath).size : p.sizeBytes;
      downloadedDescriptors.push({
        fileName: p.fileName,
        filePath: partFilePath,
        sizeBytes: actualSize
      });
    }
    await editTelegramStatusMessage(
      chatId,
      messageId || session.statusMessageId,
      `${hudHeader("UNIENDO / DESCOMPRIMIENDO EN DISCO EF\xCDMERO")}
` + hudBox([
        `\u{1F9E9} <b>Partes descargadas:</b> ${downloadedDescriptors.length}`,
        `\u{1F9E0} <b>Buffer RAM:</b> <code>256 KB</code> (sin sobrecarga de memoria)`,
        `\u{1F4BF} <b>Disco Ef\xEDmero:</b> <code>${escapeHtml(TMP_UPLOAD_DIR)}</code>`
      ]) + `
\u23F3 <i>Ensamblando archivo \xFAnico y limpiando fragmentos temporales...</i>`,
      void 0,
      true
    );
    const assembled = await assembleMultiPartFilesOnDisk(
      downloadedDescriptors,
      TMP_UPLOAD_DIR,
      masterJobId
    );
    const firstPart = session.parts[0];
    pendingMultiPartByChat.delete(chatId);
    const safeExt = path3.extname(assembled.finalFileName) || ".mp4";
    const canonicalJobPath = path3.join(TMP_UPLOAD_DIR, `${masterJobId}${safeExt}`);
    if (assembled.finalFilePath !== canonicalJobPath) {
      fs3.renameSync(assembled.finalFilePath, canonicalJobPath);
    }
    const combinedCaption = session.parts.map((pt) => pt.caption).filter(Boolean).join("\n").trim();
    const analyzedIntake = analyzeVideoTitleAndSynopsis(assembled.finalFileName, combinedCaption);
    const unifiedJob = {
      id: masterJobId,
      telegramMessageId: firstPart.telegramMessageId,
      statusMessageId: messageId || session.statusMessageId,
      telegramChatId: chatId,
      senderName: "MultiPart",
      fileId: firstPart.fileId,
      fileUniqueId: firstPart.fileUniqueId,
      thumbnailFileId: firstPart.thumbnailFileId,
      fileName: assembled.finalFileName,
      mimeType: "video/mp4",
      caption: combinedCaption,
      expectedBytes: assembled.finalSizeBytes,
      downloadedBytes: assembled.finalSizeBytes,
      integrityVerified: true,
      diskVerifiedBytes: assembled.finalSizeBytes,
      uploadedBytes: 0,
      tempFilePath: canonicalJobPath,
      stage: "awaiting_category",
      title: analyzedIntake.initialTitle,
      titleMode: "pending",
      synopsis: analyzedIntake.initialSynopsis,
      category: "Audiovisual",
      tipologiaId: 8,
      tags: [],
      speedMBps: 0,
      targetChannelId: userChannelCtx.channelId,
      targetChannelName: userChannelCtx.channelName,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    transferJobs.unshift(unifiedJob);
    saveJobsToDisk();
    await editTelegramStatusMessage(
      chatId,
      messageId || session.statusMessageId,
      `${hudHeader("ARCHIVO UNIDO AL 100% EN DISCO EF\xCDMERO")}
` + hudBox([
        `\u{1F4C4} <b>Archivo resultante:</b> <code>${escapeHtml(assembled.finalFileName)}</code>`,
        `\u{1F4E6} <b>Tama\xF1o \xEDntegro:</b> <b>${formatBytes(assembled.finalSizeBytes)}</b>`,
        `\u2699\uFE0F <b>Modo aplicado:</b> <code>${escapeHtml(assembled.modeUsed)}</code>`,
        `\u{1F4FA} <b>Canal destino:</b> ${escapeHtml(userChannelCtx.channelName)} (#${escapeHtml(userChannelCtx.channelId)})`
      ]) + `
\u{1F4C2} <b>Selecciona ahora la categor\xEDa de Picta para subirlo de inmediato:</b>`,
      buildCategorySelectionKeyboard(unifiedJob.id),
      true
    );
  } catch (err) {
    session.assembling = false;
    for (const d of downloadedDescriptors) {
      if (fs3.existsSync(d.filePath)) {
        try {
          fs3.unlinkSync(d.filePath);
        } catch {
        }
      }
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    await sendOrEditMultiPartMenuInTelegram(
      chatId,
      messageId || session.statusMessageId,
      void 0,
      `\u274C <b>Error al unir/descomprimir en el disco ef\xEDmero:</b> <code>${escapeHtml(errMsg.slice(0, 180))}</code>`
    );
  }
}
function isTransferJobRunningOrProcessing(excludeJobId) {
  if (activeDownloadJobId && activeDownloadJobId !== excludeJobId) return true;
  if (activeUploadJobId && activeUploadJobId !== excludeJobId) return true;
  if (activeJobId && activeJobId !== excludeJobId) return true;
  for (const id of runningJobIds) {
    if (id !== excludeJobId) return true;
  }
  return false;
}
async function triggerCloudRunKeepAliveTransfer(jobId, customTitle, callbackMessageId) {
  const job = transferJobs.find((j) => j.id === jobId);
  if (!job) return;
  cancelledJobIds.delete(job.id);
  if (callbackMessageId) {
    job.statusMessageId = Number(callbackMessageId);
  }
  if (customTitle && customTitle.trim()) {
    job.title = customTitle.trim();
    job.titleMode = "manual";
  }
  resolveJobTargetChannelInfo(job);
  if (runningJobIds.has(job.id)) {
    return;
  }
  job.stage = "queued";
  job.errorDetails = void 0;
  job.encoderRetryNextAt = void 0;
  if (!uploadQueue.includes(job.id)) {
    uploadQueue.push(job.id);
  }
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  saveJobsToDisk();
  const userQueued = uploadQueue.filter((id) => {
    const qj = transferJobs.find((j) => j.id === id);
    return qj && (isMasterAdminChat(job.telegramChatId) || qj.telegramChatId === job.telegramChatId);
  });
  const qPos = Math.max(1, userQueued.indexOf(job.id) + 1);
  if (isTransferJobRunningOrProcessing(job.id)) {
    addLiveLog(
      "system",
      "info",
      `Video "${job.title}" puesto en cola (posici\xF3n #${qPos}). El pipeline dual descargar\xE1/subir\xE1 autom\xE1ticamente.`
    );
    const queueCard = `\u23F3 <b>EN COLA DE SUBIDA \xB7 POSICI\xD3N #${qPos}</b>
<blockquote>\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}
\u{1F4C2} <b>Categor\xEDa:</b> ${escapeHtml(job.category)}
\u{1F4E6} <b>Tama\xF1o:</b> ${formatBytes(job.expectedBytes)}</blockquote>
<i>Se pre-descargar\xE1 y publicar\xE1 autom\xE1ticamente sin esperas innecesarias.</i>`;
    const qKb = [
      [{ text: "\u{1F6D1} Cancelar esta subida", callback_data: `cancel_job:${job.id}` }],
      [{ text: "\u{1F4CB} Ver Cola de Espera", callback_data: "queue_view" }]
    ];
    if (job.statusMessageId) {
      await editTelegramStatusMessage(job.telegramChatId, job.statusMessageId, queueCard, qKb, true);
    } else {
      const sentId = await sendTelegramStatusMessage(
        job.telegramChatId,
        queueCard,
        job.telegramMessageId,
        qKb
      );
      if (sentId) {
        job.statusMessageId = sentId;
        saveJobsToDisk();
      }
    }
  }
  void scheduleTransferPipeline();
  const deadline = Date.now() + 45e3;
  while (Date.now() < deadline && (activeDownloadJobId === job.id || activeUploadJobId === job.id || runningJobIds.has(job.id))) {
    await new Promise((r) => setTimeout(r, 800));
  }
}
function escapeHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderVisualBar(pct, size = 10) {
  return hudSegmentedBar(pct, size);
}
function renderWizardStepBar(step) {
  return hudWizardStep(step);
}
var pendingPubEditByChat = /* @__PURE__ */ new Map();
var pendingStandaloneSerieByChat = /* @__PURE__ */ new Map();
var pendingChannelEditByChat = /* @__PURE__ */ new Map();
var pendingToolkitInputByChat = /* @__PURE__ */ new Map();
var localChannelPlaylistsCache = /* @__PURE__ */ new Map();
async function downloadTelegramThumbnailBuffer(fileId) {
  if (!fileId || !fileId.trim()) return null;
  try {
    const fileInfo = await callTelegramBotApi("getFile", { file_id: fileId.trim() });
    if (fileInfo?.file_path) {
      const fileUrl = `https://api.telegram.org/file/bot${botConfig.telegramBotToken.trim()}/${fileInfo.file_path}`;
      const res = await fetch(fileUrl);
      if (res.ok) {
        const arrBuf = await res.arrayBuffer();
        if (arrBuf.byteLength > 0) {
          return Buffer.from(arrBuf);
        }
      }
    }
  } catch {
  }
  return null;
}
async function fetchPictaChannelDetails(chatId) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const context = getEffectivePictaContext(effectiveChatId);
  if (!context.isLinked || !context.channelId) {
    throw new Error("No has vinculado tu cuenta de Picta. Usa /login primero.");
  }
  const token = await context.accessTokenPromise;
  const channelId = context.channelId;
  let res = await fetchPictaWithRetry(
    `https://api.picta.cu/v1/canal/${encodeURIComponent(channelId)}/`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      }
    }
  );
  if (!res.ok) {
    res = await fetchPictaWithRetry(
      `https://api.picta.cu/v2/canal/${encodeURIComponent(channelId)}/`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://admin.picta.cu",
          Referer: "https://admin.picta.cu/"
        }
      }
    );
  }
  if (!res.ok) {
    res = await fetchPictaWithRetry(
      `https://api.picta.cu/v2/canal/?id=${encodeURIComponent(channelId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://admin.picta.cu",
          Referer: "https://admin.picta.cu/"
        }
      }
    );
  }
  if (!res.ok) {
    throw new Error(`Error HTTP ${res.status} al obtener detalles del canal #${channelId}`);
  }
  const rawText = (await res.text()).trim();
  let parsed = {};
  try {
    parsed = JSON.parse(rawText);
  } catch {
    try {
      const cleanEncrypted = rawText.replace(/^"|"$/g, "");
      const decipher = crypto.createDecipheriv(
        "aes-128-ecb",
        Buffer.from(PICTA_AES_KEY, "utf8"),
        null
      );
      let decrypted = decipher.update(cleanEncrypted, "base64", "utf8");
      decrypted += decipher.final("utf8");
      parsed = JSON.parse(decrypted);
    } catch {
      parsed = {};
    }
  }
  const details = normalizePictaChannelDetails(
    parsed,
    channelId,
    context.channelName,
    botConfig.pictaClasificacion || "18+"
  );
  const session = userSessions.get(effectiveChatId);
  if (session && details.nombre) {
    session.channelName = details.nombre;
    const foundChan = (session.availableChannels || []).find(
      (c) => String(c.id) === String(details.id)
    );
    if (foundChan) {
      foundChan.nombre = details.nombre;
      if (details.alias) foundChan.alias = details.alias;
    }
    saveUserSessionsToDisk();
  } else if (effectiveChatId === MASTER_ADMIN_CHAT_ID && pictaChannels[0]) {
    if (details.nombre) pictaChannels[0].nombre = details.nombre;
    if (details.alias) pictaChannels[0].alias = details.alias;
  }
  return details;
}
async function patchPictaChannelDetails(chatId, fields, files) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const context = getEffectivePictaContext(effectiveChatId);
  if (!context.isLinked || !context.channelId) {
    throw new Error("No has vinculado tu cuenta de Picta. Usa /login primero.");
  }
  const token = await context.accessTokenPromise;
  const channelId = context.channelId;
  const buildForm = () => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      form.append(k, v);
    }
    if (files?.avatarBuffer) {
      form.append(
        "url_avatar",
        new Blob([new Uint8Array(files.avatarBuffer)], { type: "image/jpeg" }),
        `avatar_${channelId}_${Date.now()}.jpg`
      );
    }
    if (files?.coverBuffer) {
      form.append(
        "url_imagen",
        new Blob([new Uint8Array(files.coverBuffer)], { type: "image/jpeg" }),
        `portada_${channelId}_${Date.now()}.jpg`
      );
    }
    return form;
  };
  let res = await fetchPictaWithRetry(
    `https://api.picta.cu/v1/canal/${encodeURIComponent(channelId)}/`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      },
      body: buildForm()
    }
  );
  if (res.status === 404 || res.status === 405) {
    res = await fetchPictaWithRetry(
      `https://api.picta.cu/v2/canal/${encodeURIComponent(channelId)}/`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://admin.picta.cu",
          Referer: "https://admin.picta.cu/"
        },
        body: buildForm()
      }
    );
  }
  if (res.status === 401 || res.status === 403) {
    const freshToken = effectiveChatId === MASTER_ADMIN_CHAT_ID && !userSessions.has(effectiveChatId) ? await authenticateWithPicta(true) : await refreshUserPictaSession(effectiveChatId);
    res = await fetchPictaWithRetry(
      `https://api.picta.cu/v1/canal/${encodeURIComponent(channelId)}/`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${freshToken}`,
          Origin: "https://admin.picta.cu",
          Referer: "https://admin.picta.cu/"
        },
        body: buildForm()
      }
    );
  }
  if (!res.ok) {
    const errTxt = await res.text();
    throw new Error(formatPictaError(res.status, errTxt));
  }
  if (fields.nombre) {
    const session = userSessions.get(effectiveChatId);
    if (session) {
      session.channelName = fields.nombre.trim();
      const foundChan = (session.availableChannels || []).find(
        (c) => String(c.id) === String(channelId)
      );
      if (foundChan) foundChan.nombre = fields.nombre.trim();
      saveUserSessionsToDisk();
    } else if (effectiveChatId === MASTER_ADMIN_CHAT_ID && pictaChannels[0]) {
      pictaChannels[0].nombre = fields.nombre.trim();
    }
  }
  if (fields.alias && effectiveChatId === MASTER_ADMIN_CHAT_ID && pictaChannels[0]) {
    pictaChannels[0].alias = fields.alias.trim();
  }
  if (fields.clasificacion && effectiveChatId === MASTER_ADMIN_CHAT_ID) {
    botConfig.pictaClasificacion = fields.clasificacion.trim();
  }
  try {
    return await fetchPictaChannelDetails(effectiveChatId);
  } catch {
    const rawText = await res.text().catch(() => "{}");
    let parsed = {};
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = {};
    }
    return normalizePictaChannelDetails(
      { ...parsed, ...fields },
      channelId,
      fields.nombre || context.channelName,
      fields.clasificacion || botConfig.pictaClasificacion || "18+"
    );
  }
}
async function sendOrEditChannelEditorMenu(chatId, messageId, replyToMessageId, bannerNotice) {
  pendingChannelEditByChat.delete(chatId);
  const ctx = getEffectivePictaContext(chatId);
  if (!ctx.isLinked || !ctx.channelId) {
    const session = userSessions.get(chatId);
    if (session && session.authToken) {
      const needChanText = `${hudHeader(`ESTUDIO DE CANAL \xB7 ${session.userFullName || session.username}`)}
` + hudBox([
        `\u{1F511} <b>Sesi\xF3n:</b> \u{1F7E2} Activa`,
        `\u{1F4FA} <b>Canal:</b> \u26AA Pendiente de vincular`
      ]) + `
Escribe el <b>enlace</b>, <b>slug</b> o <b>ID num\xE9rico</b> de tu canal:
<code>/canal https://www.picta.cu/canal/mi-canal</code>`;
      const needChanKb = [
        [{ text: "\u{1F50D} Escribir Enlace o ID", callback_data: "chan_switch:prompt" }],
        [{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]
      ];
      if (messageId) {
        await editTelegramStatusMessage(chatId, messageId, needChanText, needChanKb, true);
      } else {
        await sendTelegramStatusMessage(chatId, needChanText, replyToMessageId, needChanKb);
      }
      return;
    }
    const unlinkedText = `${hudHeader("ESTUDIO DE CANAL \xB7 SIN VINCULAR")}
` + hudBox([`\u26AA Vincula tu cuenta de Picta con /login para administrar tu canal.`]);
    const unlinkedKb = [
      [{ text: "\u{1F511} Vincular Cuenta (/login)", callback_data: "user_picta_login_start" }],
      [{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]
    ];
    if (messageId) {
      await editTelegramStatusMessage(chatId, messageId, unlinkedText, unlinkedKb, true);
    } else {
      await sendTelegramStatusMessage(chatId, unlinkedText, replyToMessageId, unlinkedKb);
    }
    return;
  }
  let details;
  let fetchWarning = "";
  try {
    details = await fetchPictaChannelDetails(chatId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fetchWarning = `\u26A0\uFE0F <i>Aviso al sincronizar: ${escapeHtml(msg.slice(0, 100))}</i>

`;
    const isMaster = chatId === MASTER_ADMIN_CHAT_ID;
    details = normalizePictaChannelDetails(
      {
        id: Number(ctx.channelId),
        nombre: ctx.channelName,
        alias: isMaster ? pictaChannels[0]?.alias || "" : "",
        descripcion: isMaster ? botConfig.channelThemeDescription || "" : "",
        clasificacion: botConfig.pictaClasificacion || "18+",
        publicado: true,
        donacion: false
      },
      ctx.channelId,
      ctx.channelName,
      botConfig.pictaClasificacion || "18+"
    );
  }
  const editorText = (bannerNotice ? `${bannerNotice}

` : "") + fetchWarning + `${hudHeader(`ESTUDIO DE CANAL \xB7 ${details.nombre}`)}
` + hudBox([
    `\u{1F4FA} <b>Canal:</b> ${escapeHtml(details.nombre)} \xB7 <code>#${details.id}</code>`,
    `\u{1F3F7}\uFE0F <b>Alias:</b> ${escapeHtml(details.alias || "Sin lema definido")}`,
    `\u{1F51E} <b>Edad:</b> <b>${escapeHtml(details.clasificacion || "18+")}</b> \xB7 ${details.publicado ? "\u{1F7E2} P\xFAblico" : "\u{1F648} Oculto"}`,
    `\u{1F4B3} <b>Donaciones:</b> ${details.donacion ? "\u{1F7E2} Activas" : "\u26AA Pausadas"} \xB7 \u{1F465} <b>${Number(details.cantidad_suscriptores || 0).toLocaleString()}</b> suscrip.`,
    `\u{1F5BC}\uFE0F <b>Avatar:</b> ${details.url_avatar ? "\u2705" : "\u26AA"} \xB7 <b>Portada:</b> ${details.url_imagen ? "\u2705" : "\u26AA"}`
  ]) + `
${hudSection("Biograf\xEDa")}
` + hudBox([`<i>${escapeHtml((details.descripcion || "Sin descripci\xF3n configurada.").slice(0, 340))}</i>`]) + `
<i>Selecciona un par\xE1metro para actualizarlo en tiempo real:</i>`;
  const keyboard = [
    [
      { text: "\u270F\uFE0F Nombre", callback_data: "chan_edit:nombre" },
      { text: "\u{1F3F7}\uFE0F Lema / Alias", callback_data: "chan_edit:alias" }
    ],
    [
      { text: "\u{1F4DD} Biograf\xEDa", callback_data: "chan_edit:descripcion" },
      {
        text: `\u{1F51E} Edad (${details.clasificacion || "18+"})`,
        callback_data: "chan_edit:clasificacion"
      }
    ],
    [
      { text: "\u{1F464} Avatar", callback_data: "chan_edit:avatar" },
      { text: "\u{1F5BC}\uFE0F Portada", callback_data: "chan_edit:portada" }
    ],
    [
      {
        text: details.publicado ? "\u{1F648} Ocultar Canal" : "\u{1F7E2} Hacer P\xFAblico",
        callback_data: "chan_toggle:publicado"
      },
      {
        text: details.donacion ? "\u{1F4B3} Pausar Donaciones" : "\u{1F4B3} Activar Donaciones",
        callback_data: "chan_toggle:donacion"
      }
    ],
    [
      { text: "\u{1F4AC} Comentarios", callback_data: "comments_menu:0" },
      { text: "\u{1F4C2} Listas (/listas)", callback_data: "playlists_menu:0" }
    ],
    [
      { text: "\u{1F465} Colaboradores", callback_data: "chan_collabs:open" },
      { text: "\u{1F3AD} Actores y Tags", callback_data: "personas_menu" }
    ],
    [
      { text: "\u{1F504} Cambiar Canal", callback_data: "chan_switch:prompt" },
      { text: "\u{1FA7A} Auditor\xEDa (/auditoria)", callback_data: "audit:dups:0" }
    ],
    [
      { text: "\u{1F4CA} Videos (/stats)", callback_data: "dash_refresh:views:0" },
      { text: "\u{1F504} Sincronizar", callback_data: "chan_editor:refresh" }
    ],
    [{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]
  ];
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, editorText, keyboard, true);
  } else {
    await sendTelegramStatusMessage(chatId, editorText, replyToMessageId, keyboard);
  }
}
async function sendOrEditMainMenuInTelegram(chatId, messageId, replyToMessageId) {
  const isMaster = chatId === MASTER_ADMIN_CHAT_ID;
  let session = userSessions.get(chatId);
  if (!isMaster && session && !session.channelId) {
    await ensureGuestSessionChannelDiscovered(chatId).catch(() => null);
    session = userSessions.get(chatId);
  }
  const pinned = pinnedBatchSerieByChat.get(chatId);
  const ctx = getEffectivePictaContext(chatId);
  ensureDailyQuotaReset();
  const publishablePoolCount = getPoolAccountsForChat(chatId).filter(
    (acc) => acc.canPublishDirectly !== false
  ).length;
  const totalDailyCap = (1 + publishablePoolCount) * 10;
  const usedToday = isMaster ? (quotaSettings.seriesUploadedToday || 0) + (quotaSettings.otherUploadedToday || 0) : transferJobs.filter(
    (j) => j.telegramChatId === chatId && j.stage === "completed" && toCubaDateStr(j.updatedAt || j.createdAt) === quotaSettings.currentDateCuba
  ).length;
  const userQueueCount = filterJobsForUser(
    uploadQueue.map((id) => transferJobs.find((j) => j.id === id)).filter((j) => Boolean(j)),
    chatId,
    MASTER_ADMIN_CHAT_ID
  ).length;
  const startKeyboard = [
    [
      {
        text: "\u{1F3DB}\uFE0F Estudio de Canal (/canal)",
        callback_data: "chan_editor:open"
      },
      {
        text: "\u{1F4CA} Videos y Stats (/stats)",
        callback_data: "dash_refresh:views:0"
      }
    ],
    [
      {
        text: "\u{1F4FA} Mis Series y R\xE1faga (/series)",
        callback_data: "my_series:0"
      },
      {
        text: "\u{1F50E} Buscar en Picta (/buscar)",
        callback_data: "picta_search:prompt"
      }
    ],
    [
      {
        text: "\u{1F4AC} Comentarios (/comentarios)",
        callback_data: "comments_menu:0"
      },
      {
        text: "\u{1F3C6} Logros y Alertas (/logros)",
        callback_data: "alerts_menu"
      }
    ],
    [
      {
        text: "\u{1F4C2} Listas (/listas)",
        callback_data: "playlists_menu:0"
      },
      {
        text: "\u{1F6E1}\uFE0F Cuenta Picta (/cuenta)",
        callback_data: "cmd_cuenta"
      }
    ],
    [
      {
        text: "\u{1F465} Colaboradores (/colaboradores)",
        callback_data: "chan_collabs:open"
      },
      {
        text: "\u{1F3AD} Actores y Tags (/personas)",
        callback_data: "personas_menu"
      }
    ],
    [
      {
        text: "\u{1F4E2} Canal de Pedidos (/canalpedidos)",
        callback_data: "promo_cfg:open"
      },
      {
        text: `\u{1F4E5} Pedidos (${channelMediaRequests.filter((r) => r.ownerChatId === chatId && r.status === "pending").length})`,
        callback_data: "req:list:pending:0"
      }
    ],
    [
      {
        text: "\u{1FA7A} Auditor\xEDa Canal (/auditoria)",
        callback_data: "audit:dups:0"
      },
      ...isMaster ? [
        {
          text: `\u{1F465} Usuarios (${authorizedUsers.size})`,
          callback_data: "admin_users_list:0"
        }
      ] : [
        {
          text: "\u{1F511} Mi Sesi\xF3n (/login)",
          callback_data: "user_picta_login_start"
        }
      ]
    ],
    [
      {
        text: `\u{1F4CB} Cola (${userQueueCount})${pinned ? ` \xB7 \u{1F4CC} ${pinned.serieName.slice(0, 10)}` : ""}`,
        callback_data: "queue_view"
      },
      {
        text: `\u26A1 Cuota (${usedToday}/${totalDailyCap})`,
        callback_data: "quota_menu"
      }
    ]
  ];
  if (!isMaster && !session) {
    startKeyboard.unshift([
      {
        text: "\u{1F511} Vincular Cuenta Picta (/login)",
        callback_data: "user_picta_login_start"
      }
    ]);
  } else if (!isMaster && session && (session.availableChannels || []).length > 1) {
    startKeyboard.unshift([
      {
        text: `\u{1F4FA} Cambiar Canal (${session.channelName.slice(0, 16)})`,
        callback_data: "user_channel_pick:" + session.channelId
      }
    ]);
  }
  const userDisplayHtml = isMaster ? `@${pictaUser?.username || "Ghosthell"} \xB7 +5356942234` : session ? `@${escapeHtml(session.userFullName || session.username)}` : "<i>Sin vincular (usa /login)</i>";
  const channelDisplayHtml = isMaster || session && ctx.channelId ? `<b>${escapeHtml(ctx.channelName)}</b> \xB7 <code>#${escapeHtml(ctx.channelId)}</code>` : "<i>Sin canal activo</i>";
  const quotaPct = totalDailyCap > 0 ? Math.round(usedToday / totalDailyCap * 100) : 0;
  const text = `${hudHeader("PANEL DE CONTROL")}
` + hudBox([
    `\u{1F464} <b>Cuenta:</b> ${userDisplayHtml}`,
    `\u{1F4FA} <b>Canal:</b> ${channelDisplayHtml}`,
    `\u{1F680} <b>Motor:</b> MTProto 4 GB \xB7 Disco Ef\xEDmero + S3 Directo`,
    `\u26A1 <b>Cuota Hoy:</b> <code>${hudSegmentedBar(quotaPct, 8)}</code> (${usedToday}/${totalDailyCap})`,
    pinned ? `\u{1F4CC} <b>Serie Fija:</b> \u{1F7E2} ${escapeHtml(pinned.serieName)} \xB7 T${escapeHtml(pinned.seasonNum)}` : null
  ]) + `
${hudSection("M\xF3dulos Operativos")}
\u2022 \u{1F3AC} <b>Subida Directa:</b> Env\xEDa cualquier video MP4/MKV y el bot completa ficha, portada HD y reparto.
\u2022 \u{1F4AC} <b>Comunidad y Logros:</b> Alertas en tiempo real con respuesta directa y metas por video.
\u2022 \u{1F6E0}\uFE0F <b>Estudio API:</b> Control total de series, listas, colaboradores y permisos sin web externa.`;
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, startKeyboard, true);
  } else {
    await sendTelegramStatusMessage(chatId, text, replyToMessageId, startKeyboard);
  }
}
async function resolveOwnerPictaChannelLinkAndName(chatId) {
  const ctx = getEffectivePictaContext(chatId);
  const channelId = String(ctx.channelId || "").trim();
  const channelName = String(ctx.channelName || "Mi Canal en Picta").trim();
  const resolvedReq = resolveRequestsChannelForChat(
    chatId,
    MASTER_ADMIN_CHAT_ID,
    userPromoChannels,
    MASTER_PRIVATE_REQUESTS_CHANNEL
  );
  if (resolvedReq.isPrivateMasterDefault && isMasterAdminChat(chatId)) {
    return {
      channelId,
      channelName,
      channelUrl: MASTER_PRIVATE_REQUESTS_CHANNEL.pictaChannelUrl
    };
  }
  let slugUrl = "";
  if (channelId) {
    const cacheKey = `${channelId}:${isMasterAdminChat(chatId) ? "master" : chatId}`;
    const snap = channelCatalogSnapshotCache.get(cacheKey);
    if (snap?.channelSlugUrl) {
      slugUrl = snap.channelSlugUrl;
    } else if (ctx.isLinked) {
      const details = await Promise.race([
        fetchPictaChannelDetails(chatId).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 4500))
      ]);
      if (details?.slug_url) {
        slugUrl = details.slug_url;
      }
    }
  }
  const channelUrl = resolveCanonicalPictaChannelUrl({
    channelId,
    slugUrl,
    customUrl: resolvedReq.customPictaChannelUrl
  });
  return {
    channelId,
    channelName,
    channelUrl
  };
}
function buildMoviePromoConfirmationPrompt(promo, chatId) {
  const resolvedReq = resolveRequestsChannelForChat(
    chatId,
    MASTER_ADMIN_CHAT_ID,
    userPromoChannels,
    MASTER_PRIVATE_REQUESTS_CHANNEL
  );
  const ratingBadge = promo.rating ? `\u2B50 ${promo.rating}` : "\u2B50 N/D";
  const yearBadge = promo.year ? ` (${promo.year})` : "";
  const hasPhoto = Boolean(promo.posterUrl || promo.backdropUrl || promo.posterBase64);
  const boxLines = [
    `\u{1F3AC} <b>Pel\xEDcula:</b> ${escapeHtml(promo.title)}${escapeHtml(yearBadge)}`,
    `\u{1F3AD} <b>G\xE9nero:</b> ${escapeHtml(promo.genre || "Pel\xEDcula")} \xB7 ${escapeHtml(ratingBadge)}`,
    `\u{1F5BC}\uFE0F <b>Portada:</b> ${hasPhoto ? "\u2705 Lista para tarjeta visual" : "\u{1F4DD} Modo ficha HTML"}`,
    `\u{1F4FA} <b>Bot\xF3n Canal Picta:</b> ${escapeHtml(promo.pictaChannelName)}`,
    resolvedReq.configured ? `\u{1F4E2} <b>Canal de Pedidos:</b> ${escapeHtml(resolvedReq.targetChannelLabel)} (<code>${escapeHtml(resolvedReq.targetChannelId)}</code>)` : `\u{1F4E2} <b>Canal de Pedidos:</b> \u26AA Sin configurar (solo privado para tu cuenta)`
  ];
  const textHtml = `${hudHeader("FICHA PROMOCIONAL LISTA")}
` + hudBox(boxLines) + `
<blockquote>${escapeHtml((promo.synopsis || "").slice(0, 260))}${promo.synopsis.length > 260 ? "..." : ""}</blockquote>
` + (resolvedReq.configured ? `\xBFDeseas publicar esta ficha visual en tu <b>Canal de Pedidos</b> ahora?` : `Configura primero tu propio <b>Canal de Pedidos</b> (el bot debe ser administrador) para publicar esta ficha con un toque:`);
  const keyboard = [];
  if (resolvedReq.configured) {
    keyboard.push([
      {
        text: "\u{1F4E2} Publicar Ficha en Canal de Pedidos",
        callback_data: `promo_send:${promo.promoId}`
      }
    ]);
    keyboard.push([
      { text: "\u{1F441}\uFE0F Vista Previa aqu\xED", callback_data: `promo_preview:${promo.promoId}` },
      { text: "\u2699\uFE0F Cambiar Canal", callback_data: `promo_cfg:prompt_for:${promo.promoId}` }
    ]);
    keyboard.push([
      { text: "\u23ED\uFE0F Omitir publicaci\xF3n", callback_data: `promo_skip:${promo.promoId}` }
    ]);
  } else {
    keyboard.push([
      { text: "\u2699\uFE0F Configurar Canal de Pedidos", callback_data: `promo_cfg:prompt_for:${promo.promoId}` }
    ]);
    keyboard.push([
      { text: "\u{1F441}\uFE0F Vista Previa aqu\xED", callback_data: `promo_preview:${promo.promoId}` },
      { text: "\u23ED\uFE0F Omitir", callback_data: `promo_skip:${promo.promoId}` }
    ]);
  }
  return { textHtml, keyboard };
}
async function publishPromoRecordToTargetChat(promo, targetChatId) {
  try {
    const payload = buildMoviePromoCardPayload({
      title: promo.title,
      year: promo.year,
      rating: promo.rating,
      genre: promo.genre,
      synopsis: promo.synopsis,
      pictaVideoUrl: promo.pictaVideoUrl,
      pictaChannelUrl: promo.pictaChannelUrl,
      pictaChannelName: promo.pictaChannelName,
      posterUrl: promo.posterUrl,
      backdropUrl: promo.backdropUrl
    });
    let photoBuffer = null;
    if (promo.posterBase64) {
      try {
        photoBuffer = Buffer.from(promo.posterBase64, "base64");
      } catch {
        photoBuffer = null;
      }
    }
    return await sendTelegramPhotoWithKeyboard({
      targetChatId,
      captionHtml: payload.photoCaptionHtml,
      fallbackTextHtml: payload.textMessageHtml,
      inlineKeyboard: payload.inlineKeyboard,
      photoUrl: payload.preferredImageUrl,
      photoBuffer
    });
  } catch (err) {
    return {
      ok: false,
      messageId: null,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
async function handlePostUploadMoviePromoConfirmation(job) {
  if (Number(job.tipologiaId) !== 1 || !job.pictaPublicationId) {
    return;
  }
  const chatId = String(job.telegramChatId || "").trim();
  if (!chatId) return;
  try {
    const meta = job.modelMetadata || {};
    const rawTitle = String(job.title || "Pel\xEDcula en Picta").trim();
    const yearFromTitle = rawTitle.match(/\((\d{4})\)/)?.[1] || "";
    const cleanTitleNoYear = rawTitle.replace(/\s*\(\d{4}\)\s*$/, "").trim();
    let year = String(meta.estreno || yearFromTitle || "").match(/\b(19\d\d|20\d\d)\b/)?.[1] || "";
    let rating = normalizeMovieRatingLabel(meta.calificacion || meta.rating || "");
    let genre = String(meta.genero || job.category || "").trim();
    if (!genre || genre.toLowerCase() === "pel\xEDcula" || genre.toLowerCase() === "pelicula") {
      const cleanTags = (job.tags || []).map((t) => String(t || "").trim()).filter((t) => t && !/^(hd|1080p|720p|4k|pelicula|película|espanol|español|latino)$/i.test(t));
      genre = cleanTags.slice(0, 3).join(", ") || "Pel\xEDcula";
    }
    let posterUrl = String(meta.onlinePosterUrl || meta.onlineCoverUrl || "").trim();
    let backdropUrl = String(meta.onlineBackdropUrl || "").trim();
    let synopsis = sanitizePublicPictaText(String(job.synopsis || "")).trim();
    if ((!posterUrl || !rating) && cleanTitleNoYear && !isRandomOrCrypticFilename(cleanTitleNoYear)) {
      try {
        const quickOnline = await Promise.race([
          searchMovieOrSeriesInfoOnline(cleanTitleNoYear, 1),
          new Promise((resolve) => setTimeout(() => resolve(null), 4e3))
        ]);
        if (quickOnline) {
          if (!posterUrl && (quickOnline.posterUrl || quickOnline.imageUrl)) {
            posterUrl = String(quickOnline.posterUrl || quickOnline.imageUrl || "").trim();
          }
          if (!backdropUrl && (quickOnline.backdropUrl || quickOnline.imageUrl)) {
            backdropUrl = String(quickOnline.backdropUrl || quickOnline.imageUrl || "").trim();
          }
          if (!rating && quickOnline.rating) {
            rating = normalizeMovieRatingLabel(quickOnline.rating);
          }
          if (!year && quickOnline.year) {
            year = String(quickOnline.year).match(/\b(19\d\d|20\d\d)\b/)?.[1] || "";
          }
          if ((!synopsis || isGenericAutoSynopsis(synopsis, job.caption)) && quickOnline.synopsis) {
            synopsis = sanitizePublicPictaText(quickOnline.synopsis);
          }
          if (genre === "Pel\xEDcula" && quickOnline.genero) {
            genre = String(quickOnline.genero).split(/[,;|/]+/).map((s) => s.trim()).filter(Boolean).slice(0, 3).join(", ") || "Pel\xEDcula";
          }
        }
      } catch {
      }
    }
    let posterBase64;
    if (!posterUrl && !backdropUrl) {
      const fileIdCandidate = String(
        job.customPosterFileId || job.customCoverFileId || job.thumbnailFileId || ""
      ).trim();
      if (fileIdCandidate) {
        try {
          const buf = await downloadTelegramThumbnailBuffer(fileIdCandidate);
          if (buf && buf.byteLength > 200 && buf.byteLength < 1.5 * 1024 * 1024) {
            posterBase64 = buf.toString("base64");
          }
        } catch {
        }
      }
    }
    const slug = String(meta.pictaSlugUrl || "").trim();
    const pictaVideoUrl = slug ? `https://www.picta.cu/medias/${encodeURIComponent(slug)}` : `https://www.picta.cu/medias/${job.pictaPublicationId}`;
    const ownerChannel = await resolveOwnerPictaChannelLinkAndName(chatId);
    const promoId = `prm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const record = {
      promoId,
      jobId: job.id,
      ownerChatId: chatId,
      title: cleanTitleNoYear || rawTitle,
      ...year ? { year } : {},
      ...rating ? { rating } : {},
      ...genre ? { genre } : {},
      synopsis: synopsis || "Pel\xEDcula completa disponible para ver o descargar en Picta.",
      pictaPublicationId: job.pictaPublicationId,
      pictaVideoUrl,
      pictaChannelName: ownerChannel.channelName,
      pictaChannelUrl: ownerChannel.channelUrl,
      ...posterUrl ? { posterUrl } : {},
      ...backdropUrl ? { backdropUrl } : {},
      ...posterBase64 ? { posterBase64 } : {},
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    pendingMoviePromos.set(promoId, record);
    savePendingPromosToDisk();
    const prompt = buildMoviePromoConfirmationPrompt(record, chatId);
    await sendTelegramStatusMessage(chatId, prompt.textHtml, job.telegramMessageId, prompt.keyboard);
  } catch (err) {
    addLiveLog(
      "telegram",
      "warn",
      `Aviso: no se pudo preparar la confirmaci\xF3n promocional de "${job.title}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
async function sendOrEditPromoChannelMenuInTelegram(chatId, messageId, replyToMessageId, noticeText, returnPromoId) {
  const resolvedReq = resolveRequestsChannelForChat(
    chatId,
    MASTER_ADMIN_CHAT_ID,
    userPromoChannels,
    MASTER_PRIVATE_REQUESTS_CHANNEL
  );
  const ownerChan = await resolveOwnerPictaChannelLinkAndName(chatId);
  const rawCfg = userPromoChannels.get(chatId);
  const monitorMode = rawCfg?.requestsMonitorMode || "off";
  const groupLabel = rawCfg?.requestsGroupLabel || rawCfg?.requestsGroupChatId || "Sin grupo vinculado";
  const monitorLabels = {
    off: "\u26AA Desactivado",
    prefix: "\u{1F7E1} Solo #pedido / /buscar",
    all: "\u{1F7E2} Todo mensaje en grupo"
  };
  const pendingReqCount = channelMediaRequests.filter(
    (r) => r.ownerChatId === chatId && r.status === "pending"
  ).length;
  const lines = [
    resolvedReq.configured ? `\u{1F4E2} <b>Canal de Pedidos:</b> ${escapeHtml(resolvedReq.targetChannelLabel)}` : `\u{1F4E2} <b>Canal de Pedidos:</b> \u26AA Sin configurar`,
    resolvedReq.configured ? `\u{1F194} <b>ID / Destino:</b> <code>${escapeHtml(resolvedReq.targetChannelId)}</code>` : void 0,
    `\u{1F465} <b>Grupo de Pedidos:</b> ${escapeHtml(groupLabel)}`,
    `\u{1F916} <b>Auto-Verificador en Grupo:</b> ${monitorLabels[monitorMode]}`,
    `\u{1F4E5} <b>Pedidos Pendientes:</b> <b>${pendingReqCount}</b> (/pedidos)`,
    `\u{1F4FA} <b>Bot\xF3n Canal Picta:</b> ${escapeHtml(ownerChan.channelName)}`,
    `\u{1F517} <b>Enlace Picta:</b> <code>${escapeHtml(ownerChan.channelUrl)}</code>`,
    `\u{1F510} <b>Privacidad:</b> Configuraci\xF3n 100% privada solo para tu cuenta`
  ];
  const text = (noticeText ? `${noticeText}

` : "") + `${hudHeader("CANAL DE PEDIDOS Y PROMOCI\xD3N")}
` + hudBox(lines) + `
<i>Al subir una pel\xEDcula te preguntar\xE9 si deseas publicar su ficha en tu canal. Tambi\xE9n puedes vincular tu grupo donde piden contenido para que el bot verifique al instante si ya existe en Picta.</i>

\u{1F4CC} <b>Requisito:</b> A\xF1ade este bot como <b>Administrador</b> con permiso de publicar/responder mensajes.`;
  const keyboard = [
    [
      {
        text: resolvedReq.configured ? "\u270F\uFE0F Cambiar Canal de Pedidos" : "\u2699\uFE0F Configurar mi Canal de Pedidos",
        callback_data: returnPromoId ? `promo_cfg:prompt_for:${returnPromoId}` : "promo_cfg:set"
      }
    ],
    [
      {
        text: rawCfg?.requestsGroupChatId ? "\u270F\uFE0F Cambiar Grupo de Pedidos" : "\u{1F465} Vincular Grupo de Pedidos",
        callback_data: "promo_cfg:group"
      },
      {
        text: `\u{1F4E5} Ver Pedidos (${pendingReqCount})`,
        callback_data: "req:list:pending:0"
      }
    ],
    [
      {
        text: `${monitorMode === "off" ? "\u2705 " : ""}\u26AA Auto: OFF`,
        callback_data: "promo_cfg:mode:off"
      },
      {
        text: `${monitorMode === "prefix" ? "\u2705 " : ""}\u{1F7E1} #pedido`,
        callback_data: "promo_cfg:mode:prefix"
      },
      {
        text: `${monitorMode === "all" ? "\u2705 " : ""}\u{1F7E2} Todo`,
        callback_data: "promo_cfg:mode:all"
      }
    ]
  ];
  if (resolvedReq.configured) {
    keyboard.push([
      { text: "\u{1F9EA} Verificar Permisos del Bot", callback_data: "promo_cfg:test" },
      { text: "\u{1F6AB} Desactivar Canal", callback_data: "promo_cfg:disable" }
    ]);
  }
  if (returnPromoId && pendingMoviePromos.has(returnPromoId)) {
    keyboard.push([
      { text: "\u2B05\uFE0F Volver a Ficha de Pel\xEDcula", callback_data: `promo_back:${returnPromoId}` }
    ]);
  }
  keyboard.push([{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    await sendTelegramStatusMessage(chatId, text, replyToMessageId, keyboard);
  }
}
var lastAuditReportCache = /* @__PURE__ */ new Map();
var pendingRequestSaveByChat = /* @__PURE__ */ new Map();
async function handlePostUploadRequestFulfillment(job) {
  const ownerChatId = String(job.telegramChatId || "").trim();
  if (!ownerChatId) return;
  const matchedById = job.linkedRequestId ? channelMediaRequests.filter(
    (r) => r.id === job.linkedRequestId && r.ownerChatId === ownerChatId && r.status === "pending"
  ) : [];
  const matchedByTitle = findMatchingPendingRequests(
    channelMediaRequests,
    ownerChatId,
    job.title || job.fileName
  );
  const uniqueMatched = /* @__PURE__ */ new Map();
  for (const r of [...matchedById, ...matchedByTitle]) {
    uniqueMatched.set(r.id, r);
  }
  if (uniqueMatched.size === 0) return;
  const slug = String(job.modelMetadata?.pictaSlugUrl || "").trim();
  const pictaUrl = job.pictaPublicationId ? slug ? `https://www.picta.cu/medias/${encodeURIComponent(slug)}` : `https://www.picta.cu/medias/${job.pictaPublicationId}` : "";
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  for (const req of uniqueMatched.values()) {
    req.status = "fulfilled";
    req.fulfilledAt = nowIso;
    if (job.pictaPublicationId) req.matchedPictaPubId = job.pictaPublicationId;
    if (pictaUrl) req.matchedPictaUrl = pictaUrl;
  }
  saveChannelMediaRequestsToDisk();
  const fulfilledList = Array.from(uniqueMatched.values());
  const summaryLines = fulfilledList.slice(0, 4).map(
    (r) => `\u2022 <b>${escapeHtml(r.requestedTitle)}</b> (pedido por ${escapeHtml(r.requestedByName)})`
  ).join("\n");
  const commentReplyReq = fulfilledList.find(
    (r) => r.sourceType === "picta_comment" && r.commentPublicationId && r.commentId
  );
  const fulfillKb = [];
  if (pictaUrl) {
    fulfillKb.push([{ text: "\u{1F310} Ver en Picta", url: pictaUrl }]);
  }
  if (commentReplyReq && pictaUrl) {
    fulfillKb.push([
      {
        text: "\u{1F4AC} Responder Comentario en Picta",
        callback_data: `req:reply_cm:${commentReplyReq.id}`
      }
    ]);
  }
  await sendTelegramStatusMessage(
    ownerChatId,
    `\u{1F3AF} <b>\xA1Pedido(s) cumplido(s) autom\xE1ticamente!</b>

${summaryLines}

` + (pictaUrl ? `\u{1F517} <b>Enlace en Picta:</b> ${escapeHtml(pictaUrl)}` : ""),
    job.telegramMessageId,
    fulfillKb.length > 0 ? fulfillKb : void 0
  ).catch(() => {
  });
  for (const r of fulfilledList) {
    if (r.sourceChatId && r.sourceChatId !== ownerChatId && pictaUrl) {
      await callTelegramBotApi("sendMessage", {
        chat_id: r.sourceChatId,
        ...r.sourceMessageId ? { reply_to_message_id: r.sourceMessageId } : {},
        text: `\u{1F3AC} <b>\xA1Tu pedido ya est\xE1 disponible en Picta!</b>

\u{1F4CC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}
\u{1F517} <b>Ver aqu\xED:</b> ${escapeHtml(pictaUrl)}`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "\u25B6\uFE0F Ver ahora en Picta", url: pictaUrl }]]
        }
      }).catch(() => {
      });
    }
  }
}
async function sendOrEditChannelAuditInTelegram(chatId, messageId, tab = "dups", page = 0, replyToMessageId, forceRefresh = false) {
  const ctx = getEffectivePictaContext(chatId);
  if (!ctx.isLinked || !ctx.channelId) {
    const noAuthText = `${hudHeader("AUDITOR\xCDA DE CANAL \xB7 PICTA")}
` + hudBox([
      `\u{1F512} <b>Estado:</b> Cuenta de Picta sin vincular`,
      `\u{1F449} Vincula tu cuenta con /login para escanear duplicados y salud de tu canal.`
    ]);
    const kb = [
      [{ text: "\u{1F511} Iniciar Sesi\xF3n (/login)", callback_data: "cmd_login" }],
      [{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]
    ];
    if (messageId) {
      await editTelegramStatusMessage(chatId, messageId, noAuthText, kb, true);
    } else {
      await sendTelegramStatusMessage(chatId, noAuthText, replyToMessageId, kb);
    }
    return;
  }
  let statusMsgId = messageId;
  const cacheKey = `${ctx.channelId}:${chatId}`;
  let cached = !forceRefresh ? lastAuditReportCache.get(cacheKey) : void 0;
  if (!cached || Date.now() - cached.fetchedAt > 9e4) {
    const loadingText = `${hudHeader(`AUDITOR\xCDA DE CANAL \xB7 ${ctx.channelName}`)}
\u{1F50E} <i>Escaneando todo el cat\xE1logo de tu canal en Picta para detectar duplicados internos, fichas incompletas y videos ocultos...</i>`;
    if (statusMsgId) {
      await editTelegramStatusMessage(chatId, statusMsgId, loadingText, void 0, true);
    } else {
      statusMsgId = await sendTelegramStatusMessage(chatId, loadingText, replyToMessageId);
    }
    const snapshot = await fetchPictaChannelCatalogSnapshot(chatId, forceRefresh);
    const report2 = buildChannelAuditReport(snapshot.publications);
    cached = { report: report2, fetchedAt: Date.now() };
    lastAuditReportCache.set(cacheKey, cached);
  }
  const report = cached.report;
  const PAGE_SIZE = 5;
  let bodyHtml = "";
  let totalItems = 0;
  let totalPages = 1;
  let safePage = 0;
  const itemButtons = [];
  if (tab === "dups") {
    const groups = report.duplicateGroups;
    totalItems = groups.length;
    totalPages = Math.max(1, Math.ceil(totalItems / 3));
    safePage = Math.max(0, Math.min(page, totalPages - 1));
    const slice = groups.slice(safePage * 3, (safePage + 1) * 3);
    if (slice.length === 0) {
      bodyHtml = `\u{1F7E2} <b>\xA1Excelente!</b> No se detectaron videos duplicados dentro de tu propio canal.`;
    } else {
      bodyHtml = slice.map((g, gi) => {
        const lines = g.items.slice(0, 4).map(
          (it) => `   \u2022 <code>#${it.id}</code> <b>${escapeHtml(it.nombre.slice(0, 42))}</b> (${formatBytes(it.tamanio)} \xB7 \u{1F441}\uFE0F ${it.views})`
        ).join("\n");
        const firstDup = g.items[0];
        const extraDup = g.items[1];
        if (firstDup && extraDup) {
          itemButtons.push([
            {
              text: `\u{1F50E} Ver #${firstDup.id}`,
              callback_data: `dash_pub:${firstDup.id}:views:0`
            },
            {
              text: `\u{1F50E} Ver copia #${extraDup.id}`,
              callback_data: `dash_pub:${extraDup.id}:views:0`
            }
          ]);
        }
        return `<b>${safePage * 3 + gi + 1}. ${escapeHtml(g.reason)}</b>
${lines}`;
      }).join("\n\n");
    }
  } else {
    const list = tab === "inc" ? report.incompleteItems : tab === "unpub" ? report.unpublishedItems : report.orphanEpisodeItems;
    totalItems = list.length;
    totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
    safePage = Math.max(0, Math.min(page, totalPages - 1));
    const slice = list.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
    if (slice.length === 0) {
      const okMsg = tab === "inc" ? "Todas tus publicaciones tienen portada, sinopsis y etiquetas." : tab === "unpub" ? "Todos los videos de tu canal est\xE1n publicados y activos." : "No se detectaron cap\xEDtulos sueltos sin asignar a su serie.";
      bodyHtml = `\u{1F7E2} <b>\xA1Limpio!</b> ${okMsg}`;
    } else {
      bodyHtml = slice.map((it, idx) => {
        itemButtons.push([
          {
            text: `\u{1F6E0}\uFE0F Editar #${it.id} \xB7 ${it.nombre.slice(0, 22)}`,
            callback_data: `dash_pub:${it.id}:views:0`
          }
        ]);
        return `<b>${safePage * PAGE_SIZE + idx + 1}.</b> <code>#${it.id}</code> <b>${escapeHtml(it.nombre.slice(0, 48))}</b>
   \u26A0\uFE0F <i>${escapeHtml(it.issueSummary)}</i> \xB7 \u{1F4C2} ${escapeHtml(it.categoriaNombre)} \xB7 \u{1F441}\uFE0F ${it.views}`;
      }).join("\n\n");
    }
  }
  const tabTitles = {
    dups: "\u{1F501} Posibles Duplicados",
    inc: "\u{1F5BC}\uFE0F Fichas Incompletas",
    unpub: "\u23F3 Sin Publicar / Moderaci\xF3n",
    series: "\u{1F4FA} Cap\xEDtulos Sueltos"
  };
  const text = `${hudHeader(`AUDITOR\xCDA DE CANAL \xB7 ${ctx.channelName}`)}
` + hudBox([
    `\u{1F4E6} <b>Analizados:</b> <b>${report.totalScanned}</b> videos en <code>#${escapeHtml(ctx.channelId)}</code>`,
    `\u{1F501} <b>Grupos duplicados:</b> ${report.duplicateGroups.length} \xB7 \u{1F5BC}\uFE0F <b>Incompletos:</b> ${report.incompleteItems.length}`,
    `\u23F3 <b>Sin publicar/Moderaci\xF3n:</b> ${report.unpublishedItems.length} \xB7 \u{1F4FA} <b>Cap\xEDtulos sueltos:</b> ${report.orphanEpisodeItems.length}`
  ]) + `
${hudSection(`${tabTitles[tab]} \xB7 P\xE1g. ${safePage + 1}/${totalPages}`)}

` + (tab === "unpub" && report.unpublishedItems.length > 0 ? `<i>\u{1F4A1} Nota: Videos que nunca aprob\xF3 Picta o est\xE1n esperando moderaci\xF3n aparecen aqu\xED como "Sin publicar". Picta solo permite publicarlos tras aprobaci\xF3n de moderaci\xF3n, o puedes eliminarlos si ya no sirven.</i>

` : "") + `${bodyHtml}`;
  const keyboard = [
    [
      {
        text: `${tab === "dups" ? "\u2705 " : ""}\u{1F501} Duplicados (${report.duplicateGroups.length})`,
        callback_data: `audit:dups:0`
      },
      {
        text: `${tab === "inc" ? "\u2705 " : ""}\u{1F5BC}\uFE0F Incompletos (${report.incompleteItems.length})`,
        callback_data: `audit:inc:0`
      }
    ],
    [
      {
        text: `${tab === "unpub" ? "\u2705 " : ""}\u23F3 Sin publicar (${report.unpublishedItems.length})`,
        callback_data: `audit:unpub:0`
      },
      {
        text: `${tab === "series" ? "\u2705 " : ""}\u{1F4FA} Cap\xEDtulos (${report.orphanEpisodeItems.length})`,
        callback_data: `audit:series:0`
      }
    ],
    ...itemButtons
  ];
  if (totalPages > 1) {
    const nav = [];
    if (safePage > 0) nav.push({ text: "\u2B05\uFE0F Anterior", callback_data: `audit:${tab}:${safePage - 1}` });
    nav.push({ text: `\u{1F4C4} ${safePage + 1}/${totalPages}`, callback_data: `audit:refresh:${tab}:${safePage}` });
    if (safePage < totalPages - 1) nav.push({ text: "Siguiente \u27A1\uFE0F", callback_data: `audit:${tab}:${safePage + 1}` });
    keyboard.push(nav);
  }
  keyboard.push([
    { text: "\u{1F504} Re-escanear Canal", callback_data: `audit:refresh:${tab}:${safePage}` },
    { text: "\u{1F3DB}\uFE0F Estudio /canal", callback_data: "chan_editor:open" }
  ]);
  keyboard.push([{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]);
  if (statusMsgId) {
    await editTelegramStatusMessage(chatId, statusMsgId, text, keyboard, true);
  } else {
    await sendTelegramStatusMessage(chatId, text, replyToMessageId, keyboard);
  }
}
async function sendOrEditRequestsManagerInTelegram(chatId, messageId, filter = "pending", page = 0, replyToMessageId, noticeText, scanCommentsNow = false) {
  pendingToolkitInputByChat.delete(chatId);
  let commentSyncNotice = "";
  if (scanCommentsNow || getEffectivePictaContext(chatId).isLinked) {
    try {
      const ctx = getEffectivePictaContext(chatId);
      if (ctx.isLinked && ctx.channelId) {
        const { comments } = await fetchChannelCommentsAndDenunciasInPicta(
          chatId,
          void 0,
          scanCommentsNow
        );
        const ownerUname = isMasterAdminChat(chatId) ? "Ghosthell" : userSessions.get(chatId)?.username || "";
        const syncRes = syncPictaCommentsToChannelRequests(
          chatId,
          comments,
          ownerUname ? [ownerUname] : []
        );
        if (syncRes.added > 0) {
          commentSyncNotice = `\u{1F4AC} <b>Se detectaron ${syncRes.added} nuevo(s) pedido(s) en comentarios de Picta.</b>`;
        } else if (scanCommentsNow) {
          commentSyncNotice = `\u{1F4AC} <b>Comentarios escaneados:</b> sin nuevos pedidos pendientes por a\xF1adir.`;
        }
      }
    } catch {
    }
  }
  const ownerRequests = channelMediaRequests.filter((r) => r.ownerChatId === chatId);
  const pendingCount = ownerRequests.filter((r) => r.status === "pending").length;
  const fulfilledCount = ownerRequests.filter((r) => r.status === "fulfilled").length;
  const filtered = ownerRequests.filter((r) => {
    if (filter === "pending") return r.status === "pending";
    if (filter === "fulfilled") return r.status === "fulfilled";
    return r.status !== "dismissed";
  });
  const PAGE_SIZE = 5;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const listHtml = slice.length > 0 ? slice.map((r, idx) => {
    const rank = safePage * PAGE_SIZE + idx + 1;
    const icon = r.status === "fulfilled" ? "\u2705" : "\u23F3";
    const srcBadge = r.sourceType === "picta_comment" ? `\u{1F4AC} Comentario${r.commentPublicationTitle ? ` en "${escapeHtml(r.commentPublicationTitle.slice(0, 28))}"` : ""}` : r.sourceType === "telegram_group" ? "\u{1F465} Grupo Telegram" : "\u270D\uFE0F Manual";
    const dateStr = new Date(r.createdAt).toLocaleDateString("es-CU", {
      timeZone: "America/Havana"
    });
    return `<b>${rank}.</b> ${icon} <b>${escapeHtml(r.requestedTitle)}</b>
   \u{1F464} ${escapeHtml(r.requestedByName)} \xB7 ${srcBadge} \xB7 \u{1F4C5} ${escapeHtml(dateStr)}` + (r.matchedPictaUrl ? `
   \u{1F517} ${escapeHtml(r.matchedPictaUrl)}` : "");
  }).join("\n\n") : filter === "pending" ? "<i>\u2728 No tienes pedidos pendientes por ahora.</i>" : "<i>\u2728 No hay pedidos registrados en esta vista.</i>";
  const combinedNotice = [noticeText, commentSyncNotice].filter(Boolean).join("\n");
  const text = (combinedNotice ? `${combinedNotice}

` : "") + `${hudHeader("GESTOR DE PEDIDOS Y VERIFICADOR")}
` + hudBox([
    `\u23F3 <b>Pendientes:</b> <b>${pendingCount}</b> \xB7 \u2705 <b>Cumplidos:</b> <b>${fulfilledCount}</b>`,
    `\u{1F4A1} <i>Detecta pedidos en comentarios de Picta, grupo de suscriptores o consultas manuales.</i>`
  ]) + `
${hudSection(`Vista: ${filter === "pending" ? "\u23F3 Pendientes" : filter === "fulfilled" ? "\u2705 Cumplidos" : "\u{1F4CB} Todos"} (${filtered.length})`)}

${listHtml}`;
  const keyboard = [
    [
      { text: "\u{1F50E} Verificar / A\xF1adir Pedido", callback_data: "req:add_prompt" },
      { text: "\u{1F4AC} Escanear Comentarios", callback_data: "req:scan_comments" }
    ],
    [
      { text: `${filter === "pending" ? "\u2705 " : ""}\u23F3 Pendientes (${pendingCount})`, callback_data: "req:list:pending:0" },
      { text: `${filter === "fulfilled" ? "\u2705 " : ""}\u2705 Cumplidos (${fulfilledCount})`, callback_data: "req:list:fulfilled:0" }
    ],
    [{ text: "\u{1F4E2} Config. Grupo (/canalpedidos)", callback_data: "promo_cfg:open" }]
  ];
  slice.forEach((r, idx) => {
    const rank = safePage * PAGE_SIZE + idx + 1;
    const row = [
      { text: `\u{1F50E} #${rank} Picta`, callback_data: `req:check:${r.id}` }
    ];
    if (r.status === "pending") {
      row.push({ text: `\u2705 Cumplido`, callback_data: `req:done:${r.id}` });
    }
    row.push({ text: `\u{1F5D1}\uFE0F`, callback_data: `req:del:${r.id}` });
    keyboard.push(row);
  });
  if (totalPages > 1) {
    const nav = [];
    if (safePage > 0) nav.push({ text: "\u2B05\uFE0F Anterior", callback_data: `req:list:${filter}:${safePage - 1}` });
    nav.push({ text: `\u{1F4C4} ${safePage + 1}/${totalPages}`, callback_data: `req:list:${filter}:${safePage}` });
    if (safePage < totalPages - 1) nav.push({ text: "Siguiente \u27A1\uFE0F", callback_data: `req:list:${filter}:${safePage + 1}` });
    keyboard.push(nav);
  }
  keyboard.push([{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    await sendTelegramStatusMessage(chatId, text, replyToMessageId, keyboard);
  }
}
async function processRequestQueryAndReplyOrSave(params) {
  const cleanQ = params.query.trim();
  if (!cleanQ) return;
  const loadingText = `\u{1F50E} <i>Verificando si "<b>${escapeHtml(cleanQ)}</b>" ya existe en Picta (peso y resoluciones)...</i>`;
  const tempMsgId = params.replyChatId === params.ownerChatId ? await sendTelegramStatusMessage(params.replyChatId, loadingText, params.replyToMessageId) : null;
  const searchRes = await searchGlobalPictaCatalog(cleanQ, {
    chatId: params.ownerChatId,
    maxEnrich: 3,
    minScore: 0.72
  }).catch(() => ({ queryUsed: cleanQ, hits: [] }));
  const hits = searchRes.hits.slice(0, 3);
  if (hits.length > 0) {
    const formatted = formatSubscriberPictaReplyHtml(
      cleanQ,
      hits.map(
        (h) => ({
          id: h.id,
          kind: h.kind,
          title: h.title,
          categoryName: h.categoryName,
          channelName: h.channelName,
          sizeBytes: h.sizeBytes,
          resolutions: h.resolutions,
          maxResolutionLabel: h.maxResolutionLabel,
          webUrl: h.webUrl
        })
      )
    );
    if (tempMsgId) {
      await editTelegramStatusMessage(
        params.replyChatId,
        tempMsgId,
        formatted.html,
        formatted.keyboard,
        true
      );
    } else {
      await callTelegramBotApi("sendMessage", {
        chat_id: params.replyChatId,
        ...params.replyToMessageId ? { reply_to_message_id: params.replyToMessageId } : {},
        text: formatted.html,
        parse_mode: "HTML",
        disable_web_page_preview: false,
        reply_markup: { inline_keyboard: formatted.keyboard }
      }).catch(() => {
      });
    }
    return;
  }
  const norm = normalizeRequestTitle(cleanQ);
  const alreadyPending = channelMediaRequests.find(
    (r) => r.ownerChatId === params.ownerChatId && r.status === "pending" && r.normalizedTitle === norm
  );
  if (params.autoSaveIfMissing) {
    let savedReq = alreadyPending;
    if (!savedReq) {
      savedReq = {
        id: `rq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
        ownerChatId: params.ownerChatId,
        requestedTitle: cleanQ,
        normalizedTitle: norm,
        requestedByName: params.requesterName,
        ...params.requesterUsername ? { requestedByUsername: params.requesterUsername } : {},
        sourceType: params.replyChatId !== params.ownerChatId ? "telegram_group" : "manual",
        ...params.replyChatId !== params.ownerChatId ? { sourceChatId: params.replyChatId } : {},
        ...params.replyToMessageId ? { sourceMessageId: params.replyToMessageId } : {},
        status: "pending",
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      channelMediaRequests.unshift(savedReq);
      saveChannelMediaRequestsToDisk();
    }
    if (params.replyChatId !== params.ownerChatId) {
      await callTelegramBotApi("sendMessage", {
        chat_id: params.replyChatId,
        ...params.replyToMessageId ? { reply_to_message_id: params.replyToMessageId } : {},
        text: `\u{1F4E5} <b>Pedido anotado:</b> "<i>${escapeHtml(cleanQ)}</i>"
No aparece publicado todav\xEDa en Picta. Te avisaremos aqu\xED en cuanto se suba.`,
        parse_mode: "HTML"
      }).catch(() => {
      });
      if (params.notifyOwnerInPrivate && !alreadyPending) {
        await sendTelegramStatusMessage(
          params.ownerChatId,
          `\u{1F4E5} <b>Nuevo pedido desde tu grupo de suscriptores:</b>

\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(cleanQ)}
\u{1F464} <b>Solicitado por:</b> ${escapeHtml(params.requesterName)}
\u{1F50E} <b>Estado en Picta:</b> Libre (no encontrado en el cat\xE1logo global)`,
          void 0,
          [[{ text: "\u{1F4CB} Abrir Gestor de Pedidos", callback_data: "req:list:pending:0" }]]
        ).catch(() => {
        });
      }
      return;
    }
    const doneHtml = `\u{1F7E2} <b>No existe en Picta todav\xEDa.</b>

\u{1F4E5} Pedido guardado en tu lista de pendientes: <b>${escapeHtml(cleanQ)}</b>`;
    const kb = [
      [{ text: "\u{1F4CB} Ver Lista de Pedidos", callback_data: "req:list:pending:0" }],
      [{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]
    ];
    if (tempMsgId) {
      await editTelegramStatusMessage(params.replyChatId, tempMsgId, doneHtml, kb, true);
    } else {
      await sendTelegramStatusMessage(params.replyChatId, doneHtml, params.replyToMessageId, kb);
    }
    return;
  }
  pendingRequestSaveByChat.set(params.ownerChatId, {
    query: cleanQ,
    requesterName: params.requesterName,
    requesterUsername: params.requesterUsername,
    sourceChatId: params.replyChatId,
    sourceMessageId: params.replyToMessageId
  });
  const offerHtml = `\u{1F7E2} <b>\xA1Buenas noticias! "<i>${escapeHtml(cleanQ)}</i>" NO aparece publicado en Picta.</b>

` + (alreadyPending ? `<i>Ya lo tienes anotado en tu lista de Pedidos Pendientes.</i>` : `\xBFQuieres guardarlo en tu lista de <b>Pedidos Pendientes</b> para que se marque cumplido al subirlo?`);
  const offerKb = [
    ...alreadyPending ? [] : [[{ text: "\u{1F4E5} Guardar en Pedidos Pendientes", callback_data: "req:save_last" }]],
    [{ text: "\u{1F4CB} Ver Pedidos (/pedidos)", callback_data: "req:list:pending:0" }],
    [{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]
  ];
  if (tempMsgId) {
    await editTelegramStatusMessage(params.replyChatId, tempMsgId, offerHtml, offerKb, true);
  } else {
    await sendTelegramStatusMessage(params.replyChatId, offerHtml, params.replyToMessageId, offerKb);
  }
}
function findOwnerPromoConfigForGroupChat(chatIdStr, chatUsername) {
  const cleanChat = String(chatIdStr || "").trim();
  const unameAt = chatUsername ? `@${chatUsername.replace(/^@/, "").toLowerCase()}` : "";
  for (const cfg of userPromoChannels.values()) {
    if (cfg.disabled) continue;
    const mode = cfg.requestsMonitorMode || "off";
    if (mode === "off") continue;
    const grp = String(cfg.requestsGroupChatId || "").trim();
    const tgt = String(cfg.targetChannelId || "").trim();
    if (grp && (grp === cleanChat || unameAt && grp.toLowerCase() === unameAt)) {
      return cfg;
    }
    if (!grp && tgt && (tgt === cleanChat || unameAt && tgt.toLowerCase() === unameAt)) {
      return cfg;
    }
  }
  return null;
}
async function handleMonitoredRequestsGroupMessage(ownerCfg, incomingMsg) {
  const text = String(incomingMsg?.text || incomingMsg?.caption || "").trim();
  if (!text) return;
  const mode = ownerCfg.requestsMonitorMode || "off";
  const parsed = parseSubscriberRequestMessage(text, mode);
  if (!parsed.matched || !parsed.query) return;
  const requesterName = [incomingMsg.from?.first_name, incomingMsg.from?.last_name].filter(Boolean).join(" ") || incomingMsg.from?.username || incomingMsg.chat?.title || "Suscriptor";
  await processRequestQueryAndReplyOrSave({
    ownerChatId: ownerCfg.chatId,
    replyChatId: String(incomingMsg.chat?.id || ""),
    replyToMessageId: Number(incomingMsg.message_id || 0) || void 0,
    query: parsed.query,
    requesterName,
    requesterUsername: incomingMsg.from?.username,
    autoSaveIfMissing: true,
    notifyOwnerInPrivate: true
  });
}
async function handleIncomingLinkOrUrlIngestion(chatId, replyToMessageId, senderName, rawText) {
  const tgLink = parseTelegramMessageLink(rawText);
  const directUrlInfo = !tgLink ? extractDirectVideoUrl(rawText) : null;
  if (!tgLink && !directUrlInfo) return false;
  if (!isMasterAdminChat(chatId)) {
    await ensureGuestSessionChannelDiscovered(chatId);
  }
  const userChannelCtx = getEffectivePictaContext(chatId);
  if (!userChannelCtx.isLinked || !userChannelCtx.channelId) {
    await sendTelegramStatusMessage(
      chatId,
      `\u{1F512} <b>Vincula primero tu cuenta de Picta</b> usando /login para poder subir videos desde enlaces.`,
      replyToMessageId,
      [[{ text: "\u{1F511} Vincular Cuenta (/login)", callback_data: "user_picta_login_start" }]]
    );
    return true;
  }
  let fileName = `video_enlace_${Date.now()}.mp4`;
  let mimeType = "video/mp4";
  let fileSize = 0;
  let caption = "";
  let sourceType = "http_url";
  let sourceUrl;
  let sourcePeerRef;
  let sourceMessageId;
  if (tgLink) {
    const probingMsgId = await sendTelegramStatusMessage(
      chatId,
      `\u{1F517} <i>Consultando mensaje en Telegram v\xEDa MTProto (<code>${escapeHtml(tgLink.mtprotoPeer)}/${tgLink.messageId}</code>)...</i>`,
      replyToMessageId
    );
    const client = await ensureMtprotoClient();
    if (!client) {
      const errHtml = `\u26A0\uFE0F <b>MTProto no conectado a\xFAn.</b> Inicia sesi\xF3n MTProto para leer enlaces <code>t.me/...</code>.`;
      if (probingMsgId) await editTelegramStatusMessage(chatId, probingMsgId, errHtml, void 0, true);
      else await sendTelegramStatusMessage(chatId, errHtml, replyToMessageId);
      return true;
    }
    try {
      const peerArg = /^-?\d+$/.test(tgLink.mtprotoPeer) ? Number(tgLink.mtprotoPeer) : tgLink.mtprotoPeer;
      const msgs = await client.getMessages(peerArg, { ids: [tgLink.messageId] });
      const targetMsg = msgs?.[0];
      const doc = targetMsg?.media?.document;
      if (!targetMsg || !doc) {
        const notFoundHtml = `\u26A0\uFE0F <b>No encontr\xE9 un archivo de video en ese enlace.</b>
<i>Verifica que el canal sea p\xFAblico o que tu cuenta MTProto sea miembro del canal privado.</i>`;
        if (probingMsgId) await editTelegramStatusMessage(chatId, probingMsgId, notFoundHtml, void 0, true);
        else await sendTelegramStatusMessage(chatId, notFoundHtml, replyToMessageId);
        return true;
      }
      const attrFilename = Array.isArray(doc.attributes) ? doc.attributes.find((a) => typeof a?.fileName === "string" && a.fileName)?.fileName : "";
      fileName = String(attrFilename || `telegram_${tgLink.messageId}.mp4`).trim();
      mimeType = String(doc.mimeType || "video/mp4");
      fileSize = Number(String(doc.size || 0)) || 0;
      caption = String(targetMsg.message || "").trim();
      sourceType = "telegram_link";
      sourcePeerRef = tgLink.mtprotoPeer;
      sourceMessageId = tgLink.messageId;
      if (probingMsgId) {
        await callTelegramBotApi("deleteMessage", {
          chat_id: chatId,
          message_id: probingMsgId
        }).catch(() => {
        });
      }
    } catch (err) {
      const msgErr = err instanceof Error ? err.message : String(err);
      const errHtml = `\u26A0\uFE0F <b>No se pudo leer el enlace de Telegram:</b> <code>${escapeHtml(msgErr.slice(0, 140))}</code>`;
      if (probingMsgId) await editTelegramStatusMessage(chatId, probingMsgId, errHtml, void 0, true);
      else await sendTelegramStatusMessage(chatId, errHtml, replyToMessageId);
      return true;
    }
  } else if (directUrlInfo) {
    const probingMsgId = await sendTelegramStatusMessage(
      chatId,
      `\u{1F310} <i>Inspeccionando enlace directo de video...</i>`,
      replyToMessageId
    );
    try {
      const headRes = await fetch(directUrlInfo.url, {
        method: "HEAD",
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"
        }
      }).catch(() => null);
      const probeRes = headRes && headRes.ok ? headRes : await fetch(directUrlInfo.url, {
        method: "GET",
        redirect: "follow",
        headers: {
          Range: "bytes=0-1023",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"
        }
      });
      if (!probeRes.ok) {
        throw new Error(`El servidor remoto respondi\xF3 HTTP ${probeRes.status}`);
      }
      const check = isProbableVideoHttpResponse({
        url: probeRes.url || directUrlInfo.url,
        contentType: probeRes.headers.get("content-type"),
        contentDisposition: probeRes.headers.get("content-disposition")
      });
      if (!check.ok) {
        throw new Error(check.reason || "El enlace no apunta a un video directo.");
      }
      const contentRange = probeRes.headers.get("content-range");
      const totalFromRange = contentRange?.match(/\/(\d+)$/)?.[1];
      const len = Number(totalFromRange || probeRes.headers.get("content-length") || 0);
      if (len > PICTA_S3_MAX_OBJECT_BYTES) {
        throw new Error(`El archivo (${formatBytes(len)}) supera el m\xE1ximo de 5 GB de Picta.`);
      }
      fileName = check.fileName;
      mimeType = check.mimeType;
      fileSize = Number.isFinite(len) && len > 0 ? len : 0;
      sourceType = "http_url";
      sourceUrl = probeRes.url || directUrlInfo.url;
      if (probingMsgId) {
        await callTelegramBotApi("deleteMessage", {
          chat_id: chatId,
          message_id: probingMsgId
        }).catch(() => {
        });
      }
    } catch (err) {
      const msgErr = err instanceof Error ? err.message : String(err);
      const errHtml = `\u26A0\uFE0F <b>Enlace no v\xE1lido para subida directa:</b>
<code>${escapeHtml(msgErr.slice(0, 160))}</code>`;
      if (probingMsgId) await editTelegramStatusMessage(chatId, probingMsgId, errHtml, void 0, true);
      else await sendTelegramStatusMessage(chatId, errHtml, replyToMessageId);
      return true;
    }
  }
  const analyzedIntake = analyzeVideoTitleAndSynopsis(fileName, caption);
  const newJob = {
    id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    telegramMessageId: replyToMessageId,
    statusMessageId: null,
    telegramChatId: chatId,
    senderName,
    fileId: "",
    fileName,
    mimeType,
    caption,
    expectedBytes: fileSize,
    downloadedBytes: 0,
    integrityVerified: false,
    diskVerifiedBytes: 0,
    uploadedBytes: 0,
    stage: "awaiting_category",
    title: analyzedIntake.initialTitle,
    titleMode: "pending",
    synopsis: analyzedIntake.initialSynopsis,
    category: "Audiovisual",
    tipologiaId: 8,
    tags: [],
    speedMBps: 0,
    targetChannelId: userChannelCtx.channelId,
    targetChannelName: userChannelCtx.channelName,
    sourceType,
    ...sourceUrl ? { sourceUrl } : {},
    ...sourcePeerRef ? { sourcePeerRef } : {},
    ...sourceMessageId ? { sourceMessageId } : {},
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    ...analyzedIntake.episodeSubtitle || analyzedIntake.needsManualTitle || analyzedIntake.filenameIsRandom ? {
      modelMetadata: {
        ...analyzedIntake.episodeSubtitle ? { episodeSubtitle: analyzedIntake.episodeSubtitle } : {},
        ...analyzedIntake.needsManualTitle ? { needsManualTitle: "true" } : {},
        ...analyzedIntake.filenameIsRandom ? { filenameIsRandom: "true" } : {}
      }
    } : {}
  };
  transferJobs.unshift(newJob);
  pruneTransferJobsMemory();
  saveJobsToDisk();
  const sourceBadge = sourceType === "telegram_link" ? `\u{1F517} Enlace Telegram (${tgLink?.mtprotoPeer}/${tgLink?.messageId})` : `\u{1F310} Enlace Directo HTTP`;
  const sentPromptId = await sendTelegramStatusMessage(
    chatId,
    `${hudHeader("NUEVO VIDEO DESDE ENLACE")}
` + hudBox([
      `\u{1F4E1} <b>Origen:</b> ${escapeHtml(sourceBadge)}`,
      `\u{1F4C4} <b>Archivo:</b> <code>${escapeHtml(fileName)}</code>`,
      `\u{1F4E6} <b>Tama\xF1o:</b> ${fileSize > 0 ? formatBytes(fileSize) : "Se calcular\xE1 al descargar"}`,
      `\u{1F4FA} <b>Canal:</b> ${escapeHtml(userChannelCtx.channelName)} \xB7 <code>#${escapeHtml(userChannelCtx.channelId)}</code>`,
      analyzedIntake.initialTitle ? `\u{1F3AC} <b>T\xEDtulo detectado:</b> <code>${escapeHtml(analyzedIntake.initialTitle.slice(0, 64))}</code>` : void 0
    ]) + `
\u{1F4C2} <b>Selecciona la categor\xEDa de Picta:</b>`,
    replyToMessageId,
    buildCategorySelectionKeyboard(newJob.id)
  );
  if (sentPromptId) {
    newJob.statusMessageId = sentPromptId;
    saveJobsToDisk();
  }
  return true;
}
async function fetchChannelCollaboratorsInPicta(chatId) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const isMaster = isMasterAdminChat(effectiveChatId);
  const ctx = getEffectivePictaContext(effectiveChatId);
  if (!ctx.isLinked || !ctx.channelId) {
    throw new Error("No has vinculado tu cuenta de Picta. Usa /login primero.");
  }
  let token = await ctx.accessTokenPromise;
  const channelId = ctx.channelId;
  let res = await fetchPictaWithRetry(
    `https://api.picta.cu/v3/channel/${encodeURIComponent(channelId)}/`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      }
    }
  );
  if (res.status === 401) {
    token = isMaster && !userSessions.has(effectiveChatId) ? await authenticateWithPicta(true) : await refreshUserPictaSession(effectiveChatId);
    res = await fetchPictaWithRetry(
      `https://api.picta.cu/v3/channel/${encodeURIComponent(channelId)}/`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://admin.picta.cu",
          Referer: "https://admin.picta.cu/"
        }
      }
    );
  }
  if (res.status === 404 || res.status === 405) {
    res = await fetchPictaWithRetry(
      `https://api.picta.cu/v1/canal/${encodeURIComponent(channelId)}/`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://admin.picta.cu",
          Referer: "https://admin.picta.cu/"
        }
      }
    );
  }
  const session = userSessions.get(effectiveChatId);
  let ownerId = isMaster ? 212033 : Number(session?.userId || 0);
  let assocRaw = ownerId > 0 ? [ownerId] : [];
  if (res.ok) {
    const chObj = await res.json().catch(() => ({}));
    const fetchedOwner = Number(
      typeof chObj?.propietario === "object" && chObj.propietario ? chObj.propietario?.id ?? chObj.propietario?.user_id : chObj?.propietario || (typeof chObj?.usuario === "object" && chObj.usuario ? chObj.usuario?.id ?? chObj.usuario?.user_id : chObj?.usuario) || ownerId
    );
    if (Number.isFinite(fetchedOwner) && fetchedOwner > 0) {
      ownerId = fetchedOwner;
    }
    if (Array.isArray(chObj?.usuarios_asociados)) {
      assocRaw = chObj.usuarios_asociados;
    }
  }
  const knownLabels = /* @__PURE__ */ new Map();
  if (isMaster) {
    knownLabels.set(212033, "@Ghosthell (+5356942234 \xB7 Propietario)");
    knownLabels.set(994913, "@Ghost0210Picta (+5354684486 \xB7 Pool)");
    for (const acc of quotaSettings.poolAccounts) {
      if (acc.userId) {
        knownLabels.set(
          Number(acc.userId),
          `${acc.displayName || acc.username} (Pool)`
        );
      }
    }
  } else if (session?.userId) {
    knownLabels.set(
      Number(session.userId),
      `@${session.userFullName || session.username} (Propietario)`
    );
  }
  for (const s of userSessions.values()) {
    if (s.userId && !knownLabels.has(Number(s.userId))) {
      knownLabels.set(
        Number(s.userId),
        `${s.userFullName || s.username}${s.channelName ? ` \xB7 ${s.channelName}` : ""}`
      );
    }
  }
  const ids = computeUpdatedChannelCollaborators(assocRaw, ownerId, 0, "add");
  const collaborators = ids.map((id) => ({
    id,
    label: knownLabels.get(id) || `Usuario Picta #${id}`,
    isOwner: id === ownerId
  }));
  return {
    channelId,
    channelName: ctx.channelName,
    ownerId,
    collaborators
  };
}
async function resolveCollaboratorUserIdFromPicta(targetIdentifier, token, ownChannelId, isMaster) {
  const rawInput = String(targetIdentifier || "").trim();
  const cleanStr = rawInput.replace(/^@+/, "").trim();
  if (!cleanStr) {
    return { userId: 0 };
  }
  const cleanUrl = cleanStr.split(/[?#]/)[0];
  const chanUrlMatch = cleanUrl.match(
    /(?:picta\.cu\/)?(?:canal|canales|channel|channels)\/(?:edit\/)?([a-zA-Z0-9_\-]+)/i
  );
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    Origin: "https://admin.picta.cu",
    Referer: "https://admin.picta.cu/"
  };
  const extractOwnerFromChannelObj = async (chObj) => {
    if (!chObj || typeof chObj !== "object") return { userId: 0 };
    let uid = Number(
      typeof chObj.propietario === "object" && chObj.propietario ? chObj.propietario.id ?? chObj.propietario.user_id : chObj.propietario || 0
    );
    let uName = typeof chObj.propietario === "object" && chObj.propietario ? String(chObj.propietario.user_name || chObj.propietario.username || "") : String(chObj.usuario || "");
    const chId = Number(chObj.id || 0);
    if ((!uid || Number.isNaN(uid)) && chId > 0) {
      for (const ep of [
        `https://api.picta.cu/v3/channel/${chId}/`,
        `https://api.picta.cu/v1/canal/${chId}/`
      ]) {
        const dRes = await fetchPictaWithRetry(ep, { headers: authHeaders }, 1).catch(() => null);
        if (dRes && dRes.ok) {
          const d = await dRes.json().catch(() => null);
          if (d) {
            uid = Number(
              typeof d.propietario === "object" && d.propietario ? d.propietario.id ?? d.propietario.user_id : d.propietario || 0
            );
            if (!uName && typeof d.propietario === "object" && d.propietario?.user_name) {
              uName = String(d.propietario.user_name);
            }
            if (uid > 0) break;
          }
        }
      }
    }
    if (uid > 0) {
      const chTitle = String(chObj.nombre || (chId ? `Canal #${chId}` : "Canal")).trim();
      return {
        userId: uid,
        label: uName && !/^\d+$/.test(uName) ? `@${uName} (${chTitle})` : `${chTitle} (#${uid})`
      };
    }
    return { userId: 0 };
  };
  if (chanUrlMatch) {
    const slugOrId = chanUrlMatch[1];
    if (/^\d+$/.test(slugOrId)) {
      for (const ep of [
        `https://api.picta.cu/v1/canal/${slugOrId}/`,
        `https://api.picta.cu/v3/channel/${slugOrId}/`
      ]) {
        const r = await fetchPictaWithRetry(ep, { headers: authHeaders }, 2).catch(() => null);
        if (r && r.ok) {
          const d = await r.json().catch(() => null);
          const extracted = await extractOwnerFromChannelObj(d);
          if (extracted.userId > 0) {
            return { userId: extracted.userId, resolvedLabel: extracted.label };
          }
        }
      }
    } else {
      const r = await fetchPictaWithRetry(
        `https://api.picta.cu/v1/canal/?slug_url=${encodeURIComponent(slugOrId)}`,
        { headers: authHeaders },
        2
      ).catch(() => null);
      if (r && r.ok) {
        const d = await r.json().catch(() => null);
        const first = Array.isArray(d?.results) ? d.results[0] : Array.isArray(d) ? d[0] : null;
        const extracted = await extractOwnerFromChannelObj(first);
        if (extracted.userId > 0) {
          return { userId: extracted.userId, resolvedLabel: extracted.label };
        }
      }
    }
  }
  const digitsOnly = cleanStr.replace(/\D/g, "");
  const isPureNumeric = /^\d+$/.test(cleanStr);
  if (isPureNumeric && digitsOnly.length > 0 && digitsOnly.length <= 7) {
    return { userId: Number(digitsOnly) };
  }
  const lowerClean = cleanStr.toLowerCase();
  const phone8 = digitsOnly.length >= 8 ? digitsOnly.slice(-8) : "";
  if (isMaster) {
    if (lowerClean === "ghost0210picta" || phone8 && phone8 === "54684486") {
      return { userId: 994913, resolvedLabel: "@Ghost0210Picta" };
    }
    if (lowerClean === "ghosthell" || phone8 && phone8 === "56942234") {
      return { userId: 212033, resolvedLabel: "@Ghosthell" };
    }
    const matchedPool = quotaSettings.poolAccounts.find(
      (a) => a.username.toLowerCase().replace(/^@/, "") === lowerClean || a.displayName && a.displayName.toLowerCase().includes(lowerClean) || phone8 && a.username.replace(/\D/g, "").endsWith(phone8)
    );
    if (matchedPool?.userId) {
      return { userId: Number(matchedPool.userId), resolvedLabel: matchedPool.displayName || matchedPool.username };
    }
  }
  for (const s of userSessions.values()) {
    const sUser = String(s.username || "").trim().replace(/^@+/, "").toLowerCase();
    const sFull = String(s.userFullName || "").trim().toLowerCase();
    const sChatId = String(s.chatId || "").trim();
    const sDigits = String(s.username || "").replace(/\D/g, "");
    const hasChannelMatch = (s.availableChannels || []).some(
      (c) => String(c.id) === digitsOnly || String(c.id) === cleanStr || c.nombre && c.nombre.toLowerCase().includes(lowerClean)
    );
    if (s.userId && (sChatId === cleanStr || sUser && (sUser === lowerClean || sUser.includes(lowerClean) || lowerClean.includes(sUser)) || sFull && (sFull === lowerClean || sFull.includes(lowerClean) || lowerClean.includes(sFull)) || phone8 && sDigits.length >= 8 && sDigits.slice(-8) === phone8 || hasChannelMatch)) {
      const activeChan = s.availableChannels?.[0]?.nombre ? ` (${s.availableChannels[0].nombre})` : "";
      return {
        userId: Number(s.userId),
        resolvedLabel: `@${s.userFullName || s.username || cleanStr}${activeChan}`
      };
    }
  }
  try {
    const uRes = await fetchPictaWithRetry(
      `https://api.picta.cu/v2/usuario/?search=${encodeURIComponent(cleanStr)}`,
      { headers: authHeaders },
      1
    );
    if (uRes.ok) {
      const uData = await uRes.json().catch(() => ({}));
      const firstUser = Array.isArray(uData?.results) ? uData.results[0] : null;
      if (firstUser?.id) {
        return {
          userId: Number(firstUser.id),
          resolvedLabel: firstUser.username ? `@${firstUser.username}` : void 0
        };
      }
    }
  } catch {
  }
  if (/^[a-z0-9\-_]{3,}$/i.test(cleanStr)) {
    try {
      const sRes = await fetchPictaWithRetry(
        `https://api.picta.cu/v1/canal/?slug_url=${encodeURIComponent(cleanStr)}`,
        { headers: authHeaders },
        1
      );
      if (sRes.ok) {
        const sData = await sRes.json().catch(() => null);
        const first = Array.isArray(sData?.results) ? sData.results[0] : null;
        if (first && String(first.id) !== String(ownChannelId)) {
          const extracted = await extractOwnerFromChannelObj(first);
          if (extracted.userId > 0) {
            return { userId: extracted.userId, resolvedLabel: extracted.label };
          }
        }
      }
    } catch {
    }
  }
  const stripAccents = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const normalizedClean = stripAccents(cleanStr);
  const matchesPhoneOrUser = (rawCandidate) => {
    const cand = stripAccents(String(rawCandidate || "").replace(/^@+/, ""));
    if (!cand) return false;
    if (cand === normalizedClean) return true;
    if (phone8) {
      const cDigits = cand.replace(/\D/g, "");
      if (cDigits.length >= 8 && cDigits.slice(-8) === phone8) return true;
    }
    return false;
  };
  if (cleanStr.length >= 3) {
    let bestPartial = null;
    for (let startPage = 1; startPage <= 12; startPage += 4) {
      const pages = [startPage, startPage + 1, startPage + 2, startPage + 3];
      const pagePayloads = await Promise.all(
        pages.map(async (p) => {
          try {
            const r = await fetchPictaWithRetry(
              `https://api.picta.cu/v1/canal/?page=${p}&page_size=100`,
              { headers: authHeaders },
              1
            );
            if (!r.ok) return null;
            return await r.json().catch(() => null);
          } catch {
            return null;
          }
        })
      );
      let anyResults = false;
      for (const pData of pagePayloads) {
        const list = Array.isArray(pData?.results) ? pData.results : [];
        if (list.length > 0) anyResults = true;
        for (const item of list) {
          if (!item || typeof item !== "object") continue;
          const itemUser = stripAccents(String(item.usuario || ""));
          const itemName = stripAccents(String(item.nombre || ""));
          const itemAlias = stripAccents(String(item.alias || ""));
          const itemSlug = stripAccents(String(item.slug_url || ""));
          if (matchesPhoneOrUser(item.usuario) || itemSlug && itemSlug === normalizedClean || itemName && itemName === normalizedClean && String(item.id) !== String(ownChannelId)) {
            const extracted = await extractOwnerFromChannelObj(item);
            if (extracted.userId > 0) {
              return { userId: extracted.userId, resolvedLabel: extracted.label };
            }
          }
          if (!bestPartial && !isPureNumeric && String(item.id) !== String(ownChannelId) && (itemUser.includes(normalizedClean) || itemName.includes(normalizedClean) || itemAlias.includes(normalizedClean))) {
            bestPartial = item;
          }
        }
      }
      if (!anyResults) break;
    }
    if (bestPartial) {
      const extracted = await extractOwnerFromChannelObj(bestPartial);
      if (extracted.userId > 0) {
        return { userId: extracted.userId, resolvedLabel: extracted.label };
      }
    }
    if (!isPureNumeric) {
      for (let startPage = 1; startPage <= 12; startPage += 4) {
        const pages = [startPage, startPage + 1, startPage + 2, startPage + 3];
        const pagePayloads = await Promise.all(
          pages.map(async (p) => {
            try {
              const r = await fetchPictaWithRetry(
                `https://api.picta.cu/v3/channel/?page=${p}&page_size=100`,
                { headers: authHeaders },
                1
              );
              if (!r.ok) return null;
              return await r.json().catch(() => null);
            } catch {
              return null;
            }
          })
        );
        let anyResults = false;
        for (const pData of pagePayloads) {
          const list = Array.isArray(pData?.results) ? pData.results : [];
          if (list.length > 0) anyResults = true;
          for (const item of list) {
            if (!item || typeof item !== "object") continue;
            if (String(item.id) === String(ownChannelId)) continue;
            const itemName = stripAccents(String(item.nombre || ""));
            const itemSlug = stripAccents(String(item.slug_url || ""));
            if (itemSlug && itemSlug === normalizedClean || itemName && itemName === normalizedClean) {
              const extracted = await extractOwnerFromChannelObj(item);
              if (extracted.userId > 0) {
                return { userId: extracted.userId, resolvedLabel: extracted.label };
              }
            }
          }
        }
        if (!anyResults) break;
      }
    }
  }
  if (ownChannelId && (!cleanStr.includes(" ") || Boolean(phone8))) {
    for (let startPage = 1; startPage <= 10; startPage += 4) {
      const pages = [startPage, startPage + 1, startPage + 2, startPage + 3];
      const subPayloads = await Promise.all(
        pages.map(async (p) => {
          try {
            const r = await fetchPictaWithRetry(
              `https://api.picta.cu/v2/suscripcion/?canal=${encodeURIComponent(ownChannelId)}&page=${p}&page_size=100`,
              { headers: authHeaders },
              1
            );
            if (!r.ok) return null;
            return await r.json().catch(() => null);
          } catch {
            return null;
          }
        })
      );
      let anySubs = false;
      for (const sData of subPayloads) {
        const list = Array.isArray(sData?.results) ? sData.results : [];
        if (list.length > 0) anySubs = true;
        for (const sub of list) {
          const u = sub?.usuario;
          if (u && typeof u === "object" && u.id && matchesPhoneOrUser(u.username)) {
            return {
              userId: Number(u.id),
              resolvedLabel: u.username ? `@${u.username} (Suscriptor)` : void 0
            };
          }
        }
      }
      if (!anySubs) break;
    }
  }
  return { userId: 0 };
}
async function modifyChannelCollaboratorInPicta(chatId, targetIdentifier, action) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const isMaster = isMasterAdminChat(effectiveChatId);
  const ctx = getEffectivePictaContext(effectiveChatId);
  if (!ctx.isLinked || !ctx.channelId) {
    throw new Error("No has vinculado tu cuenta de Picta. Usa /login primero.");
  }
  const token = await ctx.accessTokenPromise;
  const channelId = ctx.channelId;
  const cleanStr = String(targetIdentifier).trim().replace(/^@+/, "");
  const resolved = await resolveCollaboratorUserIdFromPicta(
    targetIdentifier,
    token,
    channelId,
    isMaster
  );
  let targetUserId = resolved.userId;
  if (!targetUserId || isNaN(targetUserId)) {
    addLiveLog(
      "picta",
      "warn",
      `Colaborador no resuelto para "${cleanStr}" en canal #${channelId} (Picta bloquea /v2/usuario/?search= con 403).`
    );
    throw new Error(
      `No encontr\xE9 el ID de "${cleanStr}" porque Picta bloquea la b\xFAsqueda por tel\xE9fono/nombre real (HTTP 403) a cuentas no-staff (tu otra cuenta funcion\xF3 por n\xFAmero porque ya estaba guardada en el bot). Env\xEDa el enlace o nombre del canal de tu socio (ej: https://www.picta.cu/canal/su-canal), su @usuario exacto de Picta, su ID num\xE9rico, o p\xEDdele que env\xEDe /login al bot una vez.`
    );
  }
  const currentInfo = await fetchChannelCollaboratorsInPicta(effectiveChatId);
  if (action === "add" && currentInfo.collaborators.some((c) => c.id === targetUserId)) {
    return {
      collaborators: currentInfo.collaborators,
      targetUserId,
      resolvedLabel: resolved.resolvedLabel
    };
  }
  const sendPatchCollaborators = async (candidateIds) => {
    let activeToken = token;
    let patchRes2 = await fetchPictaWithRetry(
      `https://api.picta.cu/v3/channel/${encodeURIComponent(channelId)}/`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${activeToken}`,
          "Content-Type": "application/json",
          Origin: "https://admin.picta.cu",
          Referer: "https://admin.picta.cu/"
        },
        body: JSON.stringify({ usuarios_asociados: candidateIds })
      }
    );
    if (patchRes2.status === 401) {
      activeToken = isMaster && !userSessions.has(effectiveChatId) ? await authenticateWithPicta(true) : await refreshUserPictaSession(effectiveChatId);
      patchRes2 = await fetchPictaWithRetry(
        `https://api.picta.cu/v3/channel/${encodeURIComponent(channelId)}/`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${activeToken}`,
            "Content-Type": "application/json",
            Origin: "https://admin.picta.cu",
            Referer: "https://admin.picta.cu/"
          },
          body: JSON.stringify({ usuarios_asociados: candidateIds })
        }
      );
    }
    if (patchRes2.status === 404 || patchRes2.status === 405) {
      patchRes2 = await fetchPictaWithRetry(
        `https://api.picta.cu/v1/canal/${encodeURIComponent(channelId)}/`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${activeToken}`,
            "Content-Type": "application/json",
            Origin: "https://admin.picta.cu",
            Referer: "https://admin.picta.cu/"
          },
          body: JSON.stringify({ usuarios_asociados: candidateIds })
        }
      );
    }
    return patchRes2;
  };
  let updatedIds = computeUpdatedChannelCollaborators(
    currentInfo.collaborators.map((c) => c.id),
    currentInfo.ownerId,
    targetUserId,
    action
  );
  let patchRes = await sendPatchCollaborators(updatedIds);
  if (!patchRes.ok && action === "add" && /^\d+$/.test(cleanStr)) {
    const errPreview = await patchRes.text().catch(() => "");
    const chProbe = await fetchPictaWithRetry(
      `https://api.picta.cu/v3/channel/${encodeURIComponent(cleanStr)}/`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://admin.picta.cu",
          Referer: "https://admin.picta.cu/"
        }
      },
      1
    ).catch(() => null);
    if (chProbe && chProbe.ok) {
      const chProbeData = await chProbe.json().catch(() => null);
      const probeOwnerId = Number(
        typeof chProbeData?.propietario === "object" && chProbeData.propietario ? chProbeData.propietario.id ?? chProbeData.propietario.user_id : chProbeData?.propietario || 0
      );
      if (probeOwnerId > 0 && probeOwnerId !== targetUserId) {
        targetUserId = probeOwnerId;
        resolved.resolvedLabel = chProbeData?.nombre ? `${chProbeData.nombre} (Propietario #${probeOwnerId})` : void 0;
        updatedIds = computeUpdatedChannelCollaborators(
          currentInfo.collaborators.map((c) => c.id),
          currentInfo.ownerId,
          targetUserId,
          action
        );
        patchRes = await sendPatchCollaborators(updatedIds);
      } else {
        throw new Error(formatPictaError(patchRes.status, errPreview));
      }
    } else {
      throw new Error(formatPictaError(patchRes.status, errPreview));
    }
  }
  if (!patchRes.ok) {
    const errTxt = await patchRes.text();
    addLiveLog(
      "picta",
      "error",
      `Error PATCH usuarios_asociados canal #${channelId} (target=${targetUserId}, HTTP ${patchRes.status}): ${errTxt.slice(0, 180)}`
    );
    throw new Error(formatPictaError(patchRes.status, errTxt));
  }
  const patchData = await patchRes.json().catch(() => null);
  const returnedAssoc = Array.isArray(patchData?.usuarios_asociados) ? patchData.usuarios_asociados.map((x) => Number(typeof x === "object" ? x?.id ?? x?.user_id : x)) : null;
  if (action === "add" && returnedAssoc && !returnedAssoc.includes(targetUserId)) {
    addLiveLog(
      "picta",
      "warn",
      `Picta respondi\xF3 200 al PATCH del canal #${channelId}, pero #${targetUserId} no qued\xF3 en usuarios_asociados (${JSON.stringify(returnedAssoc)}).`
    );
    throw new Error(
      `Picta no permiti\xF3 asociar al usuario #${targetUserId}. Verifica que sea un usuario v\xE1lido y habilitado en Picta.`
    );
  }
  addLiveLog(
    "picta",
    "success",
    `Colaborador #${targetUserId}${resolved.resolvedLabel ? ` (${resolved.resolvedLabel})` : ""} ${action === "add" ? "a\xF1adido a" : "retirado de"} canal #${channelId}.`
  );
  const refreshed = await fetchChannelCollaboratorsInPicta(effectiveChatId);
  return {
    collaborators: refreshed.collaborators,
    targetUserId,
    resolvedLabel: resolved.resolvedLabel
  };
}
async function sendOrEditChannelCollaboratorsMenu(chatId, messageId, replyToMessageId, notice) {
  pendingToolkitInputByChat.delete(chatId);
  const ctx = getEffectivePictaContext(chatId);
  if (!ctx.isLinked || !ctx.channelId) {
    const text = `${hudHeader("COLABORADORES \xB7 ACCESO REQUERIDO")}
` + hudBox([`\u{1F512} Inicia sesi\xF3n con /login y vincula tu canal para gestionar colaboradores.`]);
    const keyboard = [
      [{ text: "\u{1F511} Iniciar Sesi\xF3n (/login)", callback_data: "user_picta_login_start" }],
      [{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]
    ];
    if (messageId) {
      await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
    } else {
      await sendTelegramStatusMessage(chatId, text, replyToMessageId, keyboard);
    }
    return;
  }
  try {
    const info = await fetchChannelCollaboratorsInPicta(chatId);
    const lines = info.collaborators.map(
      (c, idx) => `<b>${idx + 1}.</b> <code>#${c.id}</code> \xB7 ${escapeHtml(c.label)} ${c.isOwner ? "\u{1F451}" : "\u{1F91D}"}`
    ).join("\n");
    const text = (notice ? `${notice}

` : "") + `${hudHeader(`COLABORADORES \xB7 #${info.channelId}`)}
` + hudBox([
      `\u{1F4FA} <b>Canal:</b> ${escapeHtml(info.channelName)} \xB7 <code>#${escapeHtml(info.channelId)}</code>`,
      `\u{1F91D} <b>Total asociados:</b> <b>${info.collaborators.length}</b> cuenta(s)`
    ]) + `
${hudSection("Equipo del Canal")}
${lines}

<i>Gestiona los permisos de colaboradores directamente por API sin web externa.</i>`;
    const keyboard = [
      [{ text: "\u2795 A\xF1adir Colaborador (ID o Usuario)", callback_data: "chan_collabs:add_prompt" }]
    ];
    for (const c of info.collaborators) {
      if (!c.isOwner) {
        keyboard.push([
          {
            text: `\u{1F5D1}\uFE0F Quitar #${c.id} (${c.label.slice(0, 22)})`,
            callback_data: `chan_collabs:del:${c.id}`
          }
        ]);
      }
    }
    keyboard.push([
      { text: "\u{1F504} Actualizar", callback_data: "chan_collabs:open" },
      { text: "\u2B05\uFE0F Estudio /canal", callback_data: "chan_editor:open" }
    ]);
    if (messageId) {
      await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
    } else {
      await sendTelegramStatusMessage(chatId, text, replyToMessageId, keyboard);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendOrEditChannelEditorMenu(
      chatId,
      messageId,
      replyToMessageId,
      `\u26A0\uFE0F <b>Error al consultar colaboradores:</b> <code>${escapeHtml(msg.slice(0, 120))}</code>`
    );
  }
}
async function fetchChannelPlaylistsInPicta(chatId) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const ctx = getEffectivePictaContext(effectiveChatId);
  if (!ctx.isLinked || !ctx.channelId) {
    throw new Error("No has vinculado tu cuenta de Picta. Usa /login primero.");
  }
  const token = await ctx.accessTokenPromise;
  const channelId = ctx.channelId;
  const res = await fetchPictaWithRetry(
    `https://api.picta.cu/v2/lista_reproduccion_canal/?page_size=100`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      }
    }
  );
  let list = [];
  if (res.ok) {
    const data = await res.json().catch(() => ({}));
    const results = Array.isArray(data) ? data : data.results || [];
    list = filterChannelPlaylists(results, channelId);
  }
  for (const cached of localChannelPlaylistsCache.values()) {
    if (Number(cached.canalId) === Number(channelId) && !list.some((item) => item.id === cached.id)) {
      list.unshift(cached);
    }
  }
  return list;
}
async function createChannelPlaylistInPicta(chatId, nombre) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const ctx = getEffectivePictaContext(effectiveChatId);
  if (!ctx.isLinked || !ctx.channelId) {
    throw new Error("No has vinculado tu cuenta de Picta. Usa /login primero.");
  }
  const token = await ctx.accessTokenPromise;
  const channelId = Number(ctx.channelId);
  const cleanName = sanitizePublicPictaText(nombre).trim();
  if (!cleanName) {
    throw new Error("Debes indicar un nombre v\xE1lido para la lista de reproducci\xF3n.");
  }
  const form = new FormData();
  form.append("nombre", cleanName);
  form.append("canal", String(channelId));
  form.append("publicado", "true");
  const res = await fetchPictaWithRetry(
    "https://api.picta.cu/v1/lista_reproduccion_canal/",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      },
      body: form
    }
  );
  if (!res.ok) {
    const errTxt = await res.text();
    throw new Error(formatPictaError(res.status, errTxt));
  }
  const created = await res.json().catch(() => ({}));
  const record = {
    id: Number(created.id || Date.now()),
    nombre: String(created.nombre || cleanName),
    publicado: created.publicado !== false,
    descarga: Boolean(created.descarga),
    fecha_creacion: (/* @__PURE__ */ new Date()).toISOString(),
    canalId: channelId,
    canalNombre: ctx.channelName,
    publicacionesIds: []
  };
  localChannelPlaylistsCache.set(record.id, record);
  return record;
}
async function addPublicationToPlaylistInPicta(chatId, playlistId, pubId) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const ctx = getEffectivePictaContext(effectiveChatId);
  const token = await ctx.accessTokenPromise;
  const res = await fetchPictaWithRetry("https://api.picta.cu/v1/li_re_ca_pub/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: "https://admin.picta.cu",
      Referer: "https://admin.picta.cu/"
    },
    body: JSON.stringify({
      li_rep_canal: Number(playlistId),
      publicacion: Number(pubId)
    })
  });
  if (!res.ok) {
    const errTxt = await res.text();
    throw new Error(formatPictaError(res.status, errTxt));
  }
  const cached = localChannelPlaylistsCache.get(Number(playlistId));
  if (cached && !cached.publicacionesIds.includes(Number(pubId))) {
    cached.publicacionesIds.push(Number(pubId));
  }
}
async function deleteChannelPlaylistInPicta(chatId, playlistId) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const ctx = getEffectivePictaContext(effectiveChatId);
  const token = await ctx.accessTokenPromise;
  const res = await fetchPictaWithRetry(
    `https://api.picta.cu/v1/lista_reproduccion_canal/${encodeURIComponent(String(playlistId))}/`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      }
    }
  );
  if (!res.ok && res.status !== 204) {
    const errTxt = await res.text();
    throw new Error(formatPictaError(res.status, errTxt));
  }
  localChannelPlaylistsCache.delete(Number(playlistId));
}
async function sendOrEditPlaylistsMenuInTelegram(chatId, messageId, replyToMessageId, notice) {
  pendingToolkitInputByChat.delete(chatId);
  const isMaster = isMasterAdminChat(chatId);
  const session = userSessions.get(chatId);
  if (!isMaster && !session?.channelId) {
    const text2 = `${hudHeader("LISTAS \xB7 ACCESO REQUERIDO")}
` + hudBox([`\u{1F512} Inicia sesi\xF3n con /login para crear y gestionar listas de reproducci\xF3n.`]);
    const keyboard2 = [
      [{ text: "\u{1F511} Iniciar Sesi\xF3n (/login)", callback_data: "cmd_login" }],
      [{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]
    ];
    if (messageId) {
      await editTelegramStatusMessage(chatId, messageId, text2, keyboard2, true);
    } else {
      await sendTelegramStatusMessage(chatId, text2, replyToMessageId, keyboard2);
    }
    return;
  }
  const ctx = getEffectivePictaContext(chatId);
  const playlists = await fetchChannelPlaylistsInPicta(chatId).catch(() => []);
  const listLines = playlists.length > 0 ? playlists.slice(0, 10).map(
    (pl, idx) => `<b>${idx + 1}. \u{1F4C2} ${escapeHtml(pl.nombre)}</b> \xB7 <code>#${pl.id}</code>
   \u2514 \u{1F39E}\uFE0F <b>${pl.publicacionesIds.length}</b> videos \xB7 ${pl.publicado ? "\u{1F7E2} P\xFAblica" : "\u{1F648} Oculta"}`
  ).join("\n\n") : '<i>Sin listas creadas a\xFAn. Pulsa "Crear Lista" para organizar tus colecciones.</i>';
  const text = (notice ? `${notice}

` : "") + `${hudHeader(`LISTAS DE REPRODUCCI\xD3N \xB7 #${ctx.channelId}`)}
` + hudBox([
    `\u{1F4FA} <b>Canal:</b> ${escapeHtml(ctx.channelName)} \xB7 <code>${playlists.length}</code> lista(s)`,
    `\u{1F4C2} Colecciones tem\xE1ticas sincronizadas v\xEDa API de Picta`
  ]) + `
${hudSection("Colecciones Activas")}
${listLines}`;
  const keyboard = [
    [{ text: "\u2795 Crear Nueva Lista", callback_data: "playlist_create_prompt" }]
  ];
  for (const pl of playlists.slice(0, 6)) {
    keyboard.push([
      {
        text: `\u{1F5D1}\uFE0F Eliminar "${pl.nombre.slice(0, 22)}" (#${pl.id})`,
        callback_data: `playlist_del:${pl.id}`
      }
    ]);
  }
  keyboard.push([
    { text: "\u{1F504} Actualizar", callback_data: "playlists_menu:0" },
    { text: "\u{1F3DB}\uFE0F Estudio /canal", callback_data: "chan_editor:open" }
  ]);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    await sendTelegramStatusMessage(chatId, text, replyToMessageId, keyboard);
  }
}
var channelCommentsCacheMap = /* @__PURE__ */ new Map();
function invalidateChannelCommentsCache() {
  channelCommentsCacheMap.clear();
}
async function fetchPaginatedPictaCommentPages(initialUrl, token, maxPages = 5) {
  const collected = [];
  let nextUrl = initialUrl;
  for (let p = 0; p < maxPages && nextUrl; p++) {
    const res = await fetchPictaWithRetry(nextUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu"
      }
    }).catch(() => null);
    if (!res || !res.ok) break;
    const data = await res.json().catch(() => null);
    if (!data) break;
    const batch = Array.isArray(data) ? data : Array.isArray(data.results) ? data.results : [];
    collected.push(...batch);
    nextUrl = !Array.isArray(data) && typeof data.next === "string" && data.next.startsWith("http") ? data.next : null;
    if (batch.length === 0) break;
  }
  return collected;
}
async function fetchChannelCommentsAndDenunciasInPicta(chatId, pubId, forceRefresh = false) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const ctx = getEffectivePictaContext(effectiveChatId);
  if (!ctx.isLinked || !ctx.channelId) {
    throw new Error("No has vinculado tu cuenta de Picta. Usa /login primero.");
  }
  const token = await ctx.accessTokenPromise;
  const channelId = ctx.channelId;
  const cacheKey = `${channelId}:${pubId || 0}`;
  if (!forceRefresh) {
    const cached = channelCommentsCacheMap.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 25e3) {
      return cached.data;
    }
  }
  let rawComments = [];
  const pubMetaMap = /* @__PURE__ */ new Map();
  const denPromise = fetchPictaWithRetry("https://api.picta.cu/v1/denuncia/devolver_cantidades/", {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://admin.picta.cu"
    }
  }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
  const snapshot = await fetchPictaChannelCatalogSnapshot(effectiveChatId, forceRefresh).catch(
    () => null
  );
  const catalogPubs = snapshot?.publications || [];
  for (const p of catalogPubs) {
    const pid = Number(p?.id || 0);
    if (!pid) continue;
    const tipObj = p?.categoria?.tipologia || p?.tipologia;
    const catName = String(
      tipObj?.nombre || p?.categoria?.nombre || "Otros"
    ).trim();
    pubMetaMap.set(pid, {
      nombre: String(p?.nombre || `Video #${pid}`).trim(),
      tipologiaId: Number(tipObj?.id || 0) || void 0,
      categoriaNombre: catName || "Otros"
    });
  }
  if (pubId && pubId > 0) {
    const v2Pages = await fetchPaginatedPictaCommentPages(
      `https://api.picta.cu/v2/comentario/?publicacion_id=${pubId}&page_size=100`,
      token,
      6
    );
    if (v2Pages.length > 0) {
      rawComments = v2Pages;
    } else {
      rawComments = await fetchPaginatedPictaCommentPages(
        `https://api.picta.cu/v1/comentario/?publicacion_id=${pubId}&page_size=100`,
        token,
        4
      );
    }
  } else {
    try {
      let pubsList = catalogPubs;
      if (pubsList.length === 0) {
        const pubsRes = await fetchPictaWithRetry(
          `https://api.picta.cu/v2/publicacion/?canal_id=${channelId}&page_size=100`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Origin: "https://admin.picta.cu"
            }
          }
        ).catch(() => null);
        if (pubsRes && pubsRes.ok) {
          const pubsData = await pubsRes.json().catch(() => ({}));
          pubsList = Array.isArray(pubsData.results) ? pubsData.results : [];
          for (const p of pubsList) {
            const pid = Number(p?.id || 0);
            if (!pid) continue;
            const tipObj = p?.categoria?.tipologia || p?.tipologia;
            pubMetaMap.set(pid, {
              nombre: String(p?.nombre || `Video #${pid}`).trim(),
              tipologiaId: Number(tipObj?.id || 0) || void 0,
              categoriaNombre: String(tipObj?.nombre || p?.categoria?.nombre || "Otros").trim()
            });
          }
        }
      }
      const pubsWithComments = pubsList.filter((p) => Number(p?.cantidad_comentarios || 0) > 0);
      const recentFallbackPubs = pubsList.slice(0, 15);
      const targetPubsMap = /* @__PURE__ */ new Map();
      for (const p of [...pubsWithComments, ...recentFallbackPubs]) {
        const pid = Number(p?.id || 0);
        if (pid && !targetPubsMap.has(pid)) {
          targetPubsMap.set(pid, p);
        }
      }
      const targetPubs = Array.from(targetPubsMap.values());
      const [globalFeed, channelFeed] = await Promise.all([
        fetchPaginatedPictaCommentPages(
          `https://api.picta.cu/v2/comentario/?page_size=100`,
          token,
          3
        ),
        fetchPaginatedPictaCommentPages(
          `https://api.picta.cu/v2/comentario/?canal_id=${encodeURIComponent(channelId)}&page_size=100`,
          token,
          3
        )
      ]);
      const fetchedRawList = [...channelFeed, ...globalFeed];
      const BATCH_SIZE = 6;
      for (let i = 0; i < targetPubs.length; i += BATCH_SIZE) {
        const batch = targetPubs.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (p) => {
            const list = await fetchPaginatedPictaCommentPages(
              `https://api.picta.cu/v2/comentario/?publicacion_id=${p.id}&page_size=100`,
              token,
              4
            );
            return list.map((item) => ({
              ...item,
              publicacion: typeof item.publicacion === "object" && item.publicacion ? {
                ...item.publicacion,
                id: item.publicacion.id || p.id,
                nombre: item.publicacion.nombre || p.nombre,
                categoria: item.publicacion.categoria || p.categoria,
                canal: item.publicacion.canal || { id: Number(channelId) }
              } : {
                id: p.id,
                nombre: p.nombre,
                categoria: p.categoria,
                canal: { id: Number(channelId) }
              }
            }));
          })
        );
        fetchedRawList.push(...batchResults.flat());
      }
      rawComments = fetchedRawList;
    } catch {
    }
  }
  const denRaw = await denPromise;
  const myChannelComments = filterChannelComments(rawComments, channelId, pubId, pubMetaMap);
  const result = {
    comments: myChannelComments,
    denuncias: normalizeDenunciaCounts(denRaw)
  };
  channelCommentsCacheMap.set(cacheKey, {
    timestamp: Date.now(),
    data: result
  });
  return result;
}
async function postPictaCommentInChannel(chatId, pubId, texto, parentCommentId) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const ctx = getEffectivePictaContext(effectiveChatId);
  const token = await ctx.accessTokenPromise;
  const cleanText = texto.trim();
  if (!cleanText) {
    throw new Error("Escribe un texto v\xE1lido para el comentario.");
  }
  let effectivePubId = Number(pubId || 0);
  if (!effectivePubId && parentCommentId && parentCommentId > 0) {
    try {
      let parentRes = await fetchPictaWithRetry(
        `https://api.picta.cu/v1/comentario/${parentCommentId}/`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: "https://admin.picta.cu",
            Referer: "https://admin.picta.cu/"
          }
        }
      );
      if (!parentRes.ok) {
        parentRes = await fetchPictaWithRetry(
          `https://api.picta.cu/v2/comentario/${parentCommentId}/`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Origin: "https://admin.picta.cu",
              Referer: "https://admin.picta.cu/"
            }
          }
        );
      }
      if (parentRes.ok) {
        const parentData = await parentRes.json();
        effectivePubId = Number(
          typeof parentData.publicacion === "object" ? parentData.publicacion?.id : parentData.publicacion || 0
        );
      }
    } catch {
    }
  }
  if (!effectivePubId) {
    throw new Error("No se pudo identificar la publicaci\xF3n a la que pertenece este comentario.");
  }
  const form = new FormData();
  form.append("texto", cleanText);
  form.append("publicacion", String(effectivePubId));
  if (parentCommentId && parentCommentId > 0) {
    form.append("comentario", String(parentCommentId));
  }
  const res = await fetchPictaWithRetry("https://api.picta.cu/v1/comentario/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://admin.picta.cu",
      Referer: "https://admin.picta.cu/"
    },
    body: form
  });
  if (!res.ok) {
    const errTxt = await res.text();
    throw new Error(formatPictaError(res.status, errTxt));
  }
  invalidateChannelCommentsCache();
  return res.json().catch(() => ({ ok: true }));
}
async function fetchPictaPublicationDirectLinks(chatId, pubId) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const ctx = getEffectivePictaContext(effectiveChatId);
  const token = await ctx.accessTokenPromise.catch(() => "");
  const headers = {
    Origin: "https://admin.picta.cu",
    Referer: "https://admin.picta.cu/"
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  let res = await fetchPictaWithRetry(
    `https://api.picta.cu/v2/publicacion/${encodeURIComponent(String(pubId))}/`,
    { headers }
  ).catch(() => null);
  if (!res || !res.ok) {
    res = await fetchPictaWithRetry(
      `https://api.picta.cu/v1/publicacion/${encodeURIComponent(String(pubId))}/`,
      { headers }
    );
  }
  if (!res.ok) {
    const errTxt = await res.text().catch(() => "");
    throw new Error(formatPictaError(res.status, errTxt));
  }
  const data = await res.json();
  const pub = data?.results ? data.results[0] || data : data;
  const urlDescarga = pub.url_descarga || pub.url_archivo || (pub.url_video && !String(pub.url_video).endsWith(".m3u8") ? pub.url_video : void 0);
  let urlManifiesto = pub.url_manifiesto || (pub.url_video && String(pub.url_video).endsWith(".m3u8") ? pub.url_video : void 0);
  if (urlManifiesto && !String(urlManifiesto).startsWith("http")) {
    urlManifiesto = `https://manifest.picta.cu/${String(urlManifiesto).replace(/^\/+/, "")}`;
  }
  return {
    id: Number(pub.id || pubId),
    nombre: String(pub.nombre || pub.titulo || `Video #${pubId}`),
    url_descarga: urlDescarga,
    url_manifiesto: urlManifiesto,
    url_video: pub.url_video,
    tamanio: Number(pub.tamanio || pub.size || 0),
    duracion: Number(pub.duracion || 0)
  };
}
var PICTA_SEARCH_STOPWORDS = /* @__PURE__ */ new Set([
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "de",
  "del",
  "al",
  "y",
  "e",
  "o",
  "en",
  "con",
  "por",
  "para",
  "the",
  "a",
  "an",
  "of",
  "and",
  "in",
  "on",
  "to",
  "by",
  "for",
  "pelicula",
  "movie",
  "film",
  "capitulo",
  "episodio",
  "temporada",
  "serie"
]);
function normalizePictaSearchText(raw) {
  return String(raw || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[._|/\\:;\[\]()]+/g, " ").replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();
}
function normalizeDuplicateTitleKey(raw) {
  return normalizePictaSearchText(raw).replace(/\s+/g, " ").trim();
}
function stripTechnicalMovieTags(raw) {
  let q = String(raw || "").trim();
  q = q.replace(/\.(mp4|mkv|avi|mov|webm|flv|wmv|m4v|ts)$/i, "");
  q = q.replace(/\[[^\]]{1,40}\]/g, " ");
  q = q.replace(
    /\b(2160p|1080p|720p|480p|360p|4k|uhd|fhd|hd|full\s*hd|web[-\s]?dl|webrip|bluray|blu[-\s]?ray|brrip|bdrip|dvdrip|hdtv|hdcam|camrip|x264|x265|h\.?264|h\.?265|hevc|av1|aac|ac3|dts|eac3|ddp5\.?1|10bit|dual|latino|castellano|espanol|español|subtitulada|subtitulado|sub\s*esp|vose|eng|spa)\b/gi,
    " "
  );
  q = q.replace(/[._]+/g, " ");
  q = q.replace(/\(\s*(19\d{2}|20\d{2})\s*\)/g, " ");
  q = q.replace(/\s+-\s*$/g, "");
  q = q.replace(/\s+/g, " ").trim();
  return q;
}
function extractEpisodeCoordsForMatch(title) {
  const s = String(title || "");
  let m = s.match(/\b[ST](\d{1,2})\s*[:\-xX]?\s*[EC](\d{1,3})\b/i);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = s.match(/\b(\d{1,2})\s*[xX]\s*(\d{1,3})\b/);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = s.match(/\b(?:cap(?:itulo|[ií]tulo)?|ep(?:isodio)?|parte)\s*#?\s*(\d{1,3})\b/i);
  if (m) return { episode: Number(m[1]) };
  return {};
}
function buildPictaSearchQueries(rawQuery, tipologiaId) {
  const cleaned = stripTechnicalMovieTags(rawQuery);
  const withoutTrailingYear = cleaned.replace(/\s+(19\d{2}|20\d{2})$/, "").trim();
  const base = withoutTrailingYear || cleaned || rawQuery.trim();
  const beforeDashOrSep = base.split(/\s*[·|]\s*/)[0].replace(/\b(?:[ST]\d{1,2}\s*[:\-xX]?\s*[EC]\d{1,3}|\d{1,2}[xX]\d{1,3})\b.*/i, "").trim();
  if (tipologiaId === 5 && beforeDashOrSep.length >= 2) {
    return {
      primaryQuery: beforeDashOrSep,
      coreTitle: base,
      altQuery: base !== beforeDashOrSep ? base : void 0
    };
  }
  const colonPrefix = base.includes(":") ? base.split(":")[0].trim() : "";
  return {
    primaryQuery: base,
    coreTitle: base,
    altQuery: colonPrefix.length >= 4 && colonPrefix.toLowerCase() !== base.toLowerCase() ? colonPrefix : void 0
  };
}
function scorePictaTitleMatch(queryRaw, candidateTitle, options) {
  const cleanQ = stripTechnicalMovieTags(queryRaw).replace(/\s+(19\d{2}|20\d{2})$/, "").trim();
  const cleanC = stripTechnicalMovieTags(candidateTitle).replace(/\s+(19\d{2}|20\d{2})$/, "").trim();
  const normQ = normalizePictaSearchText(cleanQ);
  const normC = normalizePictaSearchText(cleanC);
  if (!normQ || !normC) return { score: 0, level: "partial" };
  if (options?.tipologiaId === 5 && options.epNum) {
    const targetEp = Number(options.epNum);
    const targetSeason = options.seasonNum ? Number(options.seasonNum) : void 0;
    const candCoords = extractEpisodeCoordsForMatch(candidateTitle);
    if (candCoords.episode !== void 0 && targetEp > 0) {
      if (candCoords.episode !== targetEp) {
        return { score: 0.15, level: "partial" };
      }
      if (candCoords.season !== void 0 && targetSeason && candCoords.season !== targetSeason) {
        return { score: 0.15, level: "partial" };
      }
    }
  }
  if (normQ === normC) {
    return { score: 1, level: "exact" };
  }
  const qBase = normQ.replace(/\b(?:s\d{1,2}\s*e\d{1,3}|t\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{1,3})\b.*$/i, "").trim();
  const cBase = normC.replace(/\b(?:s\d{1,2}\s*e\d{1,3}|t\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{1,3})\b.*$/i, "").trim();
  if (options?.tipologiaId === 5 && options.epNum && qBase && cBase && qBase === cBase) {
    const candCoords = extractEpisodeCoordsForMatch(candidateTitle);
    const targetEp = Number(options.epNum);
    if (candCoords.episode === targetEp) {
      return { score: 0.96, level: "exact" };
    }
  }
  const qTokensAll = normQ.split(" ").filter(Boolean);
  const cTokensAll = normC.split(" ").filter(Boolean);
  const qTokens = qTokensAll.filter((t) => !PICTA_SEARCH_STOPWORDS.has(t));
  const cTokens = cTokensAll.filter((t) => !PICTA_SEARCH_STOPWORDS.has(t));
  const effQ = qTokens.length > 0 ? qTokens : qTokensAll;
  const effC = cTokens.length > 0 ? cTokens : cTokensAll;
  if (effQ.length === 0 || effC.length === 0) return { score: 0.2, level: "partial" };
  if (effQ.join(" ") === effC.join(" ")) {
    return { score: 0.95, level: "exact" };
  }
  const cSet = new Set(effC);
  const qSet = new Set(effQ);
  let overlap = 0;
  for (const t of qSet) {
    if (cSet.has(t)) overlap++;
  }
  if (overlap === 0) {
    const compactQ = effQ.join("");
    const compactC = effC.join("");
    if (compactQ === compactC) return { score: 0.94, level: "exact" };
    if (compactQ.length >= 5 && (compactC.includes(compactQ) || compactQ.includes(compactC))) {
      return { score: 0.72, level: "partial" };
    }
    return { score: 0.05, level: "partial" };
  }
  const recall = overlap / qSet.size;
  const precision = overlap / cSet.size;
  const dice = 2 * overlap / (qSet.size + cSet.size);
  const qNums = effQ.filter((t) => /^\d+$/.test(t) || /^(ii|iii|iv|v|vi)$/.test(t));
  const cNums = effC.filter((t) => /^\d+$/.test(t) || /^(ii|iii|iv|v|vi)$/.test(t));
  const numMismatch = (qNums.length > 0 || cNums.length > 0) && qNums.join(",") !== cNums.join(",");
  let score = dice * 0.65 + recall * 0.2 + precision * 0.15;
  if (normC.startsWith(normQ) || normQ.startsWith(normC)) {
    score = Math.max(score, Math.min(0.89, 0.74 + precision * 0.15));
  }
  if (numMismatch) {
    score = Math.min(score, 0.62);
  }
  if (score >= 0.92) return { score, level: "exact" };
  if (score >= 0.78) return { score, level: "high" };
  return { score, level: "partial" };
}
function resolutionLabelFromDims(w, h) {
  if (w >= 3800 || h >= 2160) return "4K";
  if (w >= 2500 || h >= 1440) return "1440p";
  if (w >= 1800 || h >= 1080) return "1080p";
  if (w >= 1200 || h >= 720) return "720p";
  if (w >= 800 || h >= 480) return "480p";
  if (w >= 580 || h >= 360) return "360p";
  if (w >= 400 || h >= 240) return "240p";
  return h > 0 ? `${h}p` : w > 0 ? `${w}px` : "";
}
function resolutionRankValue(label) {
  const s = label.toLowerCase();
  if (s.includes("4k") || s.includes("2160")) return 2160;
  const m = s.match(/(\d{3,4})/);
  return m ? Number(m[1]) : 0;
}
function parseHlsMasterPlaylistResolutions(m3u8Text) {
  const found = /* @__PURE__ */ new Set();
  const lines = String(m3u8Text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const resMatch = line.match(/RESOLUTION\s*=\s*(\d+)\s*x\s*(\d+)/i);
    if (resMatch) {
      const lbl = resolutionLabelFromDims(Number(resMatch[1]), Number(resMatch[2]));
      if (lbl) found.add(lbl);
    }
    const nameMatch = line.match(/NAME\s*=\s*"([^"]+)"/i);
    if (nameMatch) {
      const qm = nameMatch[1].match(/\b(4K|2160p|1440p|1080p|720p|480p|360p|240p)\b/i);
      if (qm) found.add(qm[1].toUpperCase() === "4K" ? "4K" : qm[1].toLowerCase());
    }
    if (!line.startsWith("#")) {
      const pathMatch = line.match(/\b(2160|1440|1080|720|480|360|240)p?\b/i);
      if (pathMatch && found.size === 0) {
        const val = pathMatch[1];
        found.add(val === "2160" ? "4K" : `${val}p`);
      }
    }
  }
  return Array.from(found).sort((a, b) => resolutionRankValue(b) - resolutionRankValue(a));
}
function formatDurationCompact(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  if (total <= 0) return "";
  const h = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
function extractInlineResolutionsFromPub(pub) {
  const found = /* @__PURE__ */ new Set();
  const addTag = (raw) => {
    const str = String(raw || "").trim();
    if (!str) return;
    const m = str.match(/\b(4K|2160p|1440p|1080p|720p|480p|360p|240p)\b/i);
    if (m) {
      found.add(m[1].toUpperCase() === "4K" ? "4K" : m[1].toLowerCase());
    }
  };
  addTag(pub?.resolucion);
  addTag(pub?.calidad);
  addTag(pub?.max_resolution);
  if (Array.isArray(pub?.calidades)) pub.calidades.forEach(addTag);
  if (Array.isArray(pub?.resoluciones)) pub.resoluciones.forEach(addTag);
  if (Array.isArray(pub?.formatos)) {
    for (const f of pub.formatos) {
      addTag(f?.nombre || f?.calidad || f?.resolucion || f);
    }
  }
  const w = Number(pub?.ancho || pub?.width || 0);
  const h = Number(pub?.alto || pub?.height || 0);
  if (w > 0 || h > 0) {
    const lbl = resolutionLabelFromDims(w, h);
    if (lbl) found.add(lbl);
  }
  return Array.from(found).sort((a, b) => resolutionRankValue(b) - resolutionRankValue(a));
}
function mapRawPictaItemToHit(raw, kind, queryForScore, options) {
  const id = Number(raw?.id || 0);
  const title = String(raw?.nombre || raw?.titulo || "").trim();
  if (!id || !title) return null;
  const catObj = raw?.categoria;
  const tipObj = catObj?.tipologia;
  const tipId = Number(tipObj?.id || raw?.tipologia?.id || raw?.tipologia_id || (kind === "serie" ? 5 : 0)) || void 0;
  const categoryName = kind === "serie" ? "Serie" : String(tipObj?.nombre || catObj?.nombre || raw?.tipologia?.nombre || "Video");
  const canalObj = typeof raw?.canal === "object" && raw?.canal ? raw.canal : null;
  const channelId = String(canalObj?.id || raw?.canal_id || (typeof raw?.canal === "number" ? raw.canal : "") || "");
  const channelName = String(
    canalObj?.nombre || raw?.canal_nombre || (channelId ? `Canal #${channelId}` : "Canal de Picta")
  ).trim();
  const urlDescarga = raw?.url_descarga || raw?.url_archivo || (raw?.url_video && !String(raw.url_video).endsWith(".m3u8") ? String(raw.url_video) : void 0);
  let urlManifiesto = raw?.url_manifiesto || (raw?.url_video && String(raw.url_video).endsWith(".m3u8") ? String(raw.url_video) : void 0);
  if (urlManifiesto && !String(urlManifiesto).startsWith("http")) {
    urlManifiesto = `https://manifest.picta.cu/${String(urlManifiesto).replace(/^\/+/, "")}`;
  }
  const inlineRes = extractInlineResolutionsFromPub(raw);
  const scored = scorePictaTitleMatch(queryForScore, title, options);
  const webUrl = kind === "serie" ? `https://www.picta.cu/series/${id}` : `https://www.picta.cu/medias/${id}`;
  return {
    id,
    kind,
    title,
    categoryName,
    tipologiaId: tipId,
    channelId,
    channelName,
    sizeBytes: Number(raw?.tamanio || raw?.size || 0),
    resolutions: inlineRes,
    maxResolutionLabel: inlineRes.length > 0 ? inlineRes.join(" \xB7 ") : "",
    durationSeconds: Number(raw?.duracion || 0),
    views: Number(raw?.cantidad_reproducciones || raw?.cantidad_visitas || raw?.vistas || 0),
    createdAt: String(raw?.fecha_publicado || raw?.fecha_creacion || ""),
    webUrl,
    manifestUrl: urlManifiesto ? String(urlManifiesto) : void 0,
    downloadUrl: urlDescarga ? String(urlDescarga) : void 0,
    matchScore: scored.score,
    matchLevel: scored.level
  };
}
async function fetchJsonWithShortTimeout(url, headers, timeoutMs = 5500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function fetchTextWithShortTimeout(url, headers, timeoutMs = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.text().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function enrichPictaHitMetadata(hit, headers) {
  if (hit.kind !== "publicacion") return hit;
  try {
    let detail = await fetchJsonWithShortTimeout(
      `https://api.picta.cu/v2/publicacion/${encodeURIComponent(String(hit.id))}/`,
      headers,
      3800
    );
    if (!detail) {
      detail = await fetchJsonWithShortTimeout(
        `https://api.picta.cu/v1/publicacion/${encodeURIComponent(String(hit.id))}/`,
        headers,
        3500
      );
    }
    const pub = detail?.results ? detail.results[0] || detail : detail;
    if (pub && typeof pub === "object") {
      const sizeVal = Number(pub.tamanio || pub.size || 0);
      if (sizeVal > 0) hit.sizeBytes = sizeVal;
      const durVal = Number(pub.duracion || 0);
      if (durVal > 0) hit.durationSeconds = durVal;
      const viewsVal = Number(pub.cantidad_reproducciones || pub.cantidad_visitas || 0);
      if (viewsVal > hit.views) hit.views = viewsVal;
      if (pub.fecha_publicado || pub.fecha_creacion) {
        hit.createdAt = String(pub.fecha_publicado || pub.fecha_creacion);
      }
      if (pub.canal && typeof pub.canal === "object") {
        if (pub.canal.nombre) hit.channelName = String(pub.canal.nombre);
        if (pub.canal.id) hit.channelId = String(pub.canal.id);
      } else if (pub.canal_nombre) {
        hit.channelName = String(pub.canal_nombre);
      }
      const inlineRes = extractInlineResolutionsFromPub(pub);
      if (inlineRes.length > 0) {
        const merged = Array.from(/* @__PURE__ */ new Set([...hit.resolutions, ...inlineRes])).sort(
          (a, b) => resolutionRankValue(b) - resolutionRankValue(a)
        );
        hit.resolutions = merged;
        hit.maxResolutionLabel = merged.join(" \xB7 ");
      }
      const dlUrl = pub.url_descarga || pub.url_archivo || (pub.url_video && !String(pub.url_video).endsWith(".m3u8") ? String(pub.url_video) : void 0);
      if (dlUrl) hit.downloadUrl = String(dlUrl);
      let maniUrl = pub.url_manifiesto || (pub.url_video && String(pub.url_video).endsWith(".m3u8") ? String(pub.url_video) : void 0);
      if (maniUrl && !String(maniUrl).startsWith("http")) {
        maniUrl = `https://manifest.picta.cu/${String(maniUrl).replace(/^\/+/, "")}`;
      }
      if (maniUrl) hit.manifestUrl = String(maniUrl);
    }
    if (hit.manifestUrl && hit.manifestUrl.startsWith("http")) {
      const m3u8Text = await fetchTextWithShortTimeout(hit.manifestUrl, headers, 3200);
      if (m3u8Text && m3u8Text.includes("#EXT")) {
        const parsedRes = parseHlsMasterPlaylistResolutions(m3u8Text);
        if (parsedRes.length > 0) {
          const merged = Array.from(/* @__PURE__ */ new Set([...hit.resolutions, ...parsedRes])).sort(
            (a, b) => resolutionRankValue(b) - resolutionRankValue(a)
          );
          hit.resolutions = merged;
          hit.maxResolutionLabel = merged.join(" \xB7 ");
        }
      }
    }
    if (hit.sizeBytes <= 0 && hit.downloadUrl && hit.downloadUrl.startsWith("http")) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2200);
      try {
        const headRes = await fetch(hit.downloadUrl, {
          method: "HEAD",
          headers,
          signal: controller.signal
        });
        const cl = Number(headRes.headers.get("content-length") || 0);
        if (cl > 0) hit.sizeBytes = cl;
      } catch {
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
  }
  return hit;
}
async function searchGlobalPictaCatalog(rawQuery, options) {
  const { primaryQuery, coreTitle, altQuery } = buildPictaSearchQueries(
    rawQuery,
    options?.tipologiaId
  );
  if (!primaryQuery || primaryQuery.length < 2) {
    return { queryUsed: rawQuery.trim(), hits: [] };
  }
  const effectiveChatId = options?.chatId || MASTER_ADMIN_CHAT_ID;
  const ctx = getEffectivePictaContext(effectiveChatId);
  const token = await ctx.accessTokenPromise.catch(() => "");
  const headers = {
    Origin: "https://www.picta.cu",
    Referer: "https://www.picta.cu/"
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const queriesToRun = [primaryQuery];
  if (altQuery && altQuery.toLowerCase() !== primaryQuery.toLowerCase()) {
    queriesToRun.push(altQuery);
  }
  const rawPromises = [];
  for (const q of queriesToRun) {
    const enc = encodeURIComponent(q);
    rawPromises.push(
      fetchJsonWithShortTimeout(
        `https://api.picta.cu/v2/publicacion/?search=${enc}&page_size=25`,
        headers,
        6e3
      ).then((data) => ({ kind: "publicacion", data }))
    );
    rawPromises.push(
      fetchJsonWithShortTimeout(
        `https://api.picta.cu/v2/serie/?search=${enc}&page_size=15`,
        headers,
        5500
      ).then((data) => ({ kind: "serie", data }))
    );
  }
  let settled = await Promise.all(rawPromises);
  const v2PubCount = settled.filter((r) => r.kind === "publicacion").reduce((sum, r) => sum + (Array.isArray(r.data?.results) ? r.data.results.length : 0), 0);
  if (v2PubCount === 0) {
    const v1Fallback = await fetchJsonWithShortTimeout(
      `https://api.picta.cu/v1/publicacion/?search=${encodeURIComponent(primaryQuery)}&page_size=25`,
      headers,
      5500
    );
    if (v1Fallback) {
      settled.push({ kind: "publicacion", data: v1Fallback });
    }
  }
  const deduped = /* @__PURE__ */ new Map();
  for (const res of settled) {
    const list = Array.isArray(res.data?.results) ? res.data.results : Array.isArray(res.data) ? res.data : [];
    for (const rawItem of list) {
      const mapped = mapRawPictaItemToHit(rawItem, res.kind, coreTitle, {
        tipologiaId: options?.tipologiaId,
        seasonNum: options?.seasonNum,
        epNum: options?.epNum
      });
      if (!mapped) continue;
      const key = `${mapped.kind}:${mapped.id}`;
      const existing = deduped.get(key);
      if (!existing || mapped.matchScore > existing.matchScore) {
        deduped.set(key, mapped);
      }
    }
  }
  const minScore = options?.minScore ?? 0.25;
  const sorted = Array.from(deduped.values()).filter((h) => h.matchScore >= minScore).sort((a, b) => {
    if (Math.abs(b.matchScore - a.matchScore) > 0.05) return b.matchScore - a.matchScore;
    return b.views - a.views;
  });
  const maxEnrich = Math.min(options?.maxEnrich ?? 5, sorted.length);
  if (maxEnrich > 0) {
    await Promise.all(
      sorted.slice(0, maxEnrich).map((hit) => enrichPictaHitMetadata(hit, headers))
    );
  }
  return { queryUsed: primaryQuery, hits: sorted };
}
async function findLikelyPictaDuplicates(queryTitle, options) {
  try {
    const res = await searchGlobalPictaCatalog(queryTitle, {
      chatId: options.chatId,
      tipologiaId: options.tipologiaId,
      seasonNum: options.seasonNum,
      epNum: options.epNum,
      maxEnrich: 4,
      minScore: 0.78
    });
    return res.hits.slice(0, 4);
  } catch {
    return [];
  }
}
function formatPictaHitEntryHtml(hit, index) {
  const badgeIcon = hit.kind === "serie" || hit.tipologiaId === 5 ? "\u{1F4FA}" : hit.tipologiaId === 1 ? "\u{1F3AC}" : hit.tipologiaId === 2 ? "\u{1F39E}\uFE0F" : "\u{1F4F9}";
  const matchTag = hit.matchLevel === "exact" ? " \u{1F7E2} <i>(Coincidencia exacta)</i>" : hit.matchLevel === "high" ? " \u{1F7E1} <i>(Muy similar)</i>" : "";
  const sizeStr = hit.sizeBytes > 0 ? formatBytes(hit.sizeBytes) : "No reportado";
  const resStr = hit.maxResolutionLabel ? hit.maxResolutionLabel : hit.kind === "serie" ? "Cat\xE1logo Serie" : "No detectada";
  const durStr = formatDurationCompact(hit.durationSeconds);
  const dateStr = hit.createdAt ? new Date(hit.createdAt).toLocaleDateString("es-CU", { timeZone: "America/Havana" }) : "";
  return `<b>${index + 1}.</b> ${badgeIcon} <a href="${escapeHtml(hit.webUrl)}"><b>${escapeHtml(hit.title)}</b></a>${matchTag}
\u251C \u{1F3F7}\uFE0F <b>Tipo:</b> ${escapeHtml(hit.categoryName)} \xB7 \u{1F4FA} <b>Canal:</b> ${escapeHtml(hit.channelName)}
\u251C \u{1F4E6} <b>Peso:</b> <code>${escapeHtml(sizeStr)}</code> \xB7 \u{1F39E}\uFE0F <b>Resoluci\xF3n:</b> <code>${escapeHtml(resStr)}</code>
\u2514 \u{1F441}\uFE0F <b>Vistas:</b> ${hit.views.toLocaleString("es-CU")}` + (durStr ? ` \xB7 \u23F1\uFE0F ${escapeHtml(durStr)}` : "") + (dateStr ? ` \xB7 \u{1F4C5} ${escapeHtml(dateStr)}` : "");
}
async function sendOrEditPictaSearchResultsInTelegram(chatId, messageId, rawQuery, page = 0, replyToMessageId) {
  const cleanQ = rawQuery.trim();
  if (!cleanQ) return;
  let cached = lastPictaSearchResultsByChat.get(chatId);
  let statusMsgId = messageId;
  if (!cached || cached.query.toLowerCase() !== cleanQ.toLowerCase() || Date.now() - cached.fetchedAt > 9e4) {
    const loadingText = `${hudHeader("BUSCADOR GLOBAL DE PICTA")}
\u{1F50E} <i>Buscando "<b>${escapeHtml(cleanQ)}</b>" en todo el cat\xE1logo de Picta y leyendo peso/resoluci\xF3n...</i>`;
    if (statusMsgId) {
      await editTelegramStatusMessage(chatId, statusMsgId, loadingText, void 0, true);
    } else {
      statusMsgId = await sendTelegramStatusMessage(chatId, loadingText, replyToMessageId);
    }
    const searchRes = await searchGlobalPictaCatalog(cleanQ, {
      chatId,
      maxEnrich: 5,
      minScore: 0.2
    });
    cached = {
      query: cleanQ,
      hits: searchRes.hits,
      fetchedAt: Date.now()
    };
    lastPictaSearchResultsByChat.set(chatId, cached);
  }
  const hits = cached.hits;
  const pageSize = 4;
  const totalPages = Math.max(1, Math.ceil(hits.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = hits.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const bodyHtml = slice.length > 0 ? slice.map((h, i) => formatPictaHitEntryHtml(h, safePage * pageSize + i)).join("\n\n") : `\u{1F7E2} <b>Sin resultados en Picta para "<code>${escapeHtml(cleanQ)}</code>".</b>
<i>No se encontraron pel\xEDculas, series ni videos con ese nombre en el cat\xE1logo global de Picta.</i>`;
  const text = `${hudHeader("BUSCADOR GLOBAL DE PICTA")}
` + hudBox([
    `\u{1F50E} <b>Consulta:</b> <code>${escapeHtml(cleanQ)}</code>`,
    `\u{1F4E6} <b>Resultados en toda Picta:</b> <b>${hits.length}</b>` + (totalPages > 1 ? ` \xB7 P\xE1gina ${safePage + 1}/${totalPages}` : "")
  ]) + `
${bodyHtml}`;
  const keyboard = [];
  if (totalPages > 1) {
    const navRow = [];
    if (safePage > 0) {
      navRow.push({ text: "\u2B05\uFE0F Anterior", callback_data: `picta_search_page:${safePage - 1}` });
    }
    if (safePage < totalPages - 1) {
      navRow.push({ text: "Siguiente \u27A1\uFE0F", callback_data: `picta_search_page:${safePage + 1}` });
    }
    if (navRow.length > 0) keyboard.push(navRow);
  }
  keyboard.push([
    { text: "\u{1F50E} Nueva B\xFAsqueda", callback_data: "picta_search:prompt" },
    { text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }
  ]);
  if (statusMsgId) {
    await editTelegramStatusMessage(chatId, statusMsgId, text, keyboard, true);
  } else {
    await sendTelegramStatusMessage(chatId, text, replyToMessageId, keyboard);
  }
}
async function promptDuplicateConfirmationInTelegram(job, chatId, messageId, matches, nextAction) {
  pendingManualTitleByChat.delete(chatId);
  job.stage = "awaiting_duplicate_confirmation";
  job.duplicateCheckNextAction = nextAction;
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  saveJobsToDisk();
  const topMatches = matches.slice(0, 3);
  const matchesHtml = topMatches.map((h, i) => formatPictaHitEntryHtml(h, i)).join("\n\n");
  const text = `${hudHeader("\u26A0\uFE0F POSIBLE CONTENIDO REPETIDO EN PICTA")}
` + hudBox([
    `\u{1F3AC} <b>Tu video:</b> ${escapeHtml(job.title || job.fileName)}`,
    `\u{1F4C2} <b>Categor\xEDa:</b> ${escapeHtml(job.category || "Audiovisual")}`,
    `\u{1F4E6} <b>Tu peso:</b> <code>${formatBytes(job.expectedBytes)}</code>`
  ]) + `
\u{1F6A8} <b>Encontr\xE9 ${matches.length} coincidencia(s) ya publicada(s) en Picta:</b>

${matchesHtml}

\u{1F4A1} <i>Revisa el canal, peso y resoluci\xF3n antes de continuar para evitar sanciones por contenido repetido. \xBFQu\xE9 deseas hacer?</i>`;
  const keyboard = [
    [
      {
        text: "\u26A0\uFE0F Subir de Todas Formas",
        callback_data: `dup_proceed:${job.id}`
      }
    ],
    [
      {
        text: "\u270F\uFE0F Cambiar / Refinar T\xEDtulo",
        callback_data: `dup_edit_title:${job.id}`
      }
    ],
    [
      {
        text: "\u{1F6D1} Cancelar Subida (Ya Existe)",
        callback_data: `cancel_job:${job.id}`
      }
    ]
  ];
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    const sentId = await sendTelegramStatusMessage(chatId, text, job.telegramMessageId, keyboard);
    if (sentId) {
      job.statusMessageId = sentId;
      saveJobsToDisk();
    }
  }
}
async function checkPictaDuplicateAndPromptIfFound(job, chatId, messageId, nextAction) {
  const titleToCheck = String(job.title || job.fileName || "").trim();
  if (!titleToCheck || isRandomOrCrypticFilename(titleToCheck)) {
    return false;
  }
  const normalizedKey = normalizeDuplicateTitleKey(titleToCheck);
  if (job.duplicateCheckApprovedTitle && job.duplicateCheckApprovedTitle === normalizedKey) {
    return false;
  }
  const meta = job.modelMetadata || {};
  const matches = await findLikelyPictaDuplicates(titleToCheck, {
    chatId,
    tipologiaId: Number(job.tipologiaId || 8),
    seasonNum: meta.temporada,
    epNum: meta.numero
  });
  if (matches.length === 0) {
    return false;
  }
  await promptDuplicateConfirmationInTelegram(job, chatId, messageId, matches, nextAction);
  return true;
}
async function proceedFromStep1ToStep2WithDuplicateCheck(job, chatId, messageId) {
  const pausedForDuplicate = await checkPictaDuplicateAndPromptIfFound(
    job,
    chatId,
    messageId,
    "step2"
  );
  if (pausedForDuplicate) return;
  await promptStep2Synopsis(job, chatId, messageId);
}
async function executeAutoUploadAfterDuplicateCheck(job, chatId, messageId) {
  const hasLinkedSerieTitle = job.tipologiaId === 5 && Boolean(job.modelMetadata?.serie) && !isGenericOrInvalidSerieName(String(job.modelMetadata?.serie || "")) && Boolean(job.title);
  job.titleMode = hasLinkedSerieTitle ? "manual" : "auto";
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  saveJobsToDisk();
  if (!job.preferredUploadAccountKey && getPoolAccountsForChat(chatId).length > 0) {
    await promptUploadAccountSelection(job, chatId, messageId);
    return;
  }
  job.stage = "generating_auto_title";
  currentActivity = `Autorrellenando todo para "${job.fileName}" (${job.category || "Audiovisual"})...`;
  saveJobsToDisk();
  const autoStartText = `\u26A1 <b>Autorrellenando ficha de ${escapeHtml(job.category || "Audiovisual")} e iniciando subida...</b>
<blockquote>\u{1F4C4} <code>${escapeHtml(job.fileName)}</code> (${formatBytes(job.expectedBytes)})` + (hasLinkedSerieTitle ? `
\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}` : "") + `</blockquote>`;
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, autoStartText, void 0, true);
  } else {
    const sentId = await sendTelegramStatusMessage(chatId, autoStartText, job.telegramMessageId);
    if (sentId) {
      job.statusMessageId = sentId;
      saveJobsToDisk();
    }
  }
  await triggerCloudRunKeepAliveTransfer(job.id, hasLinkedSerieTitle ? job.title : "", job.statusMessageId || messageId);
}
async function executePinnedSerieUploadAfterDuplicateCheck(job, chatId, messageId) {
  if (getPoolAccountsForChat(chatId).length > 0 && !job.preferredUploadAccountKey) {
    await promptUploadAccountSelection(job, chatId, messageId);
    return;
  }
  const userChannelCtx = getEffectivePictaContext(chatId);
  const pinnedSerie = pinnedBatchSerieByChat.get(chatId);
  const targetSeason = String(job.modelMetadata?.temporada || pinnedSerie?.seasonNum || "1");
  const targetEp = String(job.modelMetadata?.numero || "1");
  const serieLabel = String(job.modelMetadata?.serie || pinnedSerie?.serieName || "Serie");
  const isQueuing = isTransferJobRunningOrProcessing(job.id);
  const autoKb = [
    [{ text: "\u{1F6D1} Cancelar este cap\xEDtulo", callback_data: `cancel_job:${job.id}` }],
    [
      { text: "\u{1F4CB} Ver Cola (/cola)", callback_data: "queue_view" },
      { text: "\u{1F513} Desactivar Serie Fija", callback_data: "unpin_serie" }
    ]
  ];
  const batchMsgText = `\u{1F4CC} <b>MODO SERIE FIJA \xB7 CAP\xCDTULO DETECTADO AUTOM\xC1TICAMENTE</b>
<blockquote>\u{1F4FA} <b>Serie:</b> ${escapeHtml(serieLabel)} (T${escapeHtml(targetSeason)}:E${escapeHtml(targetEp.padStart(2, "0"))})
\u{1F3AC} <b>T\xEDtulo final:</b> <code>${escapeHtml(job.title)}</code>
\u{1F4DD} <b>Sinopsis:</b> ${escapeHtml((job.synopsis || "").slice(0, 110))}
\u{1F4E6} <b>Tama\xF1o:</b> ${formatBytes(job.expectedBytes)} \xB7 \u{1F5BC}\uFE0F <b>Portada:</b> Oficial de la serie</blockquote>
` + (isQueuing ? `\u23F3 <i>Hay una subida en curso: este cap\xEDtulo se ha puesto en la <b>cola autom\xE1tica</b> y empezar\xE1 solo al terminar el anterior.</i>` : `\u{1F680} <i>Iniciando descarga MTProto 2 GB y subida autom\xE1tica a ${escapeHtml(userChannelCtx.channelName)} (#${escapeHtml(userChannelCtx.channelId)})...</i>`);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, batchMsgText, autoKb, true);
  } else {
    const sentAutoId = await sendTelegramStatusMessage(
      chatId,
      batchMsgText,
      job.telegramMessageId,
      autoKb
    );
    if (sentAutoId) {
      job.statusMessageId = sentAutoId;
      saveJobsToDisk();
    }
  }
  await triggerCloudRunKeepAliveTransfer(job.id, job.title, job.statusMessageId || messageId);
}
async function deletePictaCommentInChannel(chatId, commentId) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const ctx = getEffectivePictaContext(effectiveChatId);
  const token = await ctx.accessTokenPromise;
  const res = await fetchPictaWithRetry(
    `https://api.picta.cu/v1/comentario/${encodeURIComponent(String(commentId))}/`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      }
    }
  );
  if (!res.ok && res.status !== 204) {
    const errTxt = await res.text();
    throw new Error(formatPictaError(res.status, errTxt));
  }
  invalidateChannelCommentsCache();
}
function loadAlertsStateFromDisk() {
  try {
    if (fs3.existsSync(ALERTS_STATE_FILE)) {
      const parsed = JSON.parse(fs3.readFileSync(ALERTS_STATE_FILE, "utf-8"));
      if (parsed && typeof parsed === "object") {
        const prefsByChat = {};
        if (parsed.prefsByChat && typeof parsed.prefsByChat === "object") {
          for (const [k, v] of Object.entries(parsed.prefsByChat)) {
            prefsByChat[String(k)] = normalizeAlertPreferences(v);
          }
        }
        return {
          prefsByChat,
          channelStates: parsed.channelStates && typeof parsed.channelStates === "object" ? parsed.channelStates : {},
          replyTargets: parsed.replyTargets && typeof parsed.replyTargets === "object" ? parsed.replyTargets : {}
        };
      }
    }
  } catch {
  }
  return { prefsByChat: {}, channelStates: {}, replyTargets: {} };
}
var alertsState = loadAlertsStateFromDisk();
function saveAlertsStateToDisk() {
  try {
    const replyEntries = Object.entries(alertsState.replyTargets);
    if (replyEntries.length > 400) {
      alertsState.replyTargets = Object.fromEntries(replyEntries.slice(-400));
    }
    fs3.writeFileSync(ALERTS_STATE_FILE, JSON.stringify(alertsState, null, 2), "utf-8");
    mirrorFileToLegacyDataDir(ALERTS_STATE_FILE, "picta_alerts_state.json");
  } catch {
  }
}
function getChatAlertPreferences(chatId) {
  if (!alertsState.prefsByChat[chatId]) {
    alertsState.prefsByChat[chatId] = getDefaultAlertPreferences();
  }
  return alertsState.prefsByChat[chatId];
}
function getChannelAlertState(chatId, channelId) {
  const key = `${chatId}:${channelId}`;
  if (!alertsState.channelStates[key]) {
    alertsState.channelStates[key] = {
      baselineInitialized: false,
      seenCommentIds: [],
      pubSnapshots: {}
    };
  }
  return alertsState.channelStates[key];
}
var alertsScannerBusy = false;
async function scanPictaAlertsAndMilestonesForTarget(chatId, channelId, channelName, token, ownUserId, ownUsername) {
  const prefs = getChatAlertPreferences(chatId);
  const state = getChannelAlertState(chatId, channelId);
  const wasInitialized = state.baselineInitialized;
  const pubs = [];
  let nextUrl = `https://api.picta.cu/v2/publicacion/?canal_id=${encodeURIComponent(channelId)}&page_size=50`;
  for (let p = 0; p < 2 && nextUrl; p++) {
    const pubRes = await fetchPictaWithRetry(nextUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu"
      }
    }).catch(() => null);
    if (!pubRes || !pubRes.ok) break;
    const pubData = await pubRes.json().catch(() => null);
    if (!pubData) break;
    const batch = Array.isArray(pubData.results) ? pubData.results : [];
    pubs.push(...batch);
    nextUrl = typeof pubData.next === "string" && pubData.next.startsWith("http") ? pubData.next : null;
  }
  if (pubs.length === 0) {
    return { newComments: 0, newMilestones: 0 };
  }
  let newMilestones = 0;
  const pubIdsWithCommentGrowth = [];
  for (const rawPub of pubs) {
    const pubId = Number(rawPub?.id || 0);
    if (!pubId) continue;
    const prevSnap = state.pubSnapshots[String(pubId)];
    const { nextSnapshot, events } = evaluatePublicationMilestones({
      pub: {
        id: pubId,
        nombre: String(rawPub.nombre || `Video #${pubId}`),
        cantidad_reproducciones: Number(rawPub.cantidad_reproducciones || 0),
        cantidad_me_gusta: Number(rawPub.cantidad_me_gusta || 0),
        cantidad_descargas: Number(rawPub.cantidad_descargas || 0),
        cantidad_comentarios: Number(rawPub.cantidad_comentarios || 0),
        cantidad_visitas: Number(rawPub.cantidad_visitas || 0)
      },
      prefs,
      prevSnapshot: prevSnap,
      baselineInitialized: wasInitialized
    });
    const prevCommentCount = prevSnap ? Number(prevSnap.commentCount || 0) : 0;
    if (nextSnapshot.commentCount > prevCommentCount || !prevSnap && nextSnapshot.commentCount > 0) {
      pubIdsWithCommentGrowth.push(pubId);
    }
    state.pubSnapshots[String(pubId)] = nextSnapshot;
    for (const ev of events) {
      newMilestones++;
      const crossedBadge = ev.crossedThresholds.length > 1 ? ` (superando tambi\xE9n: ${ev.crossedThresholds.slice(0, -1).map(formatMilestoneNumber).join(", ")})` : "";
      const alertText = `${hudHeader(`LOGRO ALCANZADO \xB7 ${channelName}`)}
` + hudBox([
        `\u{1F3AC} <b>Video:</b> ${escapeHtml(ev.pubTitle)}`,
        `${ev.metricIcon} <b>Meta superada:</b> <b>${formatMilestoneNumber(ev.threshold)} ${escapeHtml(ev.metricLabel)}</b>${escapeHtml(crossedBadge)}`,
        `\u{1F4CA} <b>Valor actual:</b> <b>${formatMilestoneNumber(ev.currentValue)}</b>`
      ]) + `
${hudSection("M\xE9tricas en Tiempo Real")}
` + hudBox([
        `\u25B6\uFE0F Reprod.: <b>${formatMilestoneNumber(ev.statsSummary.plays)}</b> \xB7 \u2764\uFE0F Likes: <b>${formatMilestoneNumber(ev.statsSummary.likes)}</b>`,
        `\u{1F4E5} Descargas: <b>${formatMilestoneNumber(ev.statsSummary.downloads)}</b> \xB7 \u{1F4AC} Comentarios: <b>${formatMilestoneNumber(ev.statsSummary.comments)}</b>`
      ]);
      await sendTelegramStatusMessage(chatId, alertText, void 0, [
        [
          {
            text: "\u{1F4CA} Editar / Ver Video",
            callback_data: `dash_pub:${ev.pubId}:views:0`
          },
          {
            text: "\u{1F310} Ver en Picta Web",
            url: `https://www.picta.cu/medias/${ev.pubId}`
          }
        ],
        [
          {
            text: "\u{1F3C6} Configurar Metas (/logros)",
            callback_data: "alerts_menu"
          }
        ]
      ]);
    }
  }
  const pubMapById = /* @__PURE__ */ new Map();
  for (const p of pubs) {
    if (p?.id) pubMapById.set(Number(p.id), String(p.nombre || `Video #${p.id}`));
  }
  const targetPubIds = Array.from(
    /* @__PURE__ */ new Set([
      ...pubIdsWithCommentGrowth.slice(0, 6),
      ...pubs.slice(0, wasInitialized ? 3 : 6).map((p) => Number(p?.id || 0))
    ])
  ).filter((id) => id > 0);
  const collectedRawComments = [];
  if (targetPubIds.length > 0) {
    const perPub = await Promise.all(
      targetPubIds.map(async (pid) => {
        const cRes = await fetchPictaWithRetry(
          `https://api.picta.cu/v2/comentario/?publicacion_id=${pid}&page_size=20`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Origin: "https://admin.picta.cu"
            }
          }
        ).catch(() => null);
        if (!cRes || !cRes.ok) return [];
        const cJson = await cRes.json().catch(() => null);
        const list = Array.isArray(cJson) ? cJson : cJson?.results || [];
        return list.map((item) => ({
          ...item,
          publicacion: {
            id: pid,
            nombre: pubMapById.get(pid) || item?.publicacion?.nombre || `Video #${pid}`,
            canal: { id: Number(channelId) }
          }
        }));
      })
    );
    collectedRawComments.push(...perPub.flat());
  }
  const globalCmRes = await fetchPictaWithRetry(
    `https://api.picta.cu/v2/comentario/?page_size=35`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu"
      }
    }
  ).catch(() => null);
  if (globalCmRes && globalCmRes.ok) {
    const gJson = await globalCmRes.json().catch(() => null);
    const gList = Array.isArray(gJson) ? gJson : gJson?.results || [];
    collectedRawComments.push(...gList);
  }
  const channelComments = filterChannelComments(collectedRawComments, channelId);
  const mappedComments = channelComments.map((c) => ({
    id: Number(c.id),
    texto: String(c.texto || "").trim(),
    usuario: String(c.usuario || "Usuario").trim(),
    fecha: String(c.fecha || ""),
    publicacionId: Number(c.publicacionId || 0),
    publicacionNombre: pubMapById.get(Number(c.publicacionId || 0)) || String(c.publicacionNombre || `Video #${c.publicacionId || 0}`)
  }));
  const { newComments, nextSeenCommentIds } = detectNewChannelComments({
    comments: mappedComments,
    seenCommentIds: state.seenCommentIds,
    baselineInitialized: wasInitialized,
    ownUserId,
    ownUsername
  });
  state.seenCommentIds = nextSeenCommentIds;
  state.baselineInitialized = true;
  let notifiedComments = 0;
  if (prefs.commentsEnabled) {
    for (const nc of newComments) {
      notifiedComments++;
      const dateLabel = nc.fecha ? new Date(nc.fecha).toLocaleString("es-CU", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      }) : "Reciente";
      const msgText = `${hudHeader(`NUEVO COMENTARIO \xB7 ${channelName}`)}
` + hudBox([
        `\u{1F3AC} <b>Video:</b> ${escapeHtml(nc.publicacionNombre)}`,
        `\u{1F464} <b>Autor:</b> <code>@${escapeHtml(nc.usuario)}</code> \xB7 \u{1F552} <i>${escapeHtml(dateLabel)}</i>`,
        `\u{1F4AC} "${escapeHtml(nc.texto.slice(0, 700))}"`
      ]) + `
\u{1F4A1} <i>Responde directo haciendo <b>Reply</b> a este mensaje o pulsando <b>"\u{1F4AC} Responder"</b>.</i>`;
      const sentId = await sendTelegramStatusMessage(chatId, msgText, void 0, [
        [
          {
            text: "\u{1F4AC} Responder",
            callback_data: `comment_reply_prompt:${nc.publicacionId}:${nc.id}`
          },
          {
            text: "\u{1F5D1}\uFE0F Borrar",
            callback_data: `comment_del_alert:${nc.publicacionId}:${nc.id}`
          }
        ],
        [
          {
            text: "\u{1F310} Ver Video en Picta",
            url: `https://www.picta.cu/medias/${nc.publicacionId}`
          }
        ]
      ]);
      if (sentId) {
        alertsState.replyTargets[`${chatId}:${sentId}`] = {
          chatId,
          channelId,
          pubId: nc.publicacionId,
          pubTitle: nc.publicacionNombre,
          commentId: nc.id,
          author: nc.usuario,
          createdAt: (/* @__PURE__ */ new Date()).toISOString()
        };
      }
    }
  }
  saveAlertsStateToDisk();
  return { newComments: notifiedComments, newMilestones };
}
async function scanAllPictaAlertsAndMilestones(onlyChatId) {
  if (alertsScannerBusy && !onlyChatId) {
    return { checked: 0, newComments: 0, newMilestones: 0 };
  }
  alertsScannerBusy = true;
  let checked = 0;
  let totalComments = 0;
  let totalMilestones = 0;
  try {
    const targets = [];
    if (!onlyChatId || isMasterAdminChat(onlyChatId)) {
      const masterCtx = getEffectivePictaContext(MASTER_ADMIN_CHAT_ID);
      if (masterCtx.channelId) {
        targets.push({
          chatId: MASTER_ADMIN_CHAT_ID,
          channelId: masterCtx.channelId,
          channelName: masterCtx.channelName,
          tokenPromise: masterCtx.accessTokenPromise,
          ownUserId: pictaUser?.id,
          ownUsername: pictaUser?.username
        });
      }
    }
    for (const [guestChatId, sess] of userSessions.entries()) {
      if (isMasterAdminChat(guestChatId)) continue;
      if (onlyChatId && guestChatId !== onlyChatId) continue;
      if (!sess.channelId || !sess.authToken) continue;
      const gCtx = getEffectivePictaContext(guestChatId);
      if (!gCtx.isLinked || !gCtx.channelId) continue;
      targets.push({
        chatId: guestChatId,
        channelId: gCtx.channelId,
        channelName: gCtx.channelName,
        tokenPromise: gCtx.accessTokenPromise,
        ownUserId: sess.userId,
        ownUsername: sess.username
      });
    }
    for (const t of targets) {
      try {
        const tok = await t.tokenPromise;
        if (!tok) continue;
        const r = await scanPictaAlertsAndMilestonesForTarget(
          t.chatId,
          t.channelId,
          t.channelName,
          tok,
          t.ownUserId,
          t.ownUsername
        );
        checked++;
        totalComments += r.newComments;
        totalMilestones += r.newMilestones;
      } catch {
      }
    }
  } finally {
    alertsScannerBusy = false;
  }
  return { checked, newComments: totalComments, newMilestones: totalMilestones };
}
async function sendOrEditAlertsMilestonesMenuInTelegram(chatId, messageId, replyToMessageId, notice) {
  pendingToolkitInputByChat.delete(chatId);
  const isMaster = isMasterAdminChat(chatId);
  const session = userSessions.get(chatId);
  if (!isMaster && !session?.channelId) {
    const text2 = `${hudHeader("LOGROS Y ALERTAS \xB7 ACCESO REQUERIDO")}
` + hudBox([
      `\u{1F512} <b>Estado:</b> Cuenta de Picta sin vincular`,
      `\u{1F449} Para recibir notificaciones de comentarios nuevos y logros de tus videos, primero vincula tu cuenta con /login.`
    ]);
    const keyboard2 = [
      [{ text: "\u{1F511} Iniciar Sesi\xF3n (/login)", callback_data: "cmd_login" }],
      [{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]
    ];
    if (messageId) {
      await editTelegramStatusMessage(chatId, messageId, text2, keyboard2, true);
    } else {
      await sendTelegramStatusMessage(chatId, text2, replyToMessageId, keyboard2);
    }
    return;
  }
  const ctx = getEffectivePictaContext(chatId);
  const prefs = getChatAlertPreferences(chatId);
  const state = getChannelAlertState(chatId, ctx.channelId);
  const trackedVideosCount = Object.keys(state.pubSnapshots || {}).length;
  const text = (notice ? `${notice}

` : "") + `${hudHeader(`LOGROS Y ALERTAS \xB7 ${ctx.channelName}`)}
` + hudBox([
    `\u{1F4FA} <b>Canal vigilado:</b> ${escapeHtml(ctx.channelName)} \xB7 <code>#${escapeHtml(ctx.channelId)}</code>`,
    `\u{1F4AC} <b>Alertas de Comentarios:</b> ${prefs.commentsEnabled ? "\u{1F7E2} Activadas (Reply directo)" : "\u26AA Desactivadas"}`,
    `\u{1F3C6} <b>Notificaciones de Logros:</b> ${prefs.milestonesEnabled ? "\u{1F7E2} Activadas" : "\u26AA Desactivadas"}`,
    `\u{1F4E1} <b>Videos monitoreados:</b> ${trackedVideosCount > 0 ? trackedVideosCount : "Se inicializar\xE1 en la pr\xF3xima revisi\xF3n"}`
  ]) + `
${hudSection("M\xE9tricas Vigiladas")}
` + hudBox([
    `\u25B6\uFE0F <b>Reproducciones:</b> ${prefs.enabledMetrics.plays ? "\u{1F7E2} Activa" : "\u26AA Pausada"}`,
    `\u2764\uFE0F <b>Likes:</b> ${prefs.enabledMetrics.likes ? "\u{1F7E2} Activa" : "\u26AA Pausada"}`,
    `\u{1F4E5} <b>Descargas:</b> ${prefs.enabledMetrics.downloads ? "\u{1F7E2} Activa" : "\u26AA Pausada"}`,
    `\u{1F4AC} <b>Comentarios:</b> ${prefs.enabledMetrics.comments ? "\u{1F7E2} Activa" : "\u26AA Pausada"}`,
    `\u{1F440} <b>Vistas:</b> \u{1F6AB} <i>Excluida permanentemente</i>`
  ]) + `
${hudSection("Metas Progresivas Actuales")}
<code>${prefs.thresholds.map(formatMilestoneNumber).join(" \xB7 ")}</code>`;
  const keyboard = [
    [
      {
        text: prefs.commentsEnabled ? "\u{1F4AC} Comentarios: \u{1F7E2} ON" : "\u{1F4AC} Comentarios: \u26AA OFF",
        callback_data: "alerts_toggle_comments"
      },
      {
        text: prefs.milestonesEnabled ? "\u{1F3C6} Logros: \u{1F7E2} ON" : "\u{1F3C6} Logros: \u26AA OFF",
        callback_data: "alerts_toggle_milestones"
      }
    ],
    [
      {
        text: `${prefs.enabledMetrics.plays ? "\u2705" : "\u2B1C"} \u25B6\uFE0F Reprod.`,
        callback_data: "alerts_toggle_metric:plays"
      },
      {
        text: `${prefs.enabledMetrics.likes ? "\u2705" : "\u2B1C"} \u2764\uFE0F Likes`,
        callback_data: "alerts_toggle_metric:likes"
      }
    ],
    [
      {
        text: `${prefs.enabledMetrics.downloads ? "\u2705" : "\u2B1C"} \u{1F4E5} Descargas`,
        callback_data: "alerts_toggle_metric:downloads"
      },
      {
        text: `${prefs.enabledMetrics.comments ? "\u2705" : "\u2B1C"} \u{1F4AC} Comentarios`,
        callback_data: "alerts_toggle_metric:comments"
      }
    ],
    [
      {
        text: "\u270F\uFE0F Editar Metas Progresivas",
        callback_data: "alerts_edit_thresholds"
      },
      {
        text: "\u267B\uFE0F Metas por Defecto",
        callback_data: "alerts_reset_thresholds"
      }
    ],
    [
      {
        text: "\u{1F504} Revisar Comentarios y Logros Ahora",
        callback_data: "alerts_scan_now"
      }
    ],
    [
      { text: "\u{1F3DB}\uFE0F Volver a /canal", callback_data: "chan_editor:open" },
      { text: "\u{1F519} Men\xFA Principal", callback_data: "cmd_start" }
    ]
  ];
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    await sendTelegramStatusMessage(chatId, text, replyToMessageId, keyboard);
  }
}
async function sendOrEditAccountDiagnosticInTelegram(chatId, messageId, replyToMessageId) {
  const isMaster = isMasterAdminChat(chatId);
  if (isMaster) {
    const text2 = `${hudHeader("CUENTA PRINCIPAL \xB7 MULTIVERSO VISUAL")}
` + hudBox([
      `\u{1F464} <b>Administrador:</b> <code>@ghosthell0210</code> (+5356942234)`,
      `\u{1F4FA} <b>Canal Oficial:</b> Multiverso Visual \xB7 <code>#36319</code>`,
      `\u{1F6E1}\uFE0F <b>Rol Picta:</b> Jefe de canal (Activo)`,
      `\u{1F511} <b>Estado:</b> Conectado \xB7 Credenciales maestras`
    ]) + `
${hudSection("Comandos de Administraci\xF3n")}
` + hudBox([
      `<code>/canal</code> \xB7 Editar nombre, lema, descripci\xF3n, avatar y portada`,
      `<code>/logros</code> \xB7 Alertas de comentarios y metas progresivas`,
      `<code>/usuarios</code> \xB7 Lista de usuarios autorizados`
    ]);
    const kb = [
      [{ text: "\u{1F3DB}\uFE0F Editar mi Canal (/canal)", callback_data: "chan_editor:open" }],
      [{ text: "\u{1F3C6} Logros y Alertas (/logros)", callback_data: "alerts_menu" }],
      [{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]
    ];
    if (messageId) {
      await editTelegramStatusMessage(chatId, messageId, text2, kb, true);
    } else {
      await sendTelegramStatusMessage(chatId, text2, replyToMessageId, kb);
    }
    return;
  }
  await ensureGuestSessionChannelDiscovered(chatId, true);
  const session = userSessions.get(chatId);
  if (!session) {
    const text2 = `${hudHeader("CUENTA DE PICTA \xB7 SIN VINCULAR")}
` + hudBox([
      `\u26AA <b>Estado:</b> No hay sesi\xF3n vinculada en este chat`,
      `\u{1F449} Para subir videos directo a tu canal de Picta, inicia sesi\xF3n abajo.`
    ]);
    const kb = [
      [{ text: "\u{1F511} Iniciar Sesi\xF3n en Picta (/login)", callback_data: "user_picta_login_start" }],
      [{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]
    ];
    if (messageId) {
      await editTelegramStatusMessage(chatId, messageId, text2, kb, true);
    } else {
      await sendTelegramStatusMessage(chatId, text2, replyToMessageId, kb);
    }
    return;
  }
  let liveGroups = session.pictaGroups || [];
  let hasAdminRole = session.hasChannelAdminRole;
  let liveWriteCheckText = "\u23F3 Sin verificar";
  let liveUsername = session.username;
  try {
    const ctx = getEffectivePictaContext(chatId);
    const tok = await ctx.accessTokenPromise;
    const meObj = await fetchDecryptedPictaMe2(tok);
    if (meObj) {
      liveUsername = String(meObj.username || session.username);
      const grp = extractPictaGroupSummary(meObj);
      liveGroups = grp.groupNames;
      hasAdminRole = grp.hasChannelAdminRole;
      session.pictaGroups = grp.groupNames;
      session.hasChannelAdminRole = grp.hasChannelAdminRole;
      saveUserSessionsToDisk();
    }
    const valRes = await fetchPictaWithRetry("https://api.picta.cu/v1/publicacion/validar_campos/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      },
      body: new FormData()
    }).catch(() => null);
    if (valRes) {
      if (valRes.status === 403) {
        liveWriteCheckText = "\u{1F534} Bloqueado (HTTP 403 en Picta \xB7 falta rol Jefe de canal)";
        hasAdminRole = false;
      } else {
        liveWriteCheckText = "\u{1F7E2} Activo (Permiso de publicaci\xF3n habilitado)";
      }
    }
  } catch {
    liveWriteCheckText = "\u26A0\uFE0F No se pudo comprobar en vivo con Picta";
  }
  const roleDiag = hasAdminRole === false ? `

${buildPictaRoleDiagnosticLines({
    username: liveUsername,
    groupNames: liveGroups,
    hasChannelAdminRole: false,
    channelName: session.channelName,
    channelId: session.channelId
  })}` : "";
  const channelButtons = (session.availableChannels || []).slice(0, 6).map((c) => [
    {
      text: `\u{1F4FA} ${c.nombre} (#${c.id})`,
      callback_data: `user_channel_pick:${c.id}`
    }
  ]);
  channelButtons.push([
    { text: "\u{1F504} Re-verificar en Picta", callback_data: "cmd_cuenta" },
    { text: "\u{1F3C6} Alertas (/logros)", callback_data: "alerts_menu" }
  ]);
  channelButtons.push([{ text: "\u{1F3DB}\uFE0F Editar mi Canal (/canal)", callback_data: "chan_editor:open" }]);
  channelButtons.push([{ text: "\u{1F6AA} Cerrar Sesi\xF3n (/logout)", callback_data: "user_picta_logout" }]);
  const text = `${hudHeader("DIAGN\xD3STICO DE CUENTA EN VIVO")}
` + hudBox([
    `\u{1F464} <b>Titular:</b> ${escapeHtml(session.userFullName || session.username)} (<code>${escapeHtml(liveUsername)}</code>)`,
    `\u{1F4FA} <b>Canal Activo:</b> ${session.channelId ? `${escapeHtml(session.channelName)} \xB7 <code>#${escapeHtml(session.channelId)}</code>` : "Sin canal asignado"}`,
    `\u{1F6E1}\uFE0F <b>Grupos Picta:</b> ${liveGroups.length > 0 ? escapeHtml(liveGroups.join(", ")) : "Por verificar"}`,
    `\u{1F510} <b>Permiso Publicaci\xF3n:</b> ${liveWriteCheckText}`
  ]) + roleDiag + (!session.channelId ? `
\u{1F4A1} Si tu cuenta tiene un canal aprobado y a\xFAn no aparece, pega su enlace con <code>/canal https://www.picta.cu/canal/tu-canal</code>.` : "");
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, channelButtons, true);
  } else {
    await sendTelegramStatusMessage(chatId, text, replyToMessageId, channelButtons);
  }
}
var lastCommentsViewByChat = /* @__PURE__ */ new Map();
function getCategoryIconForComments(catName) {
  const s = catName.toLowerCase();
  if (s.includes("pel")) return "\u{1F3AC}";
  if (s.includes("ser") || s.includes("cap")) return "\u{1F4FA}";
  if (s.includes("doc")) return "\u{1F39E}\uFE0F";
  if (s.includes("mus") || s.includes("clip")) return "\u{1F3B5}";
  if (s.includes("hum")) return "\u{1F602}";
  if (s.includes("short")) return "\u26A1";
  if (s.includes("dep")) return "\u26BD";
  if (s.includes("game")) return "\u{1F3AE}";
  return "\u{1F4F9}";
}
function getCommentCatKey(c) {
  if (c.tipologiaId && c.tipologiaId > 0) return `tip_${c.tipologiaId}`;
  const clean = String(c.categoriaNombre || "Otros").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10);
  return `cat_${clean || "otros"}`;
}
async function sendOrEditCommentsMenuInTelegram(chatId, messageId, pubId, replyToMessageId, notice, options) {
  pendingToolkitInputByChat.delete(chatId);
  const isMaster = isMasterAdminChat(chatId);
  const session = userSessions.get(chatId);
  if (!isMaster && !session?.channelId) {
    const text2 = `${hudHeader("DASHBOARD DE COMENTARIOS \xB7 ACCESO REQUERIDO")}
` + hudBox([
      `\u{1F512} <b>Estado:</b> Cuenta de Picta sin vincular`,
      `\u{1F449} Para moderar y responder comentarios en los videos de tu propio canal, vincula tu cuenta con /login.`
    ]);
    const keyboard2 = [
      [{ text: "\u{1F511} Iniciar Sesi\xF3n (/login)", callback_data: "cmd_login" }],
      [{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]
    ];
    if (messageId) {
      await editTelegramStatusMessage(chatId, messageId, text2, keyboard2, true);
    } else {
      await sendTelegramStatusMessage(chatId, text2, replyToMessageId, keyboard2);
    }
    return;
  }
  const ctx = getEffectivePictaContext(chatId);
  const effectivePubId = pubId && pubId > 0 ? pubId : 0;
  const catKey = options?.catKey || "all";
  const sortMode = options?.sort || "recent";
  const reqPage = Math.max(0, options?.page || 0);
  const { comments: allComments, denuncias } = await fetchChannelCommentsAndDenunciasInPicta(
    chatId,
    effectivePubId > 0 ? effectivePubId : void 0,
    Boolean(options?.forceRefresh)
  ).catch(() => ({
    comments: [],
    denuncias: {
      cantidad_pendientes: 0,
      cantidad_en_proceso: 0,
      cantidad_no_proceden: 0,
      cantidad_procesadas: 0,
      total: 0
    }
  }));
  const categoryStats = /* @__PURE__ */ new Map();
  let unansweredCount = 0;
  let repliesCount = 0;
  let rootCount = 0;
  for (const c of allComments) {
    if (c.parentId) {
      repliesCount++;
    } else {
      rootCount++;
      if (!c.replyCount || c.replyCount === 0) {
        unansweredCount++;
      }
    }
    const k = getCommentCatKey(c);
    const label = String(c.categoriaNombre || "Otros").trim() || "Otros";
    const existing = categoryStats.get(k);
    if (existing) {
      existing.count++;
    } else {
      categoryStats.set(k, {
        key: k,
        label,
        icon: getCategoryIconForComments(label),
        count: 1
      });
    }
  }
  const sortedCategories = Array.from(categoryStats.values()).sort((a, b) => b.count - a.count);
  const isKnownDynamicCat = sortedCategories.some((x) => x.key === catKey);
  const effectiveCatKey = catKey === "all" || catKey === "unans" || catKey === "rep" || isKnownDynamicCat ? catKey : "all";
  let filtered = allComments.filter((c) => {
    if (effectiveCatKey === "all") return true;
    if (effectiveCatKey === "unans") return !c.parentId && (!c.replyCount || c.replyCount === 0);
    if (effectiveCatKey === "rep") return Boolean(c.parentId);
    return getCommentCatKey(c) === effectiveCatKey;
  });
  filtered = [...filtered].sort((a, b) => {
    const tA = a.fecha ? new Date(a.fecha).getTime() : 0;
    const tB = b.fecha ? new Date(b.fecha).getTime() : 0;
    const vA = Number.isFinite(tA) && tA > 0 ? tA : a.id;
    const vB = Number.isFinite(tB) && tB > 0 ? tB : b.id;
    if (sortMode === "oldest") {
      return vA !== vB ? vA - vB : a.id - b.id;
    }
    if (sortMode === "video") {
      const cmp = a.publicacionNombre.localeCompare(b.publicacionNombre, "es");
      if (cmp !== 0) return cmp;
      return vB !== vA ? vB - vA : b.id - a.id;
    }
    return vB !== vA ? vB - vA : b.id - a.id;
  });
  const PAGE_SIZE = 5;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(reqPage, totalPages - 1));
  const pageItems = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  lastCommentsViewByChat.set(chatId, {
    catKey: effectiveCatKey,
    sort: sortMode,
    page: safePage,
    pubId: effectivePubId
  });
  const activeCategoryObj = sortedCategories.find((x) => x.key === effectiveCatKey);
  const activeCategoryLabel = effectiveCatKey === "all" ? "\u{1F310} Todos" : effectiveCatKey === "unans" ? "\u23F3 Sin Respuesta" : effectiveCatKey === "rep" ? "\u21A9\uFE0F Respuestas" : activeCategoryObj ? `${activeCategoryObj.icon} ${activeCategoryObj.label}` : "\u{1F310} Todos";
  const sortLabels = {
    recent: "\u{1F552} M\xE1s Recientes",
    oldest: "\u{1F570}\uFE0F M\xE1s Antiguos",
    video: "\u{1F3AC} Por Video"
  };
  const categoryBreakdownLine = sortedCategories.length > 0 ? sortedCategories.slice(0, 12).map((cat) => `${cat.icon} ${escapeHtml(cat.label)}: <b>${cat.count}</b>`).join(" \xB7 ") : "<i>Sin categor\xEDas con comentarios</i>";
  const commentLines = pageItems.length > 0 ? pageItems.map((c, idx) => {
    const rank = safePage * PAGE_SIZE + idx + 1;
    const catIcon = getCategoryIconForComments(c.categoriaNombre || "Otros");
    const catLabel = escapeHtml(c.categoriaNombre || "Otros");
    const statusBadge = c.parentId ? "\u21A9\uFE0F <i>Respuesta</i>" : c.replyCount && c.replyCount > 0 ? `\u2705 <i>${c.replyCount} resp.</i>` : "\u23F3 <i>Sin resp.</i>";
    const dateStr = c.fecha ? (() => {
      try {
        const d = new Date(c.fecha);
        return isNaN(d.getTime()) ? c.fecha : d.toLocaleString("es-CU", {
          timeZone: "America/Havana",
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        });
      } catch {
        return c.fecha;
      }
    })() : `#${c.id}`;
    return `<b>${rank}.</b> \u{1F464} <code>@${escapeHtml(c.usuario)}</code> \xB7 ${statusBadge} \xB7 \u{1F4C5} <code>${escapeHtml(dateStr)}</code>
   ${catIcon} <b>${catLabel}</b> \xB7 <i>${escapeHtml(c.publicacionNombre.slice(0, 34))}</i>
<blockquote>\u{1F4AC} "${escapeHtml(c.texto.slice(0, 170))}"</blockquote>`;
  }).join("\n\n") : effectiveCatKey === "all" ? "<i>\u2728 No hay comentarios registrados en tu canal todav\xEDa.</i>" : `<i>\u2728 No hay comentarios en la categor\xEDa "${escapeHtml(activeCategoryLabel)}".</i>`;
  const text = (notice ? `${notice}

` : "") + `${hudHeader(`DASHBOARD DE COMENTARIOS \xB7 ${ctx.channelName}`)}
` + hudBox([
    `\u{1F4FA} <b>Canal:</b> ${escapeHtml(ctx.channelName)} \xB7 <code>#${escapeHtml(ctx.channelId)}</code>${effectivePubId > 0 ? ` \xB7 \u{1F3AC} <b>Video #${effectivePubId}</b>` : ""}`,
    `\u{1F4AC} <b>Total:</b> <b>${allComments.length}</b> \xB7 \u{1F5E3}\uFE0F <b>Principales:</b> ${rootCount} \xB7 \u23F3 <b>Sin resp.:</b> ${unansweredCount} \xB7 \u21A9\uFE0F <b>Resp.:</b> ${repliesCount}`,
    `\u{1F3F7}\uFE0F <b>Categor\xEDas:</b> ${categoryBreakdownLine}`,
    `\u{1F6A8} <b>Denuncias:</b> Pendientes <code>${denuncias.cantidad_pendientes}</code> \xB7 En proceso <code>${denuncias.cantidad_en_proceso}</code> \xB7 Procesadas <code>${denuncias.cantidad_procesadas}</code>`
  ]) + `
${hudSection(`${activeCategoryLabel} \xB7 ${sortLabels[sortMode]} \xB7 P\xE1g. ${safePage + 1}/${totalPages} (${filtered.length} mostrados)`)}

${commentLines}`;
  const keyboard = [];
  if (effectivePubId > 0) {
    keyboard.push([
      {
        text: "\u270D\uFE0F Comentar en este Video",
        callback_data: `comment_reply_prompt:${effectivePubId}:0`
      },
      {
        text: `\u{1F310} Ver Todos del Canal`,
        callback_data: `cm_d:all:${sortMode}:0:0`
      }
    ]);
  }
  keyboard.push([
    {
      text: `${effectiveCatKey === "all" ? "\u2705 " : ""}\u{1F310} Todos (${allComments.length})`,
      callback_data: `cm_d:all:${sortMode}:0:${effectivePubId}`
    },
    {
      text: `${effectiveCatKey === "unans" ? "\u2705 " : ""}\u23F3 Sin Resp. (${unansweredCount})`,
      callback_data: `cm_d:unans:${sortMode}:0:${effectivePubId}`
    },
    {
      text: `${effectiveCatKey === "rep" ? "\u2705 " : ""}\u21A9\uFE0F Respuestas (${repliesCount})`,
      callback_data: `cm_d:rep:${sortMode}:0:${effectivePubId}`
    }
  ]);
  if (sortedCategories.length > 0) {
    const catButtons = sortedCategories.slice(0, 12).map((cat) => ({
      text: `${effectiveCatKey === cat.key ? "\u2705 " : ""}${cat.icon} ${cat.label.slice(0, 12)} (${cat.count})`,
      callback_data: `cm_d:${cat.key}:${sortMode}:0:${effectivePubId}`
    }));
    for (let i = 0; i < catButtons.length; i += 3) {
      keyboard.push(catButtons.slice(i, i + 3));
    }
  }
  keyboard.push([
    {
      text: `${sortMode === "recent" ? "\u2705 " : ""}\u{1F552} Recientes`,
      callback_data: `cm_d:${effectiveCatKey}:recent:0:${effectivePubId}`
    },
    {
      text: `${sortMode === "oldest" ? "\u2705 " : ""}\u{1F570}\uFE0F Antiguos`,
      callback_data: `cm_d:${effectiveCatKey}:oldest:0:${effectivePubId}`
    },
    {
      text: `${sortMode === "video" ? "\u2705 " : ""}\u{1F3AC} Por Video`,
      callback_data: `cm_d:${effectiveCatKey}:video:0:${effectivePubId}`
    }
  ]);
  pageItems.forEach((c, idx) => {
    const rank = safePage * PAGE_SIZE + idx + 1;
    keyboard.push([
      {
        text: `\u21A9\uFE0F Responder #${rank} (@${c.usuario.slice(0, 12)})`,
        callback_data: `comment_reply_prompt:${c.publicacionId || effectivePubId || 0}:${c.id}`
      },
      {
        text: `\u{1F5D1}\uFE0F Borrar #${rank}`,
        callback_data: `comment_del:${c.id}:${effectivePubId}`
      }
    ]);
  });
  if (totalPages > 1) {
    const navRow = [];
    if (safePage > 0) {
      navRow.push({
        text: "\u2B05\uFE0F Anterior",
        callback_data: `cm_d:${effectiveCatKey}:${sortMode}:${safePage - 1}:${effectivePubId}`
      });
    }
    navRow.push({
      text: `\u{1F4C4} ${safePage + 1} / ${totalPages}`,
      callback_data: `cm_r:${effectiveCatKey}:${sortMode}:${safePage}:${effectivePubId}`
    });
    if (safePage < totalPages - 1) {
      navRow.push({
        text: "Siguiente \u27A1\uFE0F",
        callback_data: `cm_d:${effectiveCatKey}:${sortMode}:${safePage + 1}:${effectivePubId}`
      });
    }
    keyboard.push(navRow);
  }
  keyboard.push([
    {
      text: "\u{1F504} Actualizar Comentarios",
      callback_data: `cm_r:${effectiveCatKey}:${sortMode}:${safePage}:${effectivePubId}`
    },
    effectivePubId > 0 ? {
      text: "\u2B05\uFE0F Volver al Video",
      callback_data: `dash_pub:${effectivePubId}:views:0`
    } : {
      text: "\u{1F3DB}\uFE0F Estudio /canal",
      callback_data: "chan_editor:open"
    }
  ]);
  keyboard.push([{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    await sendTelegramStatusMessage(chatId, text, replyToMessageId, keyboard);
  }
}
async function downloadOnlineArtworkBuffer(url) {
  const cleanUrl = String(url || "").trim();
  if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) return null;
  try {
    const res = await fetch(cleanUrl);
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    if (arr.byteLength <= 150) return null;
    return Buffer.from(arr);
  } catch {
    return null;
  }
}
async function fetchTmdbSlotBuffersForTitle(rawTitle, tipId, parentSerieName) {
  const query = cleanTitleForTmdbPosterSearch(rawTitle, parentSerieName) || rawTitle;
  const online = await searchMovieOrSeriesInfoOnline(query, tipId).catch(() => null);
  if (!online) {
    return { portadaBuffer: null, posterBuffer: null, resolvedTitle: query };
  }
  const portadaUrl = selectOnlineImageForSlot(online, "portada");
  const posterUrl = selectOnlineImageForSlot(online, "poster");
  const portadaBuffer = portadaUrl ? await downloadOnlineArtworkBuffer(portadaUrl) : null;
  let posterBuffer = null;
  if (posterUrl && posterUrl === portadaUrl) {
    posterBuffer = portadaBuffer;
  } else if (posterUrl) {
    posterBuffer = await downloadOnlineArtworkBuffer(posterUrl);
  }
  return {
    portadaBuffer,
    posterBuffer,
    resolvedTitle: online.title || query
  };
}
async function patchSerieInPictaChannel(chatId, pelserId, fields) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const ctx = getEffectivePictaContext(effectiveChatId);
  if (!ctx.isLinked || !ctx.channelId) {
    throw new Error("No has vinculado tu cuenta de Picta. Usa /login primero.");
  }
  const token = await ctx.accessTokenPromise;
  const buildSeriePatchForm = () => {
    const form = new FormData();
    if (fields.nombre) {
      form.append("nombre", cleanSerieDisplayName(fields.nombre) || fields.nombre.trim());
    }
    if (fields.sinopsis) {
      form.append("sinopsis", sanitizePublicPictaText(fields.sinopsis));
    }
    if (fields.portadaBuffer) {
      form.append(
        "url_imagen",
        new Blob([new Uint8Array(fields.portadaBuffer)], { type: "image/jpeg" }),
        `portada_serie_${pelserId}_${Date.now()}.jpg`
      );
    }
    const effectivePosterBuf = fields.posterBuffer || fields.coverBuffer;
    if (effectivePosterBuf) {
      form.append(
        "imagen_secundaria",
        new Blob([new Uint8Array(effectivePosterBuf)], { type: "image/jpeg" }),
        `poster_serie_${pelserId}_${Date.now()}.jpg`
      );
    }
    return form;
  };
  let res = await fetchPictaWithRetry(
    `https://api.picta.cu/v1/serie/${encodeURIComponent(String(pelserId))}/`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      },
      body: buildSeriePatchForm()
    }
  );
  if (res.status === 401 || res.status === 403) {
    const freshToken = effectiveChatId === MASTER_ADMIN_CHAT_ID && !userSessions.has(effectiveChatId) ? await authenticateWithPicta(true) : await refreshUserPictaSession(effectiveChatId);
    res = await fetchPictaWithRetry(
      `https://api.picta.cu/v1/serie/${encodeURIComponent(String(pelserId))}/`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${freshToken}`,
          Origin: "https://admin.picta.cu",
          Referer: "https://admin.picta.cu/"
        },
        body: buildSeriePatchForm()
      }
    );
  }
  if (!res.ok) {
    const errTxt = await res.text();
    throw new Error(formatPictaError(res.status, errTxt));
  }
  const rec = findUserChannelSerie(pelserId, effectiveChatId);
  if (rec) {
    if (fields.nombre) rec.nombre = cleanSerieDisplayName(fields.nombre) || fields.nombre.trim();
    saveChannelSeriesToDisk(channelSeriesCache);
  }
}
async function deleteSerieInPictaChannel(chatId, pelserId) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const isMaster = isMasterAdminChat(effectiveChatId);
  const ctx = getEffectivePictaContext(effectiveChatId);
  if (!ctx.isLinked || !ctx.channelId) {
    throw new Error("No has vinculado tu cuenta de Picta. Usa /login primero.");
  }
  const token = await ctx.accessTokenPromise;
  const res = await fetchPictaWithRetry(
    `https://api.picta.cu/v1/serie/${encodeURIComponent(String(pelserId))}/`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      }
    }
  );
  if (!res.ok && res.status !== 204) {
    const errTxt = await res.text();
    throw new Error(formatPictaError(res.status, errTxt));
  }
  const targetChanNum = Number(ctx.channelId);
  const idx = channelSeriesCache.findIndex(
    (s) => Number(s.pelser_id) === Number(pelserId) && (Number(s.canal_id || 0) === targetChanNum || isMaster && (!s.canal_id || Number(s.canal_id) === 36319))
  );
  if (idx >= 0) {
    channelSeriesCache.splice(idx, 1);
    saveChannelSeriesToDisk(channelSeriesCache);
  }
}
async function searchOrCreatePictaPersonaInCatalog(chatId, nombre) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const ctx = getEffectivePictaContext(effectiveChatId);
  const token = await ctx.accessTokenPromise;
  const clean = nombre.trim();
  if (!clean) throw new Error("Ingresa el nombre del actor o director.");
  const searchRes = await fetchPictaWithRetry(
    `https://api.picta.cu/v2/persona/?search=${encodeURIComponent(clean)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu"
      }
    }
  );
  if (searchRes.ok) {
    const sData = await searchRes.json().catch(() => ({}));
    const exact = (sData.results || []).find(
      (p) => String(p.nombre || "").toLowerCase().trim() === clean.toLowerCase()
    );
    if (exact?.id) {
      return { id: Number(exact.id), nombre: String(exact.nombre), created: false };
    }
  }
  const createRes = await fetchPictaWithRetry("https://api.picta.cu/v1/persona/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: "https://admin.picta.cu",
      Referer: "https://admin.picta.cu/"
    },
    body: JSON.stringify({ nombre: clean })
  });
  if (!createRes.ok) {
    const errTxt = await createRes.text();
    throw new Error(formatPictaError(createRes.status, errTxt));
  }
  const cObj = await createRes.json().catch(() => ({}));
  return { id: Number(cObj.id || 0), nombre: String(cObj.nombre || clean), created: true };
}
async function searchOrCreatePictaKeywordInCatalog(chatId, palabra) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const ctx = getEffectivePictaContext(effectiveChatId);
  const token = await ctx.accessTokenPromise;
  const clean = palabra.trim().replace(/^#/, "");
  if (!clean) throw new Error("Ingresa una palabra clave o etiqueta.");
  const searchRes = await fetchPictaWithRetry(
    `https://api.picta.cu/v2/palabra_clave/?search=${encodeURIComponent(clean)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu"
      }
    }
  );
  if (searchRes.ok) {
    const sData = await searchRes.json().catch(() => ({}));
    const exact = (sData.results || []).find(
      (p) => String(p.palabra || "").toLowerCase().trim() === clean.toLowerCase()
    );
    if (exact?.id) {
      return { id: Number(exact.id), palabra: String(exact.palabra), created: false };
    }
  }
  const createRes = await fetchPictaWithRetry("https://api.picta.cu/v1/palabra_clave/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: "https://admin.picta.cu",
      Referer: "https://admin.picta.cu/"
    },
    body: JSON.stringify({ palabra: clean })
  });
  if (!createRes.ok) {
    const errTxt = await createRes.text();
    throw new Error(formatPictaError(createRes.status, errTxt));
  }
  const cObj = await createRes.json().catch(() => ({}));
  return { id: Number(cObj.id || 0), palabra: String(cObj.palabra || clean), created: true };
}
async function sendOrEditPersonasAndTagsMenuInTelegram(chatId, messageId, replyToMessageId, notice) {
  pendingToolkitInputByChat.delete(chatId);
  const text = (notice ? `${notice}

` : "") + `${hudHeader("CAT\xC1LOGO DE PERSONAS Y ETIQUETAS")}
` + hudBox([
    `\u{1F3AD} <b>Reparto y Direcci\xF3n:</b> Registra o busca actores y directores v\xEDa API (<code>POST /v1/persona/</code>).`,
    `\u{1F3F7}\uFE0F <b>Palabras Clave:</b> Da de alta nuevas etiquetas de b\xFAsqueda (<code>POST /v1/palabra_clave/</code>).`
  ]);
  const keyboard = [
    [{ text: "\u{1F464} Registrar / Buscar Actor o Director en Picta", callback_data: "persona_create_prompt" }],
    [{ text: "\u{1F3F7}\uFE0F Registrar / Buscar Etiqueta (Palabra Clave)", callback_data: "keyword_create_prompt" }],
    [{ text: "\u2B05\uFE0F Volver a /canal", callback_data: "chan_editor:open" }]
  ];
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    await sendTelegramStatusMessage(chatId, text, replyToMessageId, keyboard);
  }
}
var channelCatalogSnapshotCache = /* @__PURE__ */ new Map();
var CHANNEL_CATALOG_CACHE_TTL_MS = 60 * 1e3;
function invalidateChannelCatalogSnapshotCache(channelId) {
  if (!channelId) {
    channelCatalogSnapshotCache.clear();
    lastAuditReportCache.clear();
    return;
  }
  const prefix = `${String(channelId).trim()}:`;
  for (const key of channelCatalogSnapshotCache.keys()) {
    if (key.startsWith(prefix)) {
      channelCatalogSnapshotCache.delete(key);
    }
  }
  for (const key of lastAuditReportCache.keys()) {
    if (key.startsWith(prefix)) {
      lastAuditReportCache.delete(key);
    }
  }
}
async function fetchSinglePictaJsonWithAuthRetry(url, effectiveChatId, tokenRef, isMaster) {
  const buildHeaders = (t) => ({
    Authorization: `Bearer ${t}`,
    Origin: "https://admin.picta.cu",
    Referer: "https://admin.picta.cu/"
  });
  let res = await fetchPictaWithRetry(url, { headers: buildHeaders(tokenRef.token) });
  if (res.status === 401 || res.status === 403) {
    try {
      tokenRef.token = isMaster && !userSessions.has(effectiveChatId) ? await authenticateWithPicta(true) : await refreshUserPictaSession(effectiveChatId);
      res = await fetchPictaWithRetry(url, { headers: buildHeaders(tokenRef.token) });
    } catch {
    }
  }
  if (!res.ok) {
    return { ok: false, status: res.status, data: null };
  }
  const data = await res.json().catch(() => null);
  return { ok: true, status: res.status, data };
}
async function fetchPaginatedChannelEndpoint(baseUrl, channelId, effectiveChatId, tokenRef, isMaster, strictChannelFilterCheck = false) {
  const page1 = await fetchSinglePictaJsonWithAuthRetry(baseUrl, effectiveChatId, tokenRef, isMaster);
  if (!page1.ok || !page1.data) {
    return { items: [], apiCount: 0, ok: false, status: page1.status, filterHonored: false };
  }
  const rawList1 = Array.isArray(page1.data) ? page1.data : Array.isArray(page1.data?.results) ? page1.data.results : [];
  const targetNum = Number(channelId);
  if (strictChannelFilterCheck && targetNum > 0 && rawList1.length > 0) {
    const hasForeign = rawList1.some((item) => {
      const chId = Number(
        item?.canal_id ?? (typeof item?.canal === "object" && item?.canal ? item.canal.id : item?.canal) ?? 0
      );
      return chId > 0 && chId !== targetNum;
    });
    if (hasForeign) {
      return { items: [], apiCount: 0, ok: true, status: page1.status, filterHonored: false };
    }
  }
  const allItems = [...rawList1];
  const reportedCount = typeof page1.data?.count === "number" && page1.data.count >= 0 ? Number(page1.data.count) : rawList1.length;
  const MAX_PAGES = 50;
  let nextUrl = parsePictaNextPageUrl(baseUrl, page1.data?.next, 1);
  if (nextUrl && rawList1.length > 0 && reportedCount > rawList1.length) {
    let usesNumericPage = false;
    let parsedNext = null;
    try {
      parsedNext = new URL2(nextUrl);
      usesNumericPage = parsedNext.searchParams.get("page") === "2";
    } catch {
      usesNumericPage = false;
    }
    if (usesNumericPage && parsedNext) {
      const totalPages = Math.min(MAX_PAGES, Math.ceil(reportedCount / rawList1.length));
      const CONCURRENCY = 4;
      for (let start = 2; start <= totalPages; start += CONCURRENCY) {
        const batchNums = [];
        for (let p = start; p < start + CONCURRENCY && p <= totalPages; p++) {
          batchNums.push(p);
        }
        const batchResponses = await Promise.all(
          batchNums.map((pageNum) => {
            const u = new URL2(parsedNext.toString());
            u.searchParams.set("page", String(pageNum));
            return fetchSinglePictaJsonWithAuthRetry(u.toString(), effectiveChatId, tokenRef, isMaster);
          })
        );
        let sawEmpty = false;
        for (const resp of batchResponses) {
          if (!resp.ok || !resp.data) continue;
          const batchItems = Array.isArray(resp.data) ? resp.data : Array.isArray(resp.data?.results) ? resp.data.results : [];
          if (batchItems.length === 0) {
            sawEmpty = true;
            continue;
          }
          allItems.push(...batchItems);
        }
        if (sawEmpty) break;
      }
      return { items: allItems, apiCount: reportedCount, ok: true, status: page1.status, filterHonored: true };
    }
  }
  let pageCount = 1;
  while (nextUrl && pageCount < MAX_PAGES) {
    pageCount++;
    const nextPage = await fetchSinglePictaJsonWithAuthRetry(nextUrl, effectiveChatId, tokenRef, isMaster);
    if (!nextPage.ok || !nextPage.data) break;
    const batchItems = Array.isArray(nextPage.data) ? nextPage.data : Array.isArray(nextPage.data?.results) ? nextPage.data.results : [];
    if (batchItems.length === 0) break;
    allItems.push(...batchItems);
    nextUrl = parsePictaNextPageUrl(baseUrl, nextPage.data?.next, pageCount);
  }
  return { items: allItems, apiCount: reportedCount, ok: true, status: page1.status, filterHonored: true };
}
async function fetchPictaResumenStatsForPeriod(effectiveChatId, tokenRef, isMaster, period, cubaTodayStr) {
  try {
    const range = getPictaDateRangeForPeriod(period, cubaTodayStr);
    const url = new URL2("https://api.picta.cu/v2/resumen/datos/");
    if (range.dateGte && range.dateLte) {
      url.searchParams.set("date__gte", range.dateGte);
      url.searchParams.set("date__lte", range.dateLte);
    }
    const resp = await fetchSinglePictaJsonWithAuthRetry(
      url.toString(),
      effectiveChatId,
      tokenRef,
      isMaster
    );
    if (!resp.ok || !resp.data) return null;
    return extractPictaResumenMetrics(resp.data);
  } catch {
    return null;
  }
}
async function fetchPictaChannelCatalogSnapshot(chatId, forceRefresh = false) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const context = getEffectivePictaContext(effectiveChatId);
  if (!context.isLinked || !context.channelId) {
    throw new Error("No has vinculado tu cuenta de Picta. Usa /login primero.");
  }
  const isMaster = isMasterAdminChat(effectiveChatId);
  const channelId = context.channelId;
  const cacheKey = `${channelId}:${isMaster ? "master" : effectiveChatId}`;
  if (!forceRefresh) {
    const cached = channelCatalogSnapshotCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAtMs < CHANNEL_CATALOG_CACHE_TTL_MS) {
      return cached;
    }
  }
  const token = await context.accessTokenPromise;
  const tokenRef = { token };
  ensureDailyQuotaReset();
  const cubaTodayStr = getTodayCubaDateStr();
  const [
    v2Result,
    v1Result,
    channelDetails,
    webAdminAllTime,
    webAdminLast30d,
    webAdminLast7d,
    webAdminToday
  ] = await Promise.all([
    fetchPaginatedChannelEndpoint(
      `https://api.picta.cu/v2/publicacion/?canal_id=${encodeURIComponent(channelId)}&page_size=100`,
      channelId,
      effectiveChatId,
      tokenRef,
      isMaster,
      false
    ),
    fetchPaginatedChannelEndpoint(
      `https://api.picta.cu/v1/publicacion/?canal_id=${encodeURIComponent(channelId)}&page_size=100`,
      channelId,
      effectiveChatId,
      tokenRef,
      isMaster,
      true
    ).catch(() => ({ items: [], apiCount: 0, ok: false, status: 0, filterHonored: false })),
    fetchPictaChannelDetails(effectiveChatId).catch(() => null),
    fetchPictaResumenStatsForPeriod(effectiveChatId, tokenRef, isMaster, "all", cubaTodayStr),
    fetchPictaResumenStatsForPeriod(effectiveChatId, tokenRef, isMaster, "30d", cubaTodayStr),
    fetchPictaResumenStatsForPeriod(effectiveChatId, tokenRef, isMaster, "7d", cubaTodayStr),
    fetchPictaResumenStatsForPeriod(effectiveChatId, tokenRef, isMaster, "today", cubaTodayStr)
  ]);
  let v1Final = v1Result;
  if (!v1Final.filterHonored && v1Final.items.length === 0) {
    v1Final = await fetchPaginatedChannelEndpoint(
      `https://api.picta.cu/v1/publicacion/?canal=${encodeURIComponent(channelId)}&page_size=100`,
      channelId,
      effectiveChatId,
      tokenRef,
      isMaster,
      true
    ).catch(() => ({ items: [], apiCount: 0, ok: false, status: 0, filterHonored: false }));
  }
  if (!v2Result.ok && !v1Final.ok) {
    throw new Error(`Error HTTP ${v2Result.status || v1Final.status || 500} al consultar estad\xEDsticas en Picta`);
  }
  const publications = mergeAndDedupeChannelPublications(
    [v2Result.items, v1Final.filterHonored ? v1Final.items : []],
    channelId
  );
  const reportedApiTotalCount = Math.max(
    v2Result.apiCount || 0,
    v1Final.filterHonored ? v1Final.apiCount || 0 : 0,
    channelDetails?.cantidad_publicaciones || 0
  );
  const dailyQuotaCapacity = isMaster ? (1 + quotaSettings.poolAccounts.filter((a) => a.canPublishDirectly !== false).length) * 10 : 10;
  const quotaUsedToday = isMaster ? (quotaSettings.seriesUploadedToday || 0) + (quotaSettings.otherUploadedToday || 0) : transferJobs.filter(
    (j) => j.telegramChatId === effectiveChatId && j.stage === "completed" && toCubaDateStr(j.updatedAt || j.createdAt) === cubaTodayStr
  ).length;
  const channelSubscribers = Number(channelDetails?.cantidad_suscriptores || 0);
  const globalStats = computeGlobalChannelStats(publications, {
    reportedApiTotalCount,
    cubaTodayStr,
    dailyQuotaCapacity,
    quotaUsedToday,
    channelSubscribers,
    webAdminAllTime,
    webAdminLast30d,
    webAdminLast7d,
    webAdminToday
  });
  const snapshot = {
    fetchedAtMs: Date.now(),
    publications,
    globalStats,
    channelSubscribers,
    ...channelDetails?.slug_url ? { channelSlugUrl: channelDetails.slug_url } : {}
  };
  channelCatalogSnapshotCache.set(cacheKey, snapshot);
  return snapshot;
}
async function fetchPictaChannelPublications(chatId, forceRefresh = false) {
  const snapshot = await fetchPictaChannelCatalogSnapshot(chatId, forceRefresh);
  return snapshot.publications;
}
async function fetchSinglePictaPublicationDirect(pubId, chatId) {
  try {
    const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
    const context = getEffectivePictaContext(effectiveChatId);
    if (!context.isLinked) return null;
    const token = await context.accessTokenPromise;
    const res = await fetchPictaWithRetry(`https://api.picta.cu/v1/publicacion/${pubId}/`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      }
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}
async function patchPictaPublicationInChannel(pubId, fields, files, chatId) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const context = getEffectivePictaContext(effectiveChatId);
  const token = await context.accessTokenPromise;
  const form = new FormData();
  form.append("tipo", fields.tipo || "publicacion");
  if (!fields.tipologia) {
    try {
      const pubs = await fetchPictaChannelPublications(effectiveChatId);
      const matchPub = pubs.find((p) => Number(p.id) === Number(pubId));
      const tipId = matchPub?.categoria?.tipologia?.id;
      if (tipId) {
        form.append("tipologia", String(tipId));
      }
    } catch {
    }
  }
  for (const [k, v] of Object.entries(fields)) {
    if (k === "tipo") continue;
    if (k === "nombre" || k === "descripcion" || k === "sinopsis") {
      form.append(k, sanitizePublicPictaText(v));
    } else {
      form.append(k, v);
    }
  }
  if (files?.coverBuffer) {
    form.append(
      "url_imagen",
      new Blob([new Uint8Array(files.coverBuffer)], { type: "image/jpeg" }),
      `cover_${pubId}_${Date.now()}.jpg`
    );
  }
  if (files?.posterBuffer) {
    form.append(
      "imagen_secundaria",
      new Blob([new Uint8Array(files.posterBuffer)], { type: "image/jpeg" }),
      `poster_${pubId}_${Date.now()}.jpg`
    );
  }
  if (files?.subtitleBuffer) {
    const subName = (files.subtitleFileName || `subtitulos_${pubId}.srt`).replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    );
    const subUrl = await uploadSubtitleBufferToMinioS3(token, files.subtitleBuffer, subName);
    if (subUrl) {
      form.append("url_subtitulo", subUrl);
    }
  }
  let res = await fetchPictaWithRetry(`https://api.picta.cu/v1/publicacion/${pubId}/`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://admin.picta.cu",
      Referer: "https://admin.picta.cu/"
    },
    body: form
  });
  if (res.status === 401 || res.status === 403) {
    const freshToken = effectiveChatId === MASTER_ADMIN_CHAT_ID && !userSessions.has(effectiveChatId) ? await authenticateWithPicta(true) : await refreshUserPictaSession(effectiveChatId);
    res = await fetchPictaWithRetry(`https://api.picta.cu/v1/publicacion/${pubId}/`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${freshToken}`,
        Origin: "https://admin.picta.cu",
        Referer: "https://admin.picta.cu/"
      },
      body: form
    });
  }
  if (!res.ok) {
    const errTxt = await res.text();
    throw new Error(formatPictaError(res.status, errTxt));
  }
  invalidateChannelCatalogSnapshotCache(context.channelId);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { id: pubId };
  }
}
async function deletePictaPublicationInChannel(pubId, chatId) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const context = getEffectivePictaContext(effectiveChatId);
  const token = await context.accessTokenPromise;
  const res = await fetchPictaWithRetry(`https://api.picta.cu/v1/publicacion/${pubId}/`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://admin.picta.cu",
      Referer: "https://admin.picta.cu/"
    }
  });
  if (!res.ok && res.status !== 204) {
    await patchPictaPublicationInChannel(pubId, { publicado: "false" }, void 0, effectiveChatId);
  }
  invalidateChannelCatalogSnapshotCache(context.channelId);
}
async function createSerieInPictaChannelDirect(chatId, serieName, seasonNum = 1, customCoverFileId) {
  const effectiveChatId = chatId || MASTER_ADMIN_CHAT_ID;
  const isMaster = isMasterAdminChat(effectiveChatId);
  const ctx = getEffectivePictaContext(effectiveChatId);
  if (!ctx.isLinked || !ctx.channelId) {
    throw new Error("No has vinculado tu cuenta de Picta. Usa /login primero.");
  }
  const token = await ctx.accessTokenPromise;
  let coverBuf = null;
  if (customCoverFileId) {
    coverBuf = await downloadTelegramThumbnailBuffer(customCoverFileId);
  }
  if (!coverBuf || coverBuf.byteLength < 100) {
    coverBuf = Buffer.from(FALLBACK_JPEG_BASE64, "base64");
  }
  const cleanName = cleanSerieDisplayName(serieName) || "Nueva Serie";
  const tempId = await ensureSerieAndTemporadaId(
    token,
    cleanName,
    seasonNum,
    { sinopsis: `Serie ${cleanName} disponible en el canal ${ctx.channelName}.` },
    coverBuf,
    ctx.channelId,
    ctx.channelName,
    isMaster
  );
  const scopedSeries = filterSeriesForChannel(channelSeriesCache, ctx.channelId, isMaster);
  const rec = scopedSeries.find(
    (s) => s.nombre.toLowerCase().trim() === cleanName.toLowerCase()
  );
  return {
    pelserId: rec?.pelser_id || tempId,
    tempId,
    serieName: rec?.nombre || cleanName,
    seasonNum
  };
}
function buildCategorySelectionKeyboard(jobId) {
  return [
    [
      { text: "\u{1F3AC} Pel\xEDcula", callback_data: `cat:1:${jobId}` },
      { text: "\u{1F4FA} Serie", callback_data: `cat:5:${jobId}` }
    ],
    [
      { text: "\u{1F4FD}\uFE0F Documental", callback_data: `cat:2:${jobId}` },
      { text: "\u{1F4F9} Audiovisual", callback_data: `cat:8:${jobId}` }
    ],
    [
      { text: "\u26A1 Shorts", callback_data: `cat:15:${jobId}` },
      { text: "\u{1F602} Humor\xEDstico", callback_data: `cat:19:${jobId}` }
    ],
    [
      { text: "\u{1F3B5} Video Musical", callback_data: `cat:3:${jobId}` },
      { text: "\u{1F3B6} Videoclip", callback_data: `cat:11:${jobId}` }
    ],
    [
      { text: "\u{1F4DA} Curso", callback_data: `cat:6:${jobId}` },
      { text: "\u26BD Deporte", callback_data: `cat:14:${jobId}` }
    ],
    [
      { text: "\u{1F4F0} Informativo", callback_data: `cat:18:${jobId}` },
      { text: "\u{1F3AD} Cultural", callback_data: `cat:17:${jobId}` }
    ],
    [
      { text: "\u{1F4CA} Dashboard Picta", callback_data: "dash_refresh:views:0" },
      { text: "\u{1F4FA} Mis Series", callback_data: "my_series:0" }
    ]
  ];
}
async function sendOrEditPictaDashboardInTelegram(chatId, messageId, sortMode = "views", page = 0, replyToMessageId, forceRefresh = false, period = "all") {
  const ctx = getEffectivePictaContext(chatId);
  if (!ctx.isLinked || !ctx.channelId) {
    const unlinkedText = `${hudHeader("ESTAD\xCDSTICAS \xB7 ACCESO REQUERIDO")}
` + hudBox([
      `\u26AA <b>Estado:</b> Sin canal vinculado en Picta`,
      `\u{1F449} Para consultar el Dashboard y editar tus videos, inicia sesi\xF3n con /login.`
    ]);
    const unlinkedKb = [
      [{ text: "\u{1F511} Vincular mi cuenta de Picta (/login)", callback_data: "user_picta_login_start" }],
      [{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]
    ];
    if (messageId) {
      await editTelegramStatusMessage(chatId, messageId, unlinkedText, unlinkedKb, true);
    } else {
      await sendTelegramStatusMessage(chatId, unlinkedText, replyToMessageId, unlinkedKb);
    }
    return;
  }
  try {
    const snapshot = await fetchPictaChannelCatalogSnapshot(chatId, forceRefresh);
    const pubs = snapshot.publications;
    const g = snapshot.globalStats;
    const sorted = [...pubs].sort((a, b) => {
      if (sortMode === "views") return Number(b.cantidad_visitas || 0) - Number(a.cantidad_visitas || 0);
      if (sortMode === "plays") return Number(b.cantidad_reproducciones || 0) - Number(a.cantidad_reproducciones || 0);
      if (sortMode === "likes") return Number(b.cantidad_me_gusta || 0) - Number(a.cantidad_me_gusta || 0);
      if (sortMode === "downloads") return Number(b.cantidad_descargas || 0) - Number(a.cantidad_descargas || 0);
      return new Date(b.fecha_publicado || b.fecha_creacion || 0).getTime() - new Date(a.fecha_publicado || a.fecha_creacion || 0).getTime();
    });
    const topViewed = g.topViewed;
    const topLiked = g.topLiked;
    const PAGE_SIZE = 6;
    const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const pageItems = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
    const sortLabels = {
      views: "\u{1F525} M\xE1s Vistos",
      plays: "\u25B6\uFE0F M\xE1s Reproducidos",
      likes: "\u2764\uFE0F M\xE1s Likes",
      downloads: "\u{1F4E5} M\xE1s Descargados",
      recent: "\u{1F552} M\xE1s Recientes"
    };
    const videoLines = pageItems.length > 0 ? pageItems.map((p, idx) => {
      const rank = safePage * PAGE_SIZE + idx + 1;
      const v = Number(p.cantidad_visitas || 0).toLocaleString();
      const r = Number(p.cantidad_reproducciones || 0).toLocaleString();
      const l = Number(p.cantidad_me_gusta || 0).toLocaleString();
      const d = Number(p.cantidad_descargas || 0).toLocaleString();
      const visBadge = p.publicado === false ? "\u{1F648} " : "";
      const shortTitle = escapeHtml(String(p.nombre || "Video").slice(0, 46));
      return `<b>${rank}. ${visBadge}${shortTitle}</b>
   <code>\u{1F440} ${v}</code> \xB7 <code>\u25B6\uFE0F ${r}</code> \xB7 <code>\u2764\uFE0F ${l}</code> \xB7 <code>\u{1F4E5} ${d}</code>`;
    }).join("\n\n") : "<i>No hay videos publicados a\xFAn en este canal.</i>";
    const videoExtraNotes = [];
    if (g.hiddenOrPendingCount > 0) {
      videoExtraNotes.push(`${g.publishedCount} pub. \xB7 ${g.hiddenOrPendingCount} ocultos/conv.`);
    }
    if (g.isPartialCatalog) {
      videoExtraNotes.push(`le\xEDdos ${g.fetchedVideos}/${g.totalVideos}`);
    }
    const videoExtraStr = videoExtraNotes.length > 0 ? ` <i>(${videoExtraNotes.join(" \xB7 ")})</i>` : "";
    const quotaNoteStr = g.quotaUsedToday > g.publishedToday ? ` <i>(cuota bot: ${g.quotaUsedToday}/${g.dailyCapacity})</i>` : "";
    const syncTimeCuba = new Date(snapshot.fetchedAtMs).toLocaleTimeString("es-CU", {
      timeZone: "America/Havana",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    const periodLabels = {
      all: "Desde siempre",
      "30d": "\xDAltimo mes (Web Admin)",
      "7d": "\xDAltimos 7 d\xEDas (Web Admin)",
      today: "Hoy (Web Admin)"
    };
    const activePeriodSummary = period === "30d" ? g.webAdminLast30d : period === "7d" ? g.webAdminLast7d : period === "today" ? g.webAdminToday : null;
    const summaryBoxLines = period !== "all" && activePeriodSummary ? [
      `\u{1F4C5} <b>Periodo Web Admin:</b> ${periodLabels[period]}`,
      `\u{1F3AC} <b>Publicaciones:</b> ${activePeriodSummary.publicadas.toLocaleString()} \xB7 \u{1F4C5} <b>Hoy:</b> ${g.publishedToday}/${g.dailyCapacity}${quotaNoteStr}`,
      `\u{1F440} <b>Visitas:</b> ${activePeriodSummary.views.toLocaleString()} \xB7 \u25B6\uFE0F <b>Reprod.:</b> ${activePeriodSummary.plays.toLocaleString()}`,
      `\u2764\uFE0F <b>Likes:</b> ${activePeriodSummary.likes.toLocaleString()} \xB7 \u{1F4E5} <b>Descargas:</b> ${activePeriodSummary.downloads.toLocaleString()}`,
      `\u{1F4AC} <b>Comentarios:</b> ${activePeriodSummary.comments.toLocaleString()}${g.channelSubscribers > 0 ? ` \xB7 \u{1F465} <b>Subs:</b> ${g.channelSubscribers.toLocaleString()}` : ""}`,
      `\u{1F6F0}\uFE0F <b>Sync Web Admin:</b> <code>${syncTimeCuba}</code> \xB7 Cat\xE1logo total: <code>${g.totalVideos}</code>`
    ] : [
      `\u{1F3AC} <b>Videos:</b> ${g.totalVideos.toLocaleString()}${videoExtraStr} \xB7 \u{1F4C5} <b>Hoy:</b> ${g.publishedToday}/${g.dailyCapacity}${quotaNoteStr}`,
      `\u{1F440} <b>Vistas:</b> ${g.totalViews.toLocaleString()} \xB7 \u25B6\uFE0F <b>Reprod.:</b> ${g.totalPlays.toLocaleString()}`,
      `\u2764\uFE0F <b>Likes:</b> ${g.totalLikes.toLocaleString()} \xB7 \u{1F4E5} <b>Descargas:</b> ${g.totalDownloads.toLocaleString()}`,
      `\u{1F4AC} <b>Comentarios:</b> ${g.totalComments.toLocaleString()}${g.channelSubscribers > 0 ? ` \xB7 \u{1F465} <b>Subs:</b> ${g.channelSubscribers.toLocaleString()}` : ""}`,
      g.webAdminLast30d ? `\u{1F4C6} <b>\xDAltimo mes:</b> ${g.webAdminLast30d.publicadas} pub. \xB7 \u{1F440} ${g.webAdminLast30d.views.toLocaleString()} \xB7 \u{1F4E5} ${g.webAdminLast30d.downloads.toLocaleString()}` : void 0,
      `\u{1F6F0}\uFE0F <b>Sync Web Admin:</b> <code>${syncTimeCuba}</code> \xB7 Cat\xE1logo completo (<code>${g.fetchedVideos}</code>)`
    ];
    const dashboardText = `${hudHeader(`TELEMETR\xCDA \xB7 ${ctx.channelName} #${ctx.channelId}`)}
` + hudBox(summaryBoxLines) + (topViewed ? `
\u{1F3C6} <b>Top Vistas:</b> <i>${escapeHtml(String(topViewed.nombre).slice(0, 38))}</i> (<code>${Number(topViewed.cantidad_visitas || 0).toLocaleString()} \u{1F440}</code>)` : "") + (topLiked ? `
\u{1F48E} <b>Top Likes:</b> <i>${escapeHtml(String(topLiked.nombre).slice(0, 38))}</i> (<code>${Number(topLiked.cantidad_me_gusta || 0).toLocaleString()} \u2764\uFE0F</code>)` : "") + `

${hudSection(`Cat\xE1logo \xB7 ${sortLabels[sortMode] || "\u{1F525} M\xE1s Vistos"} \xB7 P\xE1g. ${safePage + 1}/${totalPages}`)}

${videoLines}

\u{1F447} <i>Pulsa un bot\xF3n <b>\u{1F6E0}\uFE0F #N</b> para editar t\xEDtulo, sinopsis, portada, subt\xEDtulos o visibilidad:</i>`;
    const detailButtonsRow = pageItems.map((p, idx) => ({
      text: `\u{1F6E0}\uFE0F #${safePage * PAGE_SIZE + idx + 1}`,
      callback_data: `dash_pub:${p.id}:${sortMode}:${safePage}`
    }));
    const keyboard = [];
    if (detailButtonsRow.length > 0) {
      keyboard.push(detailButtonsRow);
    }
    keyboard.push([
      {
        text: period === "all" ? "\u2705 \u267E\uFE0F Todo" : "\u267E\uFE0F Todo",
        callback_data: `dash_period:all:${sortMode}:${safePage}`
      },
      {
        text: period === "30d" ? "\u2705 \u{1F4C5} \xDAltimo mes" : "\u{1F4C5} \xDAltimo mes",
        callback_data: `dash_period:30d:${sortMode}:${safePage}`
      },
      {
        text: period === "7d" ? "\u2705 \u{1F4C6} 7 d\xEDas" : "\u{1F4C6} 7 d\xEDas",
        callback_data: `dash_period:7d:${sortMode}:${safePage}`
      },
      {
        text: period === "today" ? "\u2705 \u{1F5D3}\uFE0F Hoy" : "\u{1F5D3}\uFE0F Hoy",
        callback_data: `dash_period:today:${sortMode}:${safePage}`
      }
    ]);
    keyboard.push([
      {
        text: sortMode === "views" ? "\u2705 \u{1F525} Vistas" : "\u{1F525} Vistas",
        callback_data: `dash_sort:views:0:${period}`
      },
      {
        text: sortMode === "plays" ? "\u2705 \u25B6\uFE0F Reprod." : "\u25B6\uFE0F Reprod.",
        callback_data: `dash_sort:plays:0:${period}`
      },
      {
        text: sortMode === "likes" ? "\u2705 \u2764\uFE0F Likes" : "\u2764\uFE0F Likes",
        callback_data: `dash_sort:likes:0:${period}`
      }
    ]);
    keyboard.push([
      {
        text: sortMode === "downloads" ? "\u2705 \u{1F4E5} Descargas" : "\u{1F4E5} Descargas",
        callback_data: `dash_sort:downloads:0:${period}`
      },
      {
        text: sortMode === "recent" ? "\u2705 \u{1F552} Recientes" : "\u{1F552} Recientes",
        callback_data: `dash_sort:recent:0:${period}`
      },
      {
        text: "\u{1F504} Actualizar",
        callback_data: `dash_refresh:${sortMode}:${safePage}:${period}`
      }
    ]);
    if (totalPages > 1) {
      const navRow = [];
      if (safePage > 0) {
        navRow.push({
          text: "\u2B05\uFE0F Anterior",
          callback_data: `dash_sort:${sortMode}:${safePage - 1}:${period}`
        });
      }
      navRow.push({
        text: `\u{1F4C4} ${safePage + 1} / ${totalPages}`,
        callback_data: `dash_refresh:${sortMode}:${safePage}:${period}`
      });
      if (safePage < totalPages - 1) {
        navRow.push({
          text: "Siguiente \u27A1\uFE0F",
          callback_data: `dash_sort:${sortMode}:${safePage + 1}:${period}`
        });
      }
      keyboard.push(navRow);
    }
    keyboard.push([
      {
        text: `\u{1F4FA} Series en mi Canal (#${ctx.channelId})`,
        callback_data: "my_series:0"
      },
      {
        text: "\u{1F3DB}\uFE0F Editar mi Canal (/canal)",
        callback_data: "chan_editor:open"
      }
    ]);
    if (messageId) {
      await editTelegramStatusMessage(chatId, messageId, dashboardText, keyboard, true);
    } else {
      await sendTelegramStatusMessage(chatId, dashboardText, replyToMessageId, keyboard);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errText = `\u26A0\uFE0F <b>No se pudo cargar el Dashboard de Picta:</b>
<code>${escapeHtml(msg)}</code>`;
    if (messageId) {
      await editTelegramStatusMessage(chatId, messageId, errText, [
        [{ text: "\u{1F504} Reintentar Dashboard", callback_data: `dash_refresh:views:0:${period}` }]
      ]);
    } else {
      await sendTelegramStatusMessage(chatId, errText, replyToMessageId, [
        [{ text: "\u{1F504} Reintentar Dashboard", callback_data: `dash_refresh:views:0:${period}` }]
      ]);
    }
  }
}
async function sendOrEditPictaPubDetailInTelegram(chatId, messageId, pubId, returnSort, returnPage, bannerNotice) {
  try {
    pendingPubEditByChat.delete(chatId);
    const [directPub, pubs] = await Promise.all([
      fetchSinglePictaPublicationDirect(pubId, chatId),
      fetchPictaChannelPublications(chatId).catch(() => [])
    ]);
    const listMatch = pubs.find((item) => Number(item.id) === Number(pubId));
    let p = directPub ? { ...listMatch || {}, ...directPub } : listMatch;
    const chapterLookup = findUserChannelChapter(pubId, chatId);
    const localCap = chapterLookup?.chapter;
    const parentSerie = chapterLookup?.serie;
    if (!p && localCap) {
      p = {
        id: localCap.pubId,
        nombre: localCap.nombre,
        descripcion: localCap.descripcion || "",
        publicado: localCap.publicado !== false,
        convertido: Boolean(localCap.convertido),
        fecha_publicado: localCap.updatedAt,
        cantidad_visitas: 0,
        cantidad_reproducciones: 0,
        cantidad_me_gusta: 0,
        cantidad_no_me_gusta: 0,
        cantidad_descargas: 0,
        cantidad_comentarios: 0
      };
    }
    if (!p) {
      if (returnSort.startsWith("serie_")) {
        const sPelserId = Number(returnSort.replace("serie_", ""));
        await sendOrEditSerieDetailInTelegram(chatId, messageId, sPelserId, returnPage);
      } else {
        await sendOrEditPictaDashboardInTelegram(chatId, messageId, returnSort, returnPage);
      }
      return;
    }
    const isFromSerieMenu = returnSort.startsWith("serie_");
    const returnPelserId = isFromSerieMenu ? Number(returnSort.replace("serie_", "")) : 0;
    const isSerieCap = Boolean(localCap || isFromSerieMenu || p?.categoria?.capitulo);
    const fechaRaw = p.fecha_publicado || p.fecha_creacion || "";
    const fechaFormatted = fechaRaw ? new Date(fechaRaw).toLocaleString("es-CU") : "N/D";
    const hasSubs = Boolean(p.url_subtitulo || Array.isArray(p.subtitulos) && p.subtitulos.length > 0);
    const isPublished = p.publicado !== false;
    const stateDesc = String(p.estado || "").trim();
    const rejectReason = String(p.motivo_rechazo || p.razon_rechazo || "").trim();
    const visibilityStatusLabel = isPublished ? "\u{1F7E2} Publicado" : !p.fecha_publicado ? "\u23F3 Sin aprobar / No publicado" : "\u{1F648} Oculto";
    const detailText = (bannerNotice ? `${bannerNotice}

` : "") + `${hudHeader("FICHA DE VIDEO Y EDICI\xD3N DIRECTA")}
` + hudBox([
      `\u{1F4CC} <b>T\xEDtulo:</b> ${escapeHtml(p.nombre || "Sin t\xEDtulo")}`,
      localCap ? `\u{1F4FA} <b>Serie:</b> ${escapeHtml(parentSerie?.nombre || "Serie")} \xB7 <code>T${localCap.temporada}:E${String(localCap.numero).padStart(2, "0")}</code>` : void 0,
      `\u{1F441}\uFE0F <b>Estado:</b> ${visibilityStatusLabel} \xB7 \u{1F39E}\uFE0F <b>Conversi\xF3n:</b> ${p.convertido ? "\u2705 Convertido" : "\u23F3 Nomad"}`,
      stateDesc ? `\u{1F4CB} <b>Moderaci\xF3n / Estado Picta:</b> ${escapeHtml(stateDesc)}` : void 0,
      rejectReason ? `\u{1F6AB} <b>Motivo Picta:</b> ${escapeHtml(rejectReason)}` : void 0,
      `\u{1F4C5} <b>Fecha:</b> ${escapeHtml(fechaFormatted)}`,
      `\u{1F5BC}\uFE0F <b>Portada:</b> ${p.url_imagen ? "\u2705 Activa" : "\u26AA Vac\xEDa"} \xB7 \u{1F39E}\uFE0F <b>P\xF3ster:</b> ${p.imagen_secundaria ? "\u2705 Activo" : "\u26AA Vac\xEDo"}`,
      `\u{1F4AC} <b>Subt\xEDtulos:</b> ${hasSubs ? "\u2705 Incluidos" : "Sin subt\xEDtulos externos"}`
    ]) + `
${hudSection("M\xE9tricas en Tiempo Real")}
` + hudBox([
      `\u{1F440} <b>Vistas:</b> <code>${Number(p.cantidad_visitas || 0).toLocaleString()}</code> \xB7 \u25B6\uFE0F <b>Reprod.:</b> <code>${Number(p.cantidad_reproducciones || 0).toLocaleString()}</code>`,
      `\u2764\uFE0F <b>Likes:</b> <code>${Number(p.cantidad_me_gusta || 0).toLocaleString()}</code> \xB7 \u{1F4E5} <b>Descargas:</b> <code>${Number(p.cantidad_descargas || 0).toLocaleString()}</code>`
    ]) + `
${hudSection("Descripci\xF3n Actual")}
<blockquote><i>${escapeHtml(sanitizePublicPictaText(String(p.descripcion || "Sin descripci\xF3n")).slice(0, 320))}</i></blockquote>
\u{1F6E0}\uFE0F <b>Controles directos por API:</b>`;
    const keyboard = [
      [
        {
          text: "\u270F\uFE0F Cambiar T\xEDtulo",
          callback_data: `pub_edit:title:${p.id}:${returnSort}:${returnPage}`
        },
        {
          text: "\u{1F4DD} Cambiar Descripci\xF3n",
          callback_data: `pub_edit:desc:${p.id}:${returnSort}:${returnPage}`
        }
      ],
      [
        {
          text: "\u{1F5BC}\uFE0F Cambiar Portada",
          callback_data: `pub_edit:cover:${p.id}:${returnSort}:${returnPage}`
        },
        {
          text: "\u{1F39E}\uFE0F Cambiar P\xF3ster",
          callback_data: `pub_edit:poster:${p.id}:${returnSort}:${returnPage}`
        }
      ],
      [
        {
          text: "\u{1F4AC} A\xF1adir Subt\xEDtulos (.srt)",
          callback_data: `pub_edit:subs:${p.id}:${returnSort}:${returnPage}`
        }
      ]
    ];
    if (isSerieCap) {
      keyboard.push([
        {
          text: "\u{1F522} Cambiar N\xBA Cap\xEDtulo o Temporada",
          callback_data: `pub_edit:epnum:${p.id}:${returnSort}:${returnPage}`
        }
      ]);
    }
    const allowDl = p.descarga !== false;
    keyboard.push(
      [
        {
          text: allowDl ? "\u{1F4E5} Descarga: Permitida (Bloquear)" : "\u{1F512} Descarga: Bloqueada (Permitir)",
          callback_data: `pub_toggle_dl:${p.id}:${returnSort}:${returnPage}`
        },
        {
          text: "\u{1F3F7}\uFE0F Editar Etiquetas",
          callback_data: `pub_edit:tags:${p.id}:${returnSort}:${returnPage}`
        }
      ],
      [
        {
          text: "\u{1F6AA} Descarga Directa (Puerta Trasera)",
          callback_data: `pub_direct_dl:${p.id}`
        },
        {
          text: "\u{1F4C2} A\xF1adir a Lista",
          callback_data: `pub_add_playlist_pick:${p.id}:${returnSort}:${returnPage}`
        }
      ],
      [
        {
          text: "\u{1F4AC} Comentarios de este Video",
          callback_data: `comments_menu:${p.id}`
        }
      ],
      [
        {
          text: isPublished ? "\u{1F648} Ocultar en mi Canal" : "\u{1F7E2} Publicar en mi Canal",
          callback_data: `pub_toggle_vis:${p.id}:${returnSort}:${returnPage}`
        },
        {
          text: "\u{1F5D1}\uFE0F Eliminar Cap\xEDtulo/Video",
          callback_data: `pub_del_ask:${p.id}:${returnSort}:${returnPage}`
        }
      ],
      [
        {
          text: "\u{1F504} Actualizar",
          callback_data: `dash_pub:${p.id}:${returnSort}:${returnPage}`
        },
        isFromSerieMenu ? {
          text: "\u2B05\uFE0F Volver a Cap\xEDtulos de la Serie",
          callback_data: `serie_manage:${returnPelserId}:${returnPage}`
        } : {
          text: "\u2B05\uFE0F Volver al Dashboard",
          callback_data: `dash_sort:${returnSort}:${returnPage}`
        }
      ]
    );
    if (messageId) {
      await editTelegramStatusMessage(chatId, messageId, detailText, keyboard, true);
    } else {
      await sendTelegramStatusMessage(chatId, detailText, void 0, keyboard);
    }
  } catch {
    if (returnSort.startsWith("serie_")) {
      const sPelserId = Number(returnSort.replace("serie_", ""));
      await sendOrEditSerieDetailInTelegram(chatId, messageId, sPelserId, returnPage);
    } else {
      await sendOrEditPictaDashboardInTelegram(chatId, messageId, returnSort, returnPage);
    }
  }
}
async function sendOrEditSerieDetailInTelegram(chatId, messageId, pelserId, page = 0, notice) {
  pendingPubEditByChat.delete(chatId);
  const isMaster = isMasterAdminChat(chatId);
  const seriesList = await syncAndGetChannelSeries(chatId);
  const serie = seriesList.find((s) => Number(s.pelser_id) === Number(pelserId)) || seriesList[0];
  if (!serie) {
    await sendOrEditMyChannelSeriesMenu(chatId, messageId);
    return;
  }
  const cleanSName = cleanSerieDisplayName(serie.nombre) || serie.nombre;
  const chapters = [...serie.chapters || []].sort(
    (a, b) => a.temporada !== b.temporada ? a.temporada - b.temporada : a.numero - b.numero
  );
  const seasonsStr = serie.seasons.length > 0 ? serie.seasons.map((st) => `Temporada ${st.numero}`).join(", ") : "Temporada 1";
  const pinned = pinnedBatchSerieByChat.get(chatId);
  const isPinned = pinned && (Number(pinned.pelserId) === Number(serie.pelser_id) || cleanSerieDisplayName(pinned.serieName).toLowerCase() === cleanSName.toLowerCase());
  const pendingSerieJobs = transferJobs.filter(
    (j) => (isMaster || j.telegramChatId === chatId) && j.tipologiaId === 5 && j.stage !== "completed" && (Number(j.modelMetadata?.serie_pelser_id) === Number(serie.pelser_id) || cleanSerieDisplayName(String(j.modelMetadata?.serie || j.title)).toLowerCase().includes(cleanSName.toLowerCase()))
  );
  const PAGE_SIZE = 6;
  const totalPages = Math.max(1, Math.ceil(chapters.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const pageChapters = chapters.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const chapterLines = pageChapters.length > 0 ? pageChapters.map((c) => {
    const epTag = `T${c.temporada}:E${String(c.numero).padStart(2, "0")}`;
    const statusIcon = c.publicado === false ? "\u{1F648} Oculto" : "\u{1F7E2} Publicado";
    const convIcon = c.convertido === false ? " \xB7 \u23F3 Nomad" : "";
    return `\u2022 <b>${epTag}</b> \u2014 ${escapeHtml(c.nombre)}
   \u2514 ${statusIcon}${convIcon}`;
  }).join("\n\n") : "<i>A\xFAn no hay cap\xEDtulos registrados en esta serie. Activa el \u{1F4CC} Modo Serie Fija abajo y env\xEDa tus cap\xEDtulos.</i>";
  const pendingLines = pendingSerieJobs.length > 0 ? `

\u26A1 <b>Cap\xEDtulos en proceso / pendientes de reanudar (${pendingSerieJobs.length}):</b>
` + pendingSerieJobs.slice(0, 3).map(
    (pj) => `\u2022 \u23F3 <b>${escapeHtml(pj.title)}</b> \u2014 <i>${pj.stage === "downloading_mtproto" ? "Descargando MTProto" : pj.stage === "queued" ? "En cola" : "Listo para reanudar"}</i>`
  ).join("\n") : "";
  const text = (notice ? `${notice}

` : "") + `${hudHeader(`GESTOR DE SERIE \xB7 ${cleanSName}`)}
` + hudBox([
    `\u{1F4C1} <b>Temporadas:</b> ${escapeHtml(seasonsStr)}`,
    `\u{1F39E}\uFE0F <b>Cap\xEDtulos subidos:</b> <b>${chapters.length}</b> cap\xEDtulo(s)`,
    `\u{1F4CC} <b>Modo Serie Fija:</b> ${isPinned ? `\u{1F7E2} <b>ACTIVO (T${pinned?.seasonNum})</b>` : "\u26AA Inactivo"}`
  ]) + `
${hudSection(`Cap\xEDtulos Subidos (P\xE1g. ${safePage + 1}/${totalPages})`)}

${chapterLines}${pendingLines}

\u{1F447} <i>Pulsa sobre cualquier cap\xEDtulo para editar sus datos, renumerarlo o eliminarlo:</i>`;
  const keyboard = [];
  for (const c of pageChapters) {
    const epTag = `T${c.temporada}:E${String(c.numero).padStart(2, "0")}`;
    keyboard.push([
      {
        text: `\u{1F6E0}\uFE0F Editar ${epTag}`,
        callback_data: `dash_pub:${c.pubId}:serie_${serie.pelser_id}:${safePage}`
      },
      {
        text: `\u{1F522} N\xBA ${epTag}`,
        callback_data: `pub_edit:epnum:${c.pubId}:serie_${serie.pelser_id}:${safePage}`
      },
      {
        text: `\u{1F5D1}\uFE0F Borrar`,
        callback_data: `pub_del_ask:${c.pubId}:serie_${serie.pelser_id}:${safePage}`
      }
    ]);
  }
  for (const pj of pendingSerieJobs.slice(0, 2)) {
    if (pj.stage === "cancelled" || pj.stage === "failed") {
      keyboard.push([
        {
          text: `\u{1F504} Reanudar Subida: "${pj.title.slice(0, 28)}"`,
          callback_data: `retry:${pj.id}`
        }
      ]);
    }
  }
  if (totalPages > 1) {
    const navRow = [];
    if (safePage > 0) {
      navRow.push({
        text: "\u2B05\uFE0F Anterior",
        callback_data: `serie_manage:${serie.pelser_id}:${safePage - 1}`
      });
    }
    navRow.push({
      text: `\u{1F4C4} ${safePage + 1}/${totalPages}`,
      callback_data: `serie_manage:${serie.pelser_id}:${safePage}`
    });
    if (safePage < totalPages - 1) {
      navRow.push({
        text: "Siguiente \u27A1\uFE0F",
        callback_data: `serie_manage:${serie.pelser_id}:${safePage + 1}`
      });
    }
    keyboard.push(navRow);
  }
  const maxSeason = serie.seasons.reduce((acc, st) => Math.max(acc, Number(st.numero || 1)), 1);
  const activeSeasonObj = serie.seasons.find((st) => Number(st.numero) === maxSeason) || serie.seasons[0];
  const nextSeason = maxSeason + 1;
  keyboard.push([
    {
      text: isPinned ? `\u{1F7E2} Serie Fija Activa (T${maxSeason}) \xB7 Desactivar` : `\u{1F4CC} Activar Modo Serie Fija (${cleanSName.slice(0, 14)} T${maxSeason})`,
      callback_data: isPinned ? "unpin_serie" : `pin_serie:${serie.pelser_id}:${maxSeason}:${activeSeasonObj?.id || 0}`
    }
  ]);
  keyboard.push([
    {
      text: "\u270F\uFE0F Nombre Serie",
      callback_data: `serie_meta_edit:name:${serie.pelser_id}`
    },
    {
      text: "\u{1F4DD} Sinopsis Serie",
      callback_data: `serie_meta_edit:synopsis:${serie.pelser_id}`
    }
  ]);
  keyboard.push([
    {
      text: "\u{1F5BC}\uFE0F Portada Serie",
      callback_data: `serie_meta_edit:portada:${serie.pelser_id}`
    },
    {
      text: "\u{1F39E}\uFE0F P\xF3ster Serie",
      callback_data: `serie_meta_edit:poster:${serie.pelser_id}`
    }
  ]);
  keyboard.push([
    {
      text: `\u2795 Crear Temporada ${nextSeason}`,
      callback_data: `standalone_season_create:${serie.pelser_id}:${nextSeason}`
    },
    {
      text: "\u{1F5D1}\uFE0F Eliminar Serie",
      callback_data: `serie_del_ask:${serie.pelser_id}`
    }
  ]);
  keyboard.push([
    {
      text: "\u2B05\uFE0F Volver a Mis Series",
      callback_data: "my_series:0"
    }
  ]);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    await sendTelegramStatusMessage(chatId, text, void 0, keyboard);
  }
}
async function sendOrEditMyChannelSeriesMenu(chatId, messageId, replyToMessageId, notice) {
  pendingStandaloneSerieByChat.delete(chatId);
  const isMaster = isMasterAdminChat(chatId);
  let session = userSessions.get(chatId);
  if (!isMaster && session && !session.channelId) {
    await ensureGuestSessionChannelDiscovered(chatId).catch(() => null);
    session = userSessions.get(chatId);
  }
  if (!isMaster && !session?.channelId) {
    const text2 = `${hudHeader("SERIES \xB7 ACCESO REQUERIDO")}
` + hudBox([
      `\u{1F512} <b>Estado:</b> Cuenta de Picta sin vincular`,
      `\u{1F449} Usa /login para gestionar las series y cap\xEDtulos de tu canal.`
    ]);
    const keyboard2 = [
      [{ text: "\u{1F511} Iniciar Sesi\xF3n (/login)", callback_data: "cmd_login" }],
      [{ text: "\u25C8 Men\xFA Principal", callback_data: "cmd_start" }]
    ];
    if (messageId) {
      await editTelegramStatusMessage(chatId, messageId, text2, keyboard2, true);
    } else {
      await sendTelegramStatusMessage(chatId, text2, replyToMessageId, keyboard2);
    }
    return;
  }
  const ctx = getEffectivePictaContext(chatId);
  const seriesList = await syncAndGetChannelSeries(chatId);
  const serieLines = seriesList.length > 0 ? seriesList.slice(0, 12).map((s, idx) => {
    const cleanSName = cleanSerieDisplayName(s.nombre) || s.nombre;
    const seasonsStr = s.seasons.length > 0 ? s.seasons.map((st) => `T${st.numero}`).join(", ") : "T1";
    const caps = [...s.chapters || []].sort(
      (a, b) => a.temporada !== b.temporada ? a.temporada - b.temporada : a.numero - b.numero
    );
    const capsBadge = caps.length > 0 ? `<b>${caps.length}</b> subido(s) (${caps.map((c) => `E${String(c.numero).padStart(2, "0")}`).join(", ")})` : "0 cap\xEDtulos subidos";
    return `<b>${idx + 1}. \u{1F4FA} ${escapeHtml(cleanSName)}</b>
   \u251C \u{1F4C1} Temporadas: <b>${seasonsStr}</b>
   \u2514 \u{1F39E}\uFE0F Cap\xEDtulos: ${capsBadge}`;
  }).join("\n\n") : "<i>A\xFAn no hay series registradas. Pulsa el bot\xF3n de abajo para crear una nueva serie en tu canal en 1 clic.</i>";
  const pinned = pinnedBatchSerieByChat.get(chatId);
  const pinnedBanner = pinned ? hudBox([
    `\u{1F4CC} <b>Modo Serie Fija ACTIVO:</b> ${escapeHtml(cleanSerieDisplayName(pinned.serieName))} \xB7 <code>T${escapeHtml(pinned.seasonNum)}</code>`,
    `<i>Cualquier video enviado ahora se subir\xE1 en r\xE1faga autom\xE1tica sin preguntas.</i>`
  ]) + "\n" : "";
  const text = (notice ? `${notice}

` : "") + `${hudHeader(`SERIES Y CAP\xCDTULOS \xB7 ${ctx.channelName || "MI CANAL"}`)}
` + hudBox([
    `\u{1F4FA} <b>Canal:</b> ${escapeHtml(ctx.channelName || "Mi Canal")} \xB7 <b>${seriesList.length}</b> serie(s)`,
    `\u26A1 Toca una serie para ver/editar cap\xEDtulos o activa el <b>Modo R\xE1faga</b>.`
  ]) + `
${pinnedBanner}${hudSection("Cat\xE1logo de Series")}
${serieLines}

\u{1F447} <i>Selecciona una serie para administrarla o fijarla:</i>`;
  const keyboard = [];
  for (const s of seriesList.slice(0, 8)) {
    const cleanSName = cleanSerieDisplayName(s.nombre) || s.nombre;
    const capCount = (s.chapters || []).length;
    const maxSeason = s.seasons.reduce((acc, st) => Math.max(acc, Number(st.numero || 1)), 1);
    const activeSeasonObj = s.seasons.find((st) => Number(st.numero) === maxSeason) || s.seasons[0];
    const isPinned = pinned && (Number(pinned.pelserId) === Number(s.pelser_id) || cleanSerieDisplayName(pinned.serieName).toLowerCase() === cleanSName.toLowerCase());
    keyboard.push([
      {
        text: `\u{1F4C2} ${cleanSName.slice(0, 16)}: Ver Cap\xEDtulos (${capCount})`,
        callback_data: `serie_manage:${s.pelser_id}:0`
      },
      {
        text: `${isPinned ? "\u{1F7E2} Fijada" : "\u{1F4CC} Fijar R\xE1faga"} (T${maxSeason})`,
        callback_data: `pin_serie:${s.pelser_id}:${maxSeason}:${activeSeasonObj?.id || 0}`
      }
    ]);
  }
  keyboard.push([
    {
      text: "\u2795 Crear Nueva Serie en mi Canal",
      callback_data: "standalone_serie_new"
    }
  ]);
  if (pinned) {
    keyboard.push([
      {
        text: `\u{1F513} Desactivar Modo Serie Fija (${cleanSerieDisplayName(pinned.serieName).slice(0, 18)} T${pinned.seasonNum})`,
        callback_data: "unpin_serie"
      }
    ]);
  }
  keyboard.push([
    { text: "\u{1F4CB} Ver Cola (/cola)", callback_data: "queue_view" },
    { text: "\u{1F4CA} Ir al Dashboard", callback_data: "dash_refresh:views:0" }
  ]);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    await sendTelegramStatusMessage(chatId, text, replyToMessageId, keyboard);
  }
}
async function promptSeriesSelectionForJob(job, chatId, messageId) {
  job.stage = "awaiting_series_selection";
  job.tipologiaId = 5;
  job.category = "Serie";
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  pendingManualTitleByChat.set(chatId, job.id);
  currentActivity = `Seleccionando Serie del canal para "${job.fileName}"`;
  saveJobsToDisk();
  const serieInfo = extractSeriesInfoFromText(job.fileName, job.caption);
  const existingMeta = job.modelMetadata || {};
  const existingSerieStr = String(existingMeta.serie || "");
  const detectedName = String(
    !serieInfo.missingSerieName ? serieInfo.serieName : !isGenericOrInvalidSerieName(existingSerieStr) ? existingSerieStr : ""
  );
  const detectedTemp = String(serieInfo.temporada || existingMeta.temporada || "1");
  const detectedEp = String(serieInfo.numero || existingMeta.numero || "1");
  const detectedSub = String(serieInfo.episodeSubtitle || existingMeta.episodeSubtitle || "").trim();
  job.modelMetadata = {
    ...existingMeta,
    ...detectedName ? { serie: detectedName } : {},
    temporada: String(detectedTemp),
    numero: String(detectedEp),
    ...detectedSub ? { episodeSubtitle: detectedSub } : {}
  };
  if (detectedName) {
    job.title = formatSerieEpisodeTitle(detectedName, detectedTemp, detectedEp, detectedSub);
  }
  const ctx = getEffectivePictaContext(chatId);
  const targetChName = job.targetChannelName || ctx.channelName || "Mi Canal";
  const targetChId = job.targetChannelId || ctx.channelId || "";
  if (isStaleOrGenericSerieSynopsis(job.synopsis, job.caption, detectedEp)) {
    job.synopsis = detectedName ? `Cap\xEDtulo ${detectedEp} de la Temporada ${detectedTemp} de la serie ${cleanSerieDisplayName(detectedName)}${detectedSub ? ` titulado "${detectedSub}"` : ""}, disponible en el canal ${targetChName}.` : "";
  }
  saveJobsToDisk();
  const channelSeries = await syncAndGetChannelSeries(chatId);
  const sortedSeries = [...channelSeries].sort((a, b) => {
    if (!detectedName) return 0;
    const aMatch = a.nombre.toLowerCase().includes(detectedName.toLowerCase()) ? 1 : 0;
    const bMatch = b.nombre.toLowerCase().includes(detectedName.toLowerCase()) ? 1 : 0;
    return bMatch - aMatch;
  });
  const exactChannelMatch = detectedName ? sortedSeries.find(
    (s) => s.nombre.toLowerCase().trim() === detectedName.toLowerCase().trim()
  ) : void 0;
  const chTag = targetChId ? `${targetChName} (#${targetChId})` : targetChName;
  const text = `${hudHeader(`SELECCIONAR O CREAR SERIE \xB7 ${chTag}`)}
` + hudBox([
    `\u{1F4C4} <b>Archivo:</b> <code>${escapeHtml(job.fileName)}</code>`,
    `\u{1F916} <b>Detectado:</b> ${detectedName ? `<b>${escapeHtml(detectedName)}</b> \xB7 ` : "<i>Sin nombre en archivo</i> \xB7 "}<code>T${detectedTemp}:E${String(detectedEp).padStart(2, "0")}</code>`,
    serieInfo.episodeSubtitle ? `\u{1F3F7}\uFE0F <b>T\xEDtulo cap.:</b> <i>${escapeHtml(serieInfo.episodeSubtitle)}</i>` : void 0
  ]) + `
\u{1F4C2} <b>Elige una Serie de tu canal${targetChId ? ` (#${escapeHtml(targetChId)})` : ""}</b> o crea una nueva:`;
  const keyboard = [];
  if (detectedName && !exactChannelMatch) {
    keyboard.push([
      {
        text: `\u2795 Crear serie "${detectedName.slice(0, 24)}" en mi canal (1 clic)`,
        callback_data: `serie_create_auto:${job.id}`
      }
    ]);
  }
  for (const s of sortedSeries.slice(0, 8)) {
    const isMatched = detectedName && s.nombre.toLowerCase().includes(detectedName.toLowerCase());
    const seasonsBadge = s.seasons.length > 0 ? ` (${s.seasons.map((st) => `T${st.numero}`).join(",")})` : "";
    keyboard.push([
      {
        text: `${isMatched ? "\u2B50 " : "\u{1F4FA} "}${s.nombre.slice(0, 28)}${seasonsBadge}`,
        callback_data: `serie_pick:${s.pelser_id}:${job.id}`
      }
    ]);
  }
  keyboard.push([
    {
      text: "\u270D\uFE0F Crear Nueva Serie en mi Canal (Escribir nombre)",
      callback_data: `serie_create_new:${job.id}`
    }
  ]);
  keyboard.push([
    {
      text: "\u2B05\uFE0F Cambiar Categor\xEDa",
      callback_data: `back_cats:${job.id}`
    }
  ]);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    const sentId = await sendTelegramStatusMessage(chatId, text, job.telegramMessageId, keyboard);
    if (sentId) {
      job.statusMessageId = sentId;
      saveJobsToDisk();
    }
  }
}
async function promptSeasonSelectionForJob(job, chatId, messageId, pelserId, serieName, bannerNotice) {
  job.stage = "awaiting_season_selection";
  const meta = job.modelMetadata || {};
  const serieInfo = extractSeriesInfoFromText(job.fileName, job.caption);
  const tempNum = String(meta.temporada || serieInfo.temporada || "1").replace(/\D/g, "") || "1";
  const epNum = String(meta.numero || serieInfo.numero || "1").replace(/\D/g, "") || "1";
  const epSub = String(meta.episodeSubtitle || serieInfo.episodeSubtitle || "").trim();
  const inheritedStyle = resolveSeriesStyleForChannel(chatId, pelserId, serieName);
  job.modelMetadata = {
    ...meta,
    serie: serieName,
    serie_pelser_id: String(pelserId),
    temporada: tempNum,
    numero: epNum,
    ...epSub ? { episodeSubtitle: epSub } : {}
  };
  delete job.modelMetadata.needsManualTitle;
  job.title = inheritedStyle ? formatEpisodeWithSeriesStyle(inheritedStyle, {
    serieName,
    temporada: tempNum,
    numero: epNum,
    episodeSubtitle: epSub
  }) : formatSerieEpisodeTitle(serieName, tempNum, epNum, epSub);
  const ctx = getEffectivePictaContext(chatId);
  const targetChName = job.targetChannelName || ctx.channelName || "Mi Canal";
  const targetChId = job.targetChannelId || ctx.channelId || "";
  if (isStaleOrGenericSerieSynopsis(job.synopsis, job.caption, epNum)) {
    job.synopsis = `Cap\xEDtulo ${epNum} de la Temporada ${tempNum} de la serie ${cleanSerieDisplayName(serieName)}${epSub ? ` titulado "${epSub}"` : ""}, disponible en el canal ${targetChName}.`;
  }
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  pendingManualTitleByChat.set(chatId, job.id);
  currentActivity = `Confirmando Temporada y Cap\xEDtulo para "${serieName}"`;
  saveJobsToDisk();
  const serieRecord = findUserChannelSerie(pelserId, chatId) || filterSeriesForChannel(channelSeriesCache, targetChId, isMasterAdminChat(chatId)).find(
    (s) => s.nombre.toLowerCase().trim() === serieName.toLowerCase().trim()
  );
  const existingSeasons = serieRecord?.seasons || [];
  const maxSeason = existingSeasons.reduce((acc, s) => Math.max(acc, Number(s.numero || 1)), Number(tempNum) || 1);
  const nextSeason = maxSeason + 1;
  const text = (bannerNotice ? `${bannerNotice}

` : "") + `${hudHeader(`SERIE SELECCIONADA \xB7 ${serieName}`)}
` + hudBox([
    `\u{1F3DB}\uFE0F <b>Canal:</b> ${escapeHtml(targetChName)}${targetChId ? ` \xB7 <code>#${escapeHtml(targetChId)}</code>` : ""}`,
    `\u{1F194} <b>ID Serie Picta:</b> <code>${pelserId}</code>`,
    `\u{1F4C1} <b>Temporada detectada:</b> Temporada ${tempNum} \xB7 \u{1F39E}\uFE0F <b>Cap\xEDtulo:</b> ${epNum}`,
    inheritedStyle ? `\u{1F3A8} <b>Formato heredado (${inheritedStyle.sampleCount} caps):</b> <code>${escapeHtml(inheritedStyle.description)}</code>` : void 0,
    `\u{1F4CC} <b>T\xEDtulo final:</b> <code>${escapeHtml(job.title)}</code>`
  ]) + `
\u{1F447} <b>Confirma con 1 clic</b>, elige otra temporada o <b>escribe en el chat <code>Temporada | Cap\xEDtulo</code></b> (ej: <code>${tempNum} | ${epNum}</code>):`;
  const matchedSeasonObj = existingSeasons.find((st) => Number(st.numero) === Number(tempNum));
  const keyboard = [
    [
      {
        text: `\u2705 Confirmar T${tempNum}:E${epNum.padStart(2, "0")} y Continuar`,
        callback_data: `serie_confirm_tc:${tempNum}:${epNum}:${job.id}`
      }
    ],
    [
      {
        text: `\u{1F4CC} Subir este y FIJAR "${serieName.slice(0, 16)}" (T${tempNum}) para r\xE1faga`,
        callback_data: `pin_serie_and_start:${pelserId}:${tempNum}:${matchedSeasonObj?.id || 0}:${job.id}`
      }
    ]
  ];
  if (existingSeasons.length > 0) {
    const seasonRow = [];
    for (const st of existingSeasons.slice(0, 4)) {
      seasonRow.push({
        text: Number(st.numero) === Number(tempNum) ? `\u2705 Temp. ${st.numero}` : `\u{1F4C1} Temp. ${st.numero}`,
        callback_data: `serie_season_pick:${st.numero}:${st.id}:${job.id}`
      });
    }
    keyboard.push(seasonRow);
  }
  keyboard.push([
    {
      text: `\u2795 Crear Temporada ${nextSeason} en Picta (1 clic)`,
      callback_data: `serie_season_create:${pelserId}:${nextSeason}:${job.id}`
    }
  ]);
  keyboard.push([
    {
      text: "\u2B05\uFE0F Elegir otra Serie",
      callback_data: `cat:5:${job.id}`
    }
  ]);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    const sentId = await sendTelegramStatusMessage(chatId, text, job.telegramMessageId, keyboard);
    if (sentId) {
      job.statusMessageId = sentId;
      saveJobsToDisk();
    }
  }
}
async function promptStep1Title(job, chatId, messageId) {
  job.stage = "awaiting_step_title";
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  pendingManualTitleByChat.set(chatId, job.id);
  currentActivity = `Paso 1/4 (T\xEDtulo) para "${job.fileName}" (${job.category})`;
  saveJobsToDisk();
  const isSerie = job.tipologiaId === 5;
  const analyzedNaming = analyzeVideoTitleAndSynopsis(job.fileName, job.caption);
  const serieInfo = isSerie ? analyzedNaming.seriesInfo : null;
  let inheritedStyle = null;
  if (isSerie && serieInfo) {
    const existingMeta = job.modelMetadata || {};
    const existingSerieStr = String(existingMeta.serie || "");
    const finalSerieName = !isGenericOrInvalidSerieName(existingSerieStr) ? existingSerieStr : !serieInfo.missingSerieName ? serieInfo.serieName : "";
    const finalTemp = existingMeta.temporada || serieInfo.temporada || "1";
    const finalEp = existingMeta.numero || serieInfo.numero || "1";
    const finalSub = String(existingMeta.episodeSubtitle || serieInfo.episodeSubtitle || "").trim();
    const pelserId = Number(existingMeta.serie_pelser_id || 0);
    inheritedStyle = finalSerieName ? resolveSeriesStyleForChannel(chatId, pelserId, finalSerieName) : null;
    job.modelMetadata = {
      ...existingMeta,
      ...finalSerieName ? { serie: finalSerieName } : {},
      temporada: String(finalTemp),
      numero: String(finalEp),
      ...finalSub ? { episodeSubtitle: finalSub } : {}
    };
    if (finalSerieName) {
      delete job.modelMetadata.needsManualTitle;
      job.title = inheritedStyle ? formatEpisodeWithSeriesStyle(inheritedStyle, {
        serieName: String(finalSerieName),
        temporada: String(finalTemp),
        numero: String(finalEp),
        episodeSubtitle: finalSub
      }) : formatSerieEpisodeTitle(
        String(finalSerieName),
        String(finalTemp),
        String(finalEp),
        finalSub
      );
      if (isStaleOrGenericSerieSynopsis(job.synopsis, job.caption, String(finalEp))) {
        const chName = job.targetChannelName || getEffectivePictaContext(chatId).channelName || "Mi Canal";
        job.synopsis = `Cap\xEDtulo ${finalEp} de la Temporada ${finalTemp} de la serie ${cleanSerieDisplayName(String(finalSerieName))}${finalSub ? ` titulado "${finalSub}"` : ""}, disponible en el canal ${chName}.`;
      }
    }
  } else {
    const existingTitle = String(job.title || "").trim();
    const needsAskManual = job.modelMetadata?.needsManualTitle === "true" || !existingTitle && analyzedNaming.needsManualTitle || analyzedNaming.needsManualTitle && isRandomOrCrypticFilename(existingTitle);
    if (needsAskManual) {
      job.title = "";
      job.modelMetadata = {
        ...job.modelMetadata || {},
        needsManualTitle: "true"
      };
    } else if (!existingTitle || existingTitle === "Pendiente de elecci\xF3n...") {
      job.title = analyzedNaming.initialTitle || cleanGeneralVideoTitle(job.fileName) || job.fileName;
      if (job.modelMetadata) delete job.modelMetadata.needsManualTitle;
    }
  }
  saveJobsToDisk();
  const missingRealTitle = (!isSerie || !job.modelMetadata?.serie) && (job.modelMetadata?.needsManualTitle === "true" || !job.title || isRandomOrCrypticFilename(job.title));
  const serieDetectionBanner = isSerie && job.modelMetadata?.serie ? `\u{1F4FA} <b>Serie vinculada:</b> ${escapeHtml(String(job.modelMetadata.serie))} \xB7 <b>T${escapeHtml(String(job.modelMetadata.temporada || "1"))}:E${escapeHtml(String(job.modelMetadata.numero || "1").padStart(2, "0"))}</b>` + (job.modelMetadata?.episodeSubtitle ? ` \xB7 <i>"${escapeHtml(String(job.modelMetadata.episodeSubtitle))}"</i>` : "") : "";
  const serieTitleOptions = isSerie && !missingRealTitle ? buildSerieTitleOptions({
    serieName: String(job.modelMetadata?.serie || "Serie"),
    temporada: String(job.modelMetadata?.temporada || "1"),
    numero: String(job.modelMetadata?.numero || "1"),
    episodeSubtitle: String(job.modelMetadata?.episodeSubtitle || ""),
    rawCaption: job.caption,
    inheritedStyle
  }) : [];
  const text = `${hudHeader("ASISTENTE DE PUBLICACI\xD3N", `${renderWizardStepBar(1)} \xB7 T\xCDTULO`)}
` + hudBox([
    `\u{1F4C2} <b>Categor\xEDa:</b> ${escapeHtml(job.category)}`,
    `\u{1F4C4} <b>Archivo:</b> <code>${escapeHtml(job.fileName)}</code> (${formatBytes(job.expectedBytes)})`,
    analyzedNaming.titleSource === "caption" && analyzedNaming.filenameIsRandom ? `\u{1F4AC} <b>Fuente elegida:</b> Caption del mensaje (archivo con nombre aleatorio ignorado)` : void 0,
    serieDetectionBanner ? serieDetectionBanner : void 0,
    inheritedStyle ? `\u{1F3A8} <b>Formato de serie previo (${inheritedStyle.sampleCount} caps):</b> <code>${escapeHtml(inheritedStyle.sampleTitle.slice(0, 42))}</code>` : void 0,
    missingRealTitle ? `\u26A0\uFE0F <b>Nombre aleatorio / sin t\xEDtulo reconocible:</b> B\xFAsqueda en IMDb pausada hasta recibir el t\xEDtulo real` : `\u{1F4CC} <b>T\xEDtulo propuesto:</b> <code>${escapeHtml(job.title)}</code>`
  ]) + `
` + (missingRealTitle ? `\u270D\uFE0F <b>Escribe ahora en el chat el t\xEDtulo real</b> (ej: <i>El Padrino 1972</i> o <i>Dune Parte 2</i>) para buscar su ficha e IMDb correctamente:` : isSerie && serieTitleOptions.length > 0 ? `\u{1F447} <b>Elige el formato de t\xEDtulo</b>, busca en <b>IMDb / TMDB</b> o escribe el t\xEDtulo en el chat:` : `\u270D\uFE0F <b>Escribe otro t\xEDtulo en el chat</b>, confirma el propuesto o busca en <b>IMDb / TMDB</b>:`);
  const keyboard = [];
  if (missingRealTitle) {
    keyboard.push([
      {
        text: "\u2B05\uFE0F Cambiar Categor\xEDa",
        callback_data: `back_cats:${job.id}`
      },
      {
        text: "\u{1F6D1} Cancelar",
        callback_data: `cancel_job:${job.id}`
      }
    ]);
  } else if (isSerie && serieTitleOptions.length > 0) {
    serieTitleOptions.forEach((opt, idx) => {
      keyboard.push([
        {
          text: opt.buttonLabel,
          callback_data: `step1_opt:${idx}:${job.id}`
        }
      ]);
    });
    keyboard.push([
      {
        text: "\u{1F916} Buscar t\xEDtulo y sinopsis oficial (IMDb / TMDB)",
        callback_data: `step1_ai:${job.id}`
      }
    ]);
    keyboard.push(
      [
        {
          text: "\u26A1 Subir directo (Autorrellenar los 4 pasos)",
          callback_data: `auto:${job.id}`
        }
      ],
      [
        {
          text: "\u2B05\uFE0F Volver a Selecci\xF3n de Serie",
          callback_data: `cat:5:${job.id}`
        }
      ]
    );
  } else {
    keyboard.push([
      {
        text: `\u2705 Confirmar t\xEDtulo: "${job.title.slice(0, 26)}"`,
        callback_data: `step1_keep:${job.id}`
      }
    ]);
    keyboard.push([
      {
        text: "\u{1F50D} Buscar en IMDb / TMDB (Top 3 / Auto)",
        callback_data: `step1_imdb:${job.id}`
      }
    ]);
    keyboard.push(
      [
        {
          text: "\u26A1 Subir directo (Autorrellenar los 4 pasos)",
          callback_data: `auto:${job.id}`
        }
      ],
      [
        {
          text: "\u2B05\uFE0F Cambiar Categor\xEDa",
          callback_data: `back_cats:${job.id}`
        }
      ]
    );
  }
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    const sentId = await sendTelegramStatusMessage(chatId, text, job.telegramMessageId, keyboard);
    if (sentId) {
      job.statusMessageId = sentId;
      saveJobsToDisk();
    }
  }
}
async function promptImdbDisambiguationTop3(job, chatId, messageId, candidates, nextStep, query, seasonNum, epNum) {
  const top3 = candidates.slice(0, 3);
  pendingOnlineCandidatesByJob.set(job.id, {
    candidates: top3,
    nextStep,
    seasonNum,
    epNum,
    query
  });
  pendingManualTitleByChat.set(chatId, job.id);
  job.stage = "awaiting_step_title";
  saveJobsToDisk();
  const lines = top3.map((c, idx) => {
    const kind = c.mediaType === "tv" ? "\u{1F4FA} Serie" : "\u{1F3AC} Pel\xEDcula";
    const yr = c.year ? ` (${c.year})` : "";
    const orig = c.originalTitle && c.originalTitle.toLowerCase() !== c.title.toLowerCase() ? ` \xB7 <i>${escapeHtml(c.originalTitle)}</i>` : "";
    return `${idx + 1}. <b>${escapeHtml(c.title)}${escapeHtml(yr)}</b> \xB7 ${kind}${orig}`;
  });
  const text = `${hudHeader("VARIOS RESULTADOS EN IMDb / TMDB", "ELIGE EL EXACTO")}
` + hudBox([
    `\u{1F50D} <b>B\xFAsqueda:</b> <code>${escapeHtml(query)}</code>`,
    ...lines
  ]) + `
\u{1F447} <b>Selecciona el resultado correcto</b> con 1 toque o escribe un t\xEDtulo m\xE1s espec\xEDfico (con a\xF1o):`;
  const keyboard = top3.map((c, idx) => {
    const icon = c.mediaType === "tv" ? "\u{1F4FA}" : "\u{1F3AC}";
    const yr = c.year ? ` (${c.year})` : "";
    return [
      {
        text: `${icon} ${c.title.slice(0, 26)}${yr}`,
        callback_data: `imdb_pick:${idx}:${job.id}`
      }
    ];
  });
  keyboard.push([
    { text: "\u270D\uFE0F Escribir otro t\xEDtulo", callback_data: `imdb_retype:${job.id}` },
    { text: "\u23ED\uFE0F Continuar sin elegir", callback_data: `imdb_skip:${nextStep}:${job.id}` }
  ]);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    const sentId = await sendTelegramStatusMessage(chatId, text, job.telegramMessageId, keyboard);
    if (sentId) {
      job.statusMessageId = sentId;
      saveJobsToDisk();
    }
  }
}
async function applyEnrichmentToWizardJob(job, chatId, options) {
  const chInfo = resolveJobTargetChannelInfo(job);
  const meta = job.modelMetadata || {};
  const pelserId = Number(meta.serie_pelser_id || 0);
  const serieStr = meta.serie ? String(meta.serie) : void 0;
  const inheritedStyle = job.tipologiaId === 5 && serieStr ? resolveSeriesStyleForChannel(chatId, pelserId, serieStr) : null;
  const generated = await generateVideoMetadataWithAI(
    job.fileName,
    job.caption,
    options.forceTitleUpdate ? void 0 : job.title || void 0,
    job.category,
    job.tipologiaId,
    chInfo.channelName,
    job.tipologiaId === 5 ? {
      serieName: serieStr,
      temporada: meta.temporada ? String(meta.temporada) : void 0,
      numero: meta.numero ? String(meta.numero) : void 0,
      episodeSubtitle: meta.episodeSubtitle ? String(meta.episodeSubtitle) : void 0,
      inheritedStyle,
      preResolvedOnlineInfo: options.preResolvedOnlineInfo || null
    } : {
      preResolvedOnlineInfo: options.preResolvedOnlineInfo || null
    }
  );
  if (generated.modelMetadata) {
    job.modelMetadata = { ...generated.modelMetadata, ...job.modelMetadata || {} };
    if (generated.modelMetadata.onlineCoverUrl) {
      job.modelMetadata.onlineCoverUrl = generated.modelMetadata.onlineCoverUrl;
    }
    if (generated.modelMetadata.onlinePosterUrl) {
      job.modelMetadata.onlinePosterUrl = generated.modelMetadata.onlinePosterUrl;
    }
    if (generated.modelMetadata.onlineBackdropUrl) {
      job.modelMetadata.onlineBackdropUrl = generated.modelMetadata.onlineBackdropUrl;
    }
    if (options.preResolvedOnlineInfo?.rating) {
      job.modelMetadata.calificacion = String(options.preResolvedOnlineInfo.rating);
    } else if (generated.modelMetadata.calificacion && !job.modelMetadata.calificacion) {
      job.modelMetadata.calificacion = String(generated.modelMetadata.calificacion);
    }
  }
  if (options.forceTitleUpdate) {
    if (job.tipologiaId !== 5 && options.preResolvedOnlineInfo?.title) {
      job.title = options.preResolvedOnlineInfo.year ? `${options.preResolvedOnlineInfo.title} (${options.preResolvedOnlineInfo.year})` : options.preResolvedOnlineInfo.title;
    } else if (generated.title) {
      job.title = generated.title;
    }
    job.titleMode = "manual";
  } else if (options.preResolvedOnlineInfo?.title && job.tipologiaId !== 5 && (!job.title || isRandomOrCrypticFilename(job.title))) {
    job.title = options.preResolvedOnlineInfo.title;
  }
  const shouldUseGenSyn = job.tipologiaId === 5 ? isStaleOrGenericSerieSynopsis(job.synopsis, job.caption, String(meta.numero || "1")) : isGenericAutoSynopsis(job.synopsis, job.caption);
  if (generated.synopsis && (options.forceSynopsisUpdate || shouldUseGenSyn)) {
    job.synopsis = generated.synopsis;
  }
  saveJobsToDisk();
}
async function promptStep2Synopsis(job, chatId, messageId) {
  job.stage = "awaiting_step_synopsis";
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  pendingManualTitleByChat.set(chatId, job.id);
  currentActivity = `Paso 2/4 (Descripci\xF3n) para "${job.title}"`;
  if (job.synopsis && isGenericAutoSynopsis(job.synopsis, job.caption) && job.tipologiaId !== 5) {
    job.synopsis = "";
  }
  saveJobsToDisk();
  const hasValidDetectedSynopsis = Boolean(job.synopsis && job.synopsis.trim()) && !isGenericAutoSynopsis(job.synopsis, job.caption);
  const text = `${hudHeader("ASISTENTE DE PUBLICACI\xD3N", `${renderWizardStepBar(2)} \xB7 SINOPSIS`)}
` + hudBox([
    `\u2705 <b>1. T\xEDtulo:</b> ${escapeHtml(job.title)}`,
    `\u{1F4C2} <b>Categor\xEDa:</b> ${escapeHtml(job.category)}`,
    hasValidDetectedSynopsis ? `\u{1F4A1} <b>Sinopsis detectada:</b> <i>${escapeHtml(job.synopsis.slice(0, 140))}</i>` : void 0
  ]) + `
\u270D\uFE0F <b>Escribe ahora la sinopsis en el chat</b> o elige una opci\xF3n abajo:`;
  const keyboard = [
    [
      {
        text: "\u2728 Rellenar Sinopsis y Ficha con IA (IMDb / TMDB)",
        callback_data: `step2_ai:${job.id}`
      }
    ]
  ];
  if (hasValidDetectedSynopsis) {
    keyboard.push([
      {
        text: "\u2705 Usar sinopsis detectada del mensaje",
        callback_data: `step2_keep:${job.id}`
      }
    ]);
  }
  keyboard.push([
    {
      text: "\u2B05\uFE0F Volver a T\xEDtulo",
      callback_data: `step_back:1:${job.id}`
    },
    {
      text: "\u26A1 Saltar resto y Subir",
      callback_data: `step4_skip:${job.id}`
    }
  ]);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    const sentId = await sendTelegramStatusMessage(chatId, text, job.telegramMessageId, keyboard);
    if (sentId) {
      job.statusMessageId = sentId;
      saveJobsToDisk();
    }
  }
}
async function promptStep3Cover(job, chatId, messageId) {
  job.stage = "awaiting_step_cover";
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  pendingManualTitleByChat.set(chatId, job.id);
  currentActivity = `Paso 3/4 (Portada) para "${job.title}"`;
  const currentMeta = job.modelMetadata || {};
  if (!currentMeta.onlineCoverUrl) {
    try {
      const online = await searchMovieOrSeriesInfoOnline(
        job.title,
        Number(job.tipologiaId || 8),
        currentMeta.temporada ? Number(currentMeta.temporada) : void 0,
        currentMeta.numero ? Number(currentMeta.numero) : void 0
      );
      if (online?.imageUrl) {
        job.modelMetadata = {
          ...currentMeta,
          onlineCoverUrl: online.imageUrl,
          ...online.posterUrl ? { onlinePosterUrl: online.posterUrl } : {},
          ...online.backdropUrl ? { onlineBackdropUrl: online.backdropUrl } : {},
          ...online.year && !currentMeta.ano ? { ano: online.year } : {},
          ...online.director && !currentMeta.director ? { director: online.director } : {},
          ...online.reparto && !currentMeta.reparto ? { reparto: online.reparto } : {},
          ...online.pais && !currentMeta.pais ? { pais: online.pais } : {},
          ...online.genero && !currentMeta.genero ? { genero: online.genero } : {}
        };
      }
    } catch {
    }
  }
  saveJobsToDisk();
  const hasOfficialPoster = Boolean(job.modelMetadata?.onlineCoverUrl || job.modelMetadata?.onlinePosterUrl);
  const hasCustomPoster = Boolean(job.customPosterFileId);
  const hasCustomCover = Boolean(job.customCoverFileId);
  const text = `${hudHeader("ASISTENTE DE PUBLICACI\xD3N", `${renderWizardStepBar(3)} \xB7 PORTADA Y P\xD3STER`)}
` + hudBox([
    `\u2705 <b>1. T\xEDtulo:</b> ${escapeHtml(job.title)}`,
    `\u2705 <b>2. Sinopsis:</b> ${escapeHtml(job.synopsis ? job.synopsis.slice(0, 95) + (job.synopsis.length > 95 ? "..." : "") : "Autom\xE1tica con IA (TMDB/IMDb)")}`,
    `\u{1F3AC} <b>TMDB/IMDb:</b> ${hasOfficialPoster ? "\u{1F7E2} Portada 16:9 y P\xF3ster vertical listos" : "\u{1F50D} B\xFAsqueda autom\xE1tica al subir"}`,
    hasCustomCover ? `\u{1F5BC}\uFE0F <b>Portada propia:</b> \u2705 Cargada` : void 0,
    hasCustomPoster ? `\u{1F39E}\uFE0F <b>P\xF3ster vertical propio:</b> \u2705 Cargado` : void 0
  ]) + `
\u{1F4F8} <b>Env\xEDa una imagen al chat</b> para poner portada propia, o elige una opci\xF3n:`;
  const keyboard = [
    [
      {
        text: "\u{1F3AC} Aplicar Oficial HD (TMDB / IMDb)",
        callback_data: `step3_poster:${job.id}`
      }
    ],
    [
      {
        text: "\u{1F39E}\uFE0F Enviar P\xF3ster Vertical Propio (Opcional)",
        callback_data: `step3_set_poster:${job.id}`
      }
    ],
    [
      {
        text: "\u{1F5BC}\uFE0F Usar miniatura fotograma del video",
        callback_data: `step3_frame:${job.id}`
      }
    ],
    [
      {
        text: "\u2B05\uFE0F Volver a Sinopsis",
        callback_data: `step_back:2:${job.id}`
      },
      {
        text: "\u26A1 Subir Ahora",
        callback_data: `step4_skip:${job.id}`
      }
    ]
  ];
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    const sentId = await sendTelegramStatusMessage(chatId, text, job.telegramMessageId, keyboard);
    if (sentId) {
      job.statusMessageId = sentId;
      saveJobsToDisk();
    }
  }
}
async function promptStep4Subtitles(job, chatId, messageId) {
  job.stage = "awaiting_step_subtitles";
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  pendingManualTitleByChat.set(chatId, job.id);
  currentActivity = `Paso 4/4 (Subt\xEDtulos) para "${job.title}"`;
  saveJobsToDisk();
  const coverLabel = job.customCoverFileId ? "\u{1F4F8} Imagen personalizada enviada al chat" : job.modelMetadata?.preferVideoFrameCover === "true" ? "\u{1F5BC}\uFE0F Miniatura del fotograma del video" : "\u{1F3AC} Car\xE1tula Oficial HD (TMDB / IMDb)";
  const text = `${hudHeader("ASISTENTE DE PUBLICACI\xD3N", `${renderWizardStepBar(4)} \xB7 SUBT\xCDTULOS (OPCIONAL)`)}
` + hudBox([
    `\u2705 <b>1. T\xEDtulo:</b> ${escapeHtml(job.title)}`,
    `\u2705 <b>2. Sinopsis:</b> ${escapeHtml(job.synopsis ? job.synopsis.slice(0, 80) + (job.synopsis.length > 80 ? "..." : "") : "Autom\xE1tica con IA")}`,
    `\u2705 <b>3. Portada:</b> ${coverLabel}`
  ]) + `
\u{1F4CE} <b>Env\xEDa el archivo de subt\xEDtulos (<code>.srt</code> / <code>.vtt</code>)</b> o pulsa el bot\xF3n para iniciar la subida:`;
  const keyboard = [
    [
      {
        text: "\u{1F680} Sin subt\xEDtulos \xB7 Iniciar Subida Ahora",
        callback_data: `step4_skip:${job.id}`
      }
    ],
    [
      {
        text: "\u2B05\uFE0F Volver a Portada",
        callback_data: `step_back:3:${job.id}`
      }
    ]
  ];
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    const sentId = await sendTelegramStatusMessage(chatId, text, job.telegramMessageId, keyboard);
    if (sentId) {
      job.statusMessageId = sentId;
      saveJobsToDisk();
    }
  }
}
async function promptUploadAccountSelection(job, chatId, messageId) {
  ensureDailyQuotaReset();
  const poolAccounts = getPoolAccountsForChat(chatId);
  if (poolAccounts.length === 0) {
    job.preferredUploadAccountKey = "primary";
    job.preferredUploadAccountLabel = getPrimaryAccountLabelForChat(chatId);
    saveJobsToDisk();
    await startJobUploadWithSelectedAccount(job, chatId, messageId);
    return;
  }
  pendingManualTitleByChat.delete(chatId);
  job.stage = "awaiting_upload_account";
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  saveJobsToDisk();
  const { channelId: resolvedChId, channelName: resolvedChName } = resolveJobTargetChannelInfo(job);
  const primaryLabel = getPrimaryAccountLabelForChat(chatId);
  const isMaster = isMasterAdminChat(chatId);
  const todayCuba = getTodayCubaDateStr();
  const primaryUsedToday = isMaster ? Math.max(
    0,
    (quotaSettings.seriesUploadedToday || 0) + (quotaSettings.otherUploadedToday || 0) - poolAccounts.reduce((sum, a) => sum + (a.uploadedToday || 0), 0)
  ) : transferJobs.filter(
    (j) => j.telegramChatId === chatId && j.stage === "completed" && (!j.preferredUploadAccountKey || j.preferredUploadAccountKey === "primary") && toCubaDateStr(j.updatedAt || j.createdAt) === todayCuba
  ).length;
  const text = `${hudHeader("ELEGIR CUENTA DE SUBIDA")}
` + hudBox([
    `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title || job.fileName)}`,
    `\u{1F4C2} <b>Categor\xEDa:</b> ${escapeHtml(job.category || "Audiovisual")}`,
    `\u{1F4FA} <b>Canal destino:</b> ${escapeHtml(resolvedChName)}${resolvedChId ? ` \xB7 <code>#${escapeHtml(resolvedChId)}</code>` : ""}`,
    `\u{1F4E6} <b>Tama\xF1o:</b> ${formatBytes(job.expectedBytes)}`
  ]) + `
\u{1F447} <b>Selecciona con qu\xE9 cuenta deseas subir este video a tu canal:</b>`;
  const keyboard = [
    [
      {
        text: `\u{1F511} Principal: ${primaryLabel.slice(0, 22)} (${primaryUsedToday}/10)`,
        callback_data: `upload_acct:primary:${job.id}`
      }
    ]
  ];
  poolAccounts.forEach((acc, idx) => {
    const label = String(acc.displayName || acc.username || `Colaborador ${idx + 1}`).slice(0, 22);
    const roleHint = acc.canPublishDirectly === false ? " \xB7 Usuario com\xFAn" : "";
    keyboard.push([
      {
        text: `\u{1F91D} ${label} (${acc.uploadedToday || 0}/10${roleHint})`,
        callback_data: `upload_acct:pool:${idx}:${job.id}`
      }
    ]);
  });
  keyboard.push([
    {
      text: "\u2795 A\xF1adir Nuevo Colaborador al Pool",
      callback_data: `upload_acct_add:${job.id}`
    }
  ]);
  keyboard.push([
    {
      text: "\u{1F6D1} Cancelar",
      callback_data: `cancel_job:${job.id}`
    }
  ]);
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, text, keyboard, true);
  } else {
    const sentId = await sendTelegramStatusMessage(chatId, text, job.telegramMessageId, keyboard);
    if (sentId) {
      job.statusMessageId = sentId;
      saveJobsToDisk();
    }
  }
}
async function startJobUploadWithSelectedAccount(job, chatId, messageId) {
  pendingManualTitleByChat.delete(chatId);
  job.stage = job.minioKey ? "creating_picta_publication" : "generating_auto_title";
  job.errorDetails = void 0;
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  saveJobsToDisk();
  const { channelId: resolvedChId, channelName: resolvedChName } = resolveJobTargetChannelInfo(job);
  const acctLabel = job.preferredUploadAccountLabel || getPrimaryAccountLabelForChat(chatId);
  const summaryText = `${hudHeader("DESPLIEGUE INICIADO \xB7 SUBIENDO A PICTA")}
` + hudBox([
    `\u{1F464} <b>Cuenta de subida:</b> ${escapeHtml(acctLabel)}`,
    `\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title || job.fileName)}`,
    `\u{1F4C2} <b>Categor\xEDa:</b> ${escapeHtml(job.category)}`,
    `\u{1F4DD} <b>Descripci\xF3n:</b> ${escapeHtml(job.synopsis ? job.synopsis.slice(0, 100) : "Generando autom\xE1ticamente...")}`,
    `\u{1F5BC}\uFE0F <b>Portada:</b> ${job.customCoverFileId ? "Personalizada \u{1F4F8}" : "Autom\xE1tica \u{1F5BC}\uFE0F"}`,
    `\u{1F4AC} <b>Subt\xEDtulos:</b> ${job.subtitleFileName ? escapeHtml(job.subtitleFileName) : "Sin subt\xEDtulos externos"}`
  ]) + `
\u23F3 <i>${job.minioKey ? "Reutilizando video ya subido a S3 MinIO..." : "Descargando v\xEDa MTProto 2 GB y subiendo"} a ${escapeHtml(resolvedChName)}${resolvedChId ? ` (#${escapeHtml(resolvedChId)})` : ""}...</i>`;
  if (messageId) {
    await editTelegramStatusMessage(chatId, messageId, summaryText, void 0, true);
  } else {
    const sentId = await sendTelegramStatusMessage(chatId, summaryText, job.telegramMessageId);
    if (sentId) {
      job.statusMessageId = sentId;
      saveJobsToDisk();
    }
  }
  const customTitleArg = job.titleMode === "manual" && job.title ? job.title : "";
  await triggerCloudRunKeepAliveTransfer(job.id, customTitleArg, job.statusMessageId || messageId);
}
async function finalizeGuidedStepsAndStart(job, chatId, messageId) {
  pendingManualTitleByChat.delete(chatId);
  job.titleMode = "manual";
  job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  saveJobsToDisk();
  if (!job.preferredUploadAccountKey && getPoolAccountsForChat(chatId).length > 0) {
    await promptUploadAccountSelection(job, chatId, messageId);
    return;
  }
  await startJobUploadWithSelectedAccount(job, chatId, messageId);
}
async function handleTelegramUpdate(update) {
  if (externalCloudRunWebhookActive) {
    return;
  }
  if (!update || typeof update.update_id !== "number" && !update.message && !update.edited_message && !update.channel_post && !update.callback_query) {
    return;
  }
  if (!cloudVaultLoadedOnce) {
    await Promise.race([
      ensureCloudStateLoadedOnce(),
      new Promise((resolve) => setTimeout(resolve, 4e3))
    ]).catch(() => {
    });
  }
  if (typeof update?.update_id === "number") {
    if (processedUpdateIds.has(update.update_id)) {
      return;
    }
    addBoundedSetEntry(processedUpdateIds, update.update_id);
    if (update.update_id + 1 > lastUpdateOffset) {
      lastUpdateOffset = update.update_id + 1;
    }
    saveProcessedUpdatesToDisk();
  }
  lastWakeUpAt = (/* @__PURE__ */ new Date()).toISOString();
  const incomingGroupOrChannelMsg = update.channel_post || update.message;
  const incomingChatType = String(incomingGroupOrChannelMsg?.chat?.type || "");
  if (incomingGroupOrChannelMsg && !update.callback_query && (incomingChatType === "group" || incomingChatType === "supergroup" || incomingChatType === "channel")) {
    const monitoredCfg = findOwnerPromoConfigForGroupChat(
      String(incomingGroupOrChannelMsg.chat?.id || ""),
      incomingGroupOrChannelMsg.chat?.username
    );
    if (monitoredCfg) {
      if (!incomingGroupOrChannelMsg.from?.is_bot) {
        await handleMonitoredRequestsGroupMessage(monitoredCfg, incomingGroupOrChannelMsg);
      }
      return;
    }
  }
  const fromUser = update.callback_query?.from || update.message?.from || update.edited_message?.from;
  const rawSenderId = String(
    fromUser?.id || update.message?.chat?.id || update.callback_query?.message?.chat?.id || ""
  );
  const rawChatId = String(
    update.message?.chat?.id || update.callback_query?.message?.chat?.id || rawSenderId
  );
  const fromUsername = fromUser?.username || "";
  if (!isUserAuthorized(rawSenderId, fromUsername)) {
    if (update.message?.chat?.id && update.message?.chat?.type === "private") {
      await callTelegramBotApi("sendMessage", {
        chat_id: update.message.chat.id,
        text: `\u26D4 <b>No tienes permiso para usar este bot.</b>

Escr\xEDbeme a @ghosthell0210 para darte acceso.

\u{1F194} <i>Tu ID de Telegram:</i> <code>${rawSenderId}</code>`,
        parse_mode: "HTML"
      }).catch(() => {
      });
    } else if (update.callback_query?.id) {
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
        text: "\u26D4 No tienes permiso para usar el bot. Escr\xEDbeme a @ghosthell0210.",
        show_alert: true
      }).catch(() => {
      });
    }
    return;
  }
  if (update.callback_query) {
    const cq = update.callback_query;
    const cqId = String(cq.id || "");
    if (cqId && processedCallbackIds.has(cqId)) {
      return;
    }
    if (cqId) {
      addBoundedSetEntry(processedCallbackIds, cqId);
      saveProcessedUpdatesToDisk();
    }
    const data = cq.data || "";
    const chatId2 = String(cq.message?.chat?.id || cq.from?.id || "");
    const messageId = cq.message?.message_id || null;
    if (data === "cmd_start") {
      pendingToolkitInputByChat.delete(chatId2);
      pendingUserLoginByChat.delete(chatId2);
      pendingPictaSearchByChat.delete(chatId2);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Volviendo al men\xFA principal..."
      }).catch(() => {
      });
      await sendOrEditMainMenuInTelegram(chatId2, messageId);
      return;
    }
    if (data === "picta_search:prompt") {
      pendingToolkitInputByChat.delete(chatId2);
      pendingPictaSearchByChat.set(chatId2, { messageId });
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Escribe el t\xEDtulo a buscar en Picta"
      }).catch(() => {
      });
      const promptText = `${hudHeader("BUSCADOR GLOBAL DE PICTA")}
` + hudBox([
        `\u{1F50D} <b>Alcance:</b> Todo el cat\xE1logo p\xFAblico de Picta (pel\xEDculas, series, cap\xEDtulos y otros)`,
        `\u{1F4CA} <b>Datos mostrados:</b> Canal autor, categor\xEDa, peso (MB/GB), resoluci\xF3n (1080p, 720p...) y enlace`
      ]) + `
\u270D\uFE0F <b>Escribe ahora el nombre de la pel\xEDcula, serie o video que deseas verificar:</b>

<i>(O usa directo <code>/buscar Nombre</code> en cualquier momento \xB7 /cancelar para salir)</i>`;
      const kb = [[{ text: "\u2B05\uFE0F Volver al Men\xFA", callback_data: "cmd_start" }]];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, promptText, kb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, promptText, void 0, kb);
      }
      return;
    }
    if (data.startsWith("picta_search_page:")) {
      const page = Number(data.slice("picta_search_page:".length) || 0) || 0;
      const last = lastPictaSearchResultsByChat.get(chatId2);
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      if (!last) {
        await sendOrEditMainMenuInTelegram(chatId2, messageId);
        return;
      }
      await sendOrEditPictaSearchResultsInTelegram(chatId2, messageId, last.query, page);
      return;
    }
    if (data.startsWith("dup_proceed:")) {
      const jobId = data.slice("dup_proceed:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      job.duplicateCheckApprovedTitle = normalizeDuplicateTitleKey(job.title || job.fileName);
      const nextAct = job.duplicateCheckNextAction || "step2";
      job.duplicateCheckNextAction = void 0;
      saveJobsToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Continuando con la subida..."
      }).catch(() => {
      });
      if (nextAct === "auto") {
        await executeAutoUploadAfterDuplicateCheck(job, chatId2, messageId);
      } else if (nextAct === "pinned_serie") {
        await executePinnedSerieUploadAfterDuplicateCheck(job, chatId2, messageId);
      } else {
        await promptStep2Synopsis(job, chatId2, messageId);
      }
      return;
    }
    if (data.startsWith("dup_edit_title:")) {
      const jobId = data.slice("dup_edit_title:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      job.duplicateCheckApprovedTitle = void 0;
      job.duplicateCheckNextAction = void 0;
      saveJobsToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Cambia o refina el t\xEDtulo..."
      }).catch(() => {
      });
      await promptStep1Title(job, chatId2, messageId);
      return;
    }
    if (data === "cmd_cuota") {
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Actualizando cuota diaria..."
      }).catch(() => {
      });
      await sendOrEditQuotaMenuInTelegram(chatId2, messageId);
      return;
    }
    if (data === "cmd_cuenta") {
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Verificando permisos de cuenta en Picta..."
      }).catch(() => {
      });
      await sendOrEditAccountDiagnosticInTelegram(chatId2, messageId);
      return;
    }
    if (data === "alerts_menu") {
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      await sendOrEditAlertsMilestonesMenuInTelegram(chatId2, messageId);
      return;
    }
    if (data === "alerts_toggle_comments") {
      const prefs = getChatAlertPreferences(chatId2);
      prefs.commentsEnabled = !prefs.commentsEnabled;
      saveAlertsStateToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: prefs.commentsEnabled ? "\u{1F4AC} Alertas de comentarios activadas" : "\u{1F4AC} Alertas desactivadas"
      }).catch(() => {
      });
      await sendOrEditAlertsMilestonesMenuInTelegram(chatId2, messageId);
      return;
    }
    if (data === "alerts_toggle_milestones") {
      const prefs = getChatAlertPreferences(chatId2);
      prefs.milestonesEnabled = !prefs.milestonesEnabled;
      saveAlertsStateToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: prefs.milestonesEnabled ? "\u{1F3C6} Logros activados" : "\u{1F3C6} Logros desactivados"
      }).catch(() => {
      });
      await sendOrEditAlertsMilestonesMenuInTelegram(chatId2, messageId);
      return;
    }
    if (data.startsWith("alerts_toggle_metric:")) {
      const key = data.slice("alerts_toggle_metric:".length);
      const prefs = getChatAlertPreferences(chatId2);
      if (key in prefs.enabledMetrics) {
        prefs.enabledMetrics[key] = !prefs.enabledMetrics[key];
        saveAlertsStateToDisk();
      }
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "M\xE9trica actualizada."
      }).catch(() => {
      });
      await sendOrEditAlertsMilestonesMenuInTelegram(chatId2, messageId);
      return;
    }
    if (data === "alerts_reset_thresholds") {
      const prefs = getChatAlertPreferences(chatId2);
      prefs.thresholds = [...DEFAULT_MILESTONE_THRESHOLDS];
      saveAlertsStateToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "\u267B\uFE0F Metas restauradas a valores por defecto."
      }).catch(() => {
      });
      await sendOrEditAlertsMilestonesMenuInTelegram(
        chatId2,
        messageId,
        void 0,
        "\u2705 <b>Metas progresivas restauradas por defecto.</b>"
      );
      return;
    }
    if (data === "alerts_edit_thresholds") {
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      const prefs = getChatAlertPreferences(chatId2);
      pendingToolkitInputByChat.set(chatId2, {
        mode: "edit_milestone_thresholds",
        messageId
      });
      const prompt = `\u270F\uFE0F <b>EDITAR METAS PROGRESIVAS DE LOGROS</b>

Metas actuales:
<code>${prefs.thresholds.join(", ")}</code>

Escribe ahora los n\xFAmeros separados por comas o espacios (tambi\xE9n puedes usar <code>1k</code>, <code>5k</code>):
<i>Ejemplo: <code>25, 50, 100, 250, 500, 1000, 5000</code></i>`;
      const kb = [[{ text: "\u2B05\uFE0F Cancelar", callback_data: "alerts_menu" }]];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, prompt, kb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, prompt, void 0, kb);
      }
      return;
    }
    if (data === "alerts_scan_now") {
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Buscando nuevos comentarios y logros en tu canal..."
      }).catch(() => {
      });
      const summary = await scanAllPictaAlertsAndMilestones(chatId2);
      await sendOrEditAlertsMilestonesMenuInTelegram(
        chatId2,
        messageId,
        void 0,
        `\u{1F504} <b>Revisi\xF3n completada:</b> ${summary.newComments} comentario(s) nuevo(s) y ${summary.newMilestones} logro(s) nuevo(s).`
      );
      return;
    }
    if (data === "user_picta_login_start" || data === "cmd_login") {
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      pendingUserLoginByChat.set(chatId2, { step: "awaiting_username" });
      await sendTelegramStatusMessage(
        chatId2,
        `\u{1F4F1} <b>PASO 1/2 \xB7 VINCULAR TU CUENTA DE PICTA</b>

Escribe ahora en el chat tu <b>n\xFAmero de tel\xE9fono</b> (+53...) o tu <b>nombre de usuario</b> de Picta:

<i>(O escribe /cancelar para salir)</i>`
      );
      return;
    }
    if (data === "retry_auto_discover_channel") {
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "\u{1F50D} Buscando tu canal en Picta..."
      }).catch(() => {
      });
      const updated = await ensureGuestSessionChannelDiscovered(chatId2, true);
      if (updated && updated.channelId && updated.channelId !== "0") {
        pendingToolkitInputByChat.delete(chatId2);
        const channelButtons = (updated.availableChannels || []).slice(0, 8).map((c) => [
          {
            text: `\u{1F4FA} ${c.nombre} (#${c.id})`,
            callback_data: `user_channel_pick:${c.id}`
          }
        ]);
        const readyText = `\u{1F389} <b>\xA1CANAL DETECTADO Y VINCULADO AUTOM\xC1TICAMENTE!</b>

<blockquote>\u{1F464} <b>Usuario Picta:</b> ${escapeHtml(updated.userFullName || updated.username)}
\u{1F4FA} <b>Canal Activo:</b> ${escapeHtml(updated.channelName)} (<code>#${escapeHtml(updated.channelId)}</code>)
\u{1F4E6} <b>Canales encontrados:</b> ${updated.availableChannels.length}</blockquote>
\u2705 <i>Todo listo. Ya puedes enviarme videos directamente aqu\xED para subirlos a tu canal.</i>`;
        if (messageId) {
          await editTelegramStatusMessage(
            chatId2,
            messageId,
            readyText,
            channelButtons.length > 1 ? channelButtons : void 0,
            true
          );
        } else {
          await sendTelegramStatusMessage(
            chatId2,
            readyText,
            void 0,
            channelButtons.length > 1 ? channelButtons : void 0
          );
        }
      } else {
        pendingToolkitInputByChat.set(chatId2, {
          mode: "switch_channel_query",
          messageId: messageId || null
        });
        const stillMissingText = `\u{1F50D} <b>A\xFAn no aparece tu canal en la respuesta de la API</b>

\u{1F4CC} <b>Paso \xFAnico (sin comandos):</b> Pega aqu\xED mismo en el chat el <b>enlace de tu canal</b> (ej: <code>https://www.picta.cu/canal/tu-canal</code>), su <b>nombre</b> o su <b>ID num\xE9rico</b> y quedar\xE1 vinculado al instante:`;
        const kb = [
          [{ text: "\u{1F504} Reintentar Detecci\xF3n", callback_data: "retry_auto_discover_channel" }],
          [{ text: "\u2B05\uFE0F Cancelar", callback_data: "cmd_start" }]
        ];
        if (messageId) {
          await editTelegramStatusMessage(chatId2, messageId, stillMissingText, kb, true);
        } else {
          await sendTelegramStatusMessage(chatId2, stillMissingText, void 0, kb);
        }
      }
      return;
    }
    if (data.startsWith("user_channel_pick:")) {
      const targetChanId = data.replace("user_channel_pick:", "").trim();
      const session = userSessions.get(chatId2);
      const isMaster = isMasterAdminChat(chatId2);
      const masterChanId = String(botConfig.pictaChannelId || "36319");
      if (!isMaster && targetChanId === masterChanId) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u26D4 No tienes acceso a ese canal.",
          show_alert: true
        }).catch(() => {
        });
        return;
      }
      if (session) {
        const foundChan = (session.availableChannels || []).find(
          (c) => String(c.id) === targetChanId
        );
        if (!foundChan && !isMaster) {
          await callTelegramBotApi("answerCallbackQuery", {
            callback_query_id: cq.id,
            text: "\u26A0\uFE0F Ese canal no pertenece a tu sesi\xF3n actual.",
            show_alert: true
          }).catch(() => {
          });
          return;
        }
        session.channelId = targetChanId;
        if (foundChan) {
          session.channelName = foundChan.nombre;
        }
        session.verifiedChannelOwnership = true;
        session.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        saveUserSessionsToDisk();
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: `Canal cambiado a: ${session.channelName} (#${session.channelId})`
        }).catch(() => {
        });
        await sendTelegramStatusMessage(
          chatId2,
          `\u2705 <b>Canal activo actualizado:</b>

<blockquote>\u{1F4FA} <b>${escapeHtml(session.channelName)}</b> (#${session.channelId})
\u{1F464} <b>Propietario:</b> ${escapeHtml(session.userFullName || session.username)}</blockquote>
Cualquier video que env\xEDes ahora se subir\xE1 a este canal.`
        );
      } else {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "No tienes una sesi\xF3n de Picta activa."
        }).catch(() => {
        });
      }
      return;
    }
    if (data === "user_picta_logout") {
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Cerrando sesi\xF3n de Picta..."
      }).catch(() => {
      });
      userSessions.delete(chatId2);
      saveUserSessionsToDisk();
      await sendTelegramStatusMessage(
        chatId2,
        `\u{1F6AA} <b>Sesi\xF3n de Picta cerrada correctamente.</b>

Tu cuenta ha sido desvinculada del bot. Si deseas vincular una cuenta en el futuro usa <code>/login</code>.`
      );
      return;
    }
    if (data.startsWith("dash_sort:")) {
      const parts = data.split(":");
      const sortMode = parts[1] || "views";
      const page = Number(parts[2] || 0);
      const period = parts[3] || "all";
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Ordenando cat\xE1logo completo..."
      }).catch(() => {
      });
      await sendOrEditPictaDashboardInTelegram(chatId2, messageId, sortMode, page, void 0, false, period);
      return;
    }
    if (data.startsWith("dash_period:")) {
      const parts = data.split(":");
      const period = parts[1] || "all";
      const sortMode = parts[2] || "views";
      const page = Number(parts[3] || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Actualizando rango de estad\xEDsticas..."
      }).catch(() => {
      });
      await sendOrEditPictaDashboardInTelegram(chatId2, messageId, sortMode, page, void 0, false, period);
      return;
    }
    if (data.startsWith("dash_refresh:")) {
      const parts = data.split(":");
      const sortMode = parts[1] || "views";
      const page = Number(parts[2] || 0);
      const period = parts[3] || "all";
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Consultando web admin de Picta en vivo..."
      }).catch(() => {
      });
      await sendOrEditPictaDashboardInTelegram(chatId2, messageId, sortMode, page, void 0, true, period);
      return;
    }
    if (data === "promo_cfg:open") {
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      await sendOrEditPromoChannelMenuInTelegram(chatId2, messageId);
      return;
    }
    if (data === "promo_cfg:set" || data.startsWith("promo_cfg:prompt_for:")) {
      const returnPromoId = data.startsWith("promo_cfg:prompt_for:") ? data.slice("promo_cfg:prompt_for:".length).trim() : void 0;
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      pendingToolkitInputByChat.set(chatId2, {
        mode: "set_promo_requests_channel",
        promoId: returnPromoId,
        messageId
      });
      const promptMsg = `\u{1F4E2} <b>CONFIGURAR TU CANAL DE PEDIDOS EN TELEGRAM</b>

Env\xEDa ahora cualquiera de estas opciones:
\u2022 El <b>@usuario</b> de tu canal p\xFAblico (ej: <code>@micanal_pedidos</code>)
\u2022 El <b>enlace</b> de tu canal (ej: <code>https://t.me/micanal_pedidos</code>)
\u2022 El <b>ID num\xE9rico</b> de tu canal privado (ej: <code>-1001234567890</code>)
\u2022 O <b>reenv\xEDa cualquier publicaci\xF3n</b> desde tu canal hacia este chat

\u26A0\uFE0F <i>Aseg\xFArate de haber a\xF1adido este bot como Administrador del canal con permiso para publicar mensajes.</i>
<i>(O escribe /cancelar para volver)</i>`;
      const kb = [
        [
          {
            text: "\u2B05\uFE0F Cancelar",
            callback_data: returnPromoId ? `promo_back:${returnPromoId}` : "promo_cfg:open"
          }
        ]
      ];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, promptMsg, kb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, promptMsg, void 0, kb);
      }
      return;
    }
    if (data === "promo_cfg:test") {
      const resolvedReq = resolveRequestsChannelForChat(
        chatId2,
        MASTER_ADMIN_CHAT_ID,
        userPromoChannels,
        MASTER_PRIVATE_REQUESTS_CHANNEL
      );
      if (!resolvedReq.configured) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u26A0\uFE0F Configura primero tu Canal de Pedidos.",
          show_alert: true
        }).catch(() => {
        });
        return;
      }
      try {
        const chatMeta = await callTelegramBotApi("getChat", { chat_id: resolvedReq.targetChannelId });
        const me = await callTelegramBotApi("getMe");
        const member = await callTelegramBotApi("getChatMember", {
          chat_id: resolvedReq.targetChannelId,
          user_id: me.id
        }).catch(() => null);
        const status = String(member?.status || "desconocido");
        const canPost = status === "creator" || status === "administrator" && member?.can_post_messages !== false;
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: canPost ? "\u2705 Bot listo para publicar" : "\u26A0\uFE0F Revisa permisos del bot"
        }).catch(() => {
        });
        await sendOrEditPromoChannelMenuInTelegram(
          chatId2,
          messageId,
          void 0,
          canPost ? `\u2705 <b>Conexi\xF3n verificada con "${escapeHtml(chatMeta?.title || resolvedReq.targetChannelLabel)}".</b> El bot tiene permisos activos para publicar fichas.` : `\u26A0\uFE0F <b>Canal encontrado ("${escapeHtml(chatMeta?.title || resolvedReq.targetChannelLabel)}"), pero el bot figura como <code>${escapeHtml(status)}</code>.</b> Dale permiso de Administrador para publicar mensajes.`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u26A0\uFE0F No se pudo acceder al canal",
          show_alert: true
        }).catch(() => {
        });
        await sendOrEditPromoChannelMenuInTelegram(
          chatId2,
          messageId,
          void 0,
          `\u26A0\uFE0F <b>No se pudo verificar el canal:</b> <code>${escapeHtml(errMsg.slice(0, 140))}</code>
<i>Verifica el @usuario / ID y que el bot sea Administrador del canal.</i>`
        );
      }
      return;
    }
    if (data === "promo_cfg:group") {
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      pendingToolkitInputByChat.set(chatId2, {
        mode: "set_requests_group_chat",
        messageId
      });
      const promptMsg = `\u{1F465} <b>VINCULAR GRUPO O CHAT DE PEDIDOS</b>

Env\xEDa ahora el <b>@usuario</b>, <b>enlace t.me/...</b> o <b>ID num\xE9rico (-100...)</b> del grupo donde tus suscriptores piden pel\xEDculas/series (o reenv\xEDa un mensaje de ese grupo/canal).

\u{1F4CC} <i>Recuerda a\xF1adir el bot al grupo con permiso para leer y responder mensajes.</i>`;
      const kb = [[{ text: "\u2B05\uFE0F Cancelar", callback_data: "promo_cfg:open" }]];
      if (messageId) await editTelegramStatusMessage(chatId2, messageId, promptMsg, kb, true);
      else await sendTelegramStatusMessage(chatId2, promptMsg, void 0, kb);
      return;
    }
    if (data.startsWith("promo_cfg:mode:")) {
      const nextMode = data.slice("promo_cfg:mode:".length).trim();
      const existing = userPromoChannels.get(chatId2);
      const fallbackTarget = resolveRequestsChannelForChat(
        chatId2,
        MASTER_ADMIN_CHAT_ID,
        userPromoChannels,
        MASTER_PRIVATE_REQUESTS_CHANNEL
      );
      userPromoChannels.set(chatId2, {
        chatId: chatId2,
        targetChannelId: existing?.targetChannelId || fallbackTarget.targetChannelId || "",
        targetChannelLabel: existing?.targetChannelLabel || fallbackTarget.targetChannelLabel || "",
        customPictaChannelUrl: existing?.customPictaChannelUrl,
        autoSendToRequests: existing?.autoSendToRequests,
        requestsGroupChatId: existing?.requestsGroupChatId,
        requestsGroupLabel: existing?.requestsGroupLabel,
        requestsMonitorMode: nextMode === "prefix" || nextMode === "all" ? nextMode : "off",
        disabled: existing?.disabled ?? false,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      saveUserPromoChannelsToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `\u{1F916} Auto-verificador actualizado: ${nextMode.toUpperCase()}`
      }).catch(() => {
      });
      await sendOrEditPromoChannelMenuInTelegram(chatId2, messageId);
      return;
    }
    if (data.startsWith("audit:")) {
      const parts = data.split(":");
      const isRefresh = parts[1] === "refresh";
      const tabRaw = isRefresh ? parts[2] : parts[1];
      const page = Number(isRefresh ? parts[3] : parts[2]) || 0;
      const tab = tabRaw === "inc" || tabRaw === "unpub" || tabRaw === "series" ? tabRaw : "dups";
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: isRefresh ? "Re-escaneando cat\xE1logo del canal..." : "Cargando auditor\xEDa..."
      }).catch(() => {
      });
      await sendOrEditChannelAuditInTelegram(chatId2, messageId, tab, page, void 0, isRefresh);
      return;
    }
    if (data.startsWith("req:")) {
      const parts = data.split(":");
      const action = parts[1] || "";
      if (action === "list") {
        const filterRaw = parts[2] || "pending";
        const filter = filterRaw === "fulfilled" || filterRaw === "all" ? filterRaw : "pending";
        const page = Number(parts[3] || 0) || 0;
        await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
        });
        await sendOrEditRequestsManagerInTelegram(chatId2, messageId, filter, page);
        return;
      }
      if (action === "add_prompt") {
        await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
        });
        pendingToolkitInputByChat.set(chatId2, {
          mode: "add_or_check_request",
          messageId
        });
        const promptHtml = `\u{1F50E} <b>VERIFICADOR Y GESTOR DE PEDIDOS</b>

Escribe ahora el t\xEDtulo de la pel\xEDcula o serie que pidi\xF3 un suscriptor (o reenv\xEDa su mensaje aqu\xED).

<i>Primero buscar\xE9 en toda Picta: si ya existe te dar\xE9 el enlace + peso/resoluci\xF3n listo para responder; si no existe podr\xE1s guardarlo en Pedidos Pendientes.</i>`;
        const kb = [[{ text: "\u2B05\uFE0F Cancelar", callback_data: "req:list:pending:0" }]];
        if (messageId) await editTelegramStatusMessage(chatId2, messageId, promptHtml, kb, true);
        else await sendTelegramStatusMessage(chatId2, promptHtml, void 0, kb);
        return;
      }
      if (action === "scan_comments") {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "Escaneando comentarios de Picta..."
        }).catch(() => {
        });
        await sendOrEditRequestsManagerInTelegram(
          chatId2,
          messageId,
          "pending",
          0,
          void 0,
          void 0,
          true
        );
        return;
      }
      if (action === "save_last") {
        const pendingSave = pendingRequestSaveByChat.get(chatId2);
        pendingRequestSaveByChat.delete(chatId2);
        if (!pendingSave) {
          await callTelegramBotApi("answerCallbackQuery", {
            callback_query_id: cq.id,
            text: "\u26A0\uFE0F La consulta previa expir\xF3."
          }).catch(() => {
          });
          return;
        }
        const norm = normalizeRequestTitle(pendingSave.query);
        const dup = channelMediaRequests.find(
          (r) => r.ownerChatId === chatId2 && r.status === "pending" && r.normalizedTitle === norm
        );
        if (!dup) {
          channelMediaRequests.unshift({
            id: `rq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
            ownerChatId: chatId2,
            requestedTitle: pendingSave.query,
            normalizedTitle: norm,
            requestedByName: pendingSave.requesterName,
            ...pendingSave.requesterUsername ? { requestedByUsername: pendingSave.requesterUsername } : {},
            sourceType: "manual",
            status: "pending",
            createdAt: (/* @__PURE__ */ new Date()).toISOString()
          });
          saveChannelMediaRequestsToDisk();
        }
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u{1F4E5} Pedido guardado en Pendientes"
        }).catch(() => {
        });
        await sendOrEditRequestsManagerInTelegram(
          chatId2,
          messageId,
          "pending",
          0,
          void 0,
          `\u{1F4E5} <b>Pedido guardado:</b> ${escapeHtml(pendingSave.query)}`
        );
        return;
      }
      const reqId = parts[2] || "";
      const targetReq = channelMediaRequests.find(
        (r) => r.id === reqId && r.ownerChatId === chatId2
      );
      if (!targetReq) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "Pedido no encontrado."
        }).catch(() => {
        });
        return;
      }
      if (action === "check") {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "Verificando en cat\xE1logo global de Picta..."
        }).catch(() => {
        });
        await processRequestQueryAndReplyOrSave({
          ownerChatId: chatId2,
          replyChatId: chatId2,
          query: targetReq.requestedTitle,
          requesterName: targetReq.requestedByName,
          requesterUsername: targetReq.requestedByUsername,
          autoSaveIfMissing: false
        });
        return;
      }
      if (action === "done") {
        targetReq.status = "fulfilled";
        targetReq.fulfilledAt = (/* @__PURE__ */ new Date()).toISOString();
        saveChannelMediaRequestsToDisk();
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u2705 Marcado como cumplido"
        }).catch(() => {
        });
        await sendOrEditRequestsManagerInTelegram(
          chatId2,
          messageId,
          "pending",
          0,
          void 0,
          `\u2705 <b>Pedido marcado como cumplido:</b> ${escapeHtml(targetReq.requestedTitle)}`
        );
        return;
      }
      if (action === "reply_cm") {
        if (!targetReq.commentPublicationId || !targetReq.commentId || !targetReq.matchedPictaUrl) {
          await callTelegramBotApi("answerCallbackQuery", {
            callback_query_id: cq.id,
            text: "Faltan datos del comentario o enlace en Picta."
          }).catch(() => {
          });
          return;
        }
        const replyBody = `\xA1Hola! Ya subimos "${targetReq.requestedTitle}" al canal. Puedes verlo aqu\xED: ${targetReq.matchedPictaUrl}`;
        await postPictaCommentInChannel(
          chatId2,
          targetReq.commentPublicationId,
          replyBody,
          targetReq.commentId
        );
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u{1F4AC} Respuesta publicada en Picta"
        }).catch(() => {
        });
        await sendTelegramStatusMessage(
          chatId2,
          `\u{1F4AC} <b>Comentario respondido en Picta</b> para el pedido <b>${escapeHtml(targetReq.requestedTitle)}</b>:
<code>${escapeHtml(replyBody)}</code>`,
          messageId || void 0
        );
        return;
      }
      if (action === "del") {
        if (targetReq.commentId) {
          ignoredRequestCommentIds.add(targetReq.commentId);
        }
        channelMediaRequests = channelMediaRequests.filter(
          (r) => !(r.id === reqId && r.ownerChatId === chatId2)
        );
        saveChannelMediaRequestsToDisk();
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u{1F5D1}\uFE0F Pedido eliminado"
        }).catch(() => {
        });
        await sendOrEditRequestsManagerInTelegram(
          chatId2,
          messageId,
          "pending",
          0,
          void 0,
          `\u{1F5D1}\uFE0F <b>Pedido eliminado de tu lista.</b>`
        );
        return;
      }
    }
    if (data === "promo_cfg:disable") {
      const prevCfg = userPromoChannels.get(chatId2);
      userPromoChannels.set(chatId2, {
        chatId: chatId2,
        targetChannelId: "",
        targetChannelLabel: "",
        requestsGroupChatId: prevCfg?.requestsGroupChatId,
        requestsGroupLabel: prevCfg?.requestsGroupLabel,
        requestsMonitorMode: prevCfg?.requestsMonitorMode,
        disabled: true,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      saveUserPromoChannelsToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "\u{1F6AB} Canal de pedidos desactivado para tu cuenta."
      }).catch(() => {
      });
      await sendOrEditPromoChannelMenuInTelegram(
        chatId2,
        messageId,
        void 0,
        "\u{1F6AB} <b>Canal de Pedidos desactivado para tu cuenta.</b> Puedes configurarlo de nuevo cuando quieras."
      );
      return;
    }
    if (data.startsWith("promo_back:")) {
      const promoId = data.slice("promo_back:".length).trim();
      pendingToolkitInputByChat.delete(chatId2);
      const promo = pendingMoviePromos.get(promoId);
      if (!promo || promo.ownerChatId !== chatId2) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u26A0\uFE0F Ficha promocional expirada.",
          show_alert: true
        }).catch(() => {
        });
        await sendOrEditPromoChannelMenuInTelegram(chatId2, messageId);
        return;
      }
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      const prompt = buildMoviePromoConfirmationPrompt(promo, chatId2);
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, prompt.textHtml, prompt.keyboard, true);
      } else {
        await sendTelegramStatusMessage(chatId2, prompt.textHtml, void 0, prompt.keyboard);
      }
      return;
    }
    if (data.startsWith("promo_preview:")) {
      const promoId = data.slice("promo_preview:".length).trim();
      const promo = pendingMoviePromos.get(promoId);
      if (!promo || promo.ownerChatId !== chatId2) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u26A0\uFE0F Ficha promocional no disponible.",
          show_alert: true
        }).catch(() => {
        });
        return;
      }
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Enviando vista previa a tu chat privado..."
      }).catch(() => {
      });
      const res = await publishPromoRecordToTargetChat(promo, chatId2);
      if (!res.ok) {
        await sendTelegramStatusMessage(
          chatId2,
          `\u26A0\uFE0F <b>No se pudo generar la vista previa:</b> <code>${escapeHtml(String(res.error || "Error desconocido").slice(0, 140))}</code>`
        );
      }
      return;
    }
    if (data.startsWith("promo_skip:")) {
      const promoId = data.slice("promo_skip:".length).trim();
      const promo = pendingMoviePromos.get(promoId);
      if (!promo || promo.ownerChatId !== chatId2) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "Omitido."
        }).catch(() => {
        });
        return;
      }
      pendingMoviePromos.delete(promoId);
      savePendingPromosToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "\u23ED\uFE0F Publicaci\xF3n en canal de pedidos omitida."
      }).catch(() => {
      });
      if (messageId) {
        await editTelegramStatusMessage(
          chatId2,
          messageId,
          `\u23ED\uFE0F <b>Ficha promocional omitida</b> para <b>${escapeHtml(promo.title)}</b>.
<i>La subida en Picta permanece intacta.</i>`,
          [[{ text: "\u{1F310} Ver Pel\xEDcula en Picta", url: promo.pictaVideoUrl }]],
          true
        );
      }
      return;
    }
    if (data.startsWith("promo_send:")) {
      const promoId = data.slice("promo_send:".length).trim();
      const promo = pendingMoviePromos.get(promoId);
      if (!promo || promo.ownerChatId !== chatId2) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u26A0\uFE0F Esta ficha no te pertenece o ya expir\xF3.",
          show_alert: true
        }).catch(() => {
        });
        return;
      }
      const resolvedReq = resolveRequestsChannelForChat(
        chatId2,
        MASTER_ADMIN_CHAT_ID,
        userPromoChannels,
        MASTER_PRIVATE_REQUESTS_CHANNEL
      );
      if (!resolvedReq.configured) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u2699\uFE0F Configura primero tu Canal de Pedidos.",
          show_alert: true
        }).catch(() => {
        });
        await sendOrEditPromoChannelMenuInTelegram(chatId2, messageId, void 0, void 0, promoId);
        return;
      }
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "\u{1F4E2} Publicando ficha visual en tu Canal de Pedidos..."
      }).catch(() => {
      });
      const sendRes = await publishPromoRecordToTargetChat(promo, resolvedReq.targetChannelId);
      if (sendRes.ok) {
        promo.publishedToChannelId = resolvedReq.targetChannelId;
        promo.publishedAt = (/* @__PURE__ */ new Date()).toISOString();
        savePendingPromosToDisk();
        const successHtml = `${hudHeader("FICHA PUBLICADA EN CANAL DE PEDIDOS")}
` + hudBox([
          `\u{1F3AC} <b>Pel\xEDcula:</b> ${escapeHtml(promo.title)}${promo.year ? ` (${escapeHtml(promo.year)})` : ""}`,
          `\u{1F4E2} <b>Canal:</b> ${escapeHtml(resolvedReq.targetChannelLabel)}`,
          `\u{1F5BC}\uFE0F <b>Formato:</b> ${sendRes.viaFallbackText ? "Ficha HTML enriquecida" : "Portada HD + Ficha visual y botones directos"}`
        ]);
        const successKb = [
          [{ text: "\u{1F3AC} Ver Pel\xEDcula en Picta", url: promo.pictaVideoUrl }],
          [{ text: `\u{1F4FA} ${promo.pictaChannelName.slice(0, 30)}`, url: promo.pictaChannelUrl }]
        ];
        if (messageId) {
          await editTelegramStatusMessage(chatId2, messageId, successHtml, successKb, true);
        } else {
          await sendTelegramStatusMessage(chatId2, successHtml, void 0, successKb);
        }
      } else {
        const failHtml = `\u26A0\uFE0F <b>No se pudo publicar en tu Canal de Pedidos</b> (<code>${escapeHtml(resolvedReq.targetChannelLabel)}</code>)

<blockquote><code>${escapeHtml(String(sendRes.error || "Error de permisos en Telegram").slice(0, 180))}</code></blockquote>
<i>Verifica que el bot sea Administrador con permiso para publicar mensajes en ese canal. Tu video en Picta sigue publicado sin problema.</i>`;
        const failKb = [
          [{ text: "\u{1F504} Reintentar Publicaci\xF3n", callback_data: `promo_send:${promo.promoId}` }],
          [
            { text: "\u2699\uFE0F Configurar / Cambiar Canal", callback_data: `promo_cfg:prompt_for:${promo.promoId}` },
            { text: "\u23ED\uFE0F Omitir", callback_data: `promo_skip:${promo.promoId}` }
          ]
        ];
        if (messageId) {
          await editTelegramStatusMessage(chatId2, messageId, failHtml, failKb, true);
        } else {
          await sendTelegramStatusMessage(chatId2, failHtml, void 0, failKb);
        }
      }
      return;
    }
    if (data.startsWith("dash_pub:")) {
      const parts = data.split(":");
      const pubId = Number(parts[1] || 0);
      const returnSort = parts[2] || "views";
      const returnPage = Number(parts[3] || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Cargando ficha del video..."
      }).catch(() => {
      });
      await sendOrEditPictaPubDetailInTelegram(chatId2, messageId, pubId, returnSort, returnPage);
      return;
    }
    if (data === "chan_editor:open" || data === "chan_editor:refresh") {
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Cargando configuraci\xF3n de tu canal..."
      }).catch(() => {
      });
      await sendOrEditChannelEditorMenu(chatId2, messageId);
      return;
    }
    if (data.startsWith("chan_edit:")) {
      const mode = data.slice("chan_edit:".length).trim();
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      const ctx = getEffectivePictaContext(chatId2);
      if (!ctx.isLinked || !ctx.channelId) {
        await sendOrEditChannelEditorMenu(chatId2, messageId);
        return;
      }
      if (mode === "clasificacion") {
        pendingChannelEditByChat.set(chatId2, { mode: "clasificacion", messageId });
        const clasifRows = [
          PICTA_CHANNEL_CLASIFICACIONES.slice(0, 3).map((c) => ({
            text: `\u{1F51E} ${c}`,
            callback_data: `chan_set_clasif:${c}`
          })),
          PICTA_CHANNEL_CLASIFICACIONES.slice(3).map((c) => ({
            text: `\u{1F51E} ${c}`,
            callback_data: `chan_set_clasif:${c}`
          })),
          [{ text: "\u2B05\uFE0F Cancelar y Volver al Canal", callback_data: "chan_editor:open" }]
        ];
        const promptText2 = `\u{1F51E} <b>CAMBIAR CLASIFICACI\xD3N DEL CANAL</b>
<blockquote>\u{1F4FA} <b>Canal:</b> ${escapeHtml(ctx.channelName)} (<code>#${escapeHtml(ctx.channelId)}</code>)</blockquote>
Selecciona la clasificaci\xF3n de edad para tu canal (o escr\xEDbela en el chat):`;
        if (messageId) {
          await editTelegramStatusMessage(chatId2, messageId, promptText2, clasifRows, true);
        } else {
          await sendTelegramStatusMessage(chatId2, promptText2, void 0, clasifRows);
        }
        return;
      }
      pendingChannelEditByChat.set(chatId2, { mode, messageId });
      const prompts = {
        nombre: `\u270F\uFE0F <b>Escribe ahora en el chat el nuevo NOMBRE</b> para tu canal en Picta:`,
        alias: `\u{1F3F7}\uFE0F <b>Escribe ahora en el chat el nuevo LEMA / ALIAS</b> para tu canal en Picta:`,
        descripcion: `\u{1F4DD} <b>Escribe ahora en el chat la nueva DESCRIPCI\xD3N</b> para tu canal en Picta:`,
        clasificacion: `\u{1F51E} <b>Escribe la nueva CLASIFICACI\xD3N</b> (ej: TP, 7+, 12+, 16+, 18+):`,
        avatar: `\u{1F464} <b>Env\xEDa ahora al chat una FOTO o IMAGEN</b> para actualizar el <b>AVATAR (foto de perfil)</b> de tu canal en Picta:`,
        portada: `\u{1F5BC}\uFE0F <b>Env\xEDa ahora al chat una FOTO o IMAGEN</b> para actualizar la <b>PORTADA (banner)</b> de tu canal en Picta:`
      };
      const promptText = `\u{1F3DB}\uFE0F <b>EDITAR PROPIEDAD DEL CANAL EN PICTA</b>
<blockquote>\u{1F4FA} <b>Canal:</b> ${escapeHtml(ctx.channelName)} (<code>#${escapeHtml(ctx.channelId)}</code>)</blockquote>
${prompts[mode] || "Env\xEDa el nuevo valor al chat:"}`;
      const cancelKb = [[{ text: "\u2B05\uFE0F Cancelar y Volver al Canal", callback_data: "chan_editor:open" }]];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, promptText, cancelKb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, promptText, void 0, cancelKb);
      }
      return;
    }
    if (data.startsWith("chan_set_clasif:")) {
      const clasifVal = data.slice("chan_set_clasif:".length).trim();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `Actualizando clasificaci\xF3n a ${clasifVal}...`
      }).catch(() => {
      });
      try {
        await patchPictaChannelDetails(chatId2, { clasificacion: clasifVal });
        await sendOrEditChannelEditorMenu(
          chatId2,
          messageId,
          void 0,
          `\u2705 <b>\xA1Clasificaci\xF3n del canal actualizada a ${escapeHtml(clasifVal)}!</b>`
        );
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : String(err);
        await sendOrEditChannelEditorMenu(
          chatId2,
          messageId,
          void 0,
          `\u26A0\uFE0F <b>No se pudo cambiar la clasificaci\xF3n:</b> <code>${escapeHtml(msg2.slice(0, 120))}</code>`
        );
      }
      return;
    }
    if (data.startsWith("chan_toggle:")) {
      const field = data.slice("chan_toggle:".length).trim();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Actualizando canal en Picta..."
      }).catch(() => {
      });
      try {
        const current = await fetchPictaChannelDetails(chatId2);
        const nextVal = field === "publicado" ? !current.publicado : !current.donacion;
        await patchPictaChannelDetails(chatId2, {
          [field]: nextVal ? "true" : "false",
          ...field === "donacion" ? { donar: nextVal ? "true" : "false" } : {}
        });
        const notice = field === "publicado" ? nextVal ? "\u{1F7E2} <b>\xA1Tu canal ahora est\xE1 P\xFAblico (Visible) en Picta!</b>" : "\u{1F648} <b>\xA1Tu canal ha sido ocultado en Picta!</b>" : nextVal ? "\u{1F4B3} <b>\xA1Donaciones activadas en tu canal de Picta!</b>" : "\u{1F4B3} <b>\xA1Donaciones desactivadas en tu canal de Picta!</b>";
        await sendOrEditChannelEditorMenu(chatId2, messageId, void 0, notice);
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : String(err);
        await sendOrEditChannelEditorMenu(
          chatId2,
          messageId,
          void 0,
          `\u26A0\uFE0F <b>No se pudo actualizar el canal:</b> <code>${escapeHtml(msg2.slice(0, 120))}</code>`
        );
      }
      return;
    }
    if (data === "chan_collabs:open") {
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Cargando colaboradores del canal..."
      }).catch(() => {
      });
      await sendOrEditChannelCollaboratorsMenu(chatId2, messageId);
      return;
    }
    if (data === "chan_collabs:add_prompt") {
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      pendingToolkitInputByChat.set(chatId2, {
        mode: "add_collaborator_id",
        messageId
      });
      const promptText = `\u2795 <b>A\xD1ADIR COLABORADOR AL CANAL EN PICTA</b>
<blockquote>Escribe ahora en el chat cualquiera de estas opciones sobre tu socio:
\u2022 <b>Enlace directo o nombre de su canal en Picta</b> (ej: <code>https://www.picta.cu/canal/su-canal</code>)
\u2022 Su <b>nombre de usuario de Picta</b> (ej: <code>@usuario</code>)
\u2022 Su <b>ID num\xE9rico de usuario Picta</b> (ej: <code>994913</code>)</blockquote>`;
      const kb = [[{ text: "\u2B05\uFE0F Cancelar", callback_data: "chan_collabs:open" }]];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, promptText, kb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, promptText, void 0, kb);
      }
      return;
    }
    if (data.startsWith("chan_collabs:del:")) {
      const targetUserId = Number(data.slice("chan_collabs:del:".length) || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `Retirando colaborador #${targetUserId}...`
      }).catch(() => {
      });
      try {
        await modifyChannelCollaboratorInPicta(chatId2, targetUserId, "remove");
        await sendOrEditChannelCollaboratorsMenu(
          chatId2,
          messageId,
          void 0,
          `\u{1F5D1}\uFE0F <b>Colaborador <code>#${targetUserId}</code> retirado de tu canal en Picta.</b>`
        );
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : String(err);
        await sendOrEditChannelCollaboratorsMenu(
          chatId2,
          messageId,
          void 0,
          `\u26A0\uFE0F <b>No se pudo retirar colaborador:</b> <code>${escapeHtml(msg2.slice(0, 120))}</code>`
        );
      }
      return;
    }
    if (data === "chan_switch:prompt") {
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      pendingToolkitInputByChat.set(chatId2, {
        mode: "switch_channel_query",
        messageId
      });
      const promptText = `\u{1F4FA} <b>VINCULAR O CAMBIAR TU CANAL DE PICTA</b>
<blockquote>Escribe ahora en el chat el <b>enlace directo de tu canal</b> (ej: <code>https://www.picta.cu/canal/mi-canal</code>), el <b>slug</b> o su <b>ID num\xE9rico</b> (ej: <code>12345</code>):</blockquote>
<i>\u{1F4A1} Tambi\xE9n puedes escribir parte del nombre de tu canal para buscarlo.</i>`;
      const kb = [[{ text: "\u2B05\uFE0F Cancelar", callback_data: "chan_editor:open" }]];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, promptText, kb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, promptText, void 0, kb);
      }
      return;
    }
    if (data.startsWith("chan_switch:select:")) {
      const targetChanId = data.slice("chan_switch:select:".length).trim();
      const isMaster = isMasterAdminChat(chatId2);
      const masterChanId = String(botConfig.pictaChannelId || "36319");
      if (!isMaster && targetChanId === masterChanId) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u26D4 No tienes acceso a ese canal.",
          show_alert: true
        }).catch(() => {
        });
        return;
      }
      const session = userSessions.get(chatId2);
      if (session) {
        try {
          const chk = await fetchPictaWithRetry(`https://api.picta.cu/v1/canal/${targetChanId}/`, {
            headers: {
              Authorization: `Bearer ${session.authToken}`,
              Origin: "https://admin.picta.cu",
              Referer: "https://admin.picta.cu/"
            }
          });
          if (chk.ok) {
            const dataObj = await chk.json();
            if (!isMaster && (session.userId || session.username)) {
              const owned = isChannelOwnedOrAssociatedByUser(dataObj, {
                ...session.userId ? { userId: session.userId } : {},
                username: session.username,
                phone: session.username
              });
              if (owned === false) {
                await callTelegramBotApi("answerCallbackQuery", {
                  callback_query_id: cq.id,
                  text: "\u26D4 Ese canal pertenece a otro usuario de Picta.",
                  show_alert: true
                }).catch(() => {
                });
                return;
              }
            }
            session.channelId = targetChanId;
            session.channelName = String(dataObj?.nombre || `Canal #${targetChanId}`);
            session.verifiedChannelOwnership = true;
            if (!session.availableChannels.some((x) => String(x.id) === targetChanId)) {
              session.availableChannels.push({ id: Number(targetChanId), nombre: session.channelName });
            }
            saveUserSessionsToDisk();
            await callTelegramBotApi("answerCallbackQuery", {
              callback_query_id: cq.id,
              text: `\u2705 Canal vinculado: ${session.channelName}`
            }).catch(() => {
            });
            await sendOrEditChannelEditorMenu(
              chatId2,
              messageId,
              void 0,
              `\u2705 <b>Canal activo actualizado a:</b> ${escapeHtml(session.channelName)} (<code>#${targetChanId}</code>)
Todos tus videos y publicaciones se subir\xE1n a este canal.`
            );
            return;
          }
        } catch {
        }
      }
    }
    if (data.startsWith("playlists_menu:")) {
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Cargando listas de reproducci\xF3n del canal..."
      }).catch(() => {
      });
      await sendOrEditPlaylistsMenuInTelegram(chatId2, messageId);
      return;
    }
    if (data === "playlist_create_prompt") {
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      pendingToolkitInputByChat.set(chatId2, {
        mode: "new_playlist_name",
        messageId
      });
      const promptText = `\u2795 <b>CREAR NUEVA LISTA DE REPRODUCCI\xD3N EN TU CANAL</b>
<blockquote>Escribe ahora en el chat el <b>nombre de la nueva Lista de Reproducci\xF3n</b> (ej: <i>Pel\xEDculas de Acci\xF3n</i>, <i>Series en Emisi\xF3n</i>):</blockquote>`;
      const kb = [[{ text: "\u2B05\uFE0F Cancelar", callback_data: "playlists_menu:0" }]];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, promptText, kb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, promptText, void 0, kb);
      }
      return;
    }
    if (data.startsWith("playlist_del:")) {
      const playlistId = Number(data.slice("playlist_del:".length) || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Eliminando lista de reproducci\xF3n..."
      }).catch(() => {
      });
      try {
        await deleteChannelPlaylistInPicta(chatId2, playlistId);
        await sendOrEditPlaylistsMenuInTelegram(
          chatId2,
          messageId,
          void 0,
          `\u{1F5D1}\uFE0F <b>Lista de reproducci\xF3n <code>#${playlistId}</code> eliminada de Picta.</b>`
        );
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : String(err);
        await sendOrEditPlaylistsMenuInTelegram(
          chatId2,
          messageId,
          void 0,
          `\u26A0\uFE0F <b>No se pudo eliminar la lista:</b> <code>${escapeHtml(msg2.slice(0, 120))}</code>`
        );
      }
      return;
    }
    if (data.startsWith("comments_menu:")) {
      const pubId = Number(data.slice("comments_menu:".length) || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Cargando Dashboard de Comentarios..."
      }).catch(() => {
      });
      await sendOrEditCommentsMenuInTelegram(
        chatId2,
        messageId,
        pubId > 0 ? pubId : void 0
      );
      return;
    }
    if (data.startsWith("cm_d:") || data.startsWith("cm_r:")) {
      const isRefresh = data.startsWith("cm_r:");
      const parts = data.split(":");
      const catKey = parts[1] || "all";
      const sortRaw = parts[2] || "recent";
      const sortMode = sortRaw === "oldest" || sortRaw === "video" ? sortRaw : "recent";
      const page = Number(parts[3] || 0) || 0;
      const pubId = Number(parts[4] || 0) || 0;
      if (isRefresh) {
        invalidateChannelCommentsCache();
      }
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: isRefresh ? "Sincronizando todos los comentarios con Picta..." : "Actualizando vista..."
      }).catch(() => {
      });
      await sendOrEditCommentsMenuInTelegram(
        chatId2,
        messageId,
        pubId > 0 ? pubId : void 0,
        void 0,
        void 0,
        { catKey, sort: sortMode, page, forceRefresh: isRefresh }
      );
      return;
    }
    if (data.startsWith("comment_reply_prompt:")) {
      const parts = data.split(":");
      const pubId = Number(parts[1] || 0);
      const parentId = Number(parts[2] || 0);
      const prevView = lastCommentsViewByChat.get(chatId2);
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      pendingToolkitInputByChat.set(chatId2, {
        mode: "reply_comment_text",
        targetId: pubId,
        secondaryId: parentId,
        messageId
      });
      const promptText = `\u{1F4AC} <b>${parentId > 0 ? "RESPONDER COMENTARIO EN PICTA" : "PUBLICAR COMENTARIO EN VIDEO"}</b>
<blockquote>\u{1F3AC} <b>Video ID:</b> <code>#${pubId}</code>${parentId > 0 ? ` \xB7 \u21A9\uFE0F <b>Respuesta a comentario:</b> <code>#${parentId}</code>` : ""}</blockquote>
\u270D\uFE0F <b>Escribe ahora en el chat el texto de tu respuesta/comentario:</b>`;
      const cancelCallback = prevView ? `cm_d:${prevView.catKey}:${prevView.sort}:${prevView.page}:${prevView.pubId}` : `comments_menu:${pubId}`;
      const kb = [[{ text: "\u2B05\uFE0F Cancelar", callback_data: cancelCallback }]];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, promptText, kb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, promptText, void 0, kb);
      }
      return;
    }
    if (data.startsWith("comment_del:")) {
      const parts = data.split(":");
      const commentId = Number(parts[1] || 0);
      const returnPubId = Number(parts[2] || 0);
      const prevView = lastCommentsViewByChat.get(chatId2);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Eliminando comentario..."
      }).catch(() => {
      });
      try {
        await deletePictaCommentInChannel(chatId2, commentId);
        await sendOrEditCommentsMenuInTelegram(
          chatId2,
          messageId,
          returnPubId > 0 ? returnPubId : void 0,
          void 0,
          `\u{1F5D1}\uFE0F <b>Comentario <code>#${commentId}</code> eliminado de Picta.</b>`,
          prevView ? { catKey: prevView.catKey, sort: prevView.sort, page: prevView.page, forceRefresh: true } : { forceRefresh: true }
        );
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : String(err);
        await sendOrEditCommentsMenuInTelegram(
          chatId2,
          messageId,
          returnPubId > 0 ? returnPubId : void 0,
          void 0,
          `\u26A0\uFE0F <b>No se pudo borrar el comentario:</b> <code>${escapeHtml(msg2.slice(0, 120))}</code>`,
          prevView ? { catKey: prevView.catKey, sort: prevView.sort, page: prevView.page } : void 0
        );
      }
      return;
    }
    if (data.startsWith("comment_del_alert:")) {
      const parts = data.split(":");
      const pubId = Number(parts[1] || 0);
      const commentId = Number(parts[2] || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Eliminando comentario de Picta..."
      }).catch(() => {
      });
      try {
        await deletePictaCommentInChannel(chatId2, commentId);
        if (messageId) {
          await editTelegramStatusMessage(
            chatId2,
            messageId,
            `\u{1F5D1}\uFE0F <b>Comentario <code>#${commentId}</code> eliminado en Picta</b> (Video #${pubId}).`,
            void 0,
            true
          );
        }
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : String(err);
        await sendTelegramStatusMessage(
          chatId2,
          `\u26A0\uFE0F <b>No se pudo borrar el comentario #${commentId}:</b> <code>${escapeHtml(msg2.slice(0, 140))}</code>`,
          messageId || void 0
        );
      }
      return;
    }
    if (data === "personas_menu") {
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Abriendo cat\xE1logo de actores y etiquetas..."
      }).catch(() => {
      });
      await sendOrEditPersonasAndTagsMenuInTelegram(chatId2, messageId);
      return;
    }
    if (data === "persona_create_prompt") {
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      pendingToolkitInputByChat.set(chatId2, {
        mode: "new_persona_name",
        messageId
      });
      const promptText = `\u{1F464} <b>BUSCAR O REGISTRAR ACTOR / DIRECTOR EN PICTA</b>
<blockquote>Escribe ahora el <b>nombre completo del actor o director</b> (ej: <i>Simon Baker</i>, <i>Pedro Pascal</i>) para buscar su ID o darlo de alta en Picta:</blockquote>`;
      const kb = [[{ text: "\u2B05\uFE0F Cancelar", callback_data: "personas_menu" }]];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, promptText, kb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, promptText, void 0, kb);
      }
      return;
    }
    if (data === "keyword_create_prompt") {
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      pendingToolkitInputByChat.set(chatId2, {
        mode: "new_keyword_name",
        messageId
      });
      const promptText = `\u{1F3F7}\uFE0F <b>BUSCAR O CREAR ETIQUETA / PALABRA CLAVE EN PICTA</b>
<blockquote>Escribe ahora la <b>etiqueta o palabra clave</b> (ej: <i>Suspenso</i>, <i>Estreno 2026</i>) para registrarla en el buscador de Picta:</blockquote>`;
      const kb = [[{ text: "\u2B05\uFE0F Cancelar", callback_data: "personas_menu" }]];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, promptText, kb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, promptText, void 0, kb);
      }
      return;
    }
    if (data.startsWith("serie_meta_edit:")) {
      const parts = data.split(":");
      const editField = parts[1];
      const pelserId = Number(parts[2] || 0);
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      const ctx = getEffectivePictaContext(chatId2);
      if (!ctx.isLinked || !ctx.channelId) {
        await sendOrEditMyChannelSeriesMenu(chatId2, messageId);
        return;
      }
      const serieRec = findUserChannelSerie(pelserId, chatId2);
      const serieName = serieRec?.nombre || `Serie #${pelserId}`;
      const stateMode = editField === "name" ? "edit_serie_name" : editField === "synopsis" ? "edit_serie_synopsis" : editField === "portada" ? "edit_serie_portada" : editField === "poster" ? "edit_serie_poster" : "edit_serie_cover";
      pendingStandaloneSerieByChat.set(chatId2, {
        mode: stateMode,
        pelserId,
        serieName,
        messageId
      });
      const instructions = editField === "name" ? "\u270F\uFE0F <b>Escribe ahora en el chat el nuevo NOMBRE</b> para esta Serie en Picta:" : editField === "synopsis" ? "\u{1F4DD} <b>Escribe ahora en el chat la nueva SINOPSIS en espa\xF1ol</b> para la ficha principal de esta Serie:" : editField === "portada" ? "\u{1F5BC}\uFE0F <b>Env\xEDa ahora al chat una FOTO o IMAGEN horizontal (16:9)</b> para actualizar la <b>Portada</b> de esta Serie en Picta, o apl\xEDcala autom\xE1ticamente desde TMDB:" : "\u{1F39E}\uFE0F <b>Env\xEDa ahora al chat una FOTO o IMAGEN vertical (2:3)</b> para actualizar el <b>P\xF3ster</b> de esta Serie en Picta, o apl\xEDcalo autom\xE1ticamente desde TMDB:";
      const promptText = `\u{1F4FA} <b>EDITAR FICHA DE LA SERIE \xB7 ${escapeHtml(serieName.toUpperCase())}</b>
<blockquote>\u{1F194} <b>ID Serie en Picta:</b> <code>#${pelserId}</code></blockquote>
${instructions}`;
      const kb = [];
      if (editField === "portada" || editField === "poster" || editField === "cover") {
        const slot = editField === "portada" ? "portada" : "poster";
        kb.push([
          {
            text: slot === "portada" ? "\u{1F3AC} Aplicar Portada Oficial TMDB" : "\u{1F3AC} Aplicar P\xF3ster Oficial TMDB",
            callback_data: `serie_tmdb_img:${slot}:${pelserId}`
          }
        ]);
        kb.push([
          {
            text: "\u2728 Aplicar Portada y P\xF3ster ambos (TMDB)",
            callback_data: `serie_tmdb_img:both:${pelserId}`
          }
        ]);
      }
      kb.push([{ text: "\u2B05\uFE0F Cancelar", callback_data: `serie_manage:${pelserId}:0` }]);
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, promptText, kb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, promptText, void 0, kb);
      }
      return;
    }
    if (data.startsWith("serie_tmdb_img:")) {
      const parts = data.split(":");
      const slot = parts[1] || "poster";
      const pelserId = Number(parts[2] || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Buscando imagen oficial en TMDB..."
      }).catch(() => {
      });
      pendingStandaloneSerieByChat.delete(chatId2);
      const ctx = getEffectivePictaContext(chatId2);
      if (!ctx.isLinked || !ctx.channelId) {
        await sendOrEditMyChannelSeriesMenu(chatId2, messageId);
        return;
      }
      const serieRec = findUserChannelSerie(pelserId, chatId2);
      const serieName = cleanSerieDisplayName(serieRec?.nombre || "") || `Serie #${pelserId}`;
      try {
        const { portadaBuffer, posterBuffer } = await fetchTmdbSlotBuffersForTitle(serieName, 5);
        const patchFiles = buildSerieImagePatchFiles({
          slot,
          tmdbPortadaBuffer: portadaBuffer,
          tmdbPosterBuffer: posterBuffer
        });
        if (!patchFiles.portadaBuffer && !patchFiles.posterBuffer) {
          throw new Error(`No se encontr\xF3 imagen oficial en TMDB para "${serieName}".`);
        }
        await patchSerieInPictaChannel(chatId2, pelserId, patchFiles);
        const label = slot === "both" ? "Portada horizontal y P\xF3ster vertical" : slot === "portada" ? "Portada horizontal" : "P\xF3ster vertical";
        await sendOrEditSerieDetailInTelegram(
          chatId2,
          messageId,
          pelserId,
          0,
          `\u2705 <b>\xA1${label} de la serie actualizado(s) desde TMDB en Picta!</b>`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendOrEditSerieDetailInTelegram(
          chatId2,
          messageId,
          pelserId,
          0,
          `\u26A0\uFE0F <b>No se pudo aplicar imagen TMDB a la serie:</b> <code>${escapeHtml(errMsg.slice(0, 120))}</code>`
        );
      }
      return;
    }
    if (data.startsWith("serie_del_ask:")) {
      const pelserId = Number(data.slice("serie_del_ask:".length) || 0);
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      const ctx = getEffectivePictaContext(chatId2);
      if (!ctx.isLinked || !ctx.channelId) {
        await sendOrEditMyChannelSeriesMenu(chatId2, messageId);
        return;
      }
      const serieRec = findUserChannelSerie(pelserId, chatId2);
      const serieName = serieRec?.nombre || `Serie #${pelserId}`;
      const confirmText = `\u26A0\uFE0F <b>\xBFCONFIRMAS ELIMINAR LA SERIE "${escapeHtml(serieName.toUpperCase())}" DE PICTA?</b>
<blockquote>\u{1F194} <b>ID Serie:</b> <code>#${pelserId}</code>
Esta acci\xF3n ejecutar\xE1 <code>DELETE /v1/serie/${pelserId}/</code> en Picta.</blockquote>`;
      const kb = [
        [{ text: "\u{1F5D1}\uFE0F S\xED, Eliminar Serie", callback_data: `serie_del_confirm:${pelserId}` }],
        [{ text: "\u2B05\uFE0F Cancelar", callback_data: `serie_manage:${pelserId}:0` }]
      ];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, confirmText, kb, true);
      }
      return;
    }
    if (data.startsWith("serie_del_confirm:")) {
      const pelserId = Number(data.slice("serie_del_confirm:".length) || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Eliminando serie de Picta..."
      }).catch(() => {
      });
      try {
        await deleteSerieInPictaChannel(chatId2, pelserId);
        await sendOrEditMyChannelSeriesMenu(
          chatId2,
          messageId,
          void 0,
          `\u{1F5D1}\uFE0F <b>Serie <code>#${pelserId}</code> eliminada correctamente de Picta.</b>`
        );
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : String(err);
        await sendOrEditSerieDetailInTelegram(
          chatId2,
          messageId,
          pelserId,
          0,
          `\u26A0\uFE0F <b>No se pudo eliminar la serie:</b> <code>${escapeHtml(msg2.slice(0, 120))}</code>`
        );
      }
      return;
    }
    if (data.startsWith("pub_edit:")) {
      const parts = data.split(":");
      const mode = parts[1];
      const pubId = Number(parts[2] || 0);
      const returnSort = parts[3] || "views";
      const returnPage = Number(parts[4] || 0);
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      const pubs = await fetchPictaChannelPublications(chatId2).catch(() => []);
      const pub = pubs.find((p) => Number(p.id) === pubId);
      let pubTitle = String(pub?.nombre || "");
      if (!pubTitle) {
        const foundCap = findUserChannelChapter(pubId, chatId2);
        if (foundCap) {
          pubTitle = foundCap.chapter.nombre;
        }
      }
      if (!pubTitle) pubTitle = `Video #${pubId}`;
      pendingPubEditByChat.set(chatId2, {
        pubId,
        pubTitle,
        mode,
        messageId,
        returnSort,
        returnPage
      });
      const modeInstructions = {
        title: `\u270F\uFE0F <b>Escribe ahora en el chat el nuevo T\xCDTULO</b> para este video en Picta:`,
        desc: `\u{1F4DD} <b>Escribe ahora en el chat la nueva DESCRIPCI\xD3N / SINOPSIS</b> para este video en Picta (el bot limpiar\xE1 cualquier ID autom\xE1ticamente):`,
        cover: `\u{1F5BC}\uFE0F <b>Env\xEDa ahora al chat una FOTO o IMAGEN horizontal (16:9)</b> para actualizar la <b>Portada</b> de este video en Picta, o apl\xEDcala autom\xE1ticamente desde TMDB:`,
        poster: `\u{1F39E}\uFE0F <b>Env\xEDa ahora al chat una FOTO o IMAGEN vertical (2:3)</b> para actualizar el <b>P\xF3ster</b> de este video en Picta, o apl\xEDcalo autom\xE1ticamente desde TMDB:`,
        subs: `\u{1F4AC} <b>Env\xEDa ahora al chat el archivo de subt\xEDtulos (<code>.srt</code> o <code>.vtt</code>)</b> para adjuntarlo a este video en Picta:`,
        epnum: `\u{1F522} <b>Escribe ahora el nuevo n\xFAmero de Cap\xEDtulo</b> (ej: <code>4</code>) o <b>Temporada | Cap\xEDtulo</b> (ej: <code>1 | 4</code>) para actualizar este cap\xEDtulo en Picta:`,
        tags: `\u{1F3F7}\uFE0F <b>Escribe ahora las etiquetas separadas por coma</b> (ej: <code>Acci\xF3n, Suspenso, Estreno</code>) para registrarlas y asignarlas al video en Picta:`
      };
      const promptText = `\u{1F6E0}\uFE0F <b>EDITAR CAP\xCDTULO / VIDEO EN PICTA</b>
<blockquote>\u{1F3AC} <b>Video:</b> ${escapeHtml(pubTitle)}</blockquote>
${modeInstructions[mode] || "Env\xEDa el nuevo valor al chat:"}`;
      const cancelKb = [];
      if (mode === "cover" || mode === "poster") {
        const slot = mode === "poster" ? "poster" : "portada";
        cancelKb.push([
          {
            text: slot === "poster" ? "\u{1F3AC} Aplicar P\xF3ster Oficial TMDB" : "\u{1F3AC} Aplicar Portada Oficial TMDB",
            callback_data: `pub_tmdb_img:${slot}:${pubId}:${returnSort}:${returnPage}`
          }
        ]);
        cancelKb.push([
          {
            text: "\u2728 Aplicar Portada y P\xF3ster ambos (TMDB)",
            callback_data: `pub_tmdb_img:both:${pubId}:${returnSort}:${returnPage}`
          }
        ]);
      }
      cancelKb.push([
        {
          text: "\u2B05\uFE0F Cancelar y Volver",
          callback_data: `dash_pub:${pubId}:${returnSort}:${returnPage}`
        }
      ]);
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, promptText, cancelKb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, promptText, void 0, cancelKb);
      }
      return;
    }
    if (data.startsWith("pub_tmdb_img:")) {
      const parts = data.split(":");
      const slot = parts[1] || "poster";
      const pubId = Number(parts[2] || 0);
      const returnSort = parts[3] || "views";
      const returnPage = Number(parts[4] || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Buscando car\xE1tula/p\xF3ster oficial en TMDB..."
      }).catch(() => {
      });
      pendingPubEditByChat.delete(chatId2);
      try {
        const pubs = await fetchPictaChannelPublications(chatId2).catch(() => []);
        const pub = pubs.find((item) => Number(item.id) === pubId);
        const foundCap = findUserChannelChapter(pubId, chatId2);
        const pubTitle = String(pub?.nombre || foundCap?.chapter?.nombre || `Video #${pubId}`);
        const parentSerieName = foundCap?.serie?.nombre;
        const tipId = Number(pub?.categoria?.tipologia?.id || (foundCap ? 5 : 1));
        const { portadaBuffer, posterBuffer } = await fetchTmdbSlotBuffersForTitle(
          pubTitle,
          tipId,
          parentSerieName
        );
        const patchFiles = buildPublicationImagePatchFiles({
          slot,
          tmdbPortadaBuffer: portadaBuffer,
          tmdbPosterBuffer: posterBuffer
        });
        if (!patchFiles.coverBuffer && !patchFiles.posterBuffer) {
          throw new Error(`No se encontr\xF3 portada/p\xF3ster oficial en TMDB para "${pubTitle}".`);
        }
        await patchPictaPublicationInChannel(pubId, {}, patchFiles, chatId2);
        const label = slot === "both" ? "Portada y P\xF3ster" : slot === "poster" ? "P\xF3ster vertical" : "Portada horizontal";
        await sendOrEditPictaPubDetailInTelegram(
          chatId2,
          messageId,
          pubId,
          returnSort,
          returnPage,
          `\u2705 <b>\xA1${label} actualizado(s) desde TMDB exitosamente en Picta!</b>`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendOrEditPictaPubDetailInTelegram(
          chatId2,
          messageId,
          pubId,
          returnSort,
          returnPage,
          `\u26A0\uFE0F <b>No se pudo aplicar desde TMDB:</b> <code>${escapeHtml(errMsg.slice(0, 120))}</code>`
        );
      }
      return;
    }
    if (data.startsWith("pub_toggle_dl:")) {
      const parts = data.split(":");
      const pubId = Number(parts[1] || 0);
      const returnSort = parts[2] || "views";
      const returnPage = Number(parts[3] || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Actualizando permiso de descarga en Picta..."
      }).catch(() => {
      });
      try {
        const pubs = await fetchPictaChannelPublications(chatId2).catch(() => []);
        const pub = pubs.find((p) => Number(p.id) === pubId);
        const nextDl = pub?.descarga === false ? "true" : "false";
        await patchPictaPublicationInChannel(pubId, { descarga: nextDl }, void 0, chatId2);
        await sendOrEditPictaPubDetailInTelegram(
          chatId2,
          messageId,
          pubId,
          returnSort,
          returnPage,
          nextDl === "true" ? "\u{1F4E5} <b>Descarga directa ACTIVADA para este video en Picta.</b>" : "\u{1F512} <b>Descarga directa BLOQUEADA para este video en Picta.</b>"
        );
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : String(err);
        await sendOrEditPictaPubDetailInTelegram(
          chatId2,
          messageId,
          pubId,
          returnSort,
          returnPage,
          `\u26A0\uFE0F <b>No se pudo cambiar descarga:</b> <code>${escapeHtml(msg2.slice(0, 120))}</code>`
        );
      }
      return;
    }
    if (data.startsWith("pub_direct_dl:")) {
      const pubId = Number(data.slice("pub_direct_dl:".length) || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Generando enlaces directos de descarga..."
      }).catch(() => {
      });
      try {
        const direct = await fetchPictaPublicationDirectLinks(chatId2, pubId);
        const dlUrl = direct.url_descarga || direct.url_video;
        const maniUrl = direct.url_manifiesto;
        const dlBlock = dlUrl ? `\u{1F4E5} <b>Enlace de Descarga Directa (Archivo Video/MP4):</b>
<code>${escapeHtml(dlUrl)}</code>

` : `\u{1F4E5} <i>Enlace MP4 directo a\xFAn proces\xE1ndose en los servidores de Picta.</i>

`;
        const maniBlock = maniUrl ? `\u{1F4FA} <b>Enlace de Streaming Directo (HLS .m3u8):</b>
<code>${escapeHtml(maniUrl)}</code>

` : "";
        const webUrl = `https://www.picta.cu/medias/${pubId}`;
        const text2 = `\u{1F6AA} <b>ENLACES DIRECTOS ("PUERTA TRASERA") \xB7 PICTA</b>
<blockquote>\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(direct.nombre)}
\u{1F194} <b>ID Picta:</b> <code>#${pubId}</code>
` + (direct.tamanio > 0 ? `\u{1F4E6} <b>Tama\xF1o:</b> ${formatBytes(direct.tamanio)}
` : "") + `\u{1F310} <b>Web Oficial:</b> ${webUrl}</blockquote>

${dlBlock}${maniBlock}\u{1F4A1} <i>Puedes abrir o copiar estos enlaces en tu navegador, gestor de descargas (IDM, FDM) o reproductor VLC para descargar o ver el video directamente sin pasar por la web de Picta.</i>`;
        const keyboard = [];
        if (dlUrl && dlUrl.startsWith("http")) {
          keyboard.push([{ text: "\u{1F4E5} Descargar Archivo Directo (MP4)", url: dlUrl }]);
        }
        if (maniUrl && maniUrl.startsWith("http")) {
          keyboard.push([{ text: "\u{1F4FA} Abrir Stream HLS (.m3u8)", url: maniUrl }]);
        }
        keyboard.push([
          { text: "\u{1F310} Abrir en Picta Web", url: webUrl },
          { text: "\u2B05\uFE0F Volver", callback_data: `dash_pub:${pubId}:views:0` }
        ]);
        if (messageId) {
          await editTelegramStatusMessage(chatId2, messageId, text2, keyboard, true);
        } else {
          await sendTelegramStatusMessage(chatId2, text2, void 0, keyboard);
        }
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : String(err);
        await sendTelegramStatusMessage(
          chatId2,
          `\u26A0\uFE0F <b>No se pudieron extraer los enlaces directos del video #${pubId}:</b>
<code>${escapeHtml(msg2.slice(0, 140))}</code>`
        );
      }
      return;
    }
    if (data.startsWith("pub_dl_link:")) {
      const parts = data.split(":");
      const pubId = Number(parts[1] || 0);
      const returnSort = parts[2] || "views";
      const returnPage = Number(parts[3] || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Obteniendo enlaces directos de Picta..."
      }).catch(() => {
      });
      try {
        const pubs = await fetchPictaChannelPublications(chatId2).catch(() => []);
        const pub = pubs.find((p) => Number(p.id) === pubId) || { id: pubId };
        const links = extractPictaPublicationLinks(pub);
        const linkNotice = `\u{1F517} <b>ENLACES DIRECTOS DEL VIDEO (#${pubId}):</b>
\u2022 \u{1F310} <b>Web Picta:</b> ${escapeHtml(links.webUrl)}
` + (links.directStreamUrl ? `\u2022 \u{1F39E}\uFE0F <b>Stream/HLS:</b> <code>${escapeHtml(links.directStreamUrl)}</code>
` : "") + (links.coverUrl ? `\u2022 \u{1F5BC}\uFE0F <b>Portada:</b> <code>${escapeHtml(links.coverUrl)}</code>` : "");
        await sendOrEditPictaPubDetailInTelegram(
          chatId2,
          messageId,
          pubId,
          returnSort,
          returnPage,
          linkNotice
        );
      } catch {
        await sendOrEditPictaPubDetailInTelegram(chatId2, messageId, pubId, returnSort, returnPage);
      }
      return;
    }
    if (data.startsWith("pub_add_playlist_pick:")) {
      const parts = data.split(":");
      const pubId = Number(parts[1] || 0);
      const returnSort = parts[2] || "views";
      const returnPage = Number(parts[3] || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Cargando listas de reproducci\xF3n..."
      }).catch(() => {
      });
      const playlists = await fetchChannelPlaylistsInPicta(chatId2).catch(() => []);
      const kb = [];
      for (const pl of playlists.slice(0, 8)) {
        kb.push([
          {
            text: `\u{1F4C2} A\xF1adir a "${pl.nombre.slice(0, 26)}" (#${pl.id})`,
            callback_data: `pub_add_playlist_do:${pl.id}:${pubId}:${returnSort}:${returnPage}`
          }
        ]);
      }
      kb.push([
        { text: "\u2795 Crear Nueva Lista (/listas)", callback_data: "playlist_create_prompt" },
        { text: "\u2B05\uFE0F Volver al Video", callback_data: `dash_pub:${pubId}:${returnSort}:${returnPage}` }
      ]);
      const text2 = `\u{1F4C2} <b>A\xD1ADIR VIDEO #${pubId} A UNA LISTA DE REPRODUCCI\xD3N</b>

` + (playlists.length > 0 ? `Selecciona en qu\xE9 lista de reproducci\xF3n de tu canal deseas incluir este video:` : `<i>A\xFAn no tienes listas creadas en tu canal. Pulsa "\u2795 Crear Nueva Lista" abajo para crear una.</i>`);
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, text2, kb, true);
      }
      return;
    }
    if (data.startsWith("pub_add_playlist_do:")) {
      const parts = data.split(":");
      const playlistId = Number(parts[1] || 0);
      const pubId = Number(parts[2] || 0);
      const returnSort = parts[3] || "views";
      const returnPage = Number(parts[4] || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "A\xF1adiendo video a la lista de reproducci\xF3n..."
      }).catch(() => {
      });
      try {
        await addPublicationToPlaylistInPicta(chatId2, playlistId, pubId);
        await sendOrEditPictaPubDetailInTelegram(
          chatId2,
          messageId,
          pubId,
          returnSort,
          returnPage,
          `\u2705 <b>\xA1Video a\xF1adido exitosamente a la Lista de Reproducci\xF3n <code>#${playlistId}</code>!</b>`
        );
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : String(err);
        await sendOrEditPictaPubDetailInTelegram(
          chatId2,
          messageId,
          pubId,
          returnSort,
          returnPage,
          `\u26A0\uFE0F <b>No se pudo a\xF1adir a la lista:</b> <code>${escapeHtml(msg2.slice(0, 120))}</code>`
        );
      }
      return;
    }
    if (data.startsWith("pub_toggle_vis:")) {
      const parts = data.split(":");
      const pubId = Number(parts[1] || 0);
      const returnSort = parts[2] || "views";
      const returnPage = Number(parts[3] || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Actualizando visibilidad en Picta..."
      }).catch(() => {
      });
      try {
        const directBefore = await fetchSinglePictaPublicationDirect(pubId, chatId2);
        const pubs = directBefore ? [] : await fetchPictaChannelPublications(chatId2).catch(() => []);
        const pub = directBefore || pubs.find((p) => Number(p.id) === pubId);
        let currentPubState = pub?.publicado;
        const foundCap = findUserChannelChapter(pubId, chatId2);
        if (typeof currentPubState !== "boolean" && foundCap) {
          currentPubState = foundCap.chapter.publicado !== false;
        }
        const nextPublished = currentPubState === false ? "true" : "false";
        const patchResult = await patchPictaPublicationInChannel(
          pubId,
          { publicado: nextPublished },
          void 0,
          chatId2
        );
        const verifiedAfter = await fetchSinglePictaPublicationDirect(pubId, chatId2);
        const actualPublished = typeof verifiedAfter?.publicado === "boolean" ? verifiedAfter.publicado : typeof patchResult?.publicado === "boolean" ? patchResult.publicado : nextPublished === "true";
        if (foundCap) {
          foundCap.chapter.publicado = actualPublished;
          saveChannelSeriesToDisk(channelSeriesCache);
        }
        const bannerResult = nextPublished === "true" ? actualPublished ? "\u2705 <b>Video publicado en tu canal de Picta (verificado en vivo).</b>" : "\u26A0\uFE0F <b>Picta mantuvo el video SIN PUBLICAR.</b>\n<i>Este video nunca fue aprobado por moderaci\xF3n en Picta o no complet\xF3 la conversi\xF3n Nomad. Picta no permite forzar su publicaci\xF3n hasta que un moderador lo apruebe (puedes eliminarlo si deseas limpiar la auditor\xEDa).</i>" : !actualPublished ? "\u{1F648} <b>Video ocultado de tu canal en Picta (verificado en vivo).</b>" : "\u26A0\uFE0F <b>Picta mantuvo el video publicado.</b>";
        await sendOrEditPictaPubDetailInTelegram(
          chatId2,
          messageId,
          pubId,
          returnSort,
          returnPage,
          bannerResult
        );
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : String(err);
        await sendOrEditPictaPubDetailInTelegram(
          chatId2,
          messageId,
          pubId,
          returnSort,
          returnPage,
          `\u26A0\uFE0F <b>Aviso al cambiar visibilidad:</b> <code>${escapeHtml(msg2.slice(0, 120))}</code>`
        );
      }
      return;
    }
    if (data.startsWith("pub_del_ask:")) {
      const parts = data.split(":");
      const pubId = Number(parts[1] || 0);
      const returnSort = parts[2] || "views";
      const returnPage = Number(parts[3] || 0);
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      const foundCap = findUserChannelChapter(pubId, chatId2);
      const capTitle = foundCap?.chapter.nombre || `Publicaci\xF3n #${pubId}`;
      const confirmText = `\u26A0\uFE0F <b>\xBFCONFIRMAS ELIMINAR ESTE VIDEO DE PICTA?</b>
<blockquote>\u{1F3AC} <b>Video:</b> ${escapeHtml(capTitle)}
Esta acci\xF3n eliminar\xE1 o retirar\xE1 el cap\xEDtulo/video de tu canal en Picta.</blockquote>`;
      const confirmKb = [
        [
          {
            text: "\u{1F5D1}\uFE0F S\xED, Eliminar Definitivamente",
            callback_data: `pub_del_confirm:${pubId}:${returnSort}:${returnPage}`
          }
        ],
        [
          {
            text: "\u2B05\uFE0F Cancelar",
            callback_data: returnSort.startsWith("serie_") ? `serie_manage:${returnSort.replace("serie_", "")}:${returnPage}` : `dash_pub:${pubId}:${returnSort}:${returnPage}`
          }
        ]
      ];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, confirmText, confirmKb, true);
      }
      return;
    }
    if (data.startsWith("pub_del_confirm:")) {
      const parts = data.split(":");
      const pubId = Number(parts[1] || 0);
      const returnSort = parts[2] || "views";
      const returnPage = Number(parts[3] || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Eliminando de Picta..."
      }).catch(() => {
      });
      try {
        await deletePictaPublicationInChannel(pubId, chatId2);
        const ctx = getEffectivePictaContext(chatId2);
        const scopedSeries = filterSeriesForChannel(
          channelSeriesCache,
          ctx.channelId,
          isMasterAdminChat(chatId2),
          botConfig.pictaChannelId || "36319"
        );
        for (const s of scopedSeries) {
          if (Array.isArray(s.chapters)) {
            s.chapters = s.chapters.filter((c) => Number(c.pubId) !== pubId);
          }
        }
        saveChannelSeriesToDisk(channelSeriesCache);
        if (returnSort.startsWith("serie_")) {
          const sPelserId = Number(returnSort.replace("serie_", ""));
          await sendOrEditSerieDetailInTelegram(
            chatId2,
            messageId,
            sPelserId,
            returnPage,
            `\u{1F5D1}\uFE0F <b>Cap\xEDtulo eliminado correctamente de Picta.</b>`
          );
        } else {
          await sendOrEditPictaDashboardInTelegram(chatId2, messageId, returnSort, returnPage);
        }
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : String(err);
        await sendOrEditPictaPubDetailInTelegram(
          chatId2,
          messageId,
          pubId,
          returnSort,
          returnPage,
          `\u26A0\uFE0F <b>No se pudo eliminar:</b> <code>${escapeHtml(msg2.slice(0, 120))}</code>`
        );
      }
      return;
    }
    if (data === "queue_view") {
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Cargando cola de subida..."
      }).catch(() => {
      });
      await sendOrEditQueueManagerInTelegram(chatId2, messageId);
      return;
    }
    if (data === "quota_menu") {
      pendingPoolAccountByChat.delete(chatId2);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Abriendo gestor de cuota diaria y Pool..."
      }).catch(() => {
      });
      await sendOrEditQuotaMenuInTelegram(chatId2, messageId);
      return;
    }
    if (data.startsWith("quota_split:")) {
      if (!isMasterAdminChat(chatId2)) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u26D4 Solo el Administrador Principal puede configurar el Pool multi-cuenta.",
          show_alert: true
        }).catch(() => {
        });
        return;
      }
      const maxS = Number(data.slice("quota_split:".length) || 0);
      ensureDailyQuotaReset();
      quotaSettings.maxSeriesPerDay = isNaN(maxS) || maxS < 0 ? 0 : maxS;
      saveQuotaSettingsToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: quotaSettings.maxSeriesPerDay > 0 ? `Cuota dividida: ${quotaSettings.maxSeriesPerDay} Series / ${10 - quotaSettings.maxSeriesPerDay} Pel\xEDculas` : "Cuota 10/10 sin reserva activada"
      }).catch(() => {
      });
      await sendOrEditQuotaMenuInTelegram(
        chatId2,
        messageId,
        void 0,
        quotaSettings.maxSeriesPerDay > 0 ? `\u2705 <b>Divisi\xF3n de cuota actualizada:</b> M\xE1ximo <b>${quotaSettings.maxSeriesPerDay} cap\xEDtulos de Serie</b> al d\xEDa en la cuenta principal (reservando <b>${Math.max(0, 10 - quotaSettings.maxSeriesPerDay)} cupos</b> para pel\xEDculas u otros videos).` : `\u2705 <b>Reserva desactivada:</b> Los 10 cupos diarios de cada cuenta est\xE1n 100% libres para Series o Pel\xEDculas.`
      );
      return;
    }
    if (data.startsWith("quota_unlock_and_retry:")) {
      if (!isMasterAdminChat(chatId2)) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u26D4 Acci\xF3n reservada al Administrador Principal.",
          show_alert: true
        }).catch(() => {
        });
        return;
      }
      const targetJobId = data.slice("quota_unlock_and_retry:".length);
      ensureDailyQuotaReset();
      quotaSettings.maxSeriesPerDay = 0;
      saveQuotaSettingsToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "\u{1F513} Cupos liberados. Reanudando subida de la serie..."
      }).catch(() => {
      });
      const job = transferJobs.find((j) => j.id === targetJobId);
      if (job) {
        job.errorDetails = void 0;
        saveJobsToDisk();
        await triggerCloudRunKeepAliveTransfer(job.id, job.title, messageId || job.statusMessageId);
      }
      return;
    }
    if (data === "quota_resume_queue") {
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "\u25B6\uFE0F Reanudando tu cola de subida..."
      }).catch(() => {
      });
      const isMaster = isMasterAdminChat(chatId2);
      const myQueueIds = uploadQueue.filter((qId) => {
        const j = transferJobs.find((x) => x.id === qId);
        return j && (isMaster || j.telegramChatId === chatId2);
      });
      for (const qId of myQueueIds) {
        const j = transferJobs.find((x) => x.id === qId);
        if (j && j.errorDetails) {
          j.errorDetails = void 0;
        }
      }
      saveJobsToDisk();
      void scheduleTransferPipeline();
      await sendOrEditQueueManagerInTelegram(
        chatId2,
        messageId,
        void 0,
        `\u25B6\uFE0F <b>Cola de subida reanudada.</b>`
      );
      return;
    }
    if (data === "quota_add_account") {
      const ctx = getEffectivePictaContext(chatId2);
      if (!isMasterAdminChat(chatId2) && (!ctx.isLinked || !ctx.channelId)) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u26D4 Vincula primero tu cuenta y canal con /login para a\xF1adir colaboradores al Pool.",
          show_alert: true
        }).catch(() => {
        });
        return;
      }
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      pendingPoolAccountByChat.set(chatId2, { step: "awaiting_username", messageId });
      const promptText = `\u2795 <b>A\xD1ADIR CUENTA COLABORADORA AL POOL (+10 VIDEOS/D\xCDA)</b>
<blockquote>La cuenta que agregues aqu\xED quedar\xE1 guardada en tu Pool y asociada como colaboradora de tu canal <b>${escapeHtml(ctx.channelName || "Multiverso Visual")} (#${escapeHtml(ctx.channelId || "36319")})</b>.</blockquote>
\u{1F4F1} <b>PASO 1/2:</b> Escribe ahora en el chat el <b>n\xFAmero de tel\xE9fono (+53...)</b> o <b>usuario de Picta</b> de la cuenta colaboradora:

<i>(O escribe /cancelar para volver)</i>`;
      const kb = [[{ text: "\u2B05\uFE0F Cancelar y Volver a Cuota", callback_data: "quota_menu" }]];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, promptText, kb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, promptText, void 0, kb);
      }
      return;
    }
    if (data.startsWith("quota_del_account:")) {
      const chatPool = getPoolAccountsForChat(chatId2);
      const idx = Number(data.slice("quota_del_account:".length));
      const removed = !isNaN(idx) && idx >= 0 && idx < chatPool.length ? chatPool.splice(idx, 1)[0] : null;
      savePoolAccountsForChat(chatId2);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: removed ? `Cuenta ${removed.username} eliminada del Pool` : "Cuenta no encontrada"
      }).catch(() => {
      });
      await sendOrEditQuotaMenuInTelegram(
        chatId2,
        messageId,
        void 0,
        removed ? `\u{1F5D1}\uFE0F <b>Cuenta secundaria <code>${escapeHtml(removed.displayName || removed.username)}</code> retirada del Pool.</b>` : void 0
      );
      return;
    }
    if (data.startsWith("retry_acct:")) {
      pendingPoolAccountByChat.delete(chatId2);
      const jobId = data.slice("retry_acct:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      job.preferredUploadAccountKey = void 0;
      job.preferredUploadAccountLabel = void 0;
      saveJobsToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Elige la cuenta para reintentar..."
      }).catch(() => {
      });
      await promptUploadAccountSelection(job, chatId2, messageId);
      return;
    }
    if (data.startsWith("upload_acct_add:")) {
      const jobId = data.slice("upload_acct_add:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      const ctx = getEffectivePictaContext(chatId2);
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      pendingPoolAccountByChat.set(chatId2, {
        step: "awaiting_username",
        messageId,
        returnToJobId: job.id
      });
      const promptText = `\u2795 <b>A\xD1ADIR NUEVO COLABORADOR AL POOL</b>
<blockquote>Al terminar de a\xF1adirlo volver\xE1s autom\xE1ticamente para subir <b>${escapeHtml(job.title || job.fileName)}</b> en el canal <b>${escapeHtml(ctx.channelName || "tu canal")} (#${escapeHtml(ctx.channelId || "")})</b>.</blockquote>
\u{1F4F1} <b>PASO 1/2:</b> Escribe ahora en el chat el <b>n\xFAmero de tel\xE9fono (+53...)</b> o <b>usuario de Picta</b> del colaborador:

<i>(O escribe /cancelar para volver al selector)</i>`;
      const kb = [[{ text: "\u2B05\uFE0F Volver al Selector de Cuenta", callback_data: `retry_acct:${job.id}` }]];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, promptText, kb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, promptText, void 0, kb);
      }
      return;
    }
    if (data.startsWith("upload_acct:")) {
      const rest = data.slice("upload_acct:".length);
      let selectedKey = "primary";
      let selectedLabel = getPrimaryAccountLabelForChat(chatId2);
      let jobId = "";
      if (rest.startsWith("primary:")) {
        jobId = rest.slice("primary:".length);
      } else if (rest.startsWith("pool:")) {
        const afterPool = rest.slice("pool:".length);
        const colonIdx = afterPool.indexOf(":");
        if (colonIdx === -1) return;
        const poolIdx = Number(afterPool.slice(0, colonIdx));
        jobId = afterPool.slice(colonIdx + 1);
        const poolAccounts = getPoolAccountsForChat(chatId2);
        const acc = poolAccounts[poolIdx];
        if (!acc) {
          await callTelegramBotApi("answerCallbackQuery", {
            callback_query_id: cq.id,
            text: "\u26A0\uFE0F Esa cuenta ya no est\xE1 en el Pool. Elige otra.",
            show_alert: true
          }).catch(() => {
          });
          const jFallback = transferJobs.find((j) => j.id === jobId);
          if (jFallback) await promptUploadAccountSelection(jFallback, chatId2, messageId);
          return;
        }
        selectedKey = `pool:${String(acc.username || "").trim().toLowerCase()}`;
        selectedLabel = acc.displayName || acc.username;
      } else {
        return;
      }
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      job.preferredUploadAccountKey = selectedKey;
      job.preferredUploadAccountLabel = selectedLabel;
      saveJobsToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `Subiendo con ${selectedLabel}`
      }).catch(() => {
      });
      await startJobUploadWithSelectedAccount(job, chatId2, messageId);
      return;
    }
    if (data.startsWith("admin_users_list:")) {
      if (!isMasterAdminChat(chatId2)) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u26D4 Solo el Administrador Principal puede consultar la lista de usuarios.",
          show_alert: true
        }).catch(() => {
        });
        return;
      }
      const page = Number(data.slice("admin_users_list:".length) || 0) || 0;
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Actualizando panel de usuarios y cuotas..."
      }).catch(() => {
      });
      await sendOrEditAdminUsersDashboardInTelegram(chatId2, messageId, page);
      return;
    }
    if (data.startsWith("admin_user_detail:")) {
      if (!isMasterAdminChat(chatId2)) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u26D4 Solo el Administrador Principal puede inspeccionar usuarios.",
          show_alert: true
        }).catch(() => {
        });
        return;
      }
      const parts = data.slice("admin_user_detail:".length).split(":");
      const targetUserChatId = parts[0] || "";
      const returnPage = Number(parts[1] || 0) || 0;
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Abriendo ficha detallada del usuario..."
      }).catch(() => {
      });
      await sendOrEditAdminUserDetailInTelegram(chatId2, messageId, targetUserChatId, returnPage);
      return;
    }
    if (data.startsWith("admin_user_revoke_prompt:")) {
      if (!isMasterAdminChat(chatId2)) return;
      const parts = data.slice("admin_user_revoke_prompt:".length).split(":");
      const targetUserChatId = parts[0] || "";
      const returnPage = Number(parts[1] || 0) || 0;
      const rec = authorizedUsers.get(targetUserChatId);
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      const promptText = `\u26A0\uFE0F <b>CONFIRMAR REVOCACI\xD3N DE ACCESO</b>

\xBFEst\xE1s seguro de que deseas retirar a <b>${escapeHtml(rec?.name || rec?.username || targetUserChatId)}</b> (<code>${escapeHtml(targetUserChatId)}</code>) de la lista blanca y cerrar su sesi\xF3n de Picta?`;
      const kb = [
        [
          {
            text: "\u2705 S\xED, Revocar Acceso Ahora",
            callback_data: `admin_user_revoke_confirm:${targetUserChatId}:${returnPage}`
          }
        ],
        [
          {
            text: "\u2B05\uFE0F Cancelar y Volver a la Ficha",
            callback_data: `admin_user_detail:${targetUserChatId}:${returnPage}`
          }
        ]
      ];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, promptText, kb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, promptText, void 0, kb);
      }
      return;
    }
    if (data.startsWith("admin_user_revoke_confirm:")) {
      if (!isMasterAdminChat(chatId2)) return;
      const parts = data.slice("admin_user_revoke_confirm:".length).split(":");
      const targetUserChatId = parts[0] || "";
      const returnPage = Number(parts[1] || 0) || 0;
      const res = revokeUser(targetUserChatId);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: res.message
      }).catch(() => {
      });
      await sendOrEditAdminUsersDashboardInTelegram(
        chatId2,
        messageId,
        returnPage,
        void 0,
        res.success ? `\u2705 <b>${escapeHtml(res.message)}</b>` : `\u26A0\uFE0F <b>${escapeHtml(res.message)}</b>`
      );
      return;
    }
    if (data.startsWith("multipart_join:")) {
      const action = data.slice("multipart_join:".length);
      if (action === "open") {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "Abriendo asistente /unir en Disco Ef\xEDmero..."
        }).catch(() => {
        });
        await sendOrEditMultiPartMenuInTelegram(chatId2, messageId);
        return;
      }
      if (action === "clear") {
        const s = pendingMultiPartByChat.get(chatId2);
        if (s) s.parts = [];
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "Lista de partes vaciada"
        }).catch(() => {
        });
        await sendOrEditMultiPartMenuInTelegram(
          chatId2,
          messageId,
          void 0,
          `\u{1F9F9} <b>Lista de partes vaciada.</b>`
        );
        return;
      }
      if (action === "cancel") {
        pendingMultiPartByChat.delete(chatId2);
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "Modo /unir cerrado"
        }).catch(() => {
        });
        await sendOrEditQueueManagerInTelegram(
          chatId2,
          messageId,
          void 0,
          `\u2139\uFE0F <b>Modo /unir desactivado.</b>`
        );
        return;
      }
      if (action === "confirm") {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "Iniciando descarga y uni\xF3n en Disco Ef\xEDmero..."
        }).catch(() => {
        });
        await executeMultiPartJoinAndCreateJobInTelegram(chatId2, messageId);
        return;
      }
    }
    if (data.startsWith("cancel_job:")) {
      const targetJobId = data.slice("cancel_job:".length);
      const targetJob = transferJobs.find((j) => j.id === targetJobId);
      if (targetJob && !isMasterAdminChat(chatId2) && targetJob.telegramChatId !== chatId2) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u26D4 No puedes cancelar la subida de otro usuario.",
          show_alert: true
        }).catch(() => {
        });
        return;
      }
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "\u{1F6D1} Cancelando subida..."
      }).catch(() => {
      });
      await cancelTransferJob(targetJobId, chatId2, messageId);
      return;
    }
    if (data === "unpin_serie") {
      const prev = pinnedBatchSerieByChat.get(chatId2);
      pinnedBatchSerieByChat.delete(chatId2);
      savePinnedSeriesToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "\u{1F513} Modo Serie Fija desactivado"
      }).catch(() => {
      });
      await sendOrEditQueueManagerInTelegram(
        chatId2,
        messageId,
        void 0,
        `\u{1F513} <b>Modo Serie Fija desactivado${prev ? ` (${escapeHtml(prev.serieName)})` : ""}.</b>
<i>Los pr\xF3ximos videos volver\xE1n a mostrarte el men\xFA normal de selecci\xF3n.</i>`
      );
      return;
    }
    if (data.startsWith("pin_serie:")) {
      const parts = data.split(":");
      const pelserId = Number(parts[1] || 0);
      const seasonNum = String(parts[2] || "1");
      const seasonId = Number(parts[3] || 0);
      const isMaster = isMasterAdminChat(chatId2);
      const ctx = getEffectivePictaContext(chatId2);
      const serieRec = findUserChannelSerie(pelserId, chatId2);
      const serieName = String(serieRec?.nombre || `Serie #${pelserId}`);
      const defaultCoverUrl = serieRec?.coverUrl || (isMaster && (pelserId === 4054 || /mentalista/i.test(serieName)) ? "https://www.picta.cu/imagen/poster_L6utIgf.jpeg" : void 0);
      pinnedBatchSerieByChat.set(chatId2, {
        pelserId,
        serieName,
        seasonNum,
        ...seasonId > 0 ? { seasonId } : {},
        ...defaultCoverUrl ? { coverUrl: defaultCoverUrl } : {},
        ...serieRec?.customCoverFileId ? { customCoverFileId: serieRec.customCoverFileId } : {},
        pinnedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      savePinnedSeriesToDisk();
      if (!defaultCoverUrl && pelserId > 0 && ctx.isLinked) {
        void (async () => {
          try {
            const token = await ctx.accessTokenPromise;
            const sRes = await fetchPictaWithRetry(`https://api.picta.cu/v1/serie/${pelserId}/`, {
              headers: {
                Authorization: `Bearer ${token}`,
                Origin: "https://admin.picta.cu",
                Referer: "https://admin.picta.cu/"
              }
            });
            if (sRes.ok) {
              const sObj = await sRes.json();
              const fetchedCover = String(sObj?.url_imagen || sObj?.imagen_secundaria || "").trim();
              if (fetchedCover) {
                upsertChannelSerieRecord(pelserId, serieName, void 0, {
                  coverUrl: fetchedCover,
                  canalId: Number(ctx.channelId || 0)
                });
                const curPin = pinnedBatchSerieByChat.get(chatId2);
                if (curPin && curPin.pelserId === pelserId) {
                  curPin.coverUrl = fetchedCover;
                  savePinnedSeriesToDisk();
                }
              }
            }
          } catch {
          }
        })();
      }
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `\u{1F4CC} Serie fijada: ${serieName} (T${seasonNum})`
      }).catch(() => {
      });
      await sendOrEditMyChannelSeriesMenu(
        chatId2,
        messageId,
        void 0,
        `\u{1F4CC} <b>\xA1MODO SERIE FIJA ACTIVADO PARA "${escapeHtml(serieName.toUpperCase())}" (TEMPORADA ${escapeHtml(seasonNum)})!</b>
<blockquote>\u26A1 <b>\xBFC\xF3mo funciona ahora?</b>
\u2022 Reenv\xEDa al bot todos los cap\xEDtulos seguidos que quieras (2, 5, 10 cap\xEDtulos...).
\u2022 El bot <b>NO te har\xE1 preguntas</b>: extraer\xE1 el n\xFAmero y t\xEDtulo de cada cap\xEDtulo, reutilizar\xE1 la <b>portada oficial de la serie</b> (o env\xEDa una foto ahora al chat si prefieres fijar otra portada personalizada) y los subir\xE1 <b>uno detr\xE1s de otro en cola autom\xE1tica</b>.</blockquote>`
      );
      return;
    }
    if (data.startsWith("pin_serie_and_start:")) {
      const parts = data.split(":");
      const pelserId = Number(parts[1] || 0);
      const seasonNum = String(parts[2] || "1");
      const seasonId = Number(parts[3] || 0);
      const jobId = parts.slice(4).join(":");
      const isMaster = isMasterAdminChat(chatId2);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMaster && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      const ctx = getEffectivePictaContext(chatId2);
      const serieRec = findUserChannelSerie(pelserId, chatId2);
      const serieName = String(
        serieRec?.nombre || job.modelMetadata?.serie || `Serie #${pelserId}`
      );
      const serieInfo = extractSeriesInfoFromText(job.fileName, job.caption);
      const epNum = String(job.modelMetadata?.numero || serieInfo.numero || "1");
      const epSub = String(
        job.modelMetadata?.episodeSubtitle || serieInfo.episodeSubtitle || ""
      ).trim();
      const defaultCoverUrl = serieRec?.coverUrl || (isMaster && (pelserId === 4054 || /mentalista/i.test(serieName)) ? "https://www.picta.cu/imagen/poster_L6utIgf.jpeg" : void 0);
      pinnedBatchSerieByChat.set(chatId2, {
        pelserId,
        serieName,
        seasonNum,
        ...seasonId > 0 ? { seasonId } : {},
        ...defaultCoverUrl ? { coverUrl: defaultCoverUrl } : {},
        ...serieRec?.customCoverFileId ? { customCoverFileId: serieRec.customCoverFileId } : {},
        pinnedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      savePinnedSeriesToDisk();
      job.tipologiaId = 5;
      job.category = "Serie";
      job.titleMode = "manual";
      job.modelMetadata = {
        ...job.modelMetadata || {},
        serie: serieName,
        ...pelserId > 0 ? { serie_pelser_id: String(pelserId) } : {},
        temporada: seasonNum,
        ...seasonId > 0 ? { temporada_id: String(seasonId) } : {},
        numero: epNum,
        ...epSub ? { episodeSubtitle: epSub } : {}
      };
      job.title = formatSerieEpisodeTitle(serieName, seasonNum, epNum, epSub);
      const targetChanLabel = job.targetChannelName || ctx.channelName || "tu canal";
      job.synopsis = sanitizePublicPictaText(
        `Cap\xEDtulo ${epNum} de la Temporada ${seasonNum} de la serie ${cleanSerieDisplayName(serieName)}${epSub ? ` titulado "${epSub}"` : ""}, disponible en el canal ${targetChanLabel}.`
      );
      saveJobsToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `\u{1F4CC} Modo Serie Fija activado para ${cleanSerieDisplayName(serieName)} (T${seasonNum})`
      }).catch(() => {
      });
      await finalizeGuidedStepsAndStart(job, chatId2, messageId);
      return;
    }
    if (data.startsWith("my_series:")) {
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Sincronizando series y cap\xEDtulos del canal..."
      }).catch(() => {
      });
      await sendOrEditMyChannelSeriesMenu(chatId2, messageId);
      return;
    }
    if (data.startsWith("serie_manage:")) {
      const parts = data.split(":");
      const pelserId = Number(parts[1] || 0);
      const page = Number(parts[2] || 0);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Cargando cap\xEDtulos de la serie..."
      }).catch(() => {
      });
      await sendOrEditSerieDetailInTelegram(chatId2, messageId, pelserId, page);
      return;
    }
    if (data === "standalone_serie_new") {
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      const ctx = getEffectivePictaContext(chatId2);
      if (!ctx.isLinked || !ctx.channelId) {
        await sendOrEditMyChannelSeriesMenu(chatId2, messageId);
        return;
      }
      pendingStandaloneSerieByChat.set(chatId2, {
        mode: "new_serie_name",
        messageId
      });
      const text2 = `\u2795 <b>CREAR NUEVA SERIE EN ${escapeHtml(ctx.channelName.toUpperCase())} (#${escapeHtml(ctx.channelId)})</b>
<blockquote>El bot registrar\xE1 la Serie y su Temporada 1 directamente por API en tu canal (#${escapeHtml(ctx.channelId)}) sin pasar por la web de Picta.</blockquote>
\u270D\uFE0F <b>Escribe ahora en el chat el nombre de la nueva Serie:</b>`;
      const kb = [[{ text: "\u2B05\uFE0F Cancelar", callback_data: "my_series:0" }]];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, text2, kb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, text2, void 0, kb);
      }
      return;
    }
    if (data.startsWith("standalone_season_create:")) {
      const parts = data.split(":");
      const pelserId = Number(parts[1] || 0);
      const seasonNum = Number(parts[2] || 1);
      const ctx = getEffectivePictaContext(chatId2);
      if (!ctx.isLinked || !ctx.channelId) {
        await sendOrEditMyChannelSeriesMenu(chatId2, messageId);
        return;
      }
      const serieRec = findUserChannelSerie(pelserId, chatId2);
      const serieName = serieRec?.nombre || `Serie #${pelserId}`;
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `Creando Temporada ${seasonNum} en Picta...`
      }).catch(() => {
      });
      try {
        const token = await ctx.accessTokenPromise;
        const coverBuf = Buffer.from(FALLBACK_JPEG_BASE64, "base64");
        const newTempId = await ensureSerieAndTemporadaId(
          token,
          serieName,
          seasonNum,
          { serie_pelser_id: String(pelserId) },
          coverBuf,
          ctx.channelId,
          ctx.channelName,
          isMasterAdminChat(chatId2)
        );
        await sendOrEditMyChannelSeriesMenu(
          chatId2,
          messageId,
          void 0,
          `\u2705 <b>\xA1Temporada ${seasonNum} creada exitosamente en "${escapeHtml(serieName)}" (ID: <code>${newTempId}</code>)!</b>`
        );
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : String(err);
        await sendOrEditMyChannelSeriesMenu(
          chatId2,
          messageId,
          void 0,
          `\u26A0\uFE0F <b>Error al crear Temporada ${seasonNum}:</b> <code>${escapeHtml(msg2.slice(0, 120))}</code>`
        );
      }
      return;
    }
    if (data.startsWith("back_cats:")) {
      const jobId = data.slice("back_cats:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      job.stage = "awaiting_category";
      saveJobsToDisk();
      const chInfo = resolveJobTargetChannelInfo(job);
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      await editTelegramStatusMessage(
        chatId2,
        messageId,
        `${hudHeader("SELECCIONA CATEGOR\xCDA EN PICTA")}
` + hudBox([
          `\u{1F4C4} <b>Archivo:</b> <code>${escapeHtml(job.fileName)}</code>`,
          `\u{1F4E6} <b>Tama\xF1o:</b> ${formatBytes(job.expectedBytes)}`,
          `\u{1F4FA} <b>Canal:</b> ${escapeHtml(chInfo.channelName)}${chInfo.channelId ? ` \xB7 <code>#${escapeHtml(chInfo.channelId)}</code>` : ""}`
        ]) + `
\u{1F447} <b>Elige la categor\xEDa para continuar:</b>`,
        buildCategorySelectionKeyboard(job.id),
        true
      );
      return;
    }
    if (data.startsWith("step_back:")) {
      const parts = data.split(":");
      const targetStep = Number(parts[1]);
      const jobId = parts.slice(2).join(":");
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      if (targetStep === 1) {
        await promptStep1Title(job, chatId2, messageId);
      } else if (targetStep === 2) {
        await promptStep2Synopsis(job, chatId2, messageId);
      } else if (targetStep === 3) {
        await promptStep3Cover(job, chatId2, messageId);
      }
      return;
    }
    if (data.startsWith("retry:")) {
      const jobId = data.slice("retry:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) {
        job.statusMessageId = messageId;
      }
      const chInfo = resolveJobTargetChannelInfo(job);
      const wasEncoderFailure = Boolean(
        job.encoderRetryActive || job.encoderRetryLastError && isPictaEncoderOrTransientServerError(job.encoderRetryLastError, job.pictaResponseCode)
      );
      if (wasEncoderFailure) {
        job.encoderManualRetryTriggered = true;
      }
      job.encoderRetryNextAt = 0;
      job.stage = job.minioKey ? "creating_picta_publication" : "generating_auto_title";
      job.errorDetails = void 0;
      job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      currentActivity = `Reintentando publicaci\xF3n en Picta para "${job.title}" (${job.category || "Audiovisual"})...`;
      saveJobsToDisk();
      await Promise.all([
        callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "Reintentando publicaci\xF3n en Picta..."
        }).catch(() => {
        }),
        editTelegramStatusMessage(
          chatId2,
          messageId,
          `\u{1F504} <b>Reintentando publicaci\xF3n en ${escapeHtml(chInfo.channelName)}${chInfo.channelId ? ` (#${escapeHtml(chInfo.channelId)})` : ""}...</b>
<blockquote>\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}
\u{1F4C2} <b>Categor\xEDa:</b> ${escapeHtml(job.category || "Audiovisual")}
\u{1F511} <b>Manifiesto S3:</b> <code>${job.minioKey || "Por verificar"}</code></blockquote>
\u23F3 <i>${job.minioKey ? "Video ya verificado en S3 MinIO. Enviando ficha t\xE9cnica a Picta..." : "Iniciando transferencia..."}</i>`
        )
      ]);
      await triggerCloudRunKeepAliveTransfer(job.id, job.title, messageId);
      return;
    }
    if (data.startsWith("encoder_auto_queue:")) {
      const jobId = data.slice("encoder_auto_queue:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) {
        job.statusMessageId = messageId;
      }
      if (!job.minioKey) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "Reanudando subida normal..."
        }).catch(() => {
        });
        await triggerCloudRunKeepAliveTransfer(job.id, job.title, messageId);
        return;
      }
      const decision = computeNextEncoderRetryState(job.encoderRetryCount || 0, Date.now());
      job.stage = "queued";
      job.encoderRetryActive = true;
      job.encoderRetryCount = decision.nextAttemptCount;
      job.encoderRetryNextAt = decision.nextRetryAtMs;
      job.encoderManualRetryTriggered = false;
      job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      if (!uploadQueue.includes(job.id)) {
        uploadQueue.push(job.id);
      }
      saveJobsToDisk();
      startCloudRunCpuKeepAlive();
      await Promise.all([
        callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: `\u23F1\uFE0F Auto-reintento activado (cada ${decision.waitMinutes} min)`
        }).catch(() => {
        }),
        editTelegramStatusMessage(
          chatId2,
          messageId,
          `\u23F1\uFE0F <b>AUTO-REINTENTO ACTIVADO \xB7 ESPERANDO CODIFICADOR DE PICTA</b>
<blockquote>\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}
\u{1F4C2} <b>Categor\xEDa:</b> ${escapeHtml(job.category || "Audiovisual")}
\u{1F511} <b>Manifiesto S3 Listo:</b> <code>${escapeHtml(job.minioKey)}</code> (100% seguro, 0 MB a re-subir)
\u23F3 <b>Pr\xF3ximo intento autom\xE1tico:</b> en ${decision.waitMinutes} min (Intento ${decision.nextAttemptCount}/${MAX_ENCODER_AUTO_RETRIES})</blockquote>
<i>Tus dem\xE1s subidas contin\xFAan con normalidad. Te avisar\xE9 apenas Picta vuelva a aceptar publicaciones.</i>`,
          [
            [{ text: "\u{1F504} Reintentar Ahora Mismo", callback_data: `retry:${job.id}` }],
            [{ text: "\u{1F6D1} Detener Auto-Reintento", callback_data: `encoder_stop_retry:${job.id}` }]
          ],
          true
        )
      ]);
      return;
    }
    if (data.startsWith("encoder_stop_retry:")) {
      const jobId = data.slice("encoder_stop_retry:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      removeJobFromUploadQueue(job.id);
      job.stage = "failed";
      job.encoderRetryActive = false;
      job.encoderRetryNextAt = void 0;
      job.encoderManualRetryTriggered = false;
      job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      saveJobsToDisk();
      await Promise.all([
        callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u23F8\uFE0F Auto-reintento detenido."
        }).catch(() => {
        }),
        editTelegramStatusMessage(
          chatId2,
          messageId,
          `\u23F8\uFE0F <b>AUTO-REINTENTO DETENIDO</b>
<blockquote>\u{1F3AC} <b>T\xEDtulo:</b> ${escapeHtml(job.title)}
\u{1F511} <b>Manifiesto S3:</b> <code>${escapeHtml(job.minioKey || "Pendiente")}</code> (100% seguro)</blockquote>
<i>Puedes reintentar manualmente cuando quieras sin volver a subir el video.</i>`,
          [
            [{ text: "\u{1F504} Reintentar Publicaci\xF3n Ahora", callback_data: `retry:${job.id}` }],
            [{ text: "\u23F1\uFE0F Reactivar Auto-Reintento (cada 2 min)", callback_data: `encoder_auto_queue:${job.id}` }]
          ],
          true
        )
      ]);
      return;
    }
    if (data.startsWith("retry_manual:")) {
      const jobId = data.slice("retry_manual:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) {
        job.statusMessageId = messageId;
      }
      job.preferredUploadAccountKey = void 0;
      job.preferredUploadAccountLabel = void 0;
      saveJobsToDisk();
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      if (job.tipologiaId === 5) {
        await promptSeriesSelectionForJob(job, chatId2, messageId);
      } else {
        await promptStep1Title(job, chatId2, messageId);
      }
      return;
    }
    if (data.startsWith("cat:")) {
      const parts = data.split(":");
      const catId = Number(parts[1]);
      const jobId = parts.slice(2).join(":");
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) {
        job.statusMessageId = messageId;
      }
      const tipologia = PICTA_TIPOLOGIAS.find((t) => t.id === catId) || {
        id: catId,
        nombre: "Audiovisual",
        modelo: "categoria",
        icon: "\u{1F4F9}"
      };
      job.tipologiaId = tipologia.id;
      job.category = tipologia.nombre;
      job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      saveJobsToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `Categor\xEDa: ${tipologia.nombre}`
      }).catch(() => {
      });
      if (tipologia.id === 5) {
        await promptSeriesSelectionForJob(job, chatId2, messageId);
      } else {
        await promptStep1Title(job, chatId2, messageId);
      }
      return;
    }
    if (data.startsWith("serie_pick:")) {
      const parts = data.split(":");
      const pelserId = Number(parts[1] || 0);
      const jobId = parts.slice(2).join(":");
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      const serieRec = findUserChannelSerie(pelserId, chatId2);
      const serieName = String(serieRec?.nombre || job.modelMetadata?.serie || `Serie #${pelserId}`);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `Serie elegida: ${serieName}`
      }).catch(() => {
      });
      await promptSeasonSelectionForJob(job, chatId2, messageId, pelserId, serieName);
      return;
    }
    if (data.startsWith("serie_create_auto:")) {
      const jobId = data.slice("serie_create_auto:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      const ctx = getEffectivePictaContext(chatId2);
      const chTag = ctx.channelId ? `${ctx.channelName} (#${ctx.channelId})` : ctx.channelName;
      const serieInfo = extractSeriesInfoFromText(job.fileName, job.caption);
      const serieName = String(
        job.modelMetadata?.serie || (!serieInfo.missingSerieName ? serieInfo.serieName : "") || cleanGeneralVideoTitle(job.fileName)
      );
      const seasonNum = Number(job.modelMetadata?.temporada || serieInfo.temporada || 1) || 1;
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `Creando serie "${serieName}" en tu canal...`
      }).catch(() => {
      });
      await editTelegramStatusMessage(
        chatId2,
        messageId,
        `\u23F3 <b>Creando serie "${escapeHtml(serieName)}" y Temporada ${seasonNum} en ${escapeHtml(chTag)}...</b>`
      );
      try {
        const created = await createSerieInPictaChannelDirect(
          chatId2,
          serieName,
          seasonNum,
          job.customCoverFileId || job.thumbnailFileId
        );
        job.modelMetadata = {
          ...job.modelMetadata || {},
          serie: created.serieName,
          serie_pelser_id: String(created.pelserId),
          temporada: String(created.seasonNum),
          temporada_id: String(created.tempId)
        };
        saveJobsToDisk();
        await promptSeasonSelectionForJob(
          job,
          chatId2,
          messageId,
          created.pelserId,
          created.serieName,
          `\u2705 <b>\xA1Serie "${escapeHtml(created.serieName)}" y Temporada ${created.seasonNum} creadas en ${escapeHtml(chTag)}!</b>`
        );
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : String(err);
        await promptSeasonSelectionForJob(
          job,
          chatId2,
          messageId,
          0,
          serieName,
          `\u26A0\uFE0F <b>Aviso al pre-crear serie (se crear\xE1 al publicar):</b> <code>${escapeHtml(msg2.slice(0, 100))}</code>`
        );
      }
      return;
    }
    if (data.startsWith("serie_create_new:")) {
      const jobId = data.slice("serie_create_new:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      const ctx = getEffectivePictaContext(chatId2);
      const chTag = ctx.channelId ? `${ctx.channelName} (#${ctx.channelId})` : ctx.channelName;
      job.stage = "awaiting_new_series_name";
      job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      pendingManualTitleByChat.set(chatId2, job.id);
      saveJobsToDisk();
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      const text2 = `\u2795 <b>CREAR NUEVA SERIE EN TU CANAL (${escapeHtml(chTag)})</b>
<blockquote>\u{1F4C4} <b>Archivo:</b> <code>${escapeHtml(job.fileName)}</code>
\u{1F4C1} <b>Temporada detectada:</b> ${escapeHtml(String(job.modelMetadata?.temporada || "1"))} \xB7 <b>Cap\xEDtulo:</b> ${escapeHtml(String(job.modelMetadata?.numero || "1"))}</blockquote>
\u270D\uFE0F <b>Escribe ahora en el chat el nombre de la nueva Serie</b> y el bot la crear\xE1 autom\xE1ticamente en ${escapeHtml(chTag)}:`;
      const kb = [[{ text: "\u2B05\uFE0F Volver a mis Series", callback_data: `cat:5:${job.id}` }]];
      await editTelegramStatusMessage(chatId2, messageId, text2, kb, true);
      return;
    }
    if (data.startsWith("serie_season_pick:")) {
      const parts = data.split(":");
      const seasonNum = String(parts[1] || "1");
      const seasonId = Number(parts[2] || 0);
      const jobId = parts.slice(3).join(":");
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      const meta = job.modelMetadata || {};
      const epNum = String(meta.numero || "1");
      const serieName = String(meta.serie || "Serie");
      const epSub = String(meta.episodeSubtitle || "").trim();
      job.modelMetadata = {
        ...meta,
        temporada: seasonNum,
        ...seasonId > 0 ? { temporada_id: String(seasonId) } : {}
      };
      job.title = formatSerieEpisodeTitle(serieName, seasonNum, epNum, epSub);
      saveJobsToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `Temporada ${seasonNum} seleccionada`
      }).catch(() => {
      });
      await promptStep1Title(job, chatId2, messageId);
      return;
    }
    if (data.startsWith("serie_season_create:")) {
      const parts = data.split(":");
      const pelserId = Number(parts[1] || 0);
      const seasonNum = Number(parts[2] || 1);
      const jobId = parts.slice(3).join(":");
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      const serieName = String(job.modelMetadata?.serie || `Serie #${pelserId}`);
      const epSub = String(job.modelMetadata?.episodeSubtitle || "").trim();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `Creando Temporada ${seasonNum} en Picta...`
      }).catch(() => {
      });
      try {
        const created = await createSerieInPictaChannelDirect(
          chatId2,
          serieName,
          seasonNum,
          job.customCoverFileId || job.thumbnailFileId
        );
        const inheritedStyle = resolveSeriesStyleForChannel(chatId2, created.pelserId, created.serieName);
        job.modelMetadata = {
          ...job.modelMetadata || {},
          serie: created.serieName,
          serie_pelser_id: String(created.pelserId),
          temporada: String(seasonNum),
          temporada_id: String(created.tempId)
        };
        const epNumStr = String(job.modelMetadata.numero || "1");
        job.title = inheritedStyle ? formatEpisodeWithSeriesStyle(inheritedStyle, {
          serieName: created.serieName,
          temporada: String(seasonNum),
          numero: epNumStr,
          episodeSubtitle: epSub
        }) : formatSerieEpisodeTitle(
          created.serieName,
          String(seasonNum),
          epNumStr,
          epSub
        );
        saveJobsToDisk();
      } catch {
        job.modelMetadata = {
          ...job.modelMetadata || {},
          temporada: String(seasonNum)
        };
        saveJobsToDisk();
      }
      await promptStep1Title(job, chatId2, messageId);
      return;
    }
    if (data.startsWith("serie_confirm_tc:")) {
      const parts = data.split(":");
      const tempNum = String(parts[1] || "1");
      const epNum = String(parts[2] || "1");
      const jobId = parts.slice(3).join(":");
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      const serieName = String(job.modelMetadata?.serie || "Serie");
      const pelserId = Number(job.modelMetadata?.serie_pelser_id || 0);
      const epSub = String(job.modelMetadata?.episodeSubtitle || "").trim();
      const inheritedStyle = resolveSeriesStyleForChannel(chatId2, pelserId, serieName);
      job.modelMetadata = {
        ...job.modelMetadata || {},
        temporada: tempNum,
        numero: epNum
      };
      job.title = inheritedStyle ? formatEpisodeWithSeriesStyle(inheritedStyle, {
        serieName,
        temporada: tempNum,
        numero: epNum,
        episodeSubtitle: epSub
      }) : formatSerieEpisodeTitle(serieName, tempNum, epNum, epSub);
      saveJobsToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `T${tempNum}:E${epNum.padStart(2, "0")} confirmado`
      }).catch(() => {
      });
      await promptStep1Title(job, chatId2, messageId);
      return;
    }
    if (data.startsWith("step1_opt:")) {
      const parts = data.split(":");
      const optIdx = Number(parts[1] || 0);
      const jobId = parts.slice(2).join(":");
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      const meta = job.modelMetadata || {};
      const serieName = String(meta.serie || "Serie");
      const pelserId = Number(meta.serie_pelser_id || 0);
      const inheritedStyle = resolveSeriesStyleForChannel(chatId2, pelserId, serieName);
      const opts = buildSerieTitleOptions({
        serieName,
        temporada: String(meta.temporada || "1"),
        numero: String(meta.numero || "1"),
        episodeSubtitle: String(meta.episodeSubtitle || ""),
        rawCaption: job.caption,
        inheritedStyle
      });
      const chosen = opts[optIdx] || opts[0];
      if (chosen) {
        job.title = chosen.title;
      }
      job.titleMode = "manual";
      if (isStaleOrGenericSerieSynopsis(job.synopsis, job.caption, String(meta.numero || "1"))) {
        const chName = job.targetChannelName || getEffectivePictaContext(chatId2).channelName || "Mi Canal";
        const cleanSName = cleanSerieDisplayName(String(meta.serie || "")) || String(meta.serie || "la serie");
        const epSub = String(meta.episodeSubtitle || "").trim();
        job.synopsis = `Cap\xEDtulo ${String(meta.numero || "1")} de la Temporada ${String(meta.temporada || "1")} de la serie ${cleanSName}${epSub ? ` titulado "${epSub}"` : ""}, disponible en el canal ${chName}.`;
      }
      saveJobsToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `T\xEDtulo elegido: ${(chosen?.title || job.title).slice(0, 40)}`
      }).catch(() => {
      });
      await proceedFromStep1ToStep2WithDuplicateCheck(job, chatId2, messageId);
      return;
    }
    if (data.startsWith("imdb_pick:")) {
      const parts = data.split(":");
      const pickIdx = Number(parts[1] || 0);
      const jobId = parts.slice(2).join(":");
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      const pending = pendingOnlineCandidatesByJob.get(job.id);
      const chosenCand = pending?.candidates?.[pickIdx];
      pendingOnlineCandidatesByJob.delete(job.id);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: chosenCand ? `\u2705 Elegido: ${chosenCand.title.slice(0, 34)}` : "Cargando ficha seleccionada..."
      }).catch(() => {
      });
      let preResolved = null;
      if (chosenCand) {
        preResolved = await fetchOnlineMediaDetailsByCandidate(
          chosenCand,
          pending?.seasonNum || 0,
          pending?.epNum || 0
        ).catch(() => null);
        if (job.tipologiaId === 5 && chosenCand.title && isGenericOrInvalidSerieName(String(job.modelMetadata?.serie || ""))) {
          job.modelMetadata = {
            ...job.modelMetadata || {},
            serie: chosenCand.title
          };
        }
      }
      try {
        await applyEnrichmentToWizardJob(job, chatId2, {
          forceTitleUpdate: pending?.nextStep === 2,
          forceSynopsisUpdate: true,
          preResolvedOnlineInfo: preResolved
        });
      } catch {
      }
      if (pending?.nextStep === 3) {
        await promptStep3Cover(job, chatId2, messageId);
      } else {
        await proceedFromStep1ToStep2WithDuplicateCheck(job, chatId2, messageId);
      }
      return;
    }
    if (data.startsWith("imdb_retype:")) {
      const jobId = data.slice("imdb_retype:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      pendingOnlineCandidatesByJob.delete(job.id);
      job.modelMetadata = { ...job.modelMetadata || {}, needsManualTitle: "true" };
      job.title = "";
      saveJobsToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Escribe el t\xEDtulo exacto en el chat"
      }).catch(() => {
      });
      await promptStep1Title(job, chatId2, messageId);
      return;
    }
    if (data.startsWith("imdb_skip:")) {
      const parts = data.split(":");
      const nextStep = Number(parts[1] || 2);
      const jobId = parts.slice(2).join(":");
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      pendingOnlineCandidatesByJob.delete(job.id);
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      if (nextStep === 3) {
        await promptStep3Cover(job, chatId2, messageId);
      } else {
        await proceedFromStep1ToStep2WithDuplicateCheck(job, chatId2, messageId);
      }
      return;
    }
    if (data.startsWith("step1_ai:") || data.startsWith("step1_imdb:")) {
      const isMovieImdbSearch = data.startsWith("step1_imdb:");
      const jobId = data.slice(isMovieImdbSearch ? "step1_imdb:".length : "step1_ai:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      const meta = job.modelMetadata || {};
      const queryBase = job.tipologiaId === 5 && meta.serie && !isGenericOrInvalidSerieName(String(meta.serie)) ? String(meta.serie) : String(job.title || "").trim();
      if (!queryBase || isRandomOrCrypticFilename(queryBase) || meta.needsManualTitle === "true") {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u26A0\uFE0F Escribe primero el t\xEDtulo real en el chat",
          show_alert: true
        }).catch(() => {
        });
        await promptStep1Title(job, chatId2, messageId);
        return;
      }
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "\u{1F50D} Buscando en IMDb + TMDB..."
      }).catch(() => {
      });
      try {
        const discovery = await searchMediaCandidatesOnline(
          queryBase,
          Number(job.tipologiaId || 8),
          meta.temporada ? Number(meta.temporada) : void 0,
          meta.numero ? Number(meta.numero) : void 0
        );
        if (discovery.disambiguation.needsDisambiguation && discovery.disambiguation.topCandidates.length > 1) {
          await promptImdbDisambiguationTop3(
            job,
            chatId2,
            messageId,
            discovery.disambiguation.topCandidates,
            2,
            discovery.cleanQuery || queryBase,
            discovery.effectiveSeason,
            discovery.effectiveEp
          );
          return;
        }
        const winner = discovery.disambiguation.confidentWinner || discovery.disambiguation.topCandidates[0] || null;
        const preResolved = winner ? await fetchOnlineMediaDetailsByCandidate(
          winner,
          discovery.effectiveSeason,
          discovery.effectiveEp
        ).catch(() => null) : null;
        await applyEnrichmentToWizardJob(job, chatId2, {
          forceTitleUpdate: true,
          forceSynopsisUpdate: true,
          preResolvedOnlineInfo: preResolved
        });
      } catch {
      }
      await proceedFromStep1ToStep2WithDuplicateCheck(job, chatId2, messageId);
      return;
    }
    if (data.startsWith("step1_keep:")) {
      const jobId = data.slice("step1_keep:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      if (job.modelMetadata?.needsManualTitle === "true" || !job.title || isRandomOrCrypticFilename(job.title)) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u26A0\uFE0F Escribe primero el t\xEDtulo real en el chat",
          show_alert: true
        }).catch(() => {
        });
        await promptStep1Title(job, chatId2, messageId);
        return;
      }
      job.titleMode = "manual";
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "T\xEDtulo confirmado"
      }).catch(() => {
      });
      await proceedFromStep1ToStep2WithDuplicateCheck(job, chatId2, messageId);
      return;
    }
    if (data.startsWith("step2_auto:") || data.startsWith("step2_ai:") || data.startsWith("step2_keep:")) {
      const isForceAi = data.startsWith("step2_ai:");
      const isKeepDetected = data.startsWith("step2_keep:");
      const prefix = isForceAi ? "step2_ai:" : isKeepDetected ? "step2_keep:" : "step2_auto:";
      const jobId = data.slice(prefix.length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: isKeepDetected ? "\u2705 Sinopsis conservada \xB7 Buscando ficha t\xE9cnica y car\xE1tula..." : "\u{1F50D} Buscando en IMDb + TMDB sinopsis y car\xE1tula HD..."
      }).catch(() => {
      });
      try {
        const meta = job.modelMetadata || {};
        const queryBase = job.tipologiaId === 5 && meta.serie && !isGenericOrInvalidSerieName(String(meta.serie)) ? String(meta.serie) : String(job.title || "").trim();
        let preResolved = null;
        if (!isKeepDetected && queryBase && !isRandomOrCrypticFilename(queryBase) && !meta.onlineCoverUrl) {
          const discovery = await searchMediaCandidatesOnline(
            queryBase,
            Number(job.tipologiaId || 8),
            meta.temporada ? Number(meta.temporada) : void 0,
            meta.numero ? Number(meta.numero) : void 0
          ).catch(() => null);
          if (discovery && discovery.disambiguation.needsDisambiguation && discovery.disambiguation.topCandidates.length > 1) {
            await promptImdbDisambiguationTop3(
              job,
              chatId2,
              messageId,
              discovery.disambiguation.topCandidates,
              3,
              discovery.cleanQuery || queryBase,
              discovery.effectiveSeason,
              discovery.effectiveEp
            );
            return;
          }
          const winner = discovery?.disambiguation.confidentWinner || discovery?.disambiguation.topCandidates[0] || null;
          if (winner) {
            preResolved = await fetchOnlineMediaDetailsByCandidate(
              winner,
              discovery?.effectiveSeason || 0,
              discovery?.effectiveEp || 0
            ).catch(() => null);
          }
        }
        await applyEnrichmentToWizardJob(job, chatId2, {
          forceTitleUpdate: false,
          forceSynopsisUpdate: isForceAi,
          preResolvedOnlineInfo: preResolved
        });
      } catch {
      }
      await promptStep3Cover(job, chatId2, messageId);
      return;
    }
    if (data.startsWith("step3_set_poster:")) {
      const jobId = data.slice("step3_set_poster:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      job.modelMetadata = {
        ...job.modelMetadata || {},
        awaitingCustomPoster: "true"
      };
      saveJobsToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Env\xEDa ahora la imagen vertical para el p\xF3ster"
      }).catch(() => {
      });
      const posterPrompt = `\u{1F39E}\uFE0F <b>${renderWizardStepBar(3)} \xB7 P\xD3STER VERTICAL OPCIONAL</b>
<blockquote>\u{1F3AC} <b>Video:</b> ${escapeHtml(job.title)}</blockquote>
\u{1F4F8} <b>Env\xEDa ahora al chat una foto o imagen vertical (2:3)</b> para usarla como P\xF3ster independiente en Picta:`;
      const posterKb = [
        [{ text: "\u2B05\uFE0F Volver a Opciones de Portada", callback_data: `step3_cancel_poster:${job.id}` }]
      ];
      if (messageId) {
        await editTelegramStatusMessage(chatId2, messageId, posterPrompt, posterKb, true);
      } else {
        await sendTelegramStatusMessage(chatId2, posterPrompt, void 0, posterKb);
      }
      return;
    }
    if (data.startsWith("step3_cancel_poster:")) {
      const jobId = data.slice("step3_cancel_poster:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (job.modelMetadata) {
        delete job.modelMetadata.awaitingCustomPoster;
        saveJobsToDisk();
      }
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      await promptStep3Cover(job, chatId2, messageId);
      return;
    }
    if (data.startsWith("step3_auto:") || data.startsWith("step3_poster:") || data.startsWith("step3_frame:")) {
      const isFrameOnly = data.startsWith("step3_frame:");
      const prefix = data.startsWith("step3_poster:") ? "step3_poster:" : isFrameOnly ? "step3_frame:" : "step3_auto:";
      const jobId = data.slice(prefix.length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      const nextMeta = {
        ...job.modelMetadata || {},
        preferVideoFrameCover: isFrameOnly ? "true" : "false"
      };
      delete nextMeta.awaitingCustomPoster;
      job.modelMetadata = nextMeta;
      saveJobsToDisk();
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: isFrameOnly ? "\u{1F5BC}\uFE0F Miniatura del video seleccionada" : "\u{1F3AC} Car\xE1tula Oficial HD (TMDB/IMDb) seleccionada"
      }).catch(() => {
      });
      await promptStep4Subtitles(job, chatId2, messageId);
      return;
    }
    if (data.startsWith("step4_skip:")) {
      const jobId = data.slice("step4_skip:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Iniciando subida a Picta..."
      }).catch(() => {
      });
      await finalizeGuidedStepsAndStart(job, chatId2, messageId);
      return;
    }
    if (data.startsWith("manual:")) {
      const jobId = data.slice("manual:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) job.statusMessageId = messageId;
      await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      await promptStep1Title(job, chatId2, messageId);
      return;
    }
    if (data.startsWith("auto:")) {
      const jobId = data.slice("auto:".length);
      const job = transferJobs.find((j) => j.id === jobId);
      if (!job || !isMasterAdminChat(chatId2) && job.telegramChatId !== chatId2) return;
      if (messageId) {
        job.statusMessageId = messageId;
      }
      if (job.tipologiaId !== 5 && (job.modelMetadata?.needsManualTitle === "true" || !job.title && isRandomOrCrypticFilename(job.fileName))) {
        await callTelegramBotApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "\u26A0\uFE0F Nombre aleatorio: escribe primero el t\xEDtulo real para buscar en IMDb.",
          show_alert: true
        }).catch(() => {
        });
        await promptStep1Title(job, chatId2, messageId);
        return;
      }
      pendingManualTitleByChat.delete(chatId2);
      await callTelegramBotApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Verificando si existe en Picta..."
      }).catch(() => {
      });
      const pausedForDuplicate = await checkPictaDuplicateAndPromptIfFound(
        job,
        chatId2,
        messageId,
        "auto"
      );
      if (pausedForDuplicate) return;
      await executeAutoUploadAfterDuplicateCheck(job, chatId2, messageId);
      return;
    }
    await callTelegramBotApi("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
    });
    return;
  }
  const msg = update.message || update.edited_message;
  if (!msg) return;
  const chatId = String(msg.chat?.id || "");
  const msgKey = `${chatId}:${msg.message_id}`;
  if (processedMessageKeys.has(msgKey)) {
    return;
  }
  addBoundedSetEntry(processedMessageKeys, msgKey);
  saveProcessedUpdatesToDisk();
  const senderName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || msg.from?.username || `Chat ${chatId}`;
  const photoArray = Array.isArray(msg.photo) && msg.photo.length > 0 ? msg.photo : null;
  const imageDoc = msg.document && String(msg.document.mime_type || "").startsWith("image/") ? msg.document : null;
  const subDoc = msg.document && (/\.(srt|vtt|ass|sub)$/i.test(String(msg.document.file_name || "")) || String(msg.document.mime_type || "").includes("subrip") || String(msg.document.mime_type || "").includes("vtt")) ? msg.document : null;
  const pendingChanEdit = pendingChannelEditByChat.get(chatId);
  if (pendingChanEdit && (photoArray || imageDoc) && (pendingChanEdit.mode === "avatar" || pendingChanEdit.mode === "portada")) {
    const largestPhoto = photoArray ? photoArray[photoArray.length - 1] : imageDoc;
    if (largestPhoto?.file_id) {
      pendingChannelEditByChat.delete(chatId);
      try {
        const imgBuf = await downloadTelegramThumbnailBuffer(String(largestPhoto.file_id));
        if (!imgBuf) throw new Error("No se pudo descargar la imagen desde Telegram.");
        if (pendingChanEdit.mode === "avatar") {
          await patchPictaChannelDetails(chatId, {}, { avatarBuffer: imgBuf });
          await sendOrEditChannelEditorMenu(
            chatId,
            pendingChanEdit.messageId,
            msg.message_id,
            "\u2705 <b>\xA1Avatar (foto de perfil) del canal actualizado exitosamente en Picta!</b>"
          );
        } else {
          await patchPictaChannelDetails(chatId, {}, { coverBuffer: imgBuf });
          await sendOrEditChannelEditorMenu(
            chatId,
            pendingChanEdit.messageId,
            msg.message_id,
            "\u2705 <b>\xA1Portada (banner) del canal actualizada exitosamente en Picta!</b>"
          );
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendOrEditChannelEditorMenu(
          chatId,
          pendingChanEdit.messageId,
          msg.message_id,
          `\u26A0\uFE0F <b>No se pudo actualizar la imagen del canal:</b> <code>${escapeHtml(errMsg.slice(0, 120))}</code>`
        );
      }
      return;
    }
  }
  const pendingSeriePhotoEdit = pendingStandaloneSerieByChat.get(chatId);
  if (pendingSeriePhotoEdit && (pendingSeriePhotoEdit.mode === "edit_serie_cover" || pendingSeriePhotoEdit.mode === "edit_serie_portada" || pendingSeriePhotoEdit.mode === "edit_serie_poster" || pendingSeriePhotoEdit.mode === "edit_serie_both") && pendingSeriePhotoEdit.pelserId && (photoArray || imageDoc)) {
    const largestPhoto = photoArray ? photoArray[photoArray.length - 1] : imageDoc;
    if (largestPhoto?.file_id) {
      pendingStandaloneSerieByChat.delete(chatId);
      const serieSlot = pendingSeriePhotoEdit.mode === "edit_serie_portada" ? "portada" : pendingSeriePhotoEdit.mode === "edit_serie_both" ? "both" : "poster";
      try {
        const photoFileId = String(largestPhoto.file_id);
        const imgBuf = await downloadTelegramThumbnailBuffer(photoFileId);
        if (!imgBuf) throw new Error("No se pudo descargar la imagen desde Telegram.");
        const seriePatch = buildSerieImagePatchFiles({
          slot: serieSlot,
          uploadedBuffer: imgBuf
        });
        await patchSerieInPictaChannel(chatId, pendingSeriePhotoEdit.pelserId, seriePatch);
        const cached = findUserChannelSerie(pendingSeriePhotoEdit.pelserId, chatId);
        if (cached) {
          cached.customCoverFileId = photoFileId;
          saveChannelSeriesToDisk(channelSeriesCache);
        }
        const okMsg = serieSlot === "portada" ? "\u2705 <b>\xA1Portada horizontal (16:9) de la serie actualizada en Picta!</b>" : serieSlot === "both" ? "\u2705 <b>\xA1Portada y P\xF3ster de la serie actualizados en Picta!</b>" : "\u2705 <b>\xA1P\xF3ster vertical (2:3) de la serie actualizado en Picta!</b>";
        await sendOrEditSerieDetailInTelegram(
          chatId,
          pendingSeriePhotoEdit.messageId,
          pendingSeriePhotoEdit.pelserId,
          0,
          okMsg
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendOrEditSerieDetailInTelegram(
          chatId,
          pendingSeriePhotoEdit.messageId,
          pendingSeriePhotoEdit.pelserId,
          0,
          `\u26A0\uFE0F <b>No se pudo cambiar la imagen de la serie:</b> <code>${escapeHtml(errMsg.slice(0, 120))}</code>`
        );
      }
      return;
    }
  }
  const pendingPubEdit = pendingPubEditByChat.get(chatId);
  if (pendingPubEdit && (photoArray || imageDoc) && (pendingPubEdit.mode === "cover" || pendingPubEdit.mode === "poster" || pendingPubEdit.mode === "both")) {
    const largestPhoto = photoArray ? photoArray[photoArray.length - 1] : imageDoc;
    if (largestPhoto?.file_id) {
      const pubSlot = pendingPubEdit.mode === "poster" ? "poster" : pendingPubEdit.mode === "both" ? "both" : "portada";
      try {
        const imgBuf = await downloadTelegramThumbnailBuffer(String(largestPhoto.file_id));
        if (!imgBuf) throw new Error("No se pudo descargar la imagen desde Telegram.");
        const patchFiles = buildPublicationImagePatchFiles({
          slot: pubSlot,
          uploadedBuffer: imgBuf
        });
        await patchPictaPublicationInChannel(
          pendingPubEdit.pubId,
          {},
          patchFiles,
          chatId
        );
        const okMsg = pubSlot === "poster" ? "\u2705 <b>\xA1P\xF3ster vertical actualizado exitosamente en Picta!</b>" : pubSlot === "both" ? "\u2705 <b>\xA1Portada y P\xF3ster actualizados exitosamente en Picta!</b>" : "\u2705 <b>\xA1Portada horizontal actualizada exitosamente en Picta!</b>";
        await sendOrEditPictaPubDetailInTelegram(
          chatId,
          pendingPubEdit.messageId,
          pendingPubEdit.pubId,
          pendingPubEdit.returnSort,
          pendingPubEdit.returnPage,
          okMsg
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendOrEditPictaPubDetailInTelegram(
          chatId,
          pendingPubEdit.messageId,
          pendingPubEdit.pubId,
          pendingPubEdit.returnSort,
          pendingPubEdit.returnPage,
          `\u26A0\uFE0F <b>No se pudo cambiar la imagen:</b> <code>${escapeHtml(errMsg.slice(0, 120))}</code>`
        );
      }
      return;
    }
  }
  if (pendingPubEdit && subDoc && pendingPubEdit.mode === "subs") {
    try {
      const subBuf = await downloadTelegramThumbnailBuffer(String(subDoc.file_id));
      if (!subBuf) throw new Error("No se pudo descargar el archivo .srt desde Telegram.");
      await patchPictaPublicationInChannel(
        pendingPubEdit.pubId,
        {},
        {
          subtitleBuffer: subBuf,
          subtitleFileName: String(subDoc.file_name || "subtitulos.srt")
        },
        chatId
      );
      await sendOrEditPictaPubDetailInTelegram(
        chatId,
        pendingPubEdit.messageId,
        pendingPubEdit.pubId,
        pendingPubEdit.returnSort,
        pendingPubEdit.returnPage,
        `\u2705 <b>\xA1Subt\xEDtulos (${escapeHtml(String(subDoc.file_name || "subtitulos.srt"))}) a\xF1adidos al video en Picta!</b>`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await sendOrEditPictaPubDetailInTelegram(
        chatId,
        pendingPubEdit.messageId,
        pendingPubEdit.pubId,
        pendingPubEdit.returnSort,
        pendingPubEdit.returnPage,
        `\u26A0\uFE0F <b>No se pudo subir el subt\xEDtulo:</b> <code>${escapeHtml(errMsg.slice(0, 120))}</code>`
      );
    }
    return;
  }
  const activeWizardJobId = pendingManualTitleByChat.get(chatId);
  const activeWizardJob = activeWizardJobId ? transferJobs.find((j) => j.id === activeWizardJobId) : transferJobs.find(
    (j) => j.telegramChatId === chatId && (j.stage === "awaiting_series_selection" || j.stage === "awaiting_new_series_name" || j.stage === "awaiting_season_selection" || j.stage === "awaiting_step_title" || j.stage === "awaiting_step_synopsis" || j.stage === "awaiting_step_cover" || j.stage === "awaiting_step_subtitles" || j.stage === "awaiting_manual_title")
  );
  if ((photoArray || imageDoc) && activeWizardJob && activeWizardJob.stage === "awaiting_step_cover") {
    const largestPhoto = photoArray ? photoArray[photoArray.length - 1] : imageDoc;
    if (largestPhoto?.file_id) {
      if (activeWizardJob.modelMetadata?.awaitingCustomPoster === "true") {
        activeWizardJob.customPosterFileId = String(largestPhoto.file_id);
        delete activeWizardJob.modelMetadata.awaitingCustomPoster;
        activeWizardJob.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        saveJobsToDisk();
        await promptStep3Cover(activeWizardJob, chatId, activeWizardJob.statusMessageId || null);
        return;
      }
      activeWizardJob.customCoverFileId = String(largestPhoto.file_id);
      activeWizardJob.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      saveJobsToDisk();
      await promptStep4Subtitles(activeWizardJob, chatId, activeWizardJob.statusMessageId || null);
      return;
    }
  }
  const activePinnedSerieForPhoto = pinnedBatchSerieByChat.get(chatId);
  if ((photoArray || imageDoc) && !activeWizardJob && activePinnedSerieForPhoto) {
    const largestPhoto = photoArray ? photoArray[photoArray.length - 1] : imageDoc;
    if (largestPhoto?.file_id) {
      const photoFileId = String(largestPhoto.file_id);
      activePinnedSerieForPhoto.customCoverFileId = photoFileId;
      savePinnedSeriesToDisk();
      const pinChanId = Number(getEffectivePictaContext(chatId).channelId || 0);
      upsertChannelSerieRecord(
        activePinnedSerieForPhoto.pelserId,
        activePinnedSerieForPhoto.serieName,
        void 0,
        { customCoverFileId: photoFileId, ...pinChanId > 0 ? { canalId: pinChanId } : {} }
      );
      await sendTelegramStatusMessage(
        chatId,
        `\u{1F5BC}\uFE0F <b>\xA1Portada fijada para "${escapeHtml(activePinnedSerieForPhoto.serieName)}"!</b>
<blockquote>Todos los cap\xEDtulos que env\xEDes ahora en <b>\u{1F4CC} Modo Serie Fija</b> usar\xE1n autom\xE1ticamente esta portada.</blockquote>`,
        msg.message_id
      );
      return;
    }
  }
  if (subDoc && activeWizardJob) {
    activeWizardJob.subtitleFileId = String(subDoc.file_id);
    activeWizardJob.subtitleFileName = String(subDoc.file_name || "subtitulos.srt");
    activeWizardJob.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    saveJobsToDisk();
    await finalizeGuidedStepsAndStart(
      activeWizardJob,
      chatId,
      activeWizardJob.statusMessageId || null
    );
    return;
  }
  const pendingPromoInputCheck = pendingToolkitInputByChat.get(chatId);
  if (pendingPromoInputCheck && (pendingPromoInputCheck.mode === "set_promo_requests_channel" || pendingPromoInputCheck.mode === "set_requests_group_chat")) {
    const fwdChat = msg.forward_origin?.chat || msg.forward_from_chat;
    if (fwdChat && fwdChat.id) {
      pendingToolkitInputByChat.delete(chatId);
      const fwdId = String(fwdChat.id);
      const fwdUsername = fwdChat.username ? `@${fwdChat.username}` : "";
      const fwdTitle = String(fwdChat.title || fwdUsername || fwdId).trim();
      const displayLabel = fwdUsername ? `${fwdTitle} (${fwdUsername})` : fwdTitle;
      const existingCfg = userPromoChannels.get(chatId);
      if (pendingPromoInputCheck.mode === "set_requests_group_chat") {
        userPromoChannels.set(chatId, {
          chatId,
          targetChannelId: existingCfg?.targetChannelId || "",
          targetChannelLabel: existingCfg?.targetChannelLabel || "",
          customPictaChannelUrl: existingCfg?.customPictaChannelUrl,
          autoSendToRequests: existingCfg?.autoSendToRequests,
          requestsGroupChatId: fwdId,
          requestsGroupLabel: displayLabel,
          requestsMonitorMode: existingCfg?.requestsMonitorMode && existingCfg.requestsMonitorMode !== "off" ? existingCfg.requestsMonitorMode : "prefix",
          disabled: existingCfg?.disabled ?? false,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        });
        saveUserPromoChannelsToDisk();
        await sendOrEditPromoChannelMenuInTelegram(
          chatId,
          pendingPromoInputCheck.messageId,
          msg.message_id,
          `\u2705 <b>\xA1Grupo de Pedidos vinculado por reenv\xEDo!</b> ${escapeHtml(displayLabel)} (<code>${escapeHtml(fwdId)}</code>)`
        );
        return;
      }
      userPromoChannels.set(chatId, {
        chatId,
        targetChannelId: fwdId,
        targetChannelLabel: displayLabel,
        customPictaChannelUrl: existingCfg?.customPictaChannelUrl,
        autoSendToRequests: existingCfg?.autoSendToRequests,
        requestsGroupChatId: existingCfg?.requestsGroupChatId,
        requestsGroupLabel: existingCfg?.requestsGroupLabel,
        requestsMonitorMode: existingCfg?.requestsMonitorMode,
        disabled: false,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      saveUserPromoChannelsToDisk();
      const linkedPromo = pendingPromoInputCheck.promoId ? pendingMoviePromos.get(pendingPromoInputCheck.promoId) : void 0;
      if (linkedPromo && linkedPromo.ownerChatId === chatId) {
        const prompt = buildMoviePromoConfirmationPrompt(linkedPromo, chatId);
        await sendTelegramStatusMessage(
          chatId,
          `\u2705 <b>Canal de Pedidos guardado:</b> ${escapeHtml(displayLabel)} (<code>${escapeHtml(fwdId)}</code>)

${prompt.textHtml}`,
          msg.message_id,
          prompt.keyboard
        );
      } else {
        await sendOrEditPromoChannelMenuInTelegram(
          chatId,
          pendingPromoInputCheck.messageId,
          msg.message_id,
          `\u2705 <b>\xA1Canal de Pedidos configurado por reenv\xEDo!</b> ${escapeHtml(displayLabel)} (<code>${escapeHtml(fwdId)}</code>)`
        );
      }
      return;
    }
  }
  const activeMultiPartSession = pendingMultiPartByChat.get(chatId);
  const rawIncomingMedia = msg.video || msg.document;
  if (activeMultiPartSession && rawIncomingMedia && !activeMultiPartSession.assembling) {
    const partFileName = rawIncomingMedia.file_name || `parte_${activeMultiPartSession.parts.length + 1}_${msg.message_id}.mp4`;
    const partSize = Number(rawIncomingMedia.file_size || 0);
    activeMultiPartSession.parts.push({
      telegramMessageId: msg.message_id,
      fileId: rawIncomingMedia.file_id,
      fileUniqueId: String(rawIncomingMedia.file_unique_id || ""),
      fileName: partFileName,
      mimeType: rawIncomingMedia.mime_type || "application/octet-stream",
      sizeBytes: partSize,
      caption: String(msg.caption || "").trim(),
      thumbnailFileId: String(
        rawIncomingMedia.thumbnail?.file_id || rawIncomingMedia.thumb?.file_id || ""
      )
    });
    await sendOrEditMultiPartMenuInTelegram(
      chatId,
      activeMultiPartSession.statusMessageId,
      msg.message_id,
      `\u2705 <b>Parte #${activeMultiPartSession.parts.length} agregada:</b> <code>${escapeHtml(partFileName)}</code> (${formatBytes(partSize)})`
    );
    return;
  }
  const videoObj = msg.video || (msg.document && (String(msg.document.mime_type || "").startsWith("video/") || /\.(mp4|mkv|mov|avi|webm|m4v)$/i.test(String(msg.document.file_name || ""))) ? msg.document : null);
  if (videoObj) {
    if (!isMasterAdminChat(chatId)) {
      await ensureGuestSessionChannelDiscovered(chatId);
    }
    const userChannelCtx = getEffectivePictaContext(chatId);
    if (!userChannelCtx.isLinked || !userChannelCtx.channelId) {
      const session = userSessions.get(chatId);
      if (session && session.authToken) {
        await sendTelegramStatusMessage(
          chatId,
          `\u{1F4FA} <b>CUENTA AUTENTICADA, FALTA VINCULAR TU CANAL</b>

Tu sesi\xF3n est\xE1 activa como <b>${escapeHtml(session.userFullName || session.username)}</b> \u2705

Para subir tus videos a tu propio canal de Picta, escribe:
<code>/canal &lt;enlace o id de tu canal&gt;</code>

<i>Ejemplo:</i> <code>/canal https://www.picta.cu/canal/mi-canal</code>`,
          msg.message_id,
          [[{ text: "\u{1F50D} Vincular mi canal (/canal)", callback_data: "chan_switch:prompt" }]]
        );
        return;
      }
      await sendTelegramStatusMessage(
        chatId,
        `\u26AA <b>CUENTA DE PICTA SIN VINCULAR</b>

<blockquote>\u{1F464} <b>Estado:</b> Sin vincular
\u{1F4FA} <b>Canal activo:</b> Sin vincular</blockquote>
Para subir videos a tu propio canal de Picta, primero vincula tu cuenta tocando el bot\xF3n de abajo o escribiendo <code>/login</code>:`,
        msg.message_id,
        [[{ text: "\u{1F511} Vincular mi cuenta de Picta (/login)", callback_data: "user_picta_login_start" }]]
      );
      return;
    }
    const fileName = videoObj.file_name || `video_telegram_${msg.message_id}_${Date.now().toString().slice(-4)}.mp4`;
    const fileSize = Number(videoObj.file_size || 0);
    const caption = String(msg.caption || "").trim();
    const fileUniqueId = String(videoObj.file_unique_id || "");
    const thumbnailFileId = String(
      videoObj.thumbnail?.file_id || videoObj.thumb?.file_id || ""
    );
    const existingActiveJob = fileUniqueId ? transferJobs.find(
      (j) => j.telegramChatId === chatId && j.fileUniqueId === fileUniqueId && j.stage !== "completed" && j.stage !== "failed"
    ) : void 0;
    if (existingActiveJob) {
      existingActiveJob.telegramMessageId = msg.message_id;
      existingActiveJob.fileId = videoObj.file_id || existingActiveJob.fileId;
      if (thumbnailFileId) {
        existingActiveJob.thumbnailFileId = thumbnailFileId;
      }
      existingActiveJob.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      saveJobsToDisk();
      return;
    }
    const analyzedIntake = analyzeVideoTitleAndSynopsis(fileName, caption);
    const newJob = {
      id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      telegramMessageId: msg.message_id,
      statusMessageId: null,
      telegramChatId: chatId,
      senderName,
      fileId: videoObj.file_id,
      fileUniqueId,
      thumbnailFileId,
      fileName,
      mimeType: videoObj.mime_type || "video/mp4",
      caption,
      expectedBytes: fileSize,
      downloadedBytes: 0,
      integrityVerified: false,
      diskVerifiedBytes: 0,
      uploadedBytes: 0,
      stage: "awaiting_category",
      title: analyzedIntake.initialTitle,
      titleMode: "pending",
      synopsis: analyzedIntake.initialSynopsis,
      category: "Audiovisual",
      tipologiaId: 8,
      tags: [],
      speedMBps: 0,
      targetChannelId: userChannelCtx.channelId,
      targetChannelName: userChannelCtx.channelName,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      ...analyzedIntake.episodeSubtitle || analyzedIntake.needsManualTitle || analyzedIntake.filenameIsRandom ? {
        modelMetadata: {
          ...analyzedIntake.episodeSubtitle ? { episodeSubtitle: analyzedIntake.episodeSubtitle } : {},
          ...analyzedIntake.needsManualTitle ? { needsManualTitle: "true" } : {},
          ...analyzedIntake.filenameIsRandom ? { filenameIsRandom: "true" } : {}
        }
      } : {}
    };
    transferJobs.unshift(newJob);
    pruneTransferJobsMemory();
    const pinnedSerie = pinnedBatchSerieByChat.get(chatId);
    if (pinnedSerie) {
      const serieInfo = analyzedIntake.seriesInfo;
      const targetSeason = String(
        serieInfo.temporada && Number(serieInfo.temporada) > 1 ? serieInfo.temporada : pinnedSerie.seasonNum || "1"
      );
      const targetEp = String(serieInfo.numero || "1");
      const epSub = String(
        serieInfo.episodeSubtitle || analyzedIntake.episodeSubtitle || ""
      ).trim();
      const inheritedStyle = resolveSeriesStyleForChannel(
        chatId,
        pinnedSerie.pelserId,
        pinnedSerie.serieName
      );
      newJob.tipologiaId = 5;
      newJob.category = "Serie";
      newJob.titleMode = "manual";
      newJob.title = inheritedStyle ? formatEpisodeWithSeriesStyle(inheritedStyle, {
        serieName: pinnedSerie.serieName,
        temporada: targetSeason,
        numero: targetEp,
        episodeSubtitle: epSub
      }) : formatSerieEpisodeTitle(
        pinnedSerie.serieName,
        targetSeason,
        targetEp,
        epSub
      );
      const cleanPinnedName = cleanSerieDisplayName(pinnedSerie.serieName) || pinnedSerie.serieName;
      newJob.synopsis = sanitizePublicPictaText(
        analyzedIntake.initialSynopsis && !isStaleOrGenericSerieSynopsis(analyzedIntake.initialSynopsis, caption, targetEp) ? analyzedIntake.initialSynopsis : `Cap\xEDtulo ${targetEp} de la Temporada ${targetSeason} de la serie ${cleanPinnedName}${epSub ? ` titulado "${epSub}"` : ""}, disponible en el canal ${userChannelCtx.channelName}.`
      );
      newJob.modelMetadata = {
        serie: pinnedSerie.serieName,
        ...pinnedSerie.pelserId > 0 ? { serie_pelser_id: String(pinnedSerie.pelserId) } : {},
        temporada: targetSeason,
        ...pinnedSerie.seasonId && targetSeason === String(pinnedSerie.seasonNum) ? { temporada_id: String(pinnedSerie.seasonId) } : {},
        numero: targetEp,
        ...epSub ? { episodeSubtitle: epSub } : {}
      };
      if (!newJob.customCoverFileId && pinnedSerie.customCoverFileId) {
        newJob.customCoverFileId = pinnedSerie.customCoverFileId;
      }
      saveJobsToDisk();
      const pausedForDup = await checkPictaDuplicateAndPromptIfFound(
        newJob,
        chatId,
        null,
        "pinned_serie"
      );
      if (pausedForDup) return;
      await executePinnedSerieUploadAfterDuplicateCheck(newJob, chatId, null);
      return;
    }
    currentActivity = `Video recibido de ${senderName}: "${fileName}" (${formatBytes(fileSize)}). Esperando elecci\xF3n de categor\xEDa...`;
    saveJobsToDisk();
    addLiveLog(
      "telegram",
      "info",
      `Video recibido de ${senderName}: "${fileName}" (${formatBytes(fileSize)}). Solicitando categor\xEDa de Picta.`
    );
    const sentPromptId = await sendTelegramStatusMessage(
      chatId,
      `${hudHeader("NUEVO VIDEO RECIBIDO")}
` + hudBox([
        `\u{1F4C4} <b>Archivo:</b> <code>${escapeHtml(fileName)}</code>`,
        `\u{1F4E6} <b>Tama\xF1o:</b> ${formatBytes(fileSize)}`,
        `\u{1F4FA} <b>Canal:</b> ${escapeHtml(userChannelCtx.channelName)} \xB7 <code>#${escapeHtml(userChannelCtx.channelId)}</code>`,
        analyzedIntake.needsManualTitle ? `\u26A0\uFE0F <b>Nombre aleatorio:</b> <i>Te pedir\xE9 el t\xEDtulo tras elegir categor\xEDa</i>` : analyzedIntake.initialTitle ? `${analyzedIntake.titleSource === "caption" && analyzedIntake.filenameIsRandom ? "\u{1F4AC}" : "\u{1F3AC}"} <b>T\xEDtulo detectado:</b> <code>${escapeHtml(analyzedIntake.initialTitle.slice(0, 64))}</code>` : void 0
      ]) + `
\u{1F4C2} <b>Selecciona la categor\xEDa de Picta:</b>
<i>(Si eliges <b>\u{1F4FA} Serie</b> podr\xE1s elegir una serie de tu canal, crear una nueva o activar el <b>\u{1F4CC} Modo Serie Fija</b> para r\xE1fagas autom\xE1ticas)</i>`,
      msg.message_id,
      buildCategorySelectionKeyboard(newJob.id)
    );
    if (sentPromptId) {
      newJob.statusMessageId = sentPromptId;
      saveJobsToDisk();
    }
    return;
  }
  const text = String(msg.text || "").trim();
  if (!text) return;
  const repliedMsgId = msg.reply_to_message?.message_id;
  if (repliedMsgId && !text.startsWith("/")) {
    const replyTarget = alertsState.replyTargets[`${chatId}:${repliedMsgId}`];
    if (replyTarget) {
      try {
        await postPictaCommentInChannel(
          chatId,
          replyTarget.pubId,
          text,
          replyTarget.commentId
        );
        await sendTelegramStatusMessage(
          chatId,
          `\u2705 <b>Respuesta publicada en Picta</b>
<blockquote>\u{1F3AC} <b>Video:</b> ${escapeHtml(replyTarget.pubTitle)}
\u21A9\uFE0F <b>Respondiendo a:</b> @${escapeHtml(replyTarget.author)}
\u{1F4AC} <i>"${escapeHtml(text.slice(0, 220))}"</i></blockquote>`,
          msg.message_id,
          [
            [
              {
                text: "\u{1F310} Ver Video en Picta",
                url: `https://www.picta.cu/medias/${replyTarget.pubId}`
              }
            ]
          ]
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendTelegramStatusMessage(
          chatId,
          `\u26A0\uFE0F <b>No se pudo publicar tu respuesta en Picta:</b>
<code>${escapeHtml(errMsg.slice(0, 180))}</code>`,
          msg.message_id
        );
      }
      return;
    }
  }
  const pendingLogin = pendingUserLoginByChat.get(chatId);
  if (pendingLogin) {
    if (text.startsWith("/cancelar") || text.startsWith("/salir")) {
      pendingUserLoginByChat.delete(chatId);
      await sendTelegramStatusMessage(
        chatId,
        "\u274C <i>Inicio de sesi\xF3n en Picta cancelado.</i>",
        msg.message_id
      );
      return;
    }
    if (pendingLogin.step === "awaiting_username") {
      pendingLogin.username = text.trim();
      pendingLogin.step = "awaiting_password";
      await sendTelegramStatusMessage(
        chatId,
        `\u{1F511} <b>PASO 2/2 \xB7 CONTRASE\xD1A DE PICTA</b>

Usuario: <code>${escapeHtml(pendingLogin.username)}</code>

Escribe ahora tu contrase\xF1a de Picta:

\u{1F6E1}\uFE0F <i>Tu mensaje ser\xE1 eliminado del chat de inmediato tras ser le\xEDdo para proteger tu privacidad.</i>`,
        msg.message_id
      );
      return;
    }
    if (pendingLogin.step === "awaiting_password") {
      const inputPass = text.trim();
      await callTelegramBotApi("deleteMessage", {
        chat_id: chatId,
        message_id: msg.message_id
      }).catch(() => {
      });
      const authResult = await performUserPictaLogin(chatId, pendingLogin.username || "", inputPass);
      pendingUserLoginByChat.delete(chatId);
      if (!authResult.success || !authResult.session) {
        await sendTelegramStatusMessage(
          chatId,
          `\u274C <b>Error al autenticar en Picta:</b>

<blockquote>${escapeHtml(authResult.message)}</blockquote>

Verifica tus credenciales y prueba de nuevo escribiendo <code>/login</code>.`,
          void 0,
          [[{ text: "\u{1F504} Intentar de nuevo (/login)", callback_data: "user_picta_login_start" }]]
        );
        return;
      }
      const session = authResult.session;
      const hasLinkedChan = Boolean(session.channelId && session.channelId !== "0");
      const channelButtons = (session.availableChannels || []).slice(0, 8).map((c) => [
        {
          text: `\u{1F4FA} ${c.nombre} (#${c.id})`,
          callback_data: `user_channel_pick:${c.id}`
        }
      ]);
      if (hasLinkedChan) {
        pendingToolkitInputByChat.delete(chatId);
        await sendTelegramStatusMessage(
          chatId,
          `\u{1F389} <b>\xA1CUENTA DE PICTA VINCULADA CON \xC9XITO!</b>

<blockquote>\u{1F464} <b>Usuario Picta:</b> ${escapeHtml(session.userFullName || session.username)}
\u{1F4FA} <b>Canal Activo:</b> ${escapeHtml(session.channelName)} (<code>#${escapeHtml(session.channelId)}</code>)
\u{1F4E6} <b>Canales encontrados:</b> ${session.availableChannels.length}</blockquote>
\u2705 <b>Todo listo en 1 paso:</b> Ya puedes enviarme tus videos directamente aqu\xED y se subir\xE1n exclusivamente a este canal.

` + (session.availableChannels.length > 1 ? `<i>Puedes tocar un bot\xF3n abajo para cambiar de canal activo en cualquier momento:</i>` : ""),
          void 0,
          channelButtons.length > 1 ? channelButtons : void 0
        );
      } else {
        pendingToolkitInputByChat.set(chatId, {
          mode: "switch_channel_query",
          messageId: null
        });
        await sendTelegramStatusMessage(
          chatId,
          `\u{1F389} <b>\xA1CUENTA DE PICTA VINCULADA CON \xC9XITO!</b>

<blockquote>\u{1F464} <b>Usuario Picta:</b> ${escapeHtml(session.userFullName || session.username)}
\u{1F4FA} <b>Canal Activo:</b> Sin canal asignado autom\xE1ticamente
\u{1F4E6} <b>Canales encontrados:</b> 0</blockquote>
\u{1F4CC} <b>\xDAltimo paso (solo responde este mensaje):</b> Pega aqu\xED mismo el <b>enlace de tu canal</b> (ej: <code>https://www.picta.cu/canal/tu-canal</code>), su <b>nombre</b> o su <b>ID num\xE9rico</b> y quedar\xE1 vinculado al instante sin escribir comandos:`,
          void 0,
          [
            [{ text: "\u{1F504} Reintentar Detecci\xF3n Autom\xE1tica", callback_data: "retry_auto_discover_channel" }],
            [{ text: "\u274C Cancelar", callback_data: "cmd_start" }]
          ]
        );
      }
      return;
    }
  }
  const pendingPictaSearch = pendingPictaSearchByChat.get(chatId);
  if (pendingPictaSearch && !text.startsWith("/")) {
    pendingPictaSearchByChat.delete(chatId);
    await sendOrEditPictaSearchResultsInTelegram(
      chatId,
      pendingPictaSearch.messageId,
      text.trim(),
      0,
      msg.message_id
    );
    return;
  }
  const pendingPool = pendingPoolAccountByChat.get(chatId);
  if (pendingPool) {
    const primaryCtxCheck = getEffectivePictaContext(chatId);
    if (!isMasterAdminChat(chatId) && (!primaryCtxCheck.isLinked || !primaryCtxCheck.channelId)) {
      pendingPoolAccountByChat.delete(chatId);
      return;
    }
    if (text.startsWith("/cancelar") || text.startsWith("/salir")) {
      const retJobId = pendingPool.returnToJobId;
      pendingPoolAccountByChat.delete(chatId);
      if (retJobId) {
        const retJob = transferJobs.find((j) => j.id === retJobId);
        if (retJob) {
          await promptUploadAccountSelection(retJob, chatId, pendingPool.messageId);
          return;
        }
      }
      await sendOrEditQuotaMenuInTelegram(
        chatId,
        pendingPool.messageId,
        msg.message_id,
        "\u2139\uFE0F <i>Registro de cuenta secundaria cancelado.</i>"
      );
      return;
    }
    if (pendingPool.step === "awaiting_username") {
      pendingPool.username = text.trim();
      pendingPool.step = "awaiting_password";
      await sendTelegramStatusMessage(
        chatId,
        `\u{1F511} <b>PASO 2/2 \xB7 CONTRASE\xD1A DE LA CUENTA COLABORADORA</b>

Cuenta para el Pool: <code>${escapeHtml(pendingPool.username)}</code>

Escribe ahora la contrase\xF1a de Picta de esta cuenta:

\u{1F6E1}\uFE0F <i>Tu mensaje ser\xE1 eliminado del chat de inmediato y la cuenta quedar\xE1 guardada en tu Pool para subir en tu canal.</i>`,
        msg.message_id
      );
      return;
    }
    if (pendingPool.step === "awaiting_password") {
      const inputPass = text.trim();
      await callTelegramBotApi("deleteMessage", {
        chat_id: chatId,
        message_id: msg.message_id
      }).catch(() => {
      });
      const rawUser = (pendingPool.username || "").trim();
      const retJobId = pendingPool.returnToJobId;
      const savedMsgId = pendingPool.messageId;
      pendingPoolAccountByChat.delete(chatId);
      const newPoolAcc = {
        username: rawUser,
        password: inputPass,
        uploadedToday: 0
      };
      try {
        const { userId } = await authenticatePoolPictaAccount(newPoolAcc, true);
        const primaryCtx = getEffectivePictaContext(chatId);
        const targetChanId = primaryCtx.channelId || botConfig.pictaChannelId || "36319";
        const primaryTokenOpt = await primaryCtx.accessTokenPromise.catch(() => "");
        if (primaryTokenOpt) {
          await ensurePoolAccountAssociatedWithChannel(primaryTokenOpt, targetChanId, userId).catch(() => {
          });
        }
        newPoolAcc.associatedChannelIds = [String(targetChanId)];
        let targetPoolList;
        if (isMasterAdminChat(chatId)) {
          targetPoolList = quotaSettings.poolAccounts;
        } else {
          const sess = userSessions.get(chatId);
          if (!sess) {
            throw new Error("No se encontr\xF3 tu sesi\xF3n activa de Picta (/login).");
          }
          if (!Array.isArray(sess.poolAccounts)) sess.poolAccounts = [];
          targetPoolList = sess.poolAccounts;
        }
        const existingIdx = targetPoolList.findIndex(
          (a) => a.username.toLowerCase() === rawUser.toLowerCase()
        );
        if (existingIdx >= 0) {
          targetPoolList[existingIdx] = newPoolAcc;
        } else {
          targetPoolList.push(newPoolAcc);
        }
        savePoolAccountsForChat(chatId);
        if (retJobId) {
          const retJob = transferJobs.find((j) => j.id === retJobId);
          if (retJob) {
            await sendTelegramStatusMessage(
              chatId,
              `\u2705 <b>Colaborador <code>${escapeHtml(newPoolAcc.displayName || rawUser)}</code> a\xF1adido al Pool.</b> El\xEDgelo abajo para subir tu video:`,
              msg.message_id
            );
            await promptUploadAccountSelection(retJob, chatId, savedMsgId);
            return;
          }
        }
        const publishablePoolCount = targetPoolList.filter(
          (a) => a.canPublishDirectly !== false
        ).length;
        const roleNotice = newPoolAcc.canPublishDirectly === false ? `\u26A0\uFE0F <b>Rol detectado:</b> <code>Usuario com\xFAn</code> (sin permiso <b>Jefe de canal</b>).
Podr\xE1 pre-subir videos a S3 MinIO pero requiere grupo Jefe de canal en Picta para publicar.` : `\u2705 <b>Rol verificado:</b> <code>Jefe de canal</code> \xB7 Suma <b>+10 publicaciones reales diarias</b> (total actual: <b>${(1 + publishablePoolCount) * 10} subidas diarias</b>).`;
        await sendOrEditQuotaMenuInTelegram(
          chatId,
          savedMsgId,
          void 0,
          `\u{1F389} <b>\xA1Cuenta colaboradora <code>${escapeHtml(newPoolAcc.displayName || rawUser)}</code> verificada y guardada en tu Pool (#${escapeHtml(targetChanId)})!</b>
${roleNotice}`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (retJobId) {
          const retJob = transferJobs.find((j) => j.id === retJobId);
          if (retJob) {
            await sendTelegramStatusMessage(
              chatId,
              `\u274C <b>No se pudo autenticar al colaborador (${escapeHtml(rawUser)}):</b> <code>${escapeHtml(errMsg.slice(0, 140))}</code>`,
              msg.message_id
            );
            await promptUploadAccountSelection(retJob, chatId, savedMsgId);
            return;
          }
        }
        await sendOrEditQuotaMenuInTelegram(
          chatId,
          savedMsgId,
          void 0,
          `\u274C <b>No se pudo autenticar la cuenta colaboradora (${escapeHtml(rawUser)}):</b> <code>${escapeHtml(errMsg.slice(0, 140))}</code>`
        );
      }
      return;
    }
  }
  if (text.startsWith("/autorizar")) {
    if (chatId !== MASTER_ADMIN_CHAT_ID) {
      await sendTelegramStatusMessage(
        chatId,
        `\u26D4 <i>Solo el Administrador Principal (@ghosthell0210) tiene permiso para autorizar usuarios.</i>`,
        msg.message_id
      );
      return;
    }
    const target = text.replace(/^\/autorizar(@\w+)?/i, "").trim();
    if (!target) {
      await sendTelegramStatusMessage(
        chatId,
        `\u2139\uFE0F <b>Uso del comando:</b>
<code>/autorizar &lt;ID o @usuario&gt;</code>

<b>Ejemplos:</b>
\u2022 <code>/autorizar 123456789</code>
\u2022 <code>/autorizar @pepito</code>`,
        msg.message_id
      );
      return;
    }
    const res = authorizeUser(target, chatId);
    await sendTelegramStatusMessage(
      chatId,
      res.success ? `\u2705 <b>Usuario Autorizado:</b>

<blockquote>\u{1F464} <b>Identificador:</b> <code>${escapeHtml(target)}</code>
\u{1F4C5} <b>Fecha:</b> ${(/* @__PURE__ */ new Date()).toLocaleString("es-CU")}
\u{1F6E1}\uFE0F <b>Autorizado por:</b> @ghosthell0210</blockquote>
El usuario ya puede interactuar con el bot y subir videos a Picta.` : `\u26A0\uFE0F <b>Aviso:</b> ${escapeHtml(res.message)}`,
      msg.message_id
    );
    if (res.success && /^\d+$/.test(target)) {
      await callTelegramBotApi("sendMessage", {
        chat_id: target,
        text: `\u{1F389} <b>\xA1HAS SIDO AUTORIZADO!</b>

El administrador (@ghosthell0210) te ha concedido acceso para usar el bot de Picta.

\u2022 Escribe <code>/start</code> para ver el men\xFA principal.
\u2022 Escribe <code>/login</code> para conectar tu propia cuenta y canal de Picta.`,
        parse_mode: "HTML"
      }).catch(() => {
      });
    }
    return;
  }
  if (text.startsWith("/quitar") || text.startsWith("/revocar")) {
    if (chatId !== MASTER_ADMIN_CHAT_ID) {
      await sendTelegramStatusMessage(
        chatId,
        `\u26D4 <i>Solo el Administrador Principal (@ghosthell0210) tiene permiso para revocar usuarios.</i>`,
        msg.message_id
      );
      return;
    }
    const target = text.replace(/^\/(quitar|revocar)(@\w+)?/i, "").trim();
    if (!target) {
      await sendTelegramStatusMessage(
        chatId,
        `\u2139\uFE0F <b>Uso:</b> <code>/quitar &lt;ID o @usuario&gt;</code>`,
        msg.message_id
      );
      return;
    }
    const res = revokeUser(target);
    await sendTelegramStatusMessage(
      chatId,
      res.success ? `\u2705 ${escapeHtml(res.message)}` : `\u26A0\uFE0F ${escapeHtml(res.message)}`,
      msg.message_id
    );
    return;
  }
  if (text.startsWith("/usuarios") || text.startsWith("/whitelist")) {
    await sendOrEditAdminUsersDashboardInTelegram(chatId, null, 0, msg.message_id);
    return;
  }
  if (text.startsWith("/login") || text.startsWith("/conectar")) {
    pendingUserLoginByChat.set(chatId, { step: "awaiting_username" });
    await sendTelegramStatusMessage(
      chatId,
      `\u{1F4F1} <b>PASO 1/2 \xB7 VINCULAR TU CUENTA DE PICTA</b>

Por favor, escribe tu <b>n\xFAmero de tel\xE9fono (+53...)</b> o tu <b>usuario de Picta</b>:

<i>(O escribe /cancelar para salir)</i>`,
      msg.message_id
    );
    return;
  }
  if (text.startsWith("/micuenta") || text.startsWith("/cuenta")) {
    await sendOrEditAccountDiagnosticInTelegram(chatId, null, msg.message_id);
    return;
  }
  if (text.startsWith("/canales")) {
    const isMaster = isMasterAdminChat(chatId);
    if (isMaster) {
      await sendTelegramStatusMessage(
        chatId,
        `\u{1F4FA} <b>CANAL ACTIVO:</b> Multiverso Visual (#36319)`,
        msg.message_id,
        [[{ text: "\u{1F3DB}\uFE0F Editar Canal (/canal)", callback_data: "chan_editor:open" }]]
      );
      return;
    }
    await ensureGuestSessionChannelDiscovered(chatId, true);
    const session = userSessions.get(chatId);
    if (!session) {
      await sendTelegramStatusMessage(
        chatId,
        `\u2139\uFE0F Primero debes iniciar sesi\xF3n en Picta con <code>/login</code> para ver tus canales.`,
        msg.message_id,
        [[{ text: "\u{1F511} Iniciar Sesi\xF3n (/login)", callback_data: "user_picta_login_start" }]]
      );
      return;
    }
    const channelButtons = (session.availableChannels || []).slice(0, 8).map((c) => [
      {
        text: `\u{1F4FA} ${c.nombre} (#${c.id})${String(c.id) === session.channelId ? " \u2705" : ""}`,
        callback_data: `user_channel_pick:${c.id}`
      }
    ]);
    channelButtons.push([{ text: "\u{1F3DB}\uFE0F Editar Canal Activo (/canal)", callback_data: "chan_editor:open" }]);
    await sendTelegramStatusMessage(
      chatId,
      `\u{1F4FA} <b>ELIGE TU CANAL ACTIVO EN PICTA:</b>

Actualmente seleccionado: ${session.channelId ? `<b>${escapeHtml(session.channelName)} (#${escapeHtml(session.channelId)})</b>` : "<i>Sin canal asignado</i>"}

Toca el canal donde deseas que se suban tus videos:`,
      msg.message_id,
      channelButtons
    );
    return;
  }
  if (text.startsWith("/canal") || text.startsWith("/micanal") || text.startsWith("/editarcanal")) {
    pendingToolkitInputByChat.delete(chatId);
    const rawArg = text.replace(/^\/(?:canal|micanal|editarcanal)/i, "").trim();
    const isMaster = isMasterAdminChat(chatId);
    if (!isMaster) {
      await ensureGuestSessionChannelDiscovered(chatId, true);
    }
    const session = userSessions.get(chatId);
    if (isMaster && session && (!session.channelId || session.channelId === "0")) {
      const masterChId = String(botConfig.pictaChannelId || "36319");
      session.channelId = masterChId;
      session.channelName = session.channelName || "Multiverso Visual";
      session.verifiedChannelOwnership = true;
      if (!Array.isArray(session.availableChannels)) session.availableChannels = [];
      if (!session.availableChannels.some((x) => String(x.id) === masterChId)) {
        session.availableChannels.unshift({ id: Number(masterChId), nombre: session.channelName });
      }
      saveUserSessionsToDisk();
    } else if (!isMaster && session && (!session.channelId || session.channelId === "0") && session.availableChannels?.length > 0) {
      session.channelId = String(session.availableChannels[0].id);
      session.channelName = session.availableChannels[0].nombre;
      session.verifiedChannelOwnership = true;
      saveUserSessionsToDisk();
    }
    if (rawArg) {
      if (session) {
        const candidates = await findPictaChannel(rawArg, session.authToken, chatId);
        if (candidates.length === 1) {
          const found = candidates[0];
          session.channelId = String(found.id);
          session.channelName = found.nombre;
          session.verifiedChannelOwnership = true;
          if (!session.availableChannels.some((x) => String(x.id) === String(found.id))) {
            session.availableChannels.push({ id: found.id, nombre: found.nombre, alias: found.alias });
          }
          saveUserSessionsToDisk();
          await sendTelegramStatusMessage(
            chatId,
            `\u2705 <b>Canal activo actualizado a:</b> ${escapeHtml(session.channelName)} (<code>#${found.id}</code>)
Todos tus videos y publicaciones se subir\xE1n a este canal.`,
            msg.message_id
          );
          await sendOrEditChannelEditorMenu(chatId, null, msg.message_id);
          return;
        } else if (candidates.length > 1) {
          const kb = candidates.slice(0, 5).map((c) => [
            {
              text: `\u{1F4FA} ${c.nombre} (#${c.id})`,
              callback_data: `chan_switch:select:${c.id}`
            }
          ]);
          kb.push([{ text: "\u2B05\uFE0F Cancelar", callback_data: "chan_editor:open" }]);
          await sendTelegramStatusMessage(
            chatId,
            `\u{1F50D} <b>Se encontraron ${candidates.length} canales:</b>
Toca el bot\xF3n correspondiente a tu canal para vincularlo:

` + candidates.map((c) => `\u2022 <b>${escapeHtml(c.nombre)}</b> (<code>#${c.id}</code>)`).join("\n"),
            msg.message_id,
            kb
          );
          return;
        } else {
          await sendTelegramStatusMessage(
            chatId,
            `\u26A0\uFE0F No pudimos encontrar un canal propio con "<code>${escapeHtml(rawArg)}</code>" en Picta.

\u{1F4A1} <b>\xBFC\xF3mo vincularlo?</b>
\u2022 Entra a tu canal en Picta y copia el enlace: <code>/canal https://www.picta.cu/canal/tu-canal</code>
\u2022 O ingresa su ID num\xE9rico si lo conoces: <code>/canal 12345</code>`,
            msg.message_id
          );
          return;
        }
      } else if (!isMaster) {
        await sendTelegramStatusMessage(
          chatId,
          `\u2139\uFE0F Primero debes iniciar sesi\xF3n en Picta con <code>/login</code> para vincular tu canal.`,
          msg.message_id
        );
        return;
      }
    }
    const ctx = getEffectivePictaContext(chatId);
    if (!isMaster && session && (!ctx.isLinked || !ctx.channelId || ctx.channelId === "0")) {
      pendingToolkitInputByChat.set(chatId, {
        mode: "switch_channel_query",
        messageId: null
      });
      await sendTelegramStatusMessage(
        chatId,
        `\u{1F4FA} <b>VINCULA TU CANAL DE PICTA</b>

Escribe ahora el <b>enlace directo de tu canal</b> (ej: <code>https://www.picta.cu/canal/mi-canal</code>) o su <b>ID num\xE9rico</b>:

<i>\u{1F4A1} Tambi\xE9n puedes escribir /canal &lt;enlace o id&gt; en cualquier momento.</i>`,
        msg.message_id,
        [[{ text: "\u2B05\uFE0F Cancelar", callback_data: "cmd_start" }]]
      );
      return;
    }
    await sendOrEditChannelEditorMenu(chatId, null, msg.message_id);
    return;
  }
  if (text.startsWith("/logout") || text.startsWith("/cerrarsesion")) {
    if (chatId === MASTER_ADMIN_CHAT_ID) {
      await sendTelegramStatusMessage(
        chatId,
        `\u2139\uFE0F La cuenta del Administrador Principal utiliza las credenciales seguras del servidor.`,
        msg.message_id
      );
      return;
    }
    userSessions.delete(chatId);
    saveUserSessionsToDisk();
    await sendTelegramStatusMessage(
      chatId,
      `\u{1F6AA} <b>Tu sesi\xF3n de Picta ha sido cerrada.</b>`,
      msg.message_id
    );
    return;
  }
  if (text.startsWith("/cola") || text.startsWith("/queue") || text.startsWith("/rafaga") || text.startsWith("/fijar")) {
    await sendOrEditQueueManagerInTelegram(chatId, null, msg.message_id);
    return;
  }
  if (text.startsWith("/unir") || text.startsWith("/partes") || text.startsWith("/join")) {
    await sendOrEditMultiPartMenuInTelegram(chatId, null, msg.message_id);
    return;
  }
  if (text.startsWith("/cuota") || text.startsWith("/limite") || text.startsWith("/pool") || text.startsWith("/cuentas")) {
    await sendOrEditQuotaMenuInTelegram(chatId, null, msg.message_id);
    return;
  }
  if (text.startsWith("/buscar") || text.startsWith("/search")) {
    pendingPictaSearchByChat.delete(chatId);
    const searchArg = text.replace(/^\/(buscar|search)(@\w+)?/i, "").trim();
    if (!searchArg) {
      pendingPictaSearchByChat.set(chatId, { messageId: null });
      await sendTelegramStatusMessage(
        chatId,
        `${hudHeader("BUSCADOR GLOBAL DE PICTA")}
\u270D\uFE0F <b>Escribe ahora el t\xEDtulo de la pel\xEDcula, serie o video que quieres buscar en toda Picta</b> (ej: <i>Dune Parte 2</i> o <i>Deadpool</i>):

<i>(O escribe <code>/buscar T\xEDtulo</code> directamente \xB7 /cancelar para salir)</i>`,
        msg.message_id,
        [[{ text: "\u2B05\uFE0F Volver al Men\xFA", callback_data: "cmd_start" }]]
      );
      return;
    }
    await sendOrEditPictaSearchResultsInTelegram(chatId, null, searchArg, 0, msg.message_id);
    return;
  }
  if (text.startsWith("/cancelar") || text.startsWith("/stop")) {
    if (pendingPictaSearchByChat.has(chatId)) {
      const pendingS = pendingPictaSearchByChat.get(chatId);
      pendingPictaSearchByChat.delete(chatId);
      await sendOrEditMainMenuInTelegram(chatId, pendingS?.messageId || null, msg.message_id);
      return;
    }
    if (pendingPoolAccountByChat.has(chatId)) {
      const pending = pendingPoolAccountByChat.get(chatId);
      pendingPoolAccountByChat.delete(chatId);
      await sendOrEditQuotaMenuInTelegram(
        chatId,
        pending?.messageId || null,
        msg.message_id,
        `\u2139\uFE0F <i>Registro de cuenta secundaria cancelado.</i>`
      );
      return;
    }
    if (pendingChannelEditByChat.has(chatId)) {
      const pending = pendingChannelEditByChat.get(chatId);
      pendingChannelEditByChat.delete(chatId);
      await sendOrEditChannelEditorMenu(
        chatId,
        pending?.messageId || null,
        msg.message_id,
        `\u2139\uFE0F <i>Edici\xF3n de canal cancelada.</i>`
      );
      return;
    }
    if (pendingToolkitInputByChat.has(chatId)) {
      const pendingTk = pendingToolkitInputByChat.get(chatId);
      pendingToolkitInputByChat.delete(chatId);
      if (pendingTk?.mode === "set_promo_requests_channel") {
        await sendOrEditPromoChannelMenuInTelegram(
          chatId,
          pendingTk.messageId || null,
          msg.message_id,
          `\u2139\uFE0F <i>Configuraci\xF3n de Canal de Pedidos cancelada.</i>`,
          pendingTk.promoId
        );
        return;
      }
      await sendOrEditChannelEditorMenu(
        chatId,
        pendingTk?.messageId || null,
        msg.message_id,
        `\u2139\uFE0F <i>Acci\xF3n cancelada.</i>`
      );
      return;
    }
    if (pendingStandaloneSerieByChat.has(chatId)) {
      const pendingSt = pendingStandaloneSerieByChat.get(chatId);
      pendingStandaloneSerieByChat.delete(chatId);
      await sendOrEditMyChannelSeriesMenu(
        chatId,
        pendingSt?.messageId || null,
        msg.message_id,
        `\u2139\uFE0F <i>Edici\xF3n de serie cancelada.</i>`
      );
      return;
    }
    const isMaster = isMasterAdminChat(chatId);
    const myTargetJob = transferJobs.find(
      (j) => (isMaster || j.telegramChatId === chatId) && (j.id === activeUploadJobId || j.id === activeDownloadJobId || uploadQueue.includes(j.id))
    );
    if (myTargetJob) {
      await cancelTransferJob(myTargetJob.id, chatId);
      await sendOrEditQueueManagerInTelegram(
        chatId,
        null,
        msg.message_id,
        `\u{1F6D1} <b>Transferencia cancelada correctamente.</b>`
      );
    } else {
      await sendOrEditQueueManagerInTelegram(
        chatId,
        null,
        msg.message_id,
        `\u2139\uFE0F <i>No tienes ninguna subida activa ni en cola en este momento.</i>`
      );
    }
    return;
  }
  if (text.startsWith("/stats") || text.startsWith("/estadisticas") || text.startsWith("/dashboard") || text.startsWith("/picta")) {
    await sendOrEditPictaDashboardInTelegram(chatId, null, "views", 0, msg.message_id, true);
    return;
  }
  if (text.startsWith("/series") || text.startsWith("/misseries")) {
    await sendOrEditMyChannelSeriesMenu(chatId, null, msg.message_id);
    return;
  }
  if (text.startsWith("/colaboradores") || text.startsWith("/asociados")) {
    await sendOrEditChannelCollaboratorsMenu(chatId, null, msg.message_id);
    return;
  }
  if (text.startsWith("/listas") || text.startsWith("/playlists")) {
    await sendOrEditPlaylistsMenuInTelegram(chatId, null, msg.message_id);
    return;
  }
  if (text.startsWith("/comentarios") || text.startsWith("/denuncias")) {
    await sendOrEditCommentsMenuInTelegram(chatId, null, void 0, msg.message_id);
    return;
  }
  if (text.startsWith("/logros") || text.startsWith("/alertas") || text.startsWith("/metas")) {
    await sendOrEditAlertsMilestonesMenuInTelegram(chatId, null, msg.message_id);
    return;
  }
  if (text.startsWith("/personas") || text.startsWith("/actores") || text.startsWith("/etiquetas") || text.startsWith("/tags")) {
    await sendOrEditPersonasAndTagsMenuInTelegram(chatId, null, msg.message_id);
    return;
  }
  if (text.startsWith("/canalpedidos") || text.startsWith("/promocion") || text.startsWith("/pedidoscanal")) {
    await sendOrEditPromoChannelMenuInTelegram(chatId, null, msg.message_id);
    return;
  }
  if (text.startsWith("/auditoria") || text.startsWith("/saludcanal")) {
    await sendOrEditChannelAuditInTelegram(chatId, null, "dups", 0, msg.message_id, true);
    return;
  }
  if (text === "/pedidos" || text.startsWith("/pedidos ")) {
    const inlineReq = text.replace(/^\/pedidos(@[A-Za-z0-9_]+)?\s*/i, "").trim();
    if (inlineReq) {
      await processRequestQueryAndReplyOrSave({
        ownerChatId: chatId,
        replyChatId: chatId,
        replyToMessageId: msg.message_id,
        query: inlineReq,
        requesterName: senderName,
        requesterUsername: msg.from?.username,
        autoSaveIfMissing: false
      });
    } else {
      await sendOrEditRequestsManagerInTelegram(chatId, null, "pending", 0, msg.message_id);
    }
    return;
  }
  if (text.startsWith("/pedir")) {
    const queryArg = text.replace(/^\/pedir(@[A-Za-z0-9_]+)?\s*/i, "").trim();
    if (!queryArg) {
      pendingToolkitInputByChat.set(chatId, {
        mode: "add_or_check_request",
        messageId: null
      });
      await sendTelegramStatusMessage(
        chatId,
        `\u{1F50E} <b>VERIFICAR O ANOTAR PEDIDO</b>

Escribe ahora el t\xEDtulo que pidi\xF3 el suscriptor (o usa <code>/pedir Nombre</code>):`,
        msg.message_id,
        [[{ text: "\u{1F4CB} Ver Lista (/pedidos)", callback_data: "req:list:pending:0" }]]
      );
      return;
    }
    await processRequestQueryAndReplyOrSave({
      ownerChatId: chatId,
      replyChatId: chatId,
      replyToMessageId: msg.message_id,
      query: queryArg,
      requesterName: senderName,
      requesterUsername: msg.from?.username,
      autoSaveIfMissing: false
    });
    return;
  }
  if (text.startsWith("/start") || text.startsWith("/estado") || text.startsWith("/menu")) {
    await sendOrEditMainMenuInTelegram(chatId, null, msg.message_id);
    return;
  }
  if (text.startsWith("/netlog") || text.startsWith("/diag") || text.startsWith("/mtproto")) {
    if (!isMasterAdminChat(chatId)) {
      await sendTelegramStatusMessage(
        chatId,
        `\u2139\uFE0F El diagn\xF3stico avanzado de red MTProto est\xE1 reservado para el administrador.`,
        msg.message_id
      );
      return;
    }
    const readyAux = Array.from(auxiliaryBotClients.values()).filter((c) => c.connected).length;
    const cooldownSec = mtprotoAuxFloodWaitUntilMs > Date.now() ? Math.ceil((mtprotoAuxFloodWaitUntilMs - Date.now()) / 1e3) : 0;
    const recent = mtprotoDiagLogs.slice(0, 10);
    const lines = recent.length ? recent.map((entry) => {
      const t = new Date(entry.timestamp).toLocaleTimeString("es-CU", {
        timeZone: "America/Havana",
        hour12: false
      });
      return `\u2022 <code>${t}</code> ${escapeHtml(entry.message)}`;
    }) : ["\u2022 Sin eventos MTProto registrados a\xFAn en esta instancia."];
    await sendTelegramStatusMessage(
      chatId,
      `\u{1F4E1} <b>LOG DE RED Y VELOCIDAD MTPROTO</b>

<blockquote>\u{1F50C} <b>Pool activo:</b> ${mtprotoConnected ? 1 : 0} principal + ${readyAux}/${Math.max(0, MTPROTO_TCP_POOL_SIZE - 1)} auxiliares
` + (cooldownSec > 0 ? `\u23F3 <b>Enfriamiento login auxiliar:</b> ${cooldownSec}s
` : "") + `\u{1F4CA} <b>\xDAltimos ${recent.length} eventos:</b>
` + lines.join("\n") + `</blockquote>`,
      msg.message_id
    );
    return;
  }
  if (text.startsWith("/disco")) {
    if (!isMasterAdminChat(chatId)) {
      await sendTelegramStatusMessage(
        chatId,
        `\u2139\uFE0F El disco temporal de transferencias se gestiona autom\xE1ticamente para tus videos.`,
        msg.message_id
      );
      return;
    }
    const diskStats = getScratchDiskStats(TMP_UPLOAD_DIR);
    const memStats = getMemoryTelemetry();
    const storageLabel = diskStats.storageType === "ephemeral_disk" ? "Disco ef\xEDmero real (sin consumir RAM)" : diskStats.storageType === "tmpfs_ram" ? "Memoria temporal (tmpfs)" : "Almacenamiento autom\xE1tico";
    await sendTelegramStatusMessage(
      chatId,
      `\u{1F4BE} <b>Estado de Disco Ef\xEDmero y RAM (Autom\xE1tico)</b>

<blockquote>\u{1F4C1} <b>Ruta activa:</b> <code>${escapeHtml(diskStats.path)}</code>
\u2699\uFE0F <b>Tipo:</b> ${storageLabel}
\u{1F4BD} <b>Espacio libre:</b> ${formatBytes(diskStats.freeBytes)} / ${formatBytes(diskStats.totalBytes)} (${diskStats.usedPercent}% usado)
\u{1F9E0} <b>RAM proceso:</b> ${formatBytes(memStats.rssBytes)} (Heap ${formatBytes(memStats.heapUsedBytes)})
\u{1F504} <b>Pipeline:</b> 1 descarga + 1 subida simult\xE1nea</blockquote>`,
      msg.message_id
    );
    return;
  }
  if (text.startsWith("/reintentar") || text.startsWith("/retry")) {
    const failedJob = transferJobs.find(
      (j) => j.telegramChatId === chatId && (j.stage === "failed" || j.stage !== "completed" && j.stage !== "cancelled" && Boolean(j.minioKey))
    );
    if (failedJob) {
      if (failedJob.encoderRetryActive || failedJob.encoderRetryLastError && isPictaEncoderOrTransientServerError(
        failedJob.encoderRetryLastError,
        failedJob.pictaResponseCode
      )) {
        failedJob.encoderManualRetryTriggered = true;
      }
      failedJob.encoderRetryNextAt = 0;
      failedJob.stage = failedJob.minioKey ? "creating_picta_publication" : "generating_auto_title";
      failedJob.errorDetails = void 0;
      failedJob.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      saveJobsToDisk();
      await sendTelegramStatusMessage(
        chatId,
        `\u{1F504} <b>Reintentando publicaci\xF3n para:</b> ${escapeHtml(failedJob.title)}
<blockquote>\u{1F4C2} <b>Categor\xEDa:</b> ${escapeHtml(failedJob.category || "Audiovisual")}
\u{1F511} <b>Manifiesto S3:</b> <code>${failedJob.minioKey || "Por verificar"}</code></blockquote>
\u23F3 <i>${failedJob.minioKey ? "Reutilizando subida completa a S3 MinIO. Creando ficha en Picta..." : "Iniciando transferencia..."}</i>`,
        msg.message_id
      );
      await triggerCloudRunKeepAliveTransfer(
        failedJob.id,
        failedJob.title,
        failedJob.statusMessageId || null
      );
      return;
    } else {
      await sendTelegramStatusMessage(
        chatId,
        `\u2139\uFE0F No hay transferencias fallidas pendientes de reintento para este chat.`,
        msg.message_id
      );
      return;
    }
  }
  if (pendingChanEdit && (pendingChanEdit.mode === "nombre" || pendingChanEdit.mode === "alias" || pendingChanEdit.mode === "descripcion" || pendingChanEdit.mode === "clasificacion")) {
    pendingChannelEditByChat.delete(chatId);
    const fieldLabels = {
      nombre: "Nombre del canal",
      alias: "Lema / Alias del canal",
      descripcion: "Descripci\xF3n del canal",
      clasificacion: "Clasificaci\xF3n del canal"
    };
    const cleanVal = text.trim();
    try {
      await patchPictaChannelDetails(chatId, {
        [pendingChanEdit.mode]: cleanVal
      });
      await sendOrEditChannelEditorMenu(
        chatId,
        pendingChanEdit.messageId,
        msg.message_id,
        `\u2705 <b>\xA1${fieldLabels[pendingChanEdit.mode] || "Propiedad"} actualizado exitosamente en Picta!</b>`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await sendOrEditChannelEditorMenu(
        chatId,
        pendingChanEdit.messageId,
        msg.message_id,
        `\u26A0\uFE0F <b>Error al actualizar ${fieldLabels[pendingChanEdit.mode] || "canal"}:</b> <code>${escapeHtml(errMsg.slice(0, 120))}</code>`
      );
    }
    return;
  }
  const pendingToolkit = pendingToolkitInputByChat.get(chatId);
  if (pendingToolkit) {
    pendingToolkitInputByChat.delete(chatId);
    const cleanVal = text.trim();
    if (pendingToolkit.mode === "new_playlist_name") {
      try {
        const created = await createChannelPlaylistInPicta(chatId, cleanVal);
        await sendOrEditPlaylistsMenuInTelegram(
          chatId,
          pendingToolkit.messageId,
          msg.message_id,
          `\u2705 <b>\xA1Lista de reproducci\xF3n "${escapeHtml(created.nombre)}" (ID: <code>${created.id}</code>) creada en tu canal!</b>`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendOrEditPlaylistsMenuInTelegram(
          chatId,
          pendingToolkit.messageId,
          msg.message_id,
          `\u26A0\uFE0F <b>Error al crear lista:</b> <code>${escapeHtml(errMsg.slice(0, 130))}</code>`
        );
      }
      return;
    }
    if (pendingToolkit.mode === "add_collaborator_id") {
      if (!cleanVal) {
        await sendOrEditChannelCollaboratorsMenu(
          chatId,
          null,
          msg.message_id,
          `\u26A0\uFE0F <b>Ingresa el enlace del canal de tu socio, su @usuario o su ID num\xE9rico de Picta.</b>`
        );
        return;
      }
      try {
        const result = await modifyChannelCollaboratorInPicta(chatId, cleanVal, "add");
        const labelExtra = result.resolvedLabel ? ` (${escapeHtml(result.resolvedLabel)})` : "";
        await sendOrEditChannelCollaboratorsMenu(
          chatId,
          null,
          msg.message_id,
          `\u2705 <b>\xA1Usuario <code>#${result.targetUserId}</code>${labelExtra} a\xF1adido como colaborador del canal!</b>`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendOrEditChannelCollaboratorsMenu(
          chatId,
          null,
          msg.message_id,
          `\u26A0\uFE0F <b>No se pudo asociar el colaborador:</b> ${escapeHtml(errMsg.slice(0, 260))}`
        );
      }
      return;
    }
    if (pendingToolkit.mode === "reply_comment_text") {
      const pubId = Number(pendingToolkit.targetId || 0);
      const parentId = Number(pendingToolkit.secondaryId || 0);
      const prevView = lastCommentsViewByChat.get(chatId);
      const returnPubId = prevView ? prevView.pubId : pubId;
      try {
        await postPictaCommentInChannel(chatId, pubId, cleanVal, parentId);
        await sendOrEditCommentsMenuInTelegram(
          chatId,
          pendingToolkit.messageId,
          returnPubId > 0 ? returnPubId : void 0,
          msg.message_id,
          `\u2705 <b>\xA1Tu respuesta fue publicada exitosamente en Picta!</b>

<blockquote>\u{1F4AC} <i>"${escapeHtml(cleanVal.slice(0, 120))}"</i></blockquote>`,
          prevView ? { catKey: prevView.catKey, sort: prevView.sort, page: prevView.page, forceRefresh: true } : { forceRefresh: true }
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendOrEditCommentsMenuInTelegram(
          chatId,
          pendingToolkit.messageId,
          returnPubId > 0 ? returnPubId : void 0,
          msg.message_id,
          `\u26A0\uFE0F <b>No se pudo publicar el comentario en Picta:</b> <code>${escapeHtml(errMsg.slice(0, 150))}</code>`,
          prevView ? { catKey: prevView.catKey, sort: prevView.sort, page: prevView.page } : void 0
        );
      }
      return;
    }
    if (pendingToolkit.mode === "new_persona_name") {
      try {
        const persona = await searchOrCreatePictaPersonaInCatalog(chatId, cleanVal);
        await sendOrEditPersonasAndTagsMenuInTelegram(
          chatId,
          pendingToolkit.messageId,
          msg.message_id,
          `\u2705 <b>\xA1Persona "${escapeHtml(persona.nombre)}" ${persona.created ? "creada" : "encontrada"} en Picta (ID: <code>${persona.id}</code>)!</b>`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendOrEditPersonasAndTagsMenuInTelegram(
          chatId,
          pendingToolkit.messageId,
          msg.message_id,
          `\u26A0\uFE0F <b>Error con persona:</b> <code>${escapeHtml(errMsg.slice(0, 130))}</code>`
        );
      }
      return;
    }
    if (pendingToolkit.mode === "new_keyword_name") {
      try {
        const kw = await searchOrCreatePictaKeywordInCatalog(chatId, cleanVal);
        await sendOrEditPersonasAndTagsMenuInTelegram(
          chatId,
          pendingToolkit.messageId,
          msg.message_id,
          `\u2705 <b>\xA1Palabra clave "${escapeHtml(kw.palabra)}" ${kw.created ? "creada" : "encontrada"} en Picta (ID: <code>${kw.id}</code>)!</b>`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendOrEditPersonasAndTagsMenuInTelegram(
          chatId,
          pendingToolkit.messageId,
          msg.message_id,
          `\u26A0\uFE0F <b>Error con palabra clave:</b> <code>${escapeHtml(errMsg.slice(0, 130))}</code>`
        );
      }
      return;
    }
    if (pendingToolkit.mode === "switch_channel_query") {
      const session = userSessions.get(chatId);
      if (!session) {
        await sendTelegramStatusMessage(
          chatId,
          `\u26A0\uFE0F Debes iniciar sesi\xF3n con /login primero.`,
          msg.message_id
        );
        return;
      }
      const candidates = await findPictaChannel(cleanVal, session.authToken, chatId);
      if (candidates.length === 1) {
        const found = candidates[0];
        session.channelId = String(found.id);
        session.channelName = found.nombre;
        session.verifiedChannelOwnership = true;
        if (!session.availableChannels.some((x) => String(x.id) === String(found.id))) {
          session.availableChannels.push({ id: found.id, nombre: found.nombre, alias: found.alias });
        }
        saveUserSessionsToDisk();
        if (!pendingToolkit.messageId) {
          await sendTelegramStatusMessage(
            chatId,
            `\u2705 <b>\xA1CANAL VINCULADO CON \xC9XITO!</b>

<blockquote>\u{1F464} <b>Usuario Picta:</b> ${escapeHtml(session.userFullName || session.username)}
\u{1F4FA} <b>Canal Activo:</b> ${escapeHtml(found.nombre)} (<code>#${found.id}</code>)</blockquote>
\u{1F680} <b>\xA1Todo listo!</b> Ya puedes enviarme tu primer video directamente aqu\xED para subirlo a este canal.`,
            msg.message_id,
            [[{ text: "\u{1F3DB}\uFE0F Abrir Panel de Mi Canal", callback_data: "chan_editor:open" }]]
          );
          return;
        }
        await sendOrEditChannelEditorMenu(
          chatId,
          pendingToolkit.messageId,
          msg.message_id,
          `\u2705 <b>Canal vinculado con \xE9xito:</b> ${escapeHtml(found.nombre)} (<code>#${found.id}</code>)
Todos tus videos y publicaciones se subir\xE1n a este canal.`
        );
        return;
      } else if (candidates.length > 1) {
        const kb = candidates.slice(0, 5).map((c) => [
          {
            text: `\u{1F4FA} ${c.nombre} (#${c.id})`,
            callback_data: `chan_switch:select:${c.id}`
          }
        ]);
        kb.push([{ text: "\u2B05\uFE0F Cancelar", callback_data: "chan_editor:open" }]);
        const prompt = `\u{1F50D} <b>Se encontraron ${candidates.length} canales:</b>
Toca el bot\xF3n correspondiente a tu canal para vincularlo:

` + candidates.map((c) => `\u2022 <b>${escapeHtml(c.nombre)}</b> (<code>#${c.id}</code>)`).join("\n");
        if (pendingToolkit.messageId) {
          await editTelegramStatusMessage(chatId, pendingToolkit.messageId, prompt, kb, true);
        } else {
          await sendTelegramStatusMessage(chatId, prompt, msg.message_id, kb);
        }
        return;
      } else {
        if (!pendingToolkit.messageId && (!session.channelId || session.channelId === "0")) {
          pendingToolkitInputByChat.set(chatId, {
            mode: "switch_channel_query",
            messageId: null
          });
          await sendTelegramStatusMessage(
            chatId,
            `\u26A0\uFE0F No pude verificar un canal propio con "<code>${escapeHtml(cleanVal)}</code>".

\u{1F4CC} <b>Prueba pegar directamente el enlace completo</b> (ej: <code>https://www.picta.cu/canal/tu-canal</code>) o el <b>ID num\xE9rico</b> de tu canal aqu\xED mismo:`,
            msg.message_id,
            [
              [{ text: "\u{1F504} Reintentar Detecci\xF3n Autom\xE1tica", callback_data: "retry_auto_discover_channel" }],
              [{ text: "\u274C Cancelar", callback_data: "cmd_start" }]
            ]
          );
          return;
        }
        await sendOrEditChannelEditorMenu(
          chatId,
          pendingToolkit.messageId,
          msg.message_id,
          `\u26A0\uFE0F No se encontr\xF3 ning\xFAn canal con: "<code>${escapeHtml(cleanVal)}</code>".

\u{1F4A1} <i>Tip:</i> Puedes copiar el enlace de tu canal en Picta (ej: <code>/canal https://www.picta.cu/canal/tu-canal</code>) o ingresar su ID num\xE9rico.`
        );
        return;
      }
    }
    if (pendingToolkit.mode === "edit_milestone_thresholds") {
      const parsed = parseCustomMilestoneThresholds(cleanVal);
      if (!parsed.valid) {
        await sendOrEditAlertsMilestonesMenuInTelegram(
          chatId,
          pendingToolkit.messageId,
          msg.message_id,
          `\u26A0\uFE0F <b>${escapeHtml(parsed.error || "Valores inv\xE1lidos")}</b>`
        );
        return;
      }
      const prefs = getChatAlertPreferences(chatId);
      prefs.thresholds = parsed.thresholds;
      saveAlertsStateToDisk();
      await sendOrEditAlertsMilestonesMenuInTelegram(
        chatId,
        pendingToolkit.messageId,
        msg.message_id,
        `\u2705 <b>\xA1Metas progresivas actualizadas!</b>
<code>${parsed.thresholds.map(formatMilestoneNumber).join(" \xB7 ")}</code>`
      );
      return;
    }
    if (pendingToolkit.mode === "set_promo_requests_channel") {
      const parsed = parseTelegramChannelInput(cleanVal);
      if (!parsed.valid || !parsed.targetChannelId) {
        pendingToolkitInputByChat.set(chatId, pendingToolkit);
        await sendTelegramStatusMessage(
          chatId,
          `\u26A0\uFE0F <b>${escapeHtml(parsed.error || "Canal inv\xE1lido")}</b>`,
          msg.message_id
        );
        return;
      }
      let finalChannelId = parsed.targetChannelId;
      let finalLabel = parsed.displayLabel || finalChannelId;
      try {
        const chatMeta = await callTelegramBotApi("getChat", { chat_id: finalChannelId });
        if (chatMeta?.id) {
          finalChannelId = String(chatMeta.id);
          const uname = chatMeta.username ? `@${chatMeta.username}` : "";
          const title = String(chatMeta.title || uname || finalChannelId).trim();
          finalLabel = uname && title !== uname ? `${title} (${uname})` : title;
        }
      } catch {
      }
      const prevCfg = userPromoChannels.get(chatId);
      userPromoChannels.set(chatId, {
        chatId,
        targetChannelId: finalChannelId,
        targetChannelLabel: finalLabel,
        customPictaChannelUrl: prevCfg?.customPictaChannelUrl,
        autoSendToRequests: prevCfg?.autoSendToRequests,
        requestsGroupChatId: prevCfg?.requestsGroupChatId,
        requestsGroupLabel: prevCfg?.requestsGroupLabel,
        requestsMonitorMode: prevCfg?.requestsMonitorMode,
        disabled: false,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      saveUserPromoChannelsToDisk();
      const linkedPromo = pendingToolkit.promoId ? pendingMoviePromos.get(pendingToolkit.promoId) : void 0;
      if (linkedPromo && linkedPromo.ownerChatId === chatId) {
        const prompt = buildMoviePromoConfirmationPrompt(linkedPromo, chatId);
        await sendTelegramStatusMessage(
          chatId,
          `\u2705 <b>Canal de Pedidos guardado:</b> ${escapeHtml(finalLabel)} (<code>${escapeHtml(finalChannelId)}</code>)

${prompt.textHtml}`,
          msg.message_id,
          prompt.keyboard
        );
      } else {
        await sendOrEditPromoChannelMenuInTelegram(
          chatId,
          pendingToolkit.messageId,
          msg.message_id,
          `\u2705 <b>\xA1Canal de Pedidos guardado!</b> ${escapeHtml(finalLabel)} (<code>${escapeHtml(finalChannelId)}</code>)`
        );
      }
      return;
    }
    if (pendingToolkit.mode === "set_requests_group_chat") {
      const parsed = parseTelegramChannelInput(cleanVal);
      if (!parsed.valid || !parsed.targetChannelId) {
        pendingToolkitInputByChat.set(chatId, pendingToolkit);
        await sendTelegramStatusMessage(
          chatId,
          `\u26A0\uFE0F <b>${escapeHtml(parsed.error || "Grupo inv\xE1lido")}</b>`,
          msg.message_id
        );
        return;
      }
      let finalGroupId = parsed.targetChannelId;
      let finalGroupLabel = parsed.displayLabel || finalGroupId;
      try {
        const chatMeta = await callTelegramBotApi("getChat", { chat_id: finalGroupId });
        if (chatMeta?.id) {
          finalGroupId = String(chatMeta.id);
          const uname = chatMeta.username ? `@${chatMeta.username}` : "";
          const title = String(chatMeta.title || uname || finalGroupId).trim();
          finalGroupLabel = uname && title !== uname ? `${title} (${uname})` : title;
        }
      } catch {
      }
      const prevCfg = userPromoChannels.get(chatId);
      userPromoChannels.set(chatId, {
        chatId,
        targetChannelId: prevCfg?.targetChannelId || "",
        targetChannelLabel: prevCfg?.targetChannelLabel || "",
        customPictaChannelUrl: prevCfg?.customPictaChannelUrl,
        autoSendToRequests: prevCfg?.autoSendToRequests,
        requestsGroupChatId: finalGroupId,
        requestsGroupLabel: finalGroupLabel,
        requestsMonitorMode: prevCfg?.requestsMonitorMode && prevCfg.requestsMonitorMode !== "off" ? prevCfg.requestsMonitorMode : "prefix",
        disabled: prevCfg?.disabled ?? false,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      saveUserPromoChannelsToDisk();
      await sendOrEditPromoChannelMenuInTelegram(
        chatId,
        pendingToolkit.messageId,
        msg.message_id,
        `\u2705 <b>\xA1Grupo de Pedidos vinculado!</b> ${escapeHtml(finalGroupLabel)} (<code>${escapeHtml(finalGroupId)}</code>)`
      );
      return;
    }
    if (pendingToolkit.mode === "add_or_check_request") {
      const fwdFrom = msg.forward_origin?.sender_user || msg.forward_from;
      const requesterName = fwdFrom ? [fwdFrom.first_name, fwdFrom.last_name].filter(Boolean).join(" ") || fwdFrom.username || senderName : senderName;
      await processRequestQueryAndReplyOrSave({
        ownerChatId: chatId,
        replyChatId: chatId,
        replyToMessageId: msg.message_id,
        query: cleanVal,
        requesterName,
        requesterUsername: fwdFrom?.username || msg.from?.username,
        autoSaveIfMissing: false
      });
      return;
    }
  }
  if (pendingPubEdit && (pendingPubEdit.mode === "title" || pendingPubEdit.mode === "desc" || pendingPubEdit.mode === "epnum" || pendingPubEdit.mode === "tags")) {
    if (pendingPubEdit.mode === "tags") {
      pendingPubEditByChat.delete(chatId);
      try {
        const rawTags = text.split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean).slice(0, 8);
        if (rawTags.length === 0) throw new Error("Env\xEDa al menos una etiqueta v\xE1lida.");
        const keywordIds = [];
        const resolvedWords = [];
        for (const tag of rawTags) {
          const kw = await searchOrCreatePictaKeywordInCatalog(chatId, tag);
          if (kw.id > 0) {
            keywordIds.push(kw.id);
            resolvedWords.push(kw.palabra);
          }
        }
        const ctx = getEffectivePictaContext(chatId);
        const token = await ctx.accessTokenPromise;
        const form = new FormData();
        for (const kid of keywordIds) {
          form.append("palabra_clave", String(kid));
        }
        const res = await fetch(`https://api.picta.cu/v1/publicacion/${pendingPubEdit.pubId}/`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json"
          },
          body: form
        });
        if (!res.ok) {
          const errTxt = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${errTxt.slice(0, 120)}`);
        }
        await sendOrEditPictaPubDetailInTelegram(
          chatId,
          pendingPubEdit.messageId,
          pendingPubEdit.pubId,
          pendingPubEdit.returnSort,
          pendingPubEdit.returnPage,
          `\u2705 <b>\xA1Etiquetas actualizadas en Picta (${escapeHtml(resolvedWords.join(", "))})!</b>`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendOrEditPictaPubDetailInTelegram(
          chatId,
          pendingPubEdit.messageId,
          pendingPubEdit.pubId,
          pendingPubEdit.returnSort,
          pendingPubEdit.returnPage,
          `\u26A0\uFE0F <b>Error al actualizar etiquetas:</b> <code>${escapeHtml(errMsg.slice(0, 120))}</code>`
        );
      }
      return;
    }
    if (pendingPubEdit.mode === "epnum") {
      try {
        let newTempNum = 1;
        let newEpNum = 1;
        const foundCap = findUserChannelChapter(pendingPubEdit.pubId, chatId);
        const matchedSerie = foundCap?.serie;
        const matchedCap = foundCap?.chapter;
        if (matchedCap) {
          newTempNum = matchedCap.temporada || 1;
          newEpNum = matchedCap.numero || 1;
        }
        if (text.includes("|")) {
          const parts = text.split("|").map((p) => p.replace(/\D/g, "").trim()).filter(Boolean);
          if (parts.length >= 2) {
            newTempNum = Number(parts[0]) || 1;
            newEpNum = Number(parts[1]) || 1;
          } else if (parts.length === 1) {
            newEpNum = Number(parts[0]) || 1;
          }
        } else {
          const seMatch = text.match(/[sStT]?(\d{1,2})\s*[eExX.:-]\s*[eE]?(\d{1,3})/);
          if (seMatch) {
            newTempNum = Number(seMatch[1]) || 1;
            newEpNum = Number(seMatch[2]) || 1;
          } else {
            const singleNum = Number(text.replace(/\D/g, ""));
            if (singleNum > 0) {
              newEpNum = singleNum;
            }
          }
        }
        const ctx = getEffectivePictaContext(chatId);
        const serieName = cleanSerieDisplayName(matchedSerie?.nombre || "Serie");
        const oldTitle = matchedCap?.nombre || pendingPubEdit.pubTitle;
        const subMatch = oldTitle.match(/T\d+:E\d+\s*[-–]\s*(.+)$/i);
        const epSub = subMatch ? subMatch[1].trim() : "";
        const updatedTitle = formatSerieEpisodeTitle(serieName, newTempNum, newEpNum, epSub);
        const updatedDesc = sanitizePublicPictaText(
          `Cap\xEDtulo ${newEpNum} de la Temporada ${newTempNum} de la serie ${serieName}${epSub ? ` titulado "${epSub}"` : ""}, disponible en el canal ${ctx.channelName || "tu canal"}.`
        );
        const patchFields = {
          tipologia: "5",
          numero: String(newEpNum),
          nombre: updatedTitle,
          descripcion: updatedDesc
        };
        if (matchedSerie && ctx.isLinked && ctx.channelId) {
          const token = await ctx.accessTokenPromise;
          const resolvedTempId = await ensureSerieAndTemporadaId(
            token,
            serieName,
            newTempNum,
            { serie_pelser_id: String(matchedSerie.pelser_id) },
            Buffer.from(FALLBACK_JPEG_BASE64, "base64"),
            ctx.channelId,
            ctx.channelName,
            isMasterAdminChat(chatId)
          );
          if (resolvedTempId > 0) {
            patchFields.temporada = String(resolvedTempId);
          }
        }
        await patchPictaPublicationInChannel(pendingPubEdit.pubId, patchFields, void 0, chatId);
        if (matchedCap) {
          matchedCap.temporada = newTempNum;
          matchedCap.numero = newEpNum;
          matchedCap.nombre = updatedTitle;
          matchedCap.descripcion = updatedDesc;
          if (matchedSerie?.chapters) {
            matchedSerie.chapters.sort(
              (a, b) => a.temporada !== b.temporada ? a.temporada - b.temporada : a.numero - b.numero
            );
          }
          saveChannelSeriesToDisk(channelSeriesCache);
        }
        await sendOrEditPictaPubDetailInTelegram(
          chatId,
          pendingPubEdit.messageId,
          pendingPubEdit.pubId,
          pendingPubEdit.returnSort,
          pendingPubEdit.returnPage,
          `\u2705 <b>\xA1Cap\xEDtulo movido a T${newTempNum}:E${String(newEpNum).padStart(2, "0")} (${escapeHtml(updatedTitle)})!</b>`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendOrEditPictaPubDetailInTelegram(
          chatId,
          pendingPubEdit.messageId,
          pendingPubEdit.pubId,
          pendingPubEdit.returnSort,
          pendingPubEdit.returnPage,
          `\u26A0\uFE0F <b>Error al cambiar n\xFAmero de cap\xEDtulo:</b> <code>${escapeHtml(errMsg.slice(0, 120))}</code>`
        );
      }
      return;
    }
    const fieldName = pendingPubEdit.mode === "title" ? "nombre" : "descripcion";
    const label = pendingPubEdit.mode === "title" ? "T\xEDtulo" : "Descripci\xF3n";
    const cleanValue = sanitizePublicPictaText(text);
    try {
      await patchPictaPublicationInChannel(
        pendingPubEdit.pubId,
        {
          [fieldName]: cleanValue
        },
        void 0,
        chatId
      );
      const foundCap = findUserChannelChapter(pendingPubEdit.pubId, chatId);
      if (foundCap) {
        if (fieldName === "nombre") foundCap.chapter.nombre = cleanValue;
        if (fieldName === "descripcion") foundCap.chapter.descripcion = cleanValue;
        saveChannelSeriesToDisk(channelSeriesCache);
      }
      await sendOrEditPictaPubDetailInTelegram(
        chatId,
        pendingPubEdit.messageId,
        pendingPubEdit.pubId,
        pendingPubEdit.returnSort,
        pendingPubEdit.returnPage,
        `\u2705 <b>\xA1${label} actualizado directamente en Picta!</b>`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await sendOrEditPictaPubDetailInTelegram(
        chatId,
        pendingPubEdit.messageId,
        pendingPubEdit.pubId,
        pendingPubEdit.returnSort,
        pendingPubEdit.returnPage,
        `\u26A0\uFE0F <b>Error al actualizar ${label}:</b> <code>${escapeHtml(errMsg.slice(0, 120))}</code>`
      );
    }
    return;
  }
  const pendingStandalone = pendingStandaloneSerieByChat.get(chatId);
  if (pendingStandalone) {
    if (pendingStandalone.mode === "new_serie_name") {
      pendingStandaloneSerieByChat.delete(chatId);
      try {
        const created = await createSerieInPictaChannelDirect(chatId, text.trim(), 1);
        await sendOrEditMyChannelSeriesMenu(
          chatId,
          pendingStandalone.messageId,
          msg.message_id,
          `\u2705 <b>\xA1Serie "${escapeHtml(created.serieName)}" (ID: <code>${created.pelserId}</code>) y Temporada 1 creadas en tu canal!</b>`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendOrEditMyChannelSeriesMenu(
          chatId,
          pendingStandalone.messageId,
          msg.message_id,
          `\u26A0\uFE0F <b>Error al crear la serie en Picta:</b> <code>${escapeHtml(errMsg.slice(0, 140))}</code>`
        );
      }
      return;
    }
    if ((pendingStandalone.mode === "edit_serie_name" || pendingStandalone.mode === "edit_serie_synopsis") && pendingStandalone.pelserId) {
      pendingStandaloneSerieByChat.delete(chatId);
      const isName = pendingStandalone.mode === "edit_serie_name";
      const cleanVal = sanitizePublicPictaText(text.trim());
      try {
        await patchSerieInPictaChannel(chatId, pendingStandalone.pelserId, {
          ...isName ? { nombre: cleanVal } : { sinopsis: cleanVal }
        });
        await sendOrEditSerieDetailInTelegram(
          chatId,
          pendingStandalone.messageId,
          pendingStandalone.pelserId,
          0,
          `\u2705 <b>\xA1${isName ? "Nombre" : "Sinopsis"} de la serie actualizado en Picta!</b>`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendOrEditSerieDetailInTelegram(
          chatId,
          pendingStandalone.messageId,
          pendingStandalone.pelserId,
          0,
          `\u26A0\uFE0F <b>Error al editar serie:</b> <code>${escapeHtml(errMsg.slice(0, 120))}</code>`
        );
      }
      return;
    }
  }
  if (activeWizardJob) {
    if (activeWizardJob.stage === "awaiting_series_selection" || activeWizardJob.stage === "awaiting_new_series_name") {
      const newSerieName = text.trim();
      const seasonNum = Number(activeWizardJob.modelMetadata?.temporada || 1) || 1;
      const ctx = getEffectivePictaContext(chatId);
      const chTag = ctx.channelId ? `${ctx.channelName} (#${ctx.channelId})` : ctx.channelName;
      try {
        const created = await createSerieInPictaChannelDirect(
          chatId,
          newSerieName,
          seasonNum,
          activeWizardJob.customCoverFileId || activeWizardJob.thumbnailFileId
        );
        activeWizardJob.modelMetadata = {
          ...activeWizardJob.modelMetadata || {},
          serie: created.serieName,
          serie_pelser_id: String(created.pelserId),
          temporada: String(created.seasonNum),
          temporada_id: String(created.tempId)
        };
        saveJobsToDisk();
        await promptSeasonSelectionForJob(
          activeWizardJob,
          chatId,
          activeWizardJob.statusMessageId || null,
          created.pelserId,
          created.serieName,
          `\u2705 <b>\xA1Serie "${escapeHtml(created.serieName)}" creada en tu canal ${escapeHtml(chTag)}!</b>`
        );
      } catch {
        activeWizardJob.modelMetadata = {
          ...activeWizardJob.modelMetadata || {},
          serie: newSerieName
        };
        saveJobsToDisk();
        await promptSeasonSelectionForJob(
          activeWizardJob,
          chatId,
          activeWizardJob.statusMessageId || null,
          0,
          newSerieName
        );
      }
      return;
    }
    if (activeWizardJob.stage === "awaiting_season_selection") {
      const existingMeta = activeWizardJob.modelMetadata || {};
      const serieName = String(existingMeta.serie || "Serie");
      const epSub = String(existingMeta.episodeSubtitle || "").trim();
      let tempNum = String(existingMeta.temporada || "1");
      let epNum = String(existingMeta.numero || "1");
      if (text.includes("|")) {
        const parts = text.split("|").map((p) => p.replace(/\D/g, "").trim()).filter(Boolean);
        if (parts.length >= 2) {
          tempNum = parts[0];
          epNum = parts[1];
        } else if (parts.length === 1) {
          epNum = parts[0];
        }
      } else {
        const seMatch = text.match(/[sS]?(\d{1,2})\s*[eExX.:-]\s*(\d{1,3})/);
        if (seMatch) {
          tempNum = String(Number(seMatch[1]));
          epNum = String(Number(seMatch[2]));
        } else {
          const singleNum = text.replace(/\D/g, "");
          if (singleNum) {
            epNum = singleNum;
          }
        }
      }
      activeWizardJob.modelMetadata = {
        ...existingMeta,
        temporada: tempNum,
        numero: epNum
      };
      activeWizardJob.title = formatSerieEpisodeTitle(serieName, tempNum, epNum, epSub);
      saveJobsToDisk();
      await promptStep1Title(activeWizardJob, chatId, activeWizardJob.statusMessageId || null);
      return;
    }
    if (activeWizardJob.stage === "awaiting_step_title" || activeWizardJob.stage === "awaiting_manual_title" || activeWizardJob.stage === "awaiting_title_choice") {
      const isAskingForAuto = /^(saltar|auto|autom[aá]tico|dejar|ok|si|s[ií])$/i.test(text);
      const missingRealTitleOnJob = activeWizardJob.modelMetadata?.needsManualTitle === "true" || !activeWizardJob.title || isRandomOrCrypticFilename(activeWizardJob.title);
      if (isAskingForAuto && missingRealTitleOnJob) {
        await sendTelegramStatusMessage(
          chatId,
          `\u26A0\uFE0F <b>Falta el t\xEDtulo real:</b> El archivo <code>${escapeHtml(activeWizardJob.fileName)}</code> tiene un nombre aleatorio.
\u270D\uFE0F Escribe el nombre de la pel\xEDcula/serie/video para continuar:`,
          msg.message_id
        );
        return;
      }
      if (!isAskingForAuto) {
        if (activeWizardJob.modelMetadata?.needsManualTitle) {
          delete activeWizardJob.modelMetadata.needsManualTitle;
        }
        if (activeWizardJob.tipologiaId === 5) {
          const existingMeta = activeWizardJob.modelMetadata || {};
          const existingSerieStr = String(existingMeta.serie || "");
          const parsedCandidate = parseSingleSeriesCandidate(text);
          const fromFile = extractSeriesInfoFromText(activeWizardJob.fileName, activeWizardJob.caption);
          const serieName = String(
            !isGenericOrInvalidSerieName(existingSerieStr) ? existingSerieStr : !isGenericOrInvalidSerieName(parsedCandidate.serieName) ? parsedCandidate.serieName : !fromFile.missingSerieName ? fromFile.serieName : text.trim()
          );
          const seasonNum = String(
            parsedCandidate.hasExplicitNumbers ? parsedCandidate.temporada : existingMeta.temporada || fromFile.temporada || "1"
          );
          const epNum = String(
            parsedCandidate.hasExplicitNumbers ? parsedCandidate.numero : existingMeta.numero || fromFile.numero || "1"
          );
          const epSub = String(
            parsedCandidate.episodeSubtitle || (!parsedCandidate.hasExplicitNumbers && text.trim().toLowerCase() !== serieName.toLowerCase() ? text.trim() : existingMeta.episodeSubtitle || fromFile.episodeSubtitle || "")
          ).trim();
          const pelserId = Number(existingMeta.serie_pelser_id || 0);
          const inheritedStyle = resolveSeriesStyleForChannel(chatId, pelserId, serieName);
          activeWizardJob.modelMetadata = {
            ...existingMeta,
            serie: serieName,
            temporada: seasonNum,
            numero: epNum,
            ...epSub ? { episodeSubtitle: epSub } : {}
          };
          const isBareEpCodeOnly = /^(?:[sS]\d{1,2}\s*[eE]\d{1,3}|[tT]\d{1,2}\s*[:\-]?\s*[eE]\d{1,3}|\d{1,2}\s*[|xX]\s*\d{1,3}|\d{1,3})$/.test(
            text.trim()
          );
          activeWizardJob.title = isBareEpCodeOnly ? inheritedStyle ? formatEpisodeWithSeriesStyle(inheritedStyle, {
            serieName,
            temporada: seasonNum,
            numero: epNum,
            episodeSubtitle: epSub
          }) : formatSerieEpisodeTitle(serieName, seasonNum, epNum, epSub) : text.trim();
        } else {
          const parsed = parseUserManualMetadata(text, activeWizardJob.tipologiaId || 8);
          activeWizardJob.title = parsed.title || text.trim();
          if (parsed.synopsis) {
            activeWizardJob.synopsis = parsed.synopsis;
          }
          if (Object.keys(parsed.meta).length > 0) {
            activeWizardJob.modelMetadata = {
              ...activeWizardJob.modelMetadata || {},
              ...parsed.meta
            };
          }
        }
      }
      activeWizardJob.titleMode = "manual";
      saveJobsToDisk();
      await proceedFromStep1ToStep2WithDuplicateCheck(
        activeWizardJob,
        chatId,
        activeWizardJob.statusMessageId || null
      );
      return;
    }
    if (activeWizardJob.stage === "awaiting_step_synopsis") {
      const isAskingForAuto = /^(saltar|auto|autom[aá]tico|ia|no)$/i.test(text);
      if (!isAskingForAuto) {
        activeWizardJob.synopsis = text.trim();
      }
      saveJobsToDisk();
      await promptStep3Cover(
        activeWizardJob,
        chatId,
        activeWizardJob.statusMessageId || null
      );
      return;
    }
    if (activeWizardJob.stage === "awaiting_step_cover") {
      await promptStep4Subtitles(
        activeWizardJob,
        chatId,
        activeWizardJob.statusMessageId || null
      );
      return;
    }
    if (activeWizardJob.stage === "awaiting_step_subtitles") {
      await finalizeGuidedStepsAndStart(
        activeWizardJob,
        chatId,
        activeWizardJob.statusMessageId || null
      );
      return;
    }
  }
  if (text && !text.startsWith("/")) {
    const handledAsLink = await handleIncomingLinkOrUrlIngestion(
      chatId,
      msg.message_id,
      senderName,
      text
    );
    if (handledAsLink) return;
  }
}
var pollingActive = false;
var pollingLoopGeneration = 0;
async function startPollingBridge() {
  if (externalCloudRunWebhookActive || pollingActive) return;
  pollingActive = true;
  const myGeneration = ++pollingLoopGeneration;
  addLiveLog(
    "telegram",
    "info",
    "Receptor \xFAnico de Telegram activo con deduplicaci\xF3n en /tmp/picta_bot_state."
  );
  while (pollingActive && myGeneration === pollingLoopGeneration && !externalCloudRunWebhookActive) {
    try {
      const updates = await callTelegramBotApi("getUpdates", {
        offset: lastUpdateOffset,
        timeout: 15,
        allowed_updates: ["message", "edited_message", "channel_post", "callback_query"]
      });
      if (Array.isArray(updates) && updates.length > 0) {
        for (const upd of updates) {
          const nextOffset = Number(upd.update_id) + 1;
          if (nextOffset > lastUpdateOffset) {
            lastUpdateOffset = nextOffset;
            saveProcessedUpdatesToDisk();
          }
          await handleTelegramUpdate(upd);
        }
      }
    } catch {
      await new Promise((r) => setTimeout(r, 2e3));
    }
  }
}
async function initTelegramListener() {
  try {
    await ensureCloudStateLoadedOnce();
    const me = await callTelegramBotApi("getMe");
    botProfile = {
      id: me.id,
      username: me.username || "Picta2bot",
      firstName: me.first_name || "Pictaupload"
    };
    addLiveLog(
      "telegram",
      "success",
      `Bot verificado en Telegram: @${botProfile.username} (ID: ${botProfile.id})`
    );
    const hookInfo = await callTelegramBotApi("getWebhookInfo");
    const currentHookUrl = String(hookInfo.url || "").trim();
    if (!IS_PREVIEW_INSTANCE) {
      void callTelegramBotApi("setMyCommands", {
        commands: [
          {
            command: "buscar",
            description: "\u{1F50E} Buscar si una pel\xEDcula, serie o video ya existe en Picta"
          },
          {
            command: "canal",
            description: "\u{1F3DB}\uFE0F Editar mi Canal de Picta (Nombre, Lema, Avatar, Portada)"
          },
          {
            command: "series",
            description: "\u{1F4FA} Series de mi Canal y \u{1F4CC} Modo Serie Fija (R\xE1faga)"
          },
          {
            command: "cola",
            description: "\u{1F4CB} Ver Cola de Espera, Modo R\xE1faga y Cancelar Subidas"
          },
          {
            command: "cuota",
            description: "\u26A1 Dividir Cuota Diaria (10/d\xEDa) y Pool Multi-Cuenta (+10/cuenta)"
          },
          {
            command: "stats",
            description: "\u{1F4CA} Dashboard de Picta y Edici\xF3n de Videos Publicados"
          },
          {
            command: "auditoria",
            description: "\u{1FA7A} Auditar duplicados internos, faltantes y salud de tu canal"
          },
          {
            command: "pedidos",
            description: "\u{1F4E5} Gestor de pedidos y verificador r\xE1pido en Picta"
          },
          {
            command: "canalpedidos",
            description: "\u{1F4E2} Configurar Canal/Grupo de Pedidos y auto-verificador"
          },
          {
            command: "logros",
            description: "\u{1F3C6} Alertas de Comentarios y Metas de Reproducciones/Likes"
          },
          {
            command: "cuenta",
            description: "\u{1F6E1}\uFE0F Estado y permisos Jefe de canal de tu cuenta Picta"
          },
          {
            command: "menu",
            description: "\u{1F7E2} Men\xFA principal y estado del bot"
          },
          {
            command: "reintentar",
            description: "\u{1F504} Reintentar \xFAltima publicaci\xF3n pendiente"
          }
        ]
      }).catch(() => {
      });
      const baseWebhookDomain = detectCloudRunUrl();
      const targetUrl = baseWebhookDomain ? `${baseWebhookDomain}/api/telegram/webhook` : "";
      const isPlaceholderUrl = !baseWebhookDomain || targetUrl.includes("placeholder.ai.studio") || targetUrl.includes("untitled-3150.ai.studio");
      const isPublicHttps = Boolean(baseWebhookDomain) && process.env.TELEGRAM_MODE === "webhook" && targetUrl.startsWith("https://") && !targetUrl.includes("localhost") && !targetUrl.includes("ais-dev-") && !isPlaceholderUrl;
      if (isPublicHttps) {
        pollingActive = false;
        externalCloudRunWebhookActive = false;
        await callTelegramBotApi("setWebhook", {
          url: targetUrl,
          allowed_updates: ["message", "edited_message", "channel_post", "callback_query"],
          drop_pending_updates: false
        });
        webhookRegistered = true;
        botConfig.webhookUrl = targetUrl;
        lastWebhookError = null;
      } else {
        if (currentHookUrl) {
          await callTelegramBotApi("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
        }
        webhookRegistered = false;
        externalCloudRunWebhookActive = false;
        void startPollingBridge();
      }
    } else {
      pollingActive = false;
      externalCloudRunWebhookActive = true;
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addLiveLog("telegram", "error", `Error iniciando Telegram: ${msg}`);
  }
  if (!externalCloudRunWebhookActive) {
    await ensureMtprotoClient();
  }
}
async function startServer() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.get("/api/cloudrun-keepalive", async (req, res) => {
    const isBusy = () => Boolean(activeDownloadJobId || activeUploadJobId || activeJobId);
    if (req.query.hold === "1" && isBusy()) {
      const holdStart = Date.now();
      while (isBusy() && Date.now() - holdStart < 25e3) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    res.status(200).send("OK");
  });
  app.post("/api/telegram/webhook", async (req, res) => {
    try {
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      if (host && !String(host).includes("localhost") && !String(host).includes("127.0.0.1") && !String(host).includes("ais-dev-")) {
        const proto = req.headers["x-forwarded-proto"] || "https";
        dynamicDetectedPublicUrl = `${proto}://${host}`;
      }
      await handleTelegramUpdate(req.body);
      res.status(200).json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLiveLog("telegram", "error", `Error procesando webhook de Telegram: ${msg}`);
      res.status(200).json({ ok: true, error: msg });
    }
  });
  app.post("/api/internal/run-transfer", async (req, res) => {
    const { jobId, customTitle, callbackMessageId } = req.body || {};
    const job = transferJobs.find((j) => j.id === jobId);
    if (!job) {
      res.status(404).json({ ok: false });
      return;
    }
    if (runningJobIds.has(job.id)) {
      res.status(200).json({ ok: true, skippedDuplicate: true });
      return;
    }
    try {
      if (callbackMessageId) {
        job.statusMessageId = Number(callbackMessageId);
      }
      await prepareJobMetadataBeforeTransfer(job, customTitle ? String(customTitle) : void 0);
      cancelledJobIds.delete(job.id);
      if (!uploadQueue.includes(job.id)) {
        uploadQueue.push(job.id);
      }
      job.stage = "queued";
      job.errorDetails = void 0;
      job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      saveJobsToDisk();
      void scheduleTransferPipeline();
      res.status(200).json({ ok: true, queued: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLiveLog("system", "error", `Error en worker interno: ${msg}`);
      res.status(200).json({ ok: false, error: msg });
    }
  });
  app.post("/api/republish-job/:id", async (req, res) => {
    const jobId = req.params.id;
    const job = transferJobs.find((j) => j.id === jobId);
    if (!job) {
      res.status(404).json({ ok: false, error: "Trabajo no encontrado" });
      return;
    }
    if (runningJobIds.has(job.id)) {
      res.status(400).json({ ok: false, error: "El trabajo ya se est\xE1 procesando actualmente" });
      return;
    }
    try {
      job.stage = job.minioKey ? "creating_picta_publication" : "generating_auto_title";
      job.errorDetails = void 0;
      job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      saveJobsToDisk();
      addLiveLog(
        "picta",
        "info",
        `Reintentando publicaci\xF3n para "${job.title}" (${job.category || "Audiovisual"}, S3 key: ${job.minioKey || "Por generar"}).`
      );
      void triggerCloudRunKeepAliveTransfer(job.id, job.title, job.statusMessageId || null);
      res.status(200).json({ ok: true, job });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: msg });
    }
  });
  app.delete("/api/jobs/:id", (req, res) => {
    const jobId = String(req.params.id || "").trim();
    const idx = transferJobs.findIndex((j) => j.id === jobId);
    if (idx === -1) {
      res.status(404).json({ ok: false, error: "Trabajo no encontrado" });
      return;
    }
    if (runningJobIds.has(jobId)) {
      res.status(400).json({ ok: false, error: "No se puede eliminar un trabajo en ejecuci\xF3n activa" });
      return;
    }
    const [removed] = transferJobs.splice(idx, 1);
    const qIdx = uploadQueue.indexOf(jobId);
    if (qIdx !== -1) {
      uploadQueue.splice(qIdx, 1);
    }
    if (removed?.tempFilePath && fs3.existsSync(removed.tempFilePath)) {
      try {
        fs3.unlinkSync(removed.tempFilePath);
      } catch {
      }
    }
    saveJobsToDisk();
    addLiveLog("system", "info", `Registro eliminado del historial: "${removed?.title || jobId}"`);
    res.status(200).json({ ok: true, removedId: jobId });
  });
  app.post("/api/jobs/clear-failed", (_req, res) => {
    let removedCount = 0;
    const kept = [];
    for (const j of transferJobs) {
      if (j.stage === "failed" && !runningJobIds.has(j.id)) {
        const qIdx = uploadQueue.indexOf(j.id);
        if (qIdx !== -1) uploadQueue.splice(qIdx, 1);
        if (j.tempFilePath && fs3.existsSync(j.tempFilePath)) {
          try {
            fs3.unlinkSync(j.tempFilePath);
          } catch {
          }
        }
        removedCount++;
      } else {
        kept.push(j);
      }
    }
    transferJobs = kept;
    saveJobsToDisk();
    if (removedCount > 0) {
      addLiveLog("system", "info", `Historial limpiado: ${removedCount} trabajo(s) fallido(s) descartado(s).`);
    }
    res.status(200).json({ ok: true, removedCount });
  });
  app.get("/api/picta/toolkit/overview", async (_req, res) => {
    try {
      const chatId = MASTER_ADMIN_CHAT_ID;
      const [chanDetails, collabs, playlists, commentsAndDenuncias, channelPubs] = await Promise.all(
        [
          fetchPictaChannelDetails(chatId).catch(() => null),
          fetchChannelCollaboratorsInPicta(chatId).catch(() => ({
            ownerId: 212033,
            ownerUsername: "Ghosthell",
            associatedIds: []
          })),
          fetchChannelPlaylistsInPicta(chatId).catch(() => []),
          fetchChannelCommentsAndDenunciasInPicta(chatId).catch(() => ({
            comments: [],
            denuncias: {
              cantidad_pendientes: 0,
              cantidad_en_proceso: 0,
              cantidad_no_proceden: 0,
              cantidad_procesadas: 0,
              total: 0
            }
          })),
          fetchPictaChannelPublications(chatId).catch(() => [])
        ]
      );
      ensureDailyQuotaReset();
      const associatedIds = collabs.collaborators ? collabs.collaborators.map((c) => c.id) : [212033, 994913];
      const ownerUsernames = [
        "ownerUsername" in collabs ? collabs.ownerUsername : "Ghosthell",
        userSessions.get(chatId)?.username || ""
      ].filter(Boolean);
      syncPictaCommentsToChannelRequests(chatId, commentsAndDenuncias.comments, ownerUsernames);
      const enrichedComments = commentsAndDenuncias.comments.map((cm) => {
        const authorLower = String(cm.usuario || "").trim().toLowerCase();
        const isOwnerAuthor = ownerUsernames.some((u) => u.toLowerCase() === authorLower);
        const det = !isOwnerAuthor ? extractMediaRequestFromPictaComment(cm.texto, cm.publicacionNombre) : { matched: false, title: "", reason: "" };
        const linkedReq = channelMediaRequests.find(
          (r) => r.ownerChatId === chatId && r.commentId === cm.id
        );
        return {
          ...cm,
          ...det.matched ? {
            detectedRequestTitle: det.title,
            detectedRequestReason: det.reason
          } : {},
          ...linkedReq ? { linkedRequestId: linkedReq.id, linkedRequestStatus: linkedReq.status } : {}
        };
      });
      const ownerRequests = channelMediaRequests.filter(
        (r) => r.ownerChatId === chatId && r.status !== "dismissed"
      );
      res.json({
        ok: true,
        channel: chanDetails,
        collaborators: {
          ownerId: collabs.ownerId || 212033,
          ownerUsername: "Ghosthell",
          associatedIds,
          poolAccounts: quotaSettings.poolAccounts.map((acc, idx) => ({
            id: String(acc.userId || idx + 1),
            phone: acc.username,
            username: acc.displayName || acc.fullName || acc.username,
            channelId: "36319",
            channelName: "Multiverso Visual",
            uploadedToday: acc.uploadedToday || acc.usedToday || 0
          }))
        },
        playlists: playlists.map((pl) => ({
          id: pl.id,
          nombre: pl.nombre,
          canalId: pl.canalId,
          canalNombre: pl.canalNombre,
          cantidadPublicaciones: (pl.publicacionesIds || []).length
        })),
        comments: enrichedComments,
        requests: ownerRequests,
        denuncias: commentsAndDenuncias.denuncias,
        series: filterSeriesForChannel(
          channelSeriesCache,
          botConfig.pictaChannelId || "36319",
          true,
          botConfig.pictaChannelId || "36319"
        ),
        publications: channelPubs.slice(0, 40),
        quota: {
          seriesDailyTarget: quotaSettings.maxSeriesPerDay,
          otherDailyTarget: Math.max(0, 10 - quotaSettings.maxSeriesPerDay),
          seriesUploadedToday: quotaSettings.seriesUploadedToday,
          otherUploadedToday: quotaSettings.otherUploadedToday,
          poolCount: quotaSettings.poolAccounts.length
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: msg });
    }
  });
  app.post("/api/picta/toolkit/action", async (req, res) => {
    try {
      const chatId = MASTER_ADMIN_CHAT_ID;
      const body = req.body || {};
      const action = String(body.action || "").trim();
      if (action === "update_channel") {
        const fields = {};
        if (typeof body.nombre === "string" && body.nombre.trim())
          fields.nombre = body.nombre.trim();
        if (typeof body.alias === "string") fields.alias = body.alias.trim();
        if (typeof body.descripcion === "string") fields.descripcion = body.descripcion.trim();
        if (typeof body.clasificacion === "string" && body.clasificacion.trim())
          fields.clasificacion = body.clasificacion.trim();
        if (typeof body.visible === "boolean") fields.visible = String(body.visible);
        if (typeof body.recibir_donacion === "boolean")
          fields.recibir_donacion = String(body.recibir_donacion);
        await patchPictaChannelDetails(chatId, fields);
        res.json({ ok: true, message: "Canal actualizado exitosamente en Picta." });
        return;
      }
      if (action === "add_collaborator" || action === "remove_collaborator") {
        const rawTarget = String(body.targetIdentifier ?? body.targetUserId ?? "").trim();
        if (!rawTarget) {
          res.status(400).json({ ok: false, error: "Ingresa el ID, usuario o enlace del canal." });
          return;
        }
        const result = await modifyChannelCollaboratorInPicta(
          chatId,
          rawTarget,
          action === "add_collaborator" ? "add" : "remove"
        );
        res.json({
          ok: true,
          associatedIds: result.collaborators.map((c) => c.id),
          targetUserId: result.targetUserId,
          message: action === "add_collaborator" ? `Usuario #${result.targetUserId}${result.resolvedLabel ? ` (${result.resolvedLabel})` : ""} asociado al canal.` : `Usuario #${result.targetUserId} desvinculado del canal.`
        });
        return;
      }
      if (action === "create_playlist") {
        const nombre = String(body.nombre || "").trim();
        const created = await createChannelPlaylistInPicta(chatId, nombre);
        res.json({
          ok: true,
          playlist: created,
          message: `Lista "${created.nombre}" creada (#${created.id}).`
        });
        return;
      }
      if (action === "delete_playlist") {
        const playlistId = Number(body.playlistId || 0);
        await deleteChannelPlaylistInPicta(chatId, playlistId);
        res.json({ ok: true, message: `Lista #${playlistId} eliminada.` });
        return;
      }
      if (action === "add_pub_to_playlist") {
        const playlistId = Number(body.playlistId || 0);
        const pubId = Number(body.pubId || 0);
        await addPublicationToPlaylistInPicta(chatId, playlistId, pubId);
        res.json({
          ok: true,
          message: `Video #${pubId} a\xF1adido a la lista #${playlistId}.`
        });
        return;
      }
      if (action === "post_comment") {
        const pubId = Number(body.pubId || 0);
        const texto = String(body.texto || "").trim();
        const parentCommentId = body.parentCommentId ? Number(body.parentCommentId) : void 0;
        await postPictaCommentInChannel(chatId, pubId, texto, parentCommentId);
        res.json({ ok: true, message: "Comentario publicado en Picta." });
        return;
      }
      if (action === "delete_comment") {
        const commentId = Number(body.commentId || 0);
        await deletePictaCommentInChannel(chatId, commentId);
        res.json({ ok: true, message: `Comentario #${commentId} eliminado.` });
        return;
      }
      if (action === "update_serie") {
        const pelserId = Number(body.pelserId || 0);
        const nombre = typeof body.nombre === "string" ? body.nombre.trim() : void 0;
        const sinopsis = typeof body.sinopsis === "string" ? body.sinopsis.trim() : void 0;
        await patchSerieInPictaChannel(chatId, pelserId, { nombre, sinopsis });
        res.json({ ok: true, message: `Serie #${pelserId} actualizada en Picta.` });
        return;
      }
      if (action === "delete_serie") {
        const pelserId = Number(body.pelserId || 0);
        await deleteSerieInPictaChannel(chatId, pelserId);
        res.json({ ok: true, message: `Serie #${pelserId} eliminada de Picta.` });
        return;
      }
      if (action === "toggle_pub_download") {
        const pubId = Number(body.pubId || 0);
        const descargas = Boolean(body.descargas);
        await patchPictaPublicationInChannel(
          pubId,
          { descargas: String(descargas) },
          void 0,
          chatId
        );
        res.json({
          ok: true,
          message: `Descarga directa ${descargas ? "habilitada" : "deshabilitada"} para el video #${pubId}.`
        });
        return;
      }
      if (action === "toggle_pub_visibility") {
        const pubId = Number(body.pubId || 0);
        const publicado = Boolean(body.publicado);
        await patchPictaPublicationInChannel(
          pubId,
          { publicado: String(publicado) },
          void 0,
          chatId
        );
        res.json({
          ok: true,
          message: `Visibilidad del video #${pubId} cambiada a ${publicado ? "P\xFAblico" : "Oculto"}.`
        });
        return;
      }
      if (action === "create_persona") {
        const nombre = String(body.nombre || "").trim();
        const persona = await searchOrCreatePictaPersonaInCatalog(chatId, nombre);
        res.json({
          ok: true,
          persona,
          message: `Persona "${persona.nombre}" ${persona.created ? "creada" : "encontrada"} en Picta (#${persona.id}).`
        });
        return;
      }
      if (action === "create_keyword") {
        const palabra = String(body.palabra || "").trim();
        const keyword = await searchOrCreatePictaKeywordInCatalog(chatId, palabra);
        res.json({
          ok: true,
          keyword,
          message: `Palabra clave "${keyword.palabra}" ${keyword.created ? "creada" : "encontrada"} en Picta (#${keyword.id}).`
        });
        return;
      }
      if (action === "scan_comment_requests") {
        const { comments } = await fetchChannelCommentsAndDenunciasInPicta(
          chatId,
          void 0,
          true
        );
        const ownerUname = userSessions.get(chatId)?.username || "Ghosthell";
        const syncRes = syncPictaCommentsToChannelRequests(chatId, comments, [
          "Ghosthell",
          ownerUname
        ]);
        res.json({
          ok: true,
          added: syncRes.added,
          requests: syncRes.requests.filter((r) => r.status !== "dismissed"),
          message: syncRes.added > 0 ? `Escaneo completado: ${syncRes.added} nuevo(s) pedido(s) detectado(s) en comentarios.` : `Escaneo completado: no se encontraron nuevos pedidos sin registrar.`
        });
        return;
      }
      if (action === "check_or_add_request") {
        const query = String(body.query || "").trim();
        const saveAnyway = Boolean(body.saveAnyway);
        const requesterName = String(body.requesterName || "Admin Web").trim() || "Admin Web";
        if (!query || query.length < 2) {
          res.status(400).json({ ok: false, error: "Escribe el t\xEDtulo que deseas verificar o a\xF1adir." });
          return;
        }
        const searchRes = await searchGlobalPictaCatalog(query, {
          chatId,
          maxEnrich: 3,
          minScore: 0.65
        }).catch(() => ({ queryUsed: query, hits: [] }));
        const matches = searchRes.hits.slice(0, 3);
        let savedRequest = null;
        if (matches.length === 0 || saveAnyway) {
          const norm = normalizeRequestTitle(query);
          const dup = channelMediaRequests.find(
            (r) => r.ownerChatId === chatId && r.status === "pending" && r.normalizedTitle === norm
          );
          if (dup) {
            savedRequest = dup;
          } else {
            savedRequest = {
              id: `rq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
              ownerChatId: chatId,
              requestedTitle: query,
              normalizedTitle: norm,
              requestedByName: requesterName,
              sourceType: "manual",
              status: "pending",
              createdAt: (/* @__PURE__ */ new Date()).toISOString()
            };
            channelMediaRequests.unshift(savedRequest);
            saveChannelMediaRequestsToDisk();
          }
        }
        res.json({
          ok: true,
          query,
          matches,
          savedRequest,
          requests: channelMediaRequests.filter(
            (r) => r.ownerChatId === chatId && r.status !== "dismissed"
          ),
          message: matches.length > 0 && !saveAnyway ? `Se encontraron ${matches.length} coincidencia(s) ya publicadas en Picta.` : savedRequest ? `Pedido "${savedRequest.requestedTitle}" guardado en Pendientes.` : "Consulta completada."
        });
        return;
      }
      if (action === "verify_request") {
        const requestId = String(body.requestId || "").trim();
        const target = channelMediaRequests.find(
          (r) => r.id === requestId && r.ownerChatId === chatId
        );
        const query = String(body.query || target?.requestedTitle || "").trim();
        if (!query) {
          res.status(400).json({ ok: false, error: "Pedido o t\xEDtulo no especificado." });
          return;
        }
        const searchRes = await searchGlobalPictaCatalog(query, {
          chatId,
          maxEnrich: 3,
          minScore: 0.65
        }).catch(() => ({ queryUsed: query, hits: [] }));
        res.json({
          ok: true,
          requestId,
          query,
          matches: searchRes.hits.slice(0, 3),
          message: searchRes.hits.length > 0 ? `Encontradas ${Math.min(3, searchRes.hits.length)} coincidencia(s) en Picta.` : `"${query}" no aparece publicado todav\xEDa en Picta.`
        });
        return;
      }
      if (action === "import_comment_request") {
        const commentId = Number(body.commentId || 0);
        const pubId = Number(body.pubId || 0);
        const pubNombre = String(body.pubNombre || "").trim();
        const usuario = String(body.usuario || "Suscriptor Picta").trim();
        const rawText = String(body.texto || "").trim();
        const customTitle = String(body.customTitle || "").trim();
        const extracted = extractMediaRequestFromPictaComment(rawText, pubNombre);
        const requestedTitle = (customTitle || extracted.title || rawText).trim().slice(0, 100);
        if (!requestedTitle || requestedTitle.length < 2) {
          res.status(400).json({ ok: false, error: "No se pudo extraer un t\xEDtulo v\xE1lido del comentario." });
          return;
        }
        if (commentId > 0) {
          ignoredRequestCommentIds.delete(commentId);
        }
        const norm = normalizeRequestTitle(requestedTitle);
        const existing = channelMediaRequests.find(
          (r) => r.ownerChatId === chatId && (commentId > 0 && r.commentId === commentId || r.status === "pending" && r.normalizedTitle === norm)
        );
        if (!existing) {
          channelMediaRequests.unshift({
            id: commentId > 0 ? `rq_cm_${commentId}` : `rq_${Date.now().toString(36)}`,
            ownerChatId: chatId,
            requestedTitle,
            normalizedTitle: norm,
            requestedByName: usuario.startsWith("@") ? usuario : `@${usuario}`,
            requestedByUsername: usuario.replace(/^@/, ""),
            sourceType: "picta_comment",
            ...commentId > 0 ? { commentId } : {},
            ...pubId > 0 ? { commentPublicationId: pubId } : {},
            ...pubNombre ? { commentPublicationTitle: pubNombre } : {},
            status: "pending",
            createdAt: (/* @__PURE__ */ new Date()).toISOString()
          });
          saveChannelMediaRequestsToDisk();
        }
        res.json({
          ok: true,
          requests: channelMediaRequests.filter(
            (r) => r.ownerChatId === chatId && r.status !== "dismissed"
          ),
          message: existing ? `El pedido "${requestedTitle}" ya estaba en tu lista.` : `Comentario a\xF1adido a Pedidos Pendientes: "${requestedTitle}".`
        });
        return;
      }
      if (action === "fulfill_request") {
        const requestId = String(body.requestId || "").trim();
        const target = channelMediaRequests.find(
          (r) => r.id === requestId && r.ownerChatId === chatId
        );
        if (!target) {
          res.status(404).json({ ok: false, error: "Pedido no encontrado." });
          return;
        }
        target.status = "fulfilled";
        target.fulfilledAt = (/* @__PURE__ */ new Date()).toISOString();
        if (body.matchedPictaPubId) target.matchedPictaPubId = Number(body.matchedPictaPubId);
        if (typeof body.matchedPictaUrl === "string" && body.matchedPictaUrl.trim()) {
          target.matchedPictaUrl = body.matchedPictaUrl.trim();
        }
        saveChannelMediaRequestsToDisk();
        const replyCommentText = typeof body.replyCommentText === "string" ? body.replyCommentText.trim() : "";
        if (replyCommentText && target.commentPublicationId && target.commentId) {
          await postPictaCommentInChannel(
            chatId,
            target.commentPublicationId,
            replyCommentText,
            target.commentId
          );
        }
        res.json({
          ok: true,
          requests: channelMediaRequests.filter(
            (r) => r.ownerChatId === chatId && r.status !== "dismissed"
          ),
          message: replyCommentText ? `Pedido "${target.requestedTitle}" cumplido y comentario respondido en Picta.` : `Pedido "${target.requestedTitle}" marcado como cumplido.`
        });
        return;
      }
      if (action === "reopen_request") {
        const requestId = String(body.requestId || "").trim();
        const target = channelMediaRequests.find(
          (r) => r.id === requestId && r.ownerChatId === chatId
        );
        if (!target) {
          res.status(404).json({ ok: false, error: "Pedido no encontrado." });
          return;
        }
        target.status = "pending";
        target.fulfilledAt = void 0;
        saveChannelMediaRequestsToDisk();
        res.json({
          ok: true,
          requests: channelMediaRequests.filter(
            (r) => r.ownerChatId === chatId && r.status !== "dismissed"
          ),
          message: `Pedido "${target.requestedTitle}" reabierto como pendiente.`
        });
        return;
      }
      if (action === "delete_request") {
        const requestId = String(body.requestId || "").trim();
        const target = channelMediaRequests.find(
          (r) => r.id === requestId && r.ownerChatId === chatId
        );
        if (target?.commentId) {
          ignoredRequestCommentIds.add(target.commentId);
        }
        channelMediaRequests = channelMediaRequests.filter(
          (r) => !(r.id === requestId && r.ownerChatId === chatId)
        );
        saveChannelMediaRequestsToDisk();
        res.json({
          ok: true,
          requests: channelMediaRequests.filter(
            (r) => r.ownerChatId === chatId && r.status !== "dismissed"
          ),
          message: "Pedido eliminado de la lista."
        });
        return;
      }
      res.status(400).json({ ok: false, error: `Acci\xF3n desconocida: ${action}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: msg });
    }
  });
  let cachedDiskStats = null;
  let cachedDiskStatsAt = 0;
  app.get(["/healthz", "/api/health"], (_req, res) => {
    res.status(200).json({ ok: true, uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1e3) });
  });
  app.get("/api/live-state", (_req, res) => {
    const nowMs = Date.now();
    const now24h = nowMs - 24 * 60 * 60 * 1e3;
    let completedUploads = 0;
    let activeTransfers = 0;
    let failedTransfers = 0;
    let totalBytesTransferred = 0;
    let completed24h = 0;
    let failed24h = 0;
    let totalDurationSec24h = 0;
    let durationCount24h = 0;
    for (const j of transferJobs) {
      const createdMs = j.createdAt ? new Date(j.createdAt).getTime() : NaN;
      const in24h = !isNaN(createdMs) && createdMs >= now24h;
      if (j.stage === "completed") {
        completedUploads++;
        totalBytesTransferred += j.diskVerifiedBytes || j.expectedBytes || 0;
        if (in24h) {
          completed24h++;
          if (j.updatedAt) {
            const endMs = new Date(j.updatedAt).getTime();
            const diff = Math.max(1, Math.round((endMs - createdMs) / 1e3));
            if (!isNaN(diff)) {
              totalDurationSec24h += diff;
              durationCount24h++;
            }
          }
        }
      } else if (j.stage === "failed") {
        failedTransfers++;
        if (in24h) failed24h++;
      } else {
        activeTransfers++;
      }
    }
    const total24h = completed24h + failed24h;
    const successRate24h = total24h > 0 ? Math.round(completed24h / total24h * 100) : 100;
    const avgProcessingTimeSeconds24h = durationCount24h > 0 ? Math.round(totalDurationSec24h / durationCount24h) : 0;
    if (!cachedDiskStats || nowMs - cachedDiskStatsAt > 5e3) {
      cachedDiskStats = getScratchDiskStats(TMP_UPLOAD_DIR);
      cachedDiskStatsAt = nowMs;
    }
    const diskStats = cachedDiskStats;
    const memStats = getMemoryTelemetry();
    const state = {
      isPreviewInstance: externalCloudRunWebhookActive,
      instanceRole: externalCloudRunWebhookActive ? "preview_passive_monitor" : "cloud_run_active_bot",
      cloudRunAppUrl: detectCloudRunUrl(),
      webhookRegistered,
      webhookUrl: botConfig.webhookUrl,
      webhookPendingUpdates,
      lastWebhookError,
      lastWakeUpAt,
      botProfile,
      mtprotoReady: true,
      mtprotoConnected,
      maxDownloadLimitMB: TELEGRAM_MTPROTO_MAX_FILE_MB,
      pictaConfigured: Boolean(pictaUser || botConfig.pictaAuthToken.trim()),
      pictaUser,
      pictaChannels,
      currentActivity,
      activeJobId,
      activeDownloadJobId,
      activeUploadJobId,
      uptimeSeconds: Math.floor((nowMs - START_TIME) / 1e3),
      systemMetrics: {
        scratchDir: diskStats.path,
        isEphemeralVolume: diskStats.isEphemeralVolume,
        storageType: diskStats.storageType,
        diskTotalBytes: diskStats.totalBytes,
        diskFreeBytes: diskStats.freeBytes,
        diskUsedPercent: diskStats.usedPercent,
        rssBytes: memStats.rssBytes,
        heapUsedBytes: memStats.heapUsedBytes
      },
      stats: {
        totalReceived: transferJobs.length,
        completedUploads,
        activeTransfers,
        failedTransfers,
        totalBytesTransferred,
        successRate24h,
        completed24h,
        failed24h,
        total24h,
        avgProcessingTimeSeconds24h
      },
      jobs: transferJobs,
      logs: liveLogs.slice(0, 120),
      mtprotoLogs: mtprotoDiagLogs.slice(0, 80),
      pendingRequestsCount: channelMediaRequests.filter(
        (r) => r.ownerChatId === MASTER_ADMIN_CHAT_ID && r.status === "pending"
      ).length
    };
    res.json(state);
  });
  app.get("/api/mtproto-logs", (_req, res) => {
    res.json({ ok: true, logs: mtprotoDiagLogs.slice(0, 150) });
  });
  app.get(["/", "/health"], (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "pictabot-headless",
      uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1e3),
      mode: webhookRegistered ? "webhook" : "polling",
      botUsername: botProfile?.username || null,
      pollingActive,
      webhookActive: webhookRegistered,
      mtprotoConnected,
      geminiConfigured: Boolean(resolveGeminiApiKey()),
      queueActive: uploadQueue.length,
      memoryRssMb: Math.round(process.memoryUsage().rss / (1024 * 1024))
    });
  });
  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    const bootDiskStats = getScratchDiskStats(TMP_UPLOAD_DIR);
    console.log(
      `PictaBot Cloud Run Server listening on http://0.0.0.0:${PORT} (Scratch: ${TMP_UPLOAD_DIR}, Tipo: ${bootDiskStats.storageType}, Libre: ${formatBytes(bootDiskStats.freeBytes)}/${formatBytes(bootDiskStats.totalBytes)})`
    );
    addLiveLog(
      "system",
      "info",
      `Disco ef\xEDmero auto-configurado: ${TMP_UPLOAD_DIR} (${bootDiskStats.storageType === "ephemeral_disk" ? "Disco real" : "Temporal"} \xB7 ${formatBytes(bootDiskStats.freeBytes)} libres de ${formatBytes(bootDiskStats.totalBytes)}).`
    );
    const startupRemoved = cleanupOrphanedScratchFiles(
      TMP_UPLOAD_DIR,
      getProtectedScratchPaths(),
      30 * 60 * 1e3
    );
    if (startupRemoved > 0) {
      addLiveLog(
        "system",
        "info",
        `Limpieza inicial de disco scratch (${TMP_UPLOAD_DIR}): ${startupRemoved} archivo(s) hu\xE9rfano(s) eliminado(s).`
      );
    }
    const scratchCleanupInterval = setInterval(() => {
      try {
        const cleaned = cleanupOrphanedScratchFiles(
          TMP_UPLOAD_DIR,
          getProtectedScratchPaths(),
          2 * 60 * 60 * 1e3
        );
        if (cleaned > 0) {
          addLiveLog(
            "system",
            "info",
            `Limpieza peri\xF3dica scratch: ${cleaned} archivo(s) antiguo(s) eliminado(s).`
          );
        }
      } catch {
      }
    }, 30 * 60 * 1e3);
    if (typeof scratchCleanupInterval.unref === "function") {
      scratchCleanupInterval.unref();
    }
    const encoderRetryInterval = setInterval(() => {
      try {
        if (externalCloudRunWebhookActive || activeUploadJobId) return;
        const hasDueEncoderRetry = uploadQueue.some((qId) => {
          const j = transferJobs.find((x) => x.id === qId);
          return j && isEncoderJobDueForRetry(j);
        });
        if (hasDueEncoderRetry) {
          void scheduleTransferPipeline();
        }
      } catch {
      }
    }, 20 * 1e3);
    if (typeof encoderRetryInterval.unref === "function") {
      encoderRetryInterval.unref();
    }
    const alertsBaselineTimer = setTimeout(() => {
      if (!externalCloudRunWebhookActive) {
        void scanAllPictaAlertsAndMilestones();
      }
    }, 12 * 1e3);
    if (typeof alertsBaselineTimer.unref === "function") {
      alertsBaselineTimer.unref();
    }
    const pictaAlertsInterval = setInterval(() => {
      if (externalCloudRunWebhookActive) return;
      void scanAllPictaAlertsAndMilestones();
    }, 65 * 1e3);
    if (typeof pictaAlertsInterval.unref === "function") {
      pictaAlertsInterval.unref();
    }
    void authenticateWithPicta(true).catch((err) => {
      addLiveLog("picta", "warn", `Aviso en login inicial Picta: ${err.message}`);
    });
    void initTelegramListener().then(() => {
      for (const j of transferJobs) {
        if (j.synopsis) {
          j.synopsis = sanitizePublicPictaText(j.synopsis);
        }
        if (j.telegramChatId === MASTER_ADMIN_CHAT_ID && !j.targetChannelId) {
          j.targetChannelId = botConfig.pictaChannelId || "36319";
          j.targetChannelName = "Multiverso Visual";
        }
      }
      let reQueuedCount = 0;
      for (const j of transferJobs) {
        const isResumable = j.stage === "queued" || j.stage === "generating_auto_title" || j.stage === "downloading_mtproto" || j.stage === "verifying_integrity" || j.stage === "uploading_full_file_to_picta" || j.stage === "creating_picta_publication" || j.stage === "failed" && String(j.errorDetails || "").includes("503");
        if (isResumable) {
          if (j.stage !== "queued") {
            j.stage = "queued";
          }
          if (j.errorDetails && !j.encoderRetryActive && !j.errorDetails.includes("QUOTA_") && !isDailyLimitErrorText(j.errorDetails)) {
            j.errorDetails = void 0;
          }
          if (j.encoderRetryActive && Number(j.encoderRetryNextAt || 0) <= Date.now()) {
            j.encoderRetryNextAt = Date.now() + 5e3;
          }
          if (!uploadQueue.includes(j.id)) {
            uploadQueue.push(j.id);
            reQueuedCount++;
          }
        }
      }
      saveJobsToDisk();
      if (reQueuedCount > 0 || uploadQueue.length > 0 && !externalCloudRunWebhookActive) {
        addLiveLog(
          "system",
          "info",
          `Pipeline reanudado al iniciar: ${uploadQueue.length} trabajo(s) en cola.`
        );
        if (!externalCloudRunWebhookActive) {
          void scheduleTransferPipeline();
        }
      }
    });
  });
  httpServer.keepAliveTimeout = 65e3;
  httpServer.headersTimeout = 66e3;
  let shuttingDown = false;
  const handleGracefulShutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Shutdown] Se\xF1al ${signal} recibida. Guardando estado antes de salir...`);
    pollingActive = false;
    keepAliveActive = false;
    try {
      flushProcessedUpdatesToDiskNow();
      saveJobsToDisk();
      saveUserSessionsToDisk();
      saveQuotaSettingsToDisk();
      saveAuthorizedUsersToDisk();
      savePinnedSeriesToDisk();
      if (!IS_PREVIEW_INSTANCE) {
        await Promise.race([
          saveCloudStateToTelegramNow(),
          new Promise((r) => setTimeout(r, 3500))
        ]).catch(() => {
        });
      }
      await disconnectAuxiliaryBotClients(false);
      if (mtprotoClient) {
        await Promise.race([
          mtprotoClient.disconnect(),
          new Promise((r) => setTimeout(r, 1500))
        ]).catch(() => {
        });
      }
    } catch {
    } finally {
      httpServer.close(() => {
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 1e3).unref();
    }
  };
  process.once("SIGTERM", () => {
    void handleGracefulShutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void handleGracefulShutdown("SIGINT");
  });
}
void startServer();
