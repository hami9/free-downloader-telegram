import { api } from 'sdk';
import db, { and, eq, lt, ne, sql } from 'sdk/db';
import { activeDownloads, cachedMedia } from '../../schema.js';
import { BROWSER_UA, fetchWithTimeout, parseUrlParts } from '../http.js';

export const USER_AGENT = BROWSER_UA;
export const BOT_UA = 'TelegramBot (like TwitterBot)';
export const FB_UA = 'facebookexternalhit/1.1';
export const TG_MAX_UPLOAD_BYTES = 48 * 1024 * 1024;
export const TG_SPLIT_PART_BYTES = 44 * 1024 * 1024;
export const TG_MAX_PHOTO_BYTES = 9.5 * 1024 * 1024;
export const REF_TTL_SEC = 6 * 3600;
export const YTINFO_TTL_SEC = 600;
export const MEDIA_CACHE_TTL_SEC = 30 * 24 * 3600;
export const MAX_CACHE_ROWS = 25000;

const TRACKING_QUERY_PARAMS = new Set([
  'igsh',
  'igshid',
  'exln',
  'fbclid',
  's',
  't',
  'si',
  'feature',
  'pp',
  'ref',
  'ref_src',
  'ref_url',
  'is_from_webapp',
  'sender_device',
  'sender_web_id',
  'web_id',
  'u_code',
  'share_app_id',
  'social_sharing',
  'checksum',
  'tt_from',
  'sec_uid',
  'user_id',
  '_r',
  '_t',
  'app',
  'e',
]);

// Per-isolate bounded memo caches (prevent repeated SQLite reads & Telegram flood on hot chats)
const hotMemo = new Map();
const mutedStatusChats = new Map();
const chatBurstTracker = new Map();
const cancelPollMemo = new Map();
const inflightPromises = new Map();
let lastSweepMs = 0;

function memoGet(key) {
  const entry = hotMemo.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.exp) {
    hotMemo.delete(key);
    return undefined;
  }
  return entry.val;
}

function memoSet(key, val, ttlMs = 30000) {
  if (hotMemo.has(key)) hotMemo.delete(key);
  while (hotMemo.size >= 300) {
    const oldest = hotMemo.keys().next().value;
    if (oldest === undefined) break;
    hotMemo.delete(oldest);
  }
  hotMemo.set(key, { val, exp: Date.now() + ttlMs });
}

function memoDel(key) {
  hotMemo.delete(key);
}

/** Yield asynchronously cleanly without crashing when global setTimeout is absent (e.g. tgcloud v8go). */
export function safeSleep(ms = 0) {
  if (ms > 0 && typeof setTimeout === 'function') {
    return new Promise(r => setTimeout(r, ms));
  }
  return Promise.resolve();
}

function noteStatusMute(chatId, err) {
  if (!chatId || err?.code !== 429) return;
  const retry = Math.min(30, Math.max(2, Number(err?.parameters?.retry_after || 5)));
  if (mutedStatusChats.size >= 300) {
    const oldest = mutedStatusChats.keys().next().value;
    if (oldest !== undefined) mutedStatusChats.delete(oldest);
  }
  mutedStatusChats.set(chatId, Date.now() + retry * 1000);
}

function isStatusMuted(chatId) {
  const until = mutedStatusChats.get(chatId);
  if (!until) return false;
  if (Date.now() > until) {
    mutedStatusChats.delete(chatId);
    return false;
  }
  return true;
}

/**
 * Decide whether to send a temporary "⏳ Fetching..." status message.
 * During rapid chat bursts (>2 uncached requests / 10s) or active 429 cooldowns, skips status chatter
 * to reduce Telegram Bot API calls from ~5 down to 1 per media delivery.
 */
export function shouldSendStatusMessage(chatId) {
  if (!chatId || isStatusMuted(chatId)) return false;
  const now = Date.now();
  const prev = chatBurstTracker.get(chatId);
  if (!prev || now - prev.windowStart > 10000) {
    if (chatBurstTracker.size >= 500) {
      const oldest = chatBurstTracker.keys().next().value;
      if (oldest !== undefined) chatBurstTracker.delete(oldest);
    }
    chatBurstTracker.set(chatId, { windowStart: now, count: 1 });
    return true;
  }
  prev.count++;
  return prev.count <= 2;
}

