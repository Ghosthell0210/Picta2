import { GoogleGenAI, Type } from '@google/genai';
import { spawn } from 'child_process';
import fs from 'fs';
import type { TmdbEnrichedCandidate } from '../shared/types.ts';
import { loadProjectEnv } from './envLoader.ts';
import { netlog } from './netlog.ts';

const ALLOWED_IMAGE_HOSTS = new Set([
  'image.tmdb.org',
  'api.picta.cu',
  'videos.picta.cu',
  'www.picta.cu',
  'picta.cu',
  's3.picta.cu',
  'admin.picta.cu',
]);

const VALID_TIPOLOGIA_IDS = new Set([1, 2, 3, 5, 6, 8, 11, 14, 15, 17, 18, 19]);

// Bounded TTL cache for TMDB searches (50 entries, 15 minutes)
const TMDB_CACHE_MAX = 50;
const TMDB_CACHE_TTL_MS = 15 * 60 * 1000;
const tmdbCache = new Map<string, { expiresAt: number; items: TmdbEnrichedCandidate[] }>();

let sharedGeminiClient: GoogleGenAI | null = null;
let sharedGeminiKeyFingerprint = '';
let lastGeminiErrorMessage = '';

function cleanEnvSecret(raw?: string): string {
  const trimmed = String(raw || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function resolveGeminiApiKey(): string {
  let key = cleanEnvSecret(process.env.GEMINI_API_KEY) || cleanEnvSecret(process.env.GOOGLE_API_KEY);
  if (!key) {
    loadProjectEnv();
    key = cleanEnvSecret(process.env.GEMINI_API_KEY) || cleanEnvSecret(process.env.GOOGLE_API_KEY);
  }
  return key;
}

function resolveGeminiModel(): string {
  return cleanEnvSecret(process.env.GEMINI_MODEL) || 'gemini-4-hydrogen';
}

function formatGeminiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || 'Error desconocido');
  // Never leak any API key token in error text
  const sanitized = raw.replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[API_KEY]').slice(0, 260);
  if (/API_KEY_INVALID|API key not valid/i.test(sanitized)) {
    return 'Clave GEMINI_API_KEY inválida o rechazada por Google AI (400 API_KEY_INVALID).';
  }
  if (/PERMISSION_DENIED|403/i.test(sanitized)) {
    return 'Permiso denegado por Gemini API (403 PERMISSION_DENIED). Verifica permisos/región de la clave.';
  }
  if (/RESOURCE_EXHAUSTED|429/i.test(sanitized)) {
    return 'Cuota de Gemini API agotada temporalmente (429 RESOURCE_EXHAUSTED).';
  }
  if (/NOT_FOUND|404/i.test(sanitized)) {
    return `Modelo Gemini no encontrado (${resolveGeminiModel()} · 404 NOT_FOUND).`;
  }
  return sanitized;
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    lastGeminiErrorMessage = 'GEMINI_API_KEY no encontrada en .env ni en las variables de entorno.';
    return null;
  }
  if (!sharedGeminiClient || sharedGeminiKeyFingerprint !== apiKey) {
    sharedGeminiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    sharedGeminiKeyFingerprint = apiKey;
  }
  return sharedGeminiClient;
}

export function isGeminiConfigured(): boolean {
  return Boolean(resolveGeminiApiKey());
}

export function getLastGeminiError(): string {
  return lastGeminiErrorMessage;
}