export async function sendOrEditStatusError(chatId, statusMsgId, htmlText, replyToMsgId = null) {
  if (!chatId || !htmlText) return;
  if (statusMsgId) {
    await safeEditMessage(chatId, statusMsgId, htmlText);
    return;
  }
  await tgCall('sendMessage', {
    chat_id: chatId,
    text: htmlText,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {}),
  }).catch(() => {});
}

export function normalizeMediaUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (/^(?:ref:|setting:|ytinfo:|ytmeta:)/.test(trimmed)) return trimmed;

  const parts = parseUrlParts(trimmed);
  if (!parts) return trimmed;

  const lowerHost = parts.host.toLowerCase();
  const cleanedParams = [];
  if (parts.search && parts.search.length > 1) {
    for (const pair of parts.search.slice(1).split('&')) {
      if (!pair) continue;
      const eqPos = pair.indexOf('=');
      const rawKey = eqPos >= 0 ? pair.slice(0, eqPos) : pair;
      let key;
      try {
        key = decodeURIComponent(rawKey).toLowerCase();
      } catch {
        key = rawKey.toLowerCase();
      }
      if (key.startsWith('utm_') || TRACKING_QUERY_PARAMS.has(key)) continue;
      cleanedParams.push(pair);
    }
  }
  const cleanSearch = cleanedParams.length ? `?${cleanedParams.join('&')}` : '';

  const ytId = extractYouTubeId(trimmed);
  if (ytId && /(?:youtube\.com|youtu\.be)$/i.test(lowerHost.replace(/^www\.|^m\.|^music\./, ''))) {
    return `https://www.youtube.com/watch?v=${ytId}`;
  }

  if (/(?:instagram\.com|instagr\.am|ddinstagram\.com|kkinstagram\.com)$/i.test(lowerHost)) {
    const sc = parts.pathname.match(/^(?:\/[^/]+)?\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
    if (sc) {
      const kind = sc[1].toLowerCase() === 'reels' ? 'reel' : sc[1].toLowerCase();
      return `https://www.instagram.com/${kind}/${sc[2]}/`;
    }
    return `https://www.instagram.com${parts.pathname}${cleanSearch}`;
  }

  if (/(?:x\.com|twitter\.com)$/i.test(lowerHost)) {
    const cleanPath = parts.pathname.replace(/\/(?:photo|video)\/\d+\/?$/i, '');
    return `https://x.com${cleanPath}${cleanSearch}`;
  }

  if (/(?:^|\.)pinterest\.[a-z.]+$/i.test(lowerHost)) {
    const pin = parts.pathname.match(/\/pin\/([0-9]+)/i);
    if (pin) return `https://www.pinterest.com/pin/${pin[1]}/`;
  }

  return `${parts.origin}${parts.pathname}${cleanSearch}`;
}