export function normalizeCmp(str: string): string {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanGeneralVideoTitle(rawName: string): string {
  return String(rawName || '')
    .replace(/\.(mp4|mkv|avi|mov|webm|flv|wmv|ts|m4v|part\d*|rar|zip|7z)$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(
      /\((?:1080p|720p|480p|2160p|4k|hd|bluray|web-?dl|webrip|hdrip|dvdrip|x264|x265|hevc|aac|latino|español|espanol|subtitulado|dual|castellano)\)/gi,
      ' '
    )
    .replace(
      /\b(?:1080p|720p|480p|2160p|4k|uhd|hdr|bluray|bdrip|brrip|web-?dl|webrip|hdrip|dvdrip|camrip|x264|x265|h264|h265|hevc|aac|ac3|dts|latino|castellano|subtitulado|dual|vose|mp4|mkv)\b/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .replace(/^[-:|_\s]+|[-:|_\s]+$/g, '')
    .trim();
}

export function cleanMediaTitleForSearch(rawQuery: string): {
  cleanQuery: string;
  simplifiedTitle: string;
  franchise?: string;
  subtitleQuery?: string;
  year?: string;
} {
  let raw = String(rawQuery || '').trim();
  const yearMatch = raw.match(/\b(19\d\d|20\d\d)\b/);
  const year = yearMatch ? yearMatch[1] : undefined;
  raw = cleanGeneralVideoTitle(raw)
    .replace(/\bS\d{1,2}E\d{1,3}\b/gi, ' ')
    .replace(/\b\d{1,2}x\d{1,3}\b/gi, ' ')
    .replace(/\bT\d{1,2}\s*Cap\.?\s*\d{1,3}\b/gi, ' ')
    .replace(/\b(?:temporada|season|cap[íi]tulo|episodio|episode|ep|cap)\s*\d+\b/gi, ' ');
  if (year) {
    raw = raw.replace(new RegExp(`\\(?\\b${year}\\b\\)?`, 'g'), ' ');
  }
  const cleanQuery = raw.replace(/\s+/g, ' ').replace(/[-:|\s]+$/g, '').trim();
  let subtitleQuery: string | undefined;
  let franchise: string | undefined;
  let simplifiedTitle = cleanQuery;
  const colonSplit = cleanQuery.split(/[:\-–—]/);
  if (colonSplit.length >= 2 && colonSplit[0].trim().length >= 3) {
    simplifiedTitle = colonSplit[0].trim();
    franchise = simplifiedTitle;
    const rest = colonSplit.slice(1).join(' ').trim();
    if (rest.length >= 3) subtitleQuery = rest;
  }
  return {
    cleanQuery,
    simplifiedTitle,
    ...(franchise ? { franchise } : {}),
    ...(subtitleQuery ? { subtitleQuery } : {}),
    ...(year ? { year } : {}),
  };
}

export function isRandomOrCrypticFilename(name: string): boolean {
  const clean = cleanGeneralVideoTitle(String(name || '')).replace(/\s+/g, '');
  if (!clean || clean.length < 2) return true;
  if (/^(?:vid|video|mov|img|doc|file|wa|tg|telegram|document|clip)[_-]?\d{4,}$/i.test(clean)) return true;
  if (/^[0-9a-f]{12,}$/i.test(clean)) return true;
  if (/^\d{6,}$/.test(clean)) return true;
  const digits = (clean.match(/\d/g) || []).length;
  const letters = (clean.match(/[a-zA-ZáéíóúñÁÉÍÓÚÑ]/g) || []).length;
  if (letters < 2) return true;
  return clean.length >= 10 && digits / clean.length > 0.72;
}

export function isGenericOrInvalidSerieName(name: string): boolean {
  const clean = String(name || '').trim().toLowerCase();
  if (!clean || clean.length < 2) return true;
  const generics = new Set([
    'serie', 'series', 'nueva serie', 'video', 'capitulo', 'capítulo', 'episodio',
    'temporada', 'desconocido', 'pendiente', 'sin nombre', 'untitled', 'document', 'file', 'archivo',
  ]);
  if (generics.has(clean)) return true;
  return /^(?:cap(?:itulo|[ií]tulo)?|ep(?:isodio)?|temp(?:orada)?|s\d+|t\d+|\d+)$/i.test(clean);
}

export interface ParsedSeriesInfo {
  serieName: string;
  temporada: string;
  numero: string;
  episodeSubtitle?: string;
  missingSerieName: boolean;
  hasExplicitNumbers: boolean;
}

function parseSingleSeriesCandidate(rawText: string) {
  const text = cleanGeneralVideoTitle(rawText);
  let temporada = '1';
  let numero = '1';
  let hasExplicitNumbers = false;
  let serieName = text;
  let episodeSubtitle: string | undefined;

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
    serieName = (chosen[1] || '').replace(/[-·:|_\s]+$/g, '').trim();
    temporada = String(Number(chosen[2] || 1));
    numero = String(Number(chosen[3] || 1));
    const tail = (chosen[4] || '').replace(/^[-·:|_\s]+/, '').trim();
    if (tail && !isRandomOrCrypticFilename(tail)) episodeSubtitle = tail;
  } else if (capOnlyMatch) {
    hasExplicitNumbers = true;
    serieName = (capOnlyMatch[1] || '').replace(/[-·:|_\s]+$/g, '').trim();
    temporada = '1';
    numero = String(Number(capOnlyMatch[2] || 1));
    const tail = (capOnlyMatch[3] || '').replace(/^[-·:|_\s]+/, '').trim();
    if (tail && !isRandomOrCrypticFilename(tail)) episodeSubtitle = tail;
  }

  return { hasExplicitNumbers, serieName, temporada, numero, episodeSubtitle };
}

export function analyzeVideoTitleAndSynopsis(fileName: string, caption?: string): {
  initialTitle: string;
  initialSynopsis: string;
  filenameIsRandom: boolean;
  needsManualTitle: boolean;
  suggestedTipologia: number;
  seriesInfo: ParsedSeriesInfo;
} {
  const capLines = String(caption || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let capTitle = '';
  let capSynopsis = '';
  if (capLines.length === 1) {
    if (capLines[0].length > 90) capSynopsis = capLines[0];
    else capTitle = cleanGeneralVideoTitle(capLines[0]);
  } else if (capLines.length > 1) {
    capTitle = cleanGeneralVideoTitle(capLines[0]);
    capSynopsis = capLines.slice(1).join(' ').trim();
  }

  const fromCap = capLines[0] ? parseSingleSeriesCandidate(capLines[0]) : null;
  const fromFile = parseSingleSeriesCandidate(fileName);
  const chosenSerieName =
    (fromCap && !isGenericOrInvalidSerieName(fromCap.serieName) ? fromCap.serieName : '') ||
    (!isGenericOrInvalidSerieName(fromFile.serieName) ? fromFile.serieName : '');
  const hasExplicitNumbers = Boolean(fromCap?.hasExplicitNumbers || fromFile.hasExplicitNumbers);
  const temporada = fromCap?.hasExplicitNumbers ? fromCap.temporada : fromFile.hasExplicitNumbers ? fromFile.temporada : '1';
  const numero = fromCap?.hasExplicitNumbers ? fromCap.numero : fromFile.hasExplicitNumbers ? fromFile.numero : '1';
  const episodeSubtitle = fromCap?.episodeSubtitle || fromFile.episodeSubtitle;

  const seriesInfo: ParsedSeriesInfo = {
    serieName: chosenSerieName || 'Serie',
    temporada,
    numero,
    ...(episodeSubtitle ? { episodeSubtitle } : {}),
    missingSerieName: isGenericOrInvalidSerieName(chosenSerieName),
    hasExplicitNumbers,
  };

  const cleanFileTitle = cleanGeneralVideoTitle(fileName);
  const filenameIsRandom = isRandomOrCrypticFilename(fileName);
  const hasCaptionTitle = Boolean(capTitle && !isRandomOrCrypticFilename(capTitle));

  let initialTitle = '';
  if (hasExplicitNumbers && !seriesInfo.missingSerieName) {
    initialTitle = `${seriesInfo.serieName} T${seriesInfo.temporada} Cap. ${seriesInfo.numero}${episodeSubtitle ? ` · ${episodeSubtitle}` : ''}`;
  } else if (hasCaptionTitle) {
    initialTitle = capTitle;
  } else if (!filenameIsRandom && cleanFileTitle) {
    initialTitle = cleanFileTitle;
  }

  const needsManualTitle = !initialTitle;
  if (!initialTitle) initialTitle = fileName.replace(/\.[^.]+$/, '') || 'Video sin título';

  const suggestedTipologia = hasExplicitNumbers ? 5 : /\b(19\d\d|20\d\d)\b/.test(fileName) ? 1 : 8;

  return {
    initialTitle,
    initialSynopsis: capSynopsis,
    filenameIsRandom,
    needsManualTitle,
    suggestedTipologia,
    seriesInfo,
  };
}

export function buildSerieTitleOptions(serieName: string, temporada = '1', numero = '1', episodeSubtitle?: string) {
  const cleanName = String(serieName || 'Serie').trim() || 'Serie';
  const temp = Number(String(temporada).replace(/\D/g, '') || 1);
  const ep = Number(String(numero).replace(/\D/g, '') || 1);
  const sub = String(episodeSubtitle || '').trim();
  const tempPad = String(temp).padStart(2, '0');
  const epPad = String(ep).padStart(2, '0');

  return [
    `${cleanName} T${temp} Cap. ${ep}${sub ? ` · ${sub}` : ''}`,
    `${cleanName} S${tempPad}E${epPad}${sub ? ` · ${sub}` : ''}`,
    `${cleanName} · Temporada ${temp} Capítulo ${ep}`,
  ];
}

export function scoreCandidateMatch(
  cleanQuery: string,
  candidateTitle: string,
  originalTitle = '',
  candidateYear?: string,
  targetYear?: string,
  popularity = 0
): number {
  const nq = normalizeCmp(cleanQuery);
  const nt = normalizeCmp(candidateTitle);
  const no = normalizeCmp(originalTitle);
  if (!nq || (!nt && !no)) return 0;

  let best = 0;
  for (const target of [nt, no].filter(Boolean)) {
    if (target === nq) best = Math.max(best, 95);
    else if (target.startsWith(nq) || nq.startsWith(target)) best = Math.max(best, 76);
    else {
      const qWords = nq.split(' ').filter((w) => w.length > 1);
      const tWords = target.split(' ').filter((w) => w.length > 1);
      if (qWords.length > 0 && tWords.length > 0) {
        const hits = qWords.filter((w) => tWords.includes(w)).length;
        best = Math.max(best, Math.round((hits / Math.max(qWords.length, tWords.length)) * 70));
      }
    }
  }
  if (targetYear && candidateYear) {
    best += String(targetYear) === String(candidateYear) ? 15 : -10;
  }
  if (popularity > 0) {
    best += Math.min(8, Math.log10(popularity + 1) * 2.5);
  }
  return Math.max(0, Math.round(best));
}

export async function searchTmdbRichCandidates(rawQuery: string): Promise<TmdbEnrichedCandidate[]> {
  const apiKey = (process.env.TMDB_API_KEY || '').trim();
  if (!apiKey || !rawQuery.trim()) return [];
  const parsed = cleanMediaTitleForSearch(rawQuery);
  const queryText = parsed.cleanQuery || rawQuery.trim();
  const cacheKey = `${normalizeCmp(queryText)}::${parsed.year || ''}`;

  const now = Date.now();
  const cached = tmdbCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.items;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = new URL('https://api.themoviedb.org/3/search/multi');
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('language', 'es-ES');
    url.searchParams.set('query', queryText);

    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) return [];

    const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const items = Array.isArray(json.results) ? json.results : [];

    const candidates: TmdbEnrichedCandidate[] = items
      .filter((item) => item.media_type === 'movie' || item.media_type === 'tv')
      .map((item) => {
        const mediaType: 'movie' | 'tv' = item.media_type === 'tv' ? 'tv' : 'movie';
        const title = String(item.title || item.name || 'Sin título').trim();
        const originalTitle = String(item.original_title || item.original_name || '').trim();
        const dateStr = String(item.release_date || item.first_air_date || '');
        const year = dateStr ? dateStr.slice(0, 4) : undefined;
        const posterPath = typeof item.poster_path === 'string' ? item.poster_path : '';
        const backdropPath = typeof item.backdrop_path === 'string' ? item.backdrop_path : '';
        const popularity = typeof item.popularity === 'number' ? item.popularity : 0;
        const score = scoreCandidateMatch(queryText, title, originalTitle, year, parsed.year, popularity);

        return {
          id: Number(item.id || 0),
          title,
          originalTitle: originalTitle || undefined,
          mediaType,
          year,
          overview: String(item.overview || '').trim(),
          posterUrl: posterPath ? `https://image.tmdb.org/t/p/w780${posterPath}` : undefined,
          backdropUrl: backdropPath ? `https://image.tmdb.org/t/p/w1280${backdropPath}` : undefined,
          voteAverage: typeof item.vote_average === 'number' ? Number(item.vote_average.toFixed(1)) : undefined,
          popularity,
          score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    if (tmdbCache.size >= TMDB_CACHE_MAX) {
      const oldestKey = tmdbCache.keys().next().value;
      if (oldestKey) tmdbCache.delete(oldestKey);
    }
    tmdbCache.set(cacheKey, { expiresAt: now + TMDB_CACHE_TTL_MS, items: candidates });
    return candidates;
  } catch (err) {
    netlog.warn('picta', `Error buscando en TMDB: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function enrichMetadataWithGemini(params: {
  title: string;
  mediaType?: 'movie' | 'tv' | 'video';
  existingOverview?: string;
  year?: string;
}): Promise<{
  title: string;
  synopsis: string;
  clasificacion: string;
  keywords: string;
  genre: string;
  suggestedTipologia: number;
} | null> {
  const ai = getGeminiClient();
  if (!ai) return null;

  try {
    const prompt = [
      'Genera metadatos editoriales en español neutro para publicar este contenido en un canal de Picta.',
      `Título: ${params.title}`,
      params.year ? `Año: ${params.year}` : '',
      params.mediaType ? `Tipo detectado: ${params.mediaType}` : '',
      params.existingOverview ? `Referencia previa: ${params.existingOverview.slice(0, 450)}` : '',
      'Tipologías oficiales de Picta (elige el número exacto en suggestedTipologia): 1=Película, 2=Documental, 3=Video Musical, 5=Serie, 6=Curso/Deporte, 8=Audiovisual, 11=Videoclip, 14=Deporte/Gameplay, 15=Shorts, 17=Cultural/Reportaje, 18=Informativo/Receta, 19=Humorístico.',
      'Devuelve título limpio en español, sinopsis atractiva de 2-3 frases sin spoilers, clasificación (TP, +12, +16 o 18+), género principal, 4 palabras clave separadas por coma y suggestedTipologia.',
    ]
      .filter(Boolean)
      .join('\n');

    const response = await ai.models.generateContent({
      model: resolveGeminiModel(),
      contents: prompt,
      config: {
        systemInstruction:
          'Eres un editor audiovisual experto en catálogos de cine y series en español. Responde siempre en JSON válido.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            synopsis: { type: Type.STRING },
            clasificacion: { type: Type.STRING },
            keywords: { type: Type.STRING },
            genre: { type: Type.STRING },
            suggestedTipologia: { type: Type.INTEGER },
          },
          required: ['title', 'synopsis', 'clasificacion', 'keywords', 'genre', 'suggestedTipologia'],
        },
      },
    });

    const raw = (response.text || '').trim();
    if (!raw) {
      lastGeminiErrorMessage = 'Gemini devolvió una respuesta vacía.';
      return null;
    }
    const parsed = JSON.parse(raw) as {
      title?: string;
      synopsis?: string;
      clasificacion?: string;
      keywords?: string;
      genre?: string;
      suggestedTipologia?: number;
    };
    const validClasif = ['TP', '+12', '+16', '18+', 'Todos'].includes(String(parsed.clasificacion || ''))
      ? String(parsed.clasificacion)
      : '+16';
    const rawTip = Number(parsed.suggestedTipologia || 8);
    const suggestedTipologia = VALID_TIPOLOGIA_IDS.has(rawTip) ? rawTip : 8;
    lastGeminiErrorMessage = '';

    return {
      title: String(parsed.title || params.title).trim(),
      synopsis: String(parsed.synopsis || '').trim(),
      clasificacion: validClasif,
      keywords: String(parsed.keywords || '').trim(),
      genre: String(parsed.genre || 'Entretenimiento').trim(),
      suggestedTipologia,
    };
  } catch (err) {
    lastGeminiErrorMessage = formatGeminiError(err);
    console.warn(`[PictaBot][Gemini] Error enriquecimiento: ${lastGeminiErrorMessage}`);
    netlog.warn('picta', `Gemini no disponible para enriquecimiento: ${lastGeminiErrorMessage}`);
    return null;
  }
}

export async function generateAiCommentReply(params: {
  commentText: string;
  authorName: string;
  videoTitle: string;
  channelName: string;
  isRequest?: boolean;
}): Promise<string | null> {
  const ai = getGeminiClient();
  if (!ai) return null;

  try {
    const prompt = [
      `Canal de Picta: ${params.channelName}`,
      `Video comentado: ${params.videoTitle}`,
      `Usuario: ${params.authorName}`,
      `Comentario: "${params.commentText.slice(0, 450)}"`,
      params.isRequest
        ? 'El comentario parece una petición de contenido. Agradece el apoyo e indica con amabilidad que anotamos la solicitud para evaluarla y subirla pronto si está disponible.'
        : 'Redacta una respuesta cálida, cercana y natural en español (máximo 2 frases cortas, sin emojis excesivos ni sonar robótico).',
    ].join('\n');

    const response = await ai.models.generateContent({
      model: resolveGeminiModel(),
      contents: prompt,
      config: {
        systemInstruction:
          'Eres el administrador de un canal audiovisual en Picta respondiendo directamente a tu comunidad en español. Responde solo el texto listo para publicar, sin comillas ni explicaciones.',
      },
    });

    const reply = (response.text || '').trim().replace(/^["']|["']$/g, '').slice(0, 450);
    if (!reply) {
      lastGeminiErrorMessage = 'Gemini devolvió una sugerencia vacía.';
      return null;
    }
    lastGeminiErrorMessage = '';
    return reply;
  } catch (err) {
    lastGeminiErrorMessage = formatGeminiError(err);
    console.warn(`[PictaBot][Gemini] Error respuesta comentario: ${lastGeminiErrorMessage}`);
    netlog.warn('picta', `Error generando respuesta IA para comentario: ${lastGeminiErrorMessage}`);
    return null;
  }
}

export function detectViewerRequestComment(text: string): { isRequest: boolean; extractedTitle: string } {
  const clean = String(text || '').trim();
  if (clean.length < 8) return { isRequest: false, extractedTitle: '' };
  const lower = normalizeCmp(clean);

  if (
    /^(gracias|excelente|muy buena|muy bueno|genial|buenisimo|buenisima|tremendo|me encanto|saludos|bendiciones|top|brutal|jajaja|ok|si|no)(\s|$)/i.test(
      lower
    ) &&
    clean.length < 40
  ) {
    return { isRequest: false, extractedTitle: '' };
  }

  const requestRegex =
    /\b(pueden subir|puedes subir|sube|suban|por favor sube|cuando suben|cuando sale|falta el capitulo|falta la temporada|subir la pelicula|subir la serie|quiero ver|podrian subir|tienen la pelicula|tienen la serie|busco la pelicula|busco la serie|suban el cap|temporada \d|parte \d)\b/i;

  if (!requestRegex.test(lower)) {
    return { isRequest: false, extractedTitle: '' };
  }

  const stripped = clean
    .replace(
      /\b(hola|por favor|porfa|pueden|puedes|podrian|podrias|subir|sube|suban|cuando|suben|sale|la pelicula|la serie|el capitulo|los capitulos|de|porfi|gracias|admin|canal)\b/gi,
      ' '
    )
    .replace(/[¿?¡!.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    isRequest: true,
    extractedTitle: stripped.slice(0, 80) || clean.slice(0, 80),
  };
}

export async function fetchSafeImageBuffer(imageUrl: string): Promise<Buffer | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== 'https:') return null;
    if (!ALLOWED_IMAGE_HOSTS.has(parsed.hostname.toLowerCase())) {
      netlog.warn('picta', `Host de imagen bloqueado por politica SSRF: ${parsed.hostname}`);
      return null;
    }

    const res = await fetch(parsed.toString(), { signal: controller.signal });
    if (!res.ok) return null;

    const arr = await res.arrayBuffer();
    if (arr.byteLength < 100 || arr.byteLength > 12 * 1024 * 1024) return null;
    return Buffer.from(arr);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function extractVideoFrameBufferWithFfmpeg(videoFullPath: string, outJpgFullPath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'ffmpeg',
      ['-y', '-ss', '00:00:08', '-i', videoFullPath, '-vframes', '1', '-q:v', '3', outJpgFullPath],
      { shell: false }
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, 20000);

    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outJpgFullPath)) {
        try {
          const buf = fs.readFileSync(outJpgFullPath);
          fs.rmSync(outJpgFullPath, { force: true });
          resolve(buf.byteLength > 100 ? buf : null);
          return;
        } catch {
          resolve(null);
          return;
        }
      }
      resolve(null);
    });
  });
}