export function canonicalizeCacheUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (/^(?:ref:|setting:|ytinfo:|ytmeta:)/.test(trimmed)) return trimmed;

  const slideMatch = trimmed.match(/(#slide\d+)$/i);
  const slideSuffix = slideMatch ? slideMatch[1].toLowerCase() : '';
  const baseStr = slideSuffix ? trimmed.slice(0, -slideSuffix.length) : trimmed;
  const norm = normalizeMediaUrl(baseStr);

  const ytId = extractYouTubeId(norm);
  if (ytId) return `https://www.youtube.com/watch?v=${ytId}${slideSuffix}`;

  const ig = norm.match(/^https:\/\/www\.instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i);
  if (ig) return `https://www.instagram.com/p/${ig[1]}/${slideSuffix}`;

  const tw = norm.match(/^https:\/\/x\.com\/(?:[^/]+\/status|i\/(?:web\/)?status)\/(\d+)/i);
  if (tw) return `https://x.com/i/status/${tw[1]}${slideSuffix}`;

  const tt = norm.match(/^https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[^/]+\/(?:video|photo)\/(\d+)/i);
  if (tt) return `https://www.tiktok.com/@_/item/${tt[1]}${slideSuffix}`;

  return `${norm}${slideSuffix}`;
}

function shortFnvHash(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ch, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

export function getInflightLockKey(rawUrl, suffix = '') {
  const canon = canonicalizeCacheUrl(rawUrl);
  return `url:${shortFnvHash(canon)}${suffix ? `_${suffix}` : ''}`.slice(0, 40);
}

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function linkifyPlatformMentions(htmlText, platform = 'instagram') {
  if (!htmlText) return '';
  const norm = String(platform || '').toLowerCase();
  const getProfileUrl = uname => {
    switch (norm) {
      case 'tiktok':
        return `https://www.tiktok.com/@${uname}`;
      case 'x':
      case 'twitter':
        return `https://x.com/${uname}`;
      case 'youtube':
        return `https://www.youtube.com/@${uname}`;
      case 'pinterest':
        return `https://www.pinterest.com/${uname}/`;
      case 'instagram':
      default:
        return `https://www.instagram.com/${uname}/`;
    }
  };
  return htmlText.replace(/(^|[\s(>[\],;!?:])@([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)/g, (_, prefix, uname) => {
    return `${prefix}<a href="${getProfileUrl(uname)}">@${uname}</a>`;
  });
}

export function extractYouTubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|v\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

export function extractSupportedMediaLink(text) {
  if (!text || typeof text !== 'string') return null;

  const yt = text.match(/https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?[^\s<>"']*v=|shorts\/|embed\/|v\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})[^\s<>"']*/i);
  if (yt) {
    return { platform: 'youtube', url: yt[0].replace(/[.,;:!?)>"']+$/, ''), id: yt[1] };
  }

  const tt = text.match(/https?:\/\/(?:(?:vm|vt)\.tiktok\.com\/[A-Za-z0-9_-]+|(?:www\.|m\.)?tiktok\.com\/(?:t\/[A-Za-z0-9_-]+|@[^\/\s<>"']+\/(?:video|photo)\/[0-9]+))[^\s<>"']*/i);
  if (tt) {
    return { platform: 'tiktok', url: tt[0].replace(/[.,;:!?)>"']+$/, '') };
  }

  const x = text.match(/https?:\/\/(?:www\.|mobile\.|fx|vx)?(?:twitter\.com|x\.com)\/(?:[^/\s<>"']+\/status\/\d+|i\/(?:status|web\/status)\/\d+)[^\s<>"']*/i);
  if (x) {
    return { platform: 'x', url: x[0].replace(/[.,;:!?)>"']+$/, '') };
  }

  const ig = text.match(/https?:\/\/(?:www\.|m\.)?(?:instagram\.com|instagr\.am|ddinstagram\.com|kkinstagram\.com)\/(?:share\/(?:reel|reels|p)\/|[^\/\s<>"']+\/(?:p|reel|reels|tv|share)\/|(?:p|reel|reels|tv|stories|share)\/)([A-Za-z0-9_-]+)[^\s<>"']*/i);
  if (ig) {
    return { platform: 'instagram', url: ig[0].replace(/[.,;:!?)>"']+$/, ''), shortcode: ig[1] };
  }

  const pin = text.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)?pinterest\.[a-z.]+\/pin\/[0-9]+[^\s<>"']*|https?:\/\/pin\.it\/[A-Za-z0-9]+[^\s<>"']*/i);
  if (pin) {
    return { platform: 'pinterest', url: pin[0].replace(/[.,;:!?)>"']+$/, '') };
  }

  return null;
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec || 0)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

export function computeByteFingerprint(bytes) {
  if (!bytes || !bytes.length) return '';
  let h = 2166136261;
  const len = bytes.length;
  const step = Math.max(1, Math.floor(len / 4096));
  for (let i = 0; i < len; i += step) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${len}:${h.toString(36)}`;
}

export function splitCaption(fullHtml) {
  if (!fullHtml) return { shortCaption: '', overflowText: null };
  if (fullHtml.length <= 1020) {
    return { shortCaption: fullHtml, overflowText: null };
  }
  const firstNewline = fullHtml.indexOf('\n');
  const header =
    firstNewline > 0 && firstNewline <= 900
      ? fullHtml.slice(0, firstNewline)
      : escapeHtml(fullHtml.replace(/<\/?[^>]+>/g, '').slice(0, 250));
  return {
    shortCaption: `${header}\n\n📝 <i>Full caption below 👇</i>`,
    overflowText: fullHtml,
  };
}

export async function tgCall(methodOrFn, params, options = {}) {
  const { maxRetries = 2, maxRetryWaitSec = 18 } = options;
  const hasRealTimer = typeof setTimeout === 'function';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (typeof methodOrFn === 'function') {
        return await methodOrFn();
      }
      const p = typeof params === 'function' ? params() : params;
      return await api[methodOrFn](p);
    } catch (err) {
      const chatId = err?.parameters?.chat_id || (typeof params === 'object' ? params?.chat_id : undefined);
      noteStatusMute(chatId, err);
      const retryAfter = Number(err?.parameters?.retry_after || 0);
      if (hasRealTimer && err?.code === 429 && attempt < maxRetries && retryAfter > 0 && retryAfter <= maxRetryWaitSec) {
        const jitter = Math.floor(Math.random() * 350);
        await safeSleep(retryAfter * 1000 + jitter);
        continue;
      }
      throw err;
    }
  }
}

export async function safeDeleteMessage(chatId, messageId) {
  if (!chatId || !messageId) return;
  try {
    await api.deleteMessage({ chat_id: chatId, message_id: messageId });
  } catch (err) {
    noteStatusMute(chatId, err);
  }
}

export async function safeEditMessageText(params) {
  if (!params || !params.chat_id || !params.message_id) return;
  if (isStatusMuted(params.chat_id)) return;
  try {
    return await api.editMessageText(params);
  } catch (err) {
    noteStatusMute(params.chat_id, err);
  }
}

export async function safeEditMessage(chatId, messageId, text, replyMarkup = undefined) {
  if (!chatId || !messageId) return;
  return safeEditMessageText({
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

export async function sendFullCaptionOverflow(chatId, overflowText, replyToMsgId = null) {
  if (!overflowText) return;
  const maxChunk = 4000;
  const replyParams = replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {};
  for (let i = 0; i < overflowText.length; i += maxChunk) {
    const part = overflowText.slice(i, i + maxChunk);
    try {
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: part,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...replyParams,
      });
    } catch {
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: part.replace(/<\/?[^>]+>/g, ''),
        disable_web_page_preview: true,
        ...replyParams,
      }).catch(() => {});
    }
  }
}

async function maybeSweepDatabase(force = false) {
  const nowMs = Date.now();
  if (!force) {
    if (nowMs - lastSweepMs < 180000 && Math.random() >= 0.02) return;
  }
  lastSweepMs = nowMs;
  const nowSec = Math.floor(nowMs / 1000);
  try {
    await db.delete(activeDownloads).where(lt(activeDownloads.createdAt, nowSec - 3600)).run();
    await db
      .delete(cachedMedia)
      .where(and(eq(cachedMedia.mediaType, 'ref'), lt(cachedMedia.createdAt, nowSec - REF_TTL_SEC)))
      .run();
    await db
      .delete(cachedMedia)
      .where(and(ne(cachedMedia.mediaType, 'setting'), lt(cachedMedia.createdAt, nowSec - MEDIA_CACHE_TTL_SEC)))
      .run();

    const count = await db.$count(cachedMedia);
    if (count > MAX_CACHE_ROWS) {
      const trim = Math.min(2000, Math.max(500, count - MAX_CACHE_ROWS + 500));
      await db.run(
        sql`DELETE FROM cached_media WHERE id IN (SELECT id FROM cached_media WHERE media_type != 'setting' ORDER BY created_at ASC LIMIT ${trim})`
      );
    }
  } catch {}
}

export async function sweepStaleCacheNow() {
  return maybeSweepDatabase(true);
}

export async function claimUpdateLock(chatId, lockKey, ttlSeconds = 3600) {
  if (chatId === undefined || chatId === null || !lockKey) return true;
  maybeSweepDatabase().catch(() => {});
  const now = Math.floor(Date.now() / 1000);
  try {
    await db
      .delete(activeDownloads)
      .where(
        and(
          eq(activeDownloads.chatId, chatId),
          eq(activeDownloads.token, lockKey),
          lt(activeDownloads.createdAt, now - ttlSeconds)
        )
      )
      .run();

    const ins = await db
      .insert(activeDownloads)
      .values({ chatId, token: lockKey, cancelled: 0, createdAt: now })
      .onConflictDoNothing({ target: [activeDownloads.chatId, activeDownloads.token] })
      .run();
    return Number(ins?.rowsAffected || 0) > 0;
  } catch {
    return true;
  }
}

export async function hasActiveLock(chatId, lockKey, ttlSeconds = 90) {
  if (chatId === undefined || chatId === null || !lockKey) return false;
  const now = Math.floor(Date.now() / 1000);
  try {
    const row = await db
      .select()
      .from(activeDownloads)
      .where(and(eq(activeDownloads.chatId, chatId), eq(activeDownloads.token, lockKey)))
      .get();
    return Boolean(row && now - row.createdAt < ttlSeconds);
  } catch {
    return false;
  }
}

export async function releaseUpdateLock(chatId, lockKey) {
  if (chatId === undefined || chatId === null || !lockKey) return;
  try {
    await db
      .delete(activeDownloads)
      .where(and(eq(activeDownloads.chatId, chatId), eq(activeDownloads.token, lockKey)))
      .run();
  } catch {}
}

export async function createDownloadTask(chatId) {
  const token = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    await db
      .insert(activeDownloads)
      .values({
        chatId,
        token,
        cancelled: 0,
        createdAt: Math.floor(Date.now() / 1000),
      })
      .onConflictDoNothing({ target: [activeDownloads.chatId, activeDownloads.token] })
      .run();
  } catch {}
  return token;
}

export async function cancelDownloadTask(chatId, token) {
  if (token) cancelPollMemo.set(token, { checkedAt: Date.now(), cancelled: true });
  try {
    await db
      .update(activeDownloads)
      .set({ cancelled: 1 })
      .where(and(eq(activeDownloads.chatId, chatId), eq(activeDownloads.token, token)))
      .run();
  } catch {}
}

export async function isTaskCancelled(chatId, token) {
  if (!token) return false;
  const cached = cancelPollMemo.get(token);
  const now = Date.now();
  if (cached) {
    if (cached.cancelled) return true;
    if (now - cached.checkedAt < 1500) return false;
  }
  try {
    const row = await db
      .select()
      .from(activeDownloads)
      .where(and(eq(activeDownloads.chatId, chatId), eq(activeDownloads.token, token)))
      .get();
    const isCancelled = Boolean(row && row.cancelled === 1);
    while (cancelPollMemo.size >= 300) {
      const oldest = cancelPollMemo.keys().next().value;
      if (oldest === undefined) break;
      cancelPollMemo.delete(oldest);
    }
    cancelPollMemo.set(token, { checkedAt: now, cancelled: isCancelled });
    return isCancelled;
  } catch {
    return false;
  }
}

export async function cleanupDownloadTask(chatId, token) {
  if (!token) return;
  cancelPollMemo.delete(token);
  try {
    await db
      .delete(activeDownloads)
      .where(and(eq(activeDownloads.chatId, chatId), eq(activeDownloads.token, token)))
      .run();
  } catch {}
}

export function cancelKeyboard(token) {
  if (!token) return undefined;
  return { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `ytc|${token}` }]] };
}

export async function fetchWithRetry(url, options = {}, retries = 3) {
  const timeoutMs = Number(options?.timeoutMs || 15000);
  const fetchOpts = { ...options };
  delete fetchOpts.timeoutMs;
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetchWithTimeout(url, fetchOpts, timeoutMs);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        lastErr.status = res.status;
        if (i === retries - 1) return res;
        const retryHdr = Number(res.headers?.get?.('retry-after') || 0);
        const waitMs = retryHdr > 0 && retryHdr <= 3 ? retryHdr * 1000 : 250 * (i + 1) + Math.floor(Math.random() * 150);
        await safeSleep(waitMs);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (i < retries - 1) {
        await safeSleep(250 * (i + 1) + Math.floor(Math.random() * 150));
      }
    }
  }
  throw lastErr;
}

export async function saveCache(url, formatId, fileId, mediaType, caption) {
  if (!fileId || !url) return;
  const canonUrl = canonicalizeCacheUrl(url);
  const fmt = formatId || '';
  const now = Math.floor(Date.now() / 1000);
  const entry = {
    url: canonUrl,
    formatId: fmt,
    fileId,
    mediaType,
    caption: caption || '',
    createdAt: now,
  };
  try {
    await db
      .insert(cachedMedia)
      .values(entry)
      .onConflictDoUpdate({
        target: [cachedMedia.url, cachedMedia.formatId],
        set: {
          fileId: entry.fileId,
          mediaType: entry.mediaType,
          caption: entry.caption,
          createdAt: entry.createdAt,
        },
      })
      .run();
    const ttlMs = mediaType === 'setting' ? 60000 : 30000;
    memoSet(`c:${canonUrl}|${fmt}`, entry, ttlMs);
  } catch {}
}

export async function getCachedEntry(url, formatId = '', maxAgeSec = 0) {
  if (!url) return null;
  const canonUrl = canonicalizeCacheUrl(url);
  const fmt = formatId || '';
  const memoKey = `c:${canonUrl}|${fmt}`;
  const now = Math.floor(Date.now() / 1000);
  const effectiveTtl =
    maxAgeSec > 0
      ? maxAgeSec
      : fmt === 'ogref' || canonUrl.startsWith('ref:')
        ? REF_TTL_SEC
        : MEDIA_CACHE_TTL_SEC;

  const isFresh = row => {
    if (!row) return false;
    if (row.mediaType === 'setting') return true;
    return now - Number(row.createdAt || 0) <= effectiveTtl;
  };

  const memHit = memoGet(memoKey);
  if (memHit !== undefined) {
    return isFresh(memHit) ? memHit : null;
  }

  try {
    const row = await db
      .select()
      .from(cachedMedia)
      .where(and(eq(cachedMedia.url, canonUrl), eq(cachedMedia.formatId, fmt)))
      .get();
    if (!isFresh(row)) {
      memoSet(memoKey, null, 5000);
      return null;
    }
    memoSet(memoKey, row, row.mediaType === 'setting' ? 60000 : 30000);
    return row;
  } catch {
    return null;
  }
}

export async function invalidateCacheEntry(url, formatId = '') {
  if (!url) return;
  const canonUrl = canonicalizeCacheUrl(url);
  const fmt = formatId || '';
  memoDel(`c:${canonUrl}|${fmt}`);
  try {
    await db
      .delete(cachedMedia)
      .where(and(eq(cachedMedia.url, canonUrl), eq(cachedMedia.formatId, fmt)))
      .run();
  } catch {}
}

export async function storeMediaRef(payload, prefix = 'm') {
  const rawStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const refId = `${prefix}${shortFnvHash(rawStr)}`.slice(0, 14);
  const key = `ref:${refId}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    await db
      .insert(cachedMedia)
      .values({
        url: key,
        formatId: 'ref',
        fileId: rawStr,
        mediaType: 'ref',
        caption: '',
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [cachedMedia.url, cachedMedia.formatId],
        set: {
          fileId: rawStr,
          mediaType: 'ref',
          caption: '',
          createdAt: now,
        },
      })
      .run();
    memoSet(`c:${key}|ref`, { url: key, formatId: 'ref', fileId: rawStr, mediaType: 'ref', caption: '', createdAt: now }, 30000);
  } catch {}
  return refId;
}

export async function resolveMediaRef(refId, maxAgeSec = REF_TTL_SEC) {
  try {
    const row = await getCachedEntry(`ref:${refId}`, 'ref', maxAgeSec);
    if (!row?.fileId) return null;
    if (row.fileId.startsWith('{')) {
      return JSON.parse(row.fileId);
    }
    return { streamUrl: row.fileId };
  } catch {
    return null;
  }
}

/**
 * Coalesce concurrent identical URL downloads inside the same isolate (no timer spin),
 * with cross-isolate SQLite inflight tracking as secondary guard.
 */
export async function runWithSingleflight(cacheUrl, workFn, options = {}) {
  const { formatId = '', lockSuffix = '', lockTtlSec = 90 } = options;
  const lockKey = getInflightLockKey(cacheUrl, lockSuffix);

  const pending = inflightPromises.get(lockKey);
  if (pending) {
    try {
      await pending;
      const hit = await getCachedEntry(cacheUrl, formatId);
      if (hit && !(hit.caption && hit.caption.includes('Post not found'))) {
        return { role: 'hit', cached: hit };
      }
    } catch {}
  }

  let releaseGate;
  const gatePromise = new Promise(resolve => {
    releaseGate = resolve;
  });
  inflightPromises.set(lockKey, gatePromise);

  let acquired = false;
  try {
    acquired = await claimUpdateLock(0, lockKey, lockTtlSec);
    if (!acquired) {
      // Brief host-pumped yield via single cached check across isolates, or run fallback cleanly
      await safeSleep(typeof setTimeout === 'function' ? 800 : 0);
      const hit = await getCachedEntry(cacheUrl, formatId);
      if (hit && !(hit.caption && hit.caption.includes('Post not found'))) {
        return { role: 'hit', cached: hit };
      }
    }
    const result = await workFn();
    return { role: 'leader', result };
  } finally {
    if (inflightPromises.get(lockKey) === gatePromise) {
      inflightPromises.delete(lockKey);
    }
    if (acquired) {
      await releaseUpdateLock(0, lockKey);
    }
    releaseGate();
  }
}
