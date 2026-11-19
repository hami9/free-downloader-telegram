import { fetch } from 'sdk';
import { fetchMediaBuffer, fetchWithTimeout } from '../http.js';
import { sendSlidesAndCache } from '../delivery.js';
import {
  BOT_UA,
  FB_UA,
  TG_MAX_UPLOAD_BYTES,
  USER_AGENT,
  cancelKeyboard,
  cleanupDownloadTask,
  computeByteFingerprint,
  createDownloadTask,
  decodeHtmlEntities,
  escapeHtml,
  fetchWithRetry,
  getCachedEntry,
  isTaskCancelled,
  linkifyPlatformMentions,
  safeEditMessage,
  sendOrEditStatusError,
  shouldSendStatusMessage,
  tgCall,
} from './common.js';

function parseEeInstagramHtml(html) {
  const descMatch =
    html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i) ||
    html.match(/<meta[^>]+content="([^"]*)"[^>]+property="og:description"/i);
  const titleMatch =
    html.match(/<meta[^>]+name="twitter:title"[^>]+content="([^"]*)"/i) ||
    html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i);
  const vidMatch =
    html.match(/<meta[^>]+property="og:video(?::secure_url)?"[^>]+content="([^"]+)"/i) ||
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video(?::secure_url)?"/i);
  const imgMatch =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) ||
    html.match(/<meta[^>]+name="twitter:image"[^>]+content="([^"]+)"/i);

  const rawDesc = descMatch ? decodeHtmlEntities(descMatch[1]) : '';
  const rawTitle = titleMatch ? decodeHtmlEntities(titleMatch[1]) : '';

  if (rawDesc === 'Media number out of range') return { outOfRange: true, notFound: false };
  const isNotFound =
    rawDesc === 'Post not found' ||
    rawDesc === 'Media not found' ||
    rawDesc.toLowerCase() === 'post not found';

  let videoUrl = vidMatch ? decodeHtmlEntities(vidMatch[1]) : null;
  if (videoUrl && videoUrl.startsWith('/')) videoUrl = `https://www.eeinstagram.com${videoUrl}`;

  let imageUrl = imgMatch ? decodeHtmlEntities(imgMatch[1]) : null;
  if (imageUrl && imageUrl.startsWith('/')) imageUrl = `https://www.eeinstagram.com${imageUrl}`;

  return {
    outOfRange: false,
    notFound: isNotFound,
    rawDesc: isNotFound ? '' : rawDesc,
    rawTitle: rawTitle === 'fix instagram embeds' ? '' : rawTitle,
    videoUrl,
    imageUrl,
    isGrid: !!(imageUrl && imageUrl.includes('/grid/')),
  };
}

async function fetchEeInstagramBase(shortcode, isReelUrl) {
  const paths = isReelUrl
    ? [`/reel/${shortcode}`, `/p/${shortcode}/1`, `/p/${shortcode}`]
    : [`/p/${shortcode}/1`, `/p/${shortcode}`, `/reel/${shortcode}`];

  let lastInfo = null;
  for (const path of paths) {
    try {
      const res = await fetchWithRetry(`https://www.eeinstagram.com${path}`, { headers: { 'User-Agent': BOT_UA } }, 2);
      if (!res.ok) continue;
      const info = parseEeInstagramHtml(await res.text());
      lastInfo = info;
      if (!info.notFound && !info.outOfRange && (info.videoUrl || info.imageUrl)) {
        return info;
      }
    } catch {}
  }
  return lastInfo;
}

function unescapeIgString(s) {
  return decodeHtmlEntities(
    String(s || '')
      .replace(/\\u0026/gi, '&')
      .replace(/\\u002F/gi, '/')
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"')
  );
}

function extractJsonObjectAt(text, openIdx) {
  if (openIdx < 0 || text[openIdx] !== '{') return '';
  let depth = 0;
  let inStr = false;
  let escaped = false;
  const maxEnd = Math.min(text.length, openIdx + 400000);
  for (let i = openIdx; i < maxEnd; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return '';
}

function findEnclosingJsStringLiteral(text, targetIdx) {
  const scriptOpen = text.lastIndexOf('<script', targetIdx);
  const startScan = scriptOpen >= 0 ? Math.max(0, text.indexOf('>', scriptOpen) + 1) : Math.max(0, targetIdx - 120000);
  const endScan = Math.min(text.length, targetIdx + 300000);
  let i = startScan;
  while (i < endScan) {
    if (text[i] !== '"') {
      i++;
      continue;
    }
    const strStart = i;
    i++;
    let escaped = false;
    while (i < endScan) {
      const ch = text[i];
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') break;
      i++;
    }
    if (i < endScan && strStart <= targetIdx && i >= targetIdx) {
      return text.slice(strStart, i + 1);
    }
    i++;
  }
  return '';
}

function extractJsonAfterKey(text, key) {
  if (!text) return null;
  const keyPat = new RegExp(`"${key}"\\s*:\\s*\\{`, 'g');
  let m;
  while ((m = keyPat.exec(text)) !== null) {
    const braceIdx = text.indexOf('{', m.index + key.length + 2);
    const rawObj = extractJsonObjectAt(text, braceIdx);
    if (rawObj) {
      try {
        return JSON.parse(rawObj);
      } catch {}
    }
  }

  const escNeedle = `\\"${key}\\"`;
  let from = 0;
  while (from < text.length) {
    const idx = text.indexOf(escNeedle, from);
    if (idx < 0) break;
    from = idx + escNeedle.length;
    const jsLiteral = findEnclosingJsStringLiteral(text, idx);
    if (!jsLiteral) continue;
    try {
      const decodedStr = JSON.parse(jsLiteral);
      if (typeof decodedStr === 'string') {
        const parsed = extractJsonAfterKey(decodedStr, key);
        if (parsed) return parsed;
      }
    } catch {}
  }
  return null;
}

function getIgExtFromUrl(u, fallback = 'jpg') {
  const m = String(u || '').split('?')[0].match(/\.(png|webp|gif|jpe?g|heic)$/i);
  if (!m) return fallback;
  const ext = m[1].toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}

export function pickBestImageFromNode(node) {
  if (!node) return '';
  const origW = Number(node.original_width || node.dimensions?.width || 0);
  const origH = Number(node.original_height || node.dimensions?.height || 0);
  const candidates = [];
  const push = (url, w, h, prio = 1) => {
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    const stpMatch = url.match(/[?&]stp=([^&]+)/i);
    const stpVal = stpMatch ? stpMatch[1] : '';
    const resizeMatch = stpVal.match(/(?:^|_)[ps](\d+)x(\d+)(?:_|$)/i);
    const isUnscaled = !resizeMatch && !/\/[ps]\d+x\d+\//i.test(url);
    let width = Number(w) || 0;
    let height = Number(h) || 0;
    if (resizeMatch && !width) {
      width = Number(resizeMatch[1]) || 0;
      height = Number(resizeMatch[2]) || 0;
    } else if (isUnscaled && !width) {
      width = origW || 9999;
      height = origH || 9999;
    }
    candidates.push({ url, unscaled: isUnscaled ? 1 : 0, area: width * height, width, prio });
  };

  if (Array.isArray(node.image_versions2?.candidates)) {
    for (const c of node.image_versions2.candidates) {
      push(c?.url, c?.width, c?.height, 4);
    }
  }
  if (Array.isArray(node.display_resources)) {
    for (const c of node.display_resources) {
      push(c?.src, c?.config_width, c?.config_height, 3);
    }
  }
  if (node.display_url) {
    push(node.display_url, node.dimensions?.width, node.dimensions?.height, 2);
  }
  if (node.display_uri) {
    push(node.display_uri, 0, 0, 2);
  }
  if (Array.isArray(node.thumbnail_resources)) {
    for (const c of node.thumbnail_resources) {
      push(c?.src, c?.config_width, c?.config_height, 1);
    }
  }
  if (node.thumbnail_src) {
    push(node.thumbnail_src, 0, 0, 0);
  }

  if (!candidates.length) return '';
  candidates.sort((a, b) => (b.unscaled - a.unscaled) || (b.area - a.area) || (b.width - a.width) || (b.prio - a.prio));
  return candidates[0].url;
}

function pickBestVideoFromNode(node) {
  if (!node) return '';
  if (Array.isArray(node.video_versions) && node.video_versions.length) {
    const sorted = [...node.video_versions]
      .filter(v => v?.url && /^https?:\/\//i.test(v.url))
      .sort((a, b) => {
        const areaA = (Number(a.width) || 0) * (Number(a.height) || 0);
        const areaB = (Number(b.width) || 0) * (Number(b.height) || 0);
        if (areaB !== areaA) return areaB - areaA;
        if ((Number(b.width) || 0) !== (Number(a.width) || 0)) {
          return (Number(b.width) || 0) - (Number(a.width) || 0);
        }
        // In Polaris video_versions (no width/height), type 101 is highest progressive quality
        const rankA = Number(a.type) === 101 ? 0 : (Number(a.type) || 999);
        const rankB = Number(b.type) === 101 ? 0 : (Number(b.type) || 999);
        return rankA - rankB;
      });
    if (sorted[0]?.url) return sorted[0].url;
  }
  return node.video_url && /^https?:\/\//i.test(node.video_url) ? node.video_url : '';
}

function extractIgAudioTrack(media, shortcode, authorTitle) {
  const clipsMeta = media?.clips_metadata || media?.music_metadata || null;
  const musicAsset = clipsMeta?.music_info?.music_asset_info || null;
  const origSound = clipsMeta?.original_sound_info || null;
  const attrib = media?.clips_music_attribution_info || null;

  const audioUrl =
    musicAsset?.progressive_download_url ||
    musicAsset?.fast_start_progressive_download_url ||
    origSound?.progressive_download_url ||
    '';
  if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) return null;

  const title = musicAsset?.title || attrib?.song_name || origSound?.original_audio_title || 'Instagram Audio';
  const performer = musicAsset?.display_artist || attrib?.artist_name || origSound?.ig_artist?.username || authorTitle || '';
  const isMp3 = /\.mp3(?:[?#]|$)/i.test(audioUrl);
  return {
    url: audioUrl,
    headers: { 'User-Agent': USER_AGENT },
    title,
    performer,
    filename: `ig_${shortcode}_audio.${isMp3 ? 'mp3' : 'm4a'}`,
    mimeType: isMp3 ? 'audio/mpeg' : 'audio/mp4',
  };
}

function isIgVideoThumbnailUrl(rawUrl) {
  const m = String(rawUrl || '').match(/[?&]efg=([^&]+)/i);
  if (!m?.[1]) return false;
  try {
    const decoded = decodeBase64UrlJson(decodeURIComponent(m[1]));
    const tag = String(decoded?.vencode_tag || '').toLowerCase();
    return (
      tag.includes('video_') ||
      tag.includes('_thumbnail') ||
      tag.startsWith('clips.') ||
      tag.includes('igtv') ||
      tag.includes('reel')
    );
  } catch {
    return false;
  }
}

export function parseIgMediaObject(media, shortcode) {
  const slides = [];
  let hasMissingVideo = false;
  if (!media || typeof media !== 'object') {
    return { slides, authorTitle: '', postCaption: '', audioTrack: null, hasMissingVideo: false };
  }

  const authorTitle = media.owner?.username || media.user?.username || '';
  const postCaption = media.edge_media_to_caption?.edges?.[0]?.node?.text || media.caption?.text || '';

  const sidecarNodes = Array.isArray(media.edge_sidecar_to_children?.edges) && media.edge_sidecar_to_children.edges.length
    ? media.edge_sidecar_to_children.edges.map(e => e?.node).filter(Boolean)
    : (Array.isArray(media.carousel_media) && media.carousel_media.length ? media.carousel_media : null);

  const items = sidecarNodes || [media];
  items.forEach((node, idx) => {
    const suffix = items.length > 1 ? `_${idx + 1}` : '';
    const vidUrl = pickBestVideoFromNode(node);
    const explicitlyPhoto =
      node?.is_video === false ||
      node?.media_type === 1 ||
      node?.__typename === 'XIGPolarisImageMedia';
    const explicitlyVideo =
      node?.is_video === true ||
      node?.media_type === 2 ||
      node?.__typename === 'GraphVideo' ||
      node?.__typename === 'XIGPolarisVideoMedia' ||
      node?.product_type === 'clips' ||
      node?.product_type === 'igtv';

    if (!explicitlyPhoto && vidUrl) {
      slides.push({ type: 'video', url: vidUrl, filename: `ig_${shortcode}${suffix}.mp4` });
      return;
    }
    // Never substitute a video/reel cover thumbnail as a photo when Meta omits video_url
    if (explicitlyVideo) {
      hasMissingVideo = true;
      return;
    }
    const imgUrl = pickBestImageFromNode(node);
    if (imgUrl) {
      if (isIgVideoThumbnailUrl(imgUrl)) {
        hasMissingVideo = true;
        return;
      }
      const ext = getIgExtFromUrl(imgUrl, 'jpg');
      slides.push({ type: 'photo', url: imgUrl, filename: `ig_${shortcode}${suffix}.${ext}` });
    }
  });

  const isPhotoOnly = slides.length > 0 && !hasMissingVideo && slides.every(s => s.type === 'photo');
  const audioTrack = isPhotoOnly ? extractIgAudioTrack(media, shortcode, authorTitle) : null;
  return { slides, authorTitle, postCaption, audioTrack, hasMissingVideo };
}

function parseEmbedHtmlFallback(html, shortcode) {
  const slides = [];
  let authorTitle = '';
  let postCaption = '';

  const ownerMatch = html.match(/"username"\s*:\s*"([A-Za-z0-9_.]+)"/);
  const capMatch = html.match(/"edge_media_to_caption"\s*:\s*\{\s*"edges"\s*:\s*\[\s*\{\s*"node"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (ownerMatch) authorTitle = ownerMatch[1];
  if (capMatch) {
    try {
      postCaption = JSON.parse(`"${capMatch[1]}"`);
    } catch {}
  }

  const explicitlyNotVideo = /"is_video"\s*:\s*false/.test(html) && !/"is_video"\s*:\s*true/.test(html);
  const vidMatch = !explicitlyNotVideo
    ? (html.match(/"video_url"\s*:\s*"(https?:[^"]+)"/) || html.match(/<video[^>]+src="(https?:[^"]+)"/i))
    : null;
  if (vidMatch?.[1]) {
    slides.push({ type: 'video', url: unescapeIgString(vidMatch[1]), filename: `ig_${shortcode}.mp4` });
    return { slides, authorTitle, postCaption, audioTrack: null, hasMissingVideo: false };
  }

  // Reels/videos in /embed/captioned/ often omit video_url and render a WatchOnInstagram/VideoIcon overlay over a thumbnail <img>
  const looksLikeEmbedVideo =
    !explicitlyNotVideo &&
    (/"is_video"\s*:\s*true/.test(html) ||
      /"__typename"\s*:\s*"GraphVideo"/.test(html) ||
      /WatchOnInstagram|EmbeddedMediaVideo|videoSpritePlayButton|VideoIcon/i.test(html));
  if (looksLikeEmbedVideo) {
    return { slides: [], authorTitle, postCaption, audioTrack: null, hasMissingVideo: true };
  }

  const imgTagMatch =
    html.match(/<img[^>]*class="[^"]*EmbeddedMediaImage[^"]*"[^>]*>/i) ||
    html.match(/<img[^>]+src="https?:\/\/[^"]*(?:cdninstagram|fbcdn)[^"]*"[^>]*alt="Photo by[^"]*"[^>]*>/i);
  if (imgTagMatch) {
    const tag = imgTagMatch[0];
    let bestImg = '';
    const srcsetMatch = tag.match(/\bsrcset="([^"]+)"/i);
    if (srcsetMatch?.[1]) {
      let bestW = -1;
      for (const entry of srcsetMatch[1].split(',')) {
        const parts = entry.trim().split(/\s+/);
        if (!parts[0]) continue;
        const w = parseInt(parts[1] || '0', 10) || 0;
        if (w >= bestW) {
          bestW = w;
          bestImg = unescapeIgString(parts[0]);
        }
      }
    }
    if (!bestImg) {
      const srcMatch = tag.match(/\bsrc="([^"]+)"/i);
      if (srcMatch?.[1]) bestImg = unescapeIgString(srcMatch[1]);
    }
    if (bestImg && !/\/s150x150\//i.test(bestImg)) {
      if (isIgVideoThumbnailUrl(bestImg)) {
        return { slides: [], authorTitle, postCaption, audioTrack: null, hasMissingVideo: true };
      }
      const ext = getIgExtFromUrl(bestImg, 'jpg');
      slides.push({ type: 'photo', url: bestImg, filename: `ig_${shortcode}.${ext}` });
    }
  }

  return { slides, authorTitle, postCaption, audioTrack: null, hasMissingVideo: false };
}

function pickRicherIgResult(a, b) {
  if (!a || !a.slides.length) return b;
  if (!b || !b.slides.length) return a;
  if (b.slides.length > a.slides.length) return b;
  if (a.slides.length > b.slides.length) return a;
  if (!a.audioTrack && b.audioTrack) {
    return {
      ...b,
      authorTitle: b.authorTitle || a.authorTitle,
      postCaption: b.postCaption || a.postCaption,
    };
  }
  return {
    ...a,
    authorTitle: a.authorTitle || b.authorTitle,
    postCaption: a.postCaption || b.postCaption,
  };
}

const IG_MOBILE_UA =
  'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-S918B; dm3q; qcom; en_US; 458229237)';
const IG_SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const IG_GRAPHQL_DOC_IDS = ['8845758582119845', '10015901848480474', '24368985919464652', '27130156389949648'];

function shortcodeToMediaId(shortcode) {
  let id = 0n;
  for (const ch of String(shortcode || '')) {
    const idx = IG_SHORTCODE_ALPHABET.indexOf(ch);
    if (idx < 0) return '';
    id = id * 64n + BigInt(idx);
  }
  return id > 0n ? id.toString() : '';
}

function decodeBase64UrlJson(b64u) {
  const b64 = String(b64u || '').replace(/-/g, '+').replace(/_/g, '/');
  const clean = b64.replace(/=+$/, '');
  if (!clean) return null;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(128);
  lookup.fill(255);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = lookup[clean.charCodeAt(i)];
    const b = i + 1 < clean.length ? lookup[clean.charCodeAt(i + 1)] : 0;
    const c = i + 2 < clean.length ? lookup[clean.charCodeAt(i + 2)] : 0;
    const d = i + 3 < clean.length ? lookup[clean.charCodeAt(i + 3)] : 0;
    if (a === 255 || b === 255) return null;
    const triple = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
    if (o < out.length) out[o++] = (triple >> 16) & 0xff;
    if (i + 2 < clean.length && o < out.length) out[o++] = (triple >> 8) & 0xff;
    if (i + 3 < clean.length && o < out.length) out[o++] = triple & 0xff;
  }
  return JSON.parse(new TextDecoder('utf-8').decode(out));
}

export function normalizeIgCookie(raw) {
  const trimmed = String(raw || '').trim().replace(/^cookie:\s*/i, '');
  if (!trimmed) return '';
  if (!trimmed.includes('=')) {
    return `sessionid=${trimmed}; ig_nrcb=1`;
  }
  return /\big_nrcb=/i.test(trimmed) ? trimmed : `${trimmed}; ig_nrcb=1`;
}

function parseCsrfFromCookie(cookie) {
  return String(cookie || '').match(/(?:^|;\s*)csrftoken=([^;,\s]+)/i)?.[1] || '';
}

export async function verifyInstagramCookie(rawCookie) {
  const cookie = normalizeIgCookie(rawCookie);
  if (!cookie || !/sessionid=/i.test(cookie)) {
    return { ok: false, reason: 'Missing sessionid token.', cookie: '' };
  }
  try {
    const csrf = parseCsrfFromCookie(cookie);
    const res = await fetchWithTimeout(
      'https://i.instagram.com/api/v1/accounts/current_user/?edit=true',
      {
        headers: {
          'User-Agent': IG_MOBILE_UA,
          'X-IG-App-ID': '936619743392459',
          ...(csrf ? { 'X-CSRFToken': csrf } : {}),
          Cookie: cookie,
        },
      },
      8000
    );
    const data = await res.json().catch(() => null);
    if (res.ok && data?.user?.username) {
      return { ok: true, username: data.user.username, cookie };
    }
    if (res.status === 401 || res.status === 403 || /login_required|challenge|checkpoint/i.test(JSON.stringify(data || ''))) {
      return { ok: false, reason: data?.message || `HTTP ${res.status}`, cookie };
    }
    return { ok: false, reason: data?.message || `HTTP ${res.status}`, cookie };
  } catch (err) {
    return { ok: false, reason: err?.message || 'Verification failed', cookie };
  }
}

async function queryInstagramGraphql(shortcode, docId, auth = null) {
  const headers = {
    'User-Agent': USER_AGENT,
    'X-IG-App-ID': '936619743392459',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: 'https://www.instagram.com',
    Referer: `https://www.instagram.com/p/${shortcode}/`,
  };
  if (auth?.cookie) headers.Cookie = auth.cookie;
  if (auth?.csrfToken) headers['X-CSRFToken'] = auth.csrfToken;

  for (const endpoint of ['https://www.instagram.com/graphql/query', 'https://www.instagram.com/api/graphql']) {
    try {
      // Use SDK form helper (URLSearchParams does not exist in tgcloud v8go isolate)
      const gRes = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers,
          body: fetch.body.form({
            variables: JSON.stringify({ shortcode }),
            doc_id: docId,
          }),
        },
        10000
      );
      if (!gRes.ok) continue;
      const gj = await gRes.json().catch(() => null);
      const media =
        gj?.data?.xdt_shortcode_media ||
        gj?.data?.shortcode_media ||
        gj?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0] ||
        null;
      if (media) return parseIgMediaObject(media, shortcode);
    } catch {}
  }
  return null;
}

async function queryInstagramPolarisMedia(shortcode, auth = null) {
  const mediaId = shortcodeToMediaId(shortcode);
  if (!mediaId) return null;
  const lsd = 'AVqbxe3J_YA';
  const headers = {
    'User-Agent': USER_AGENT,
    'X-IG-App-ID': '936619743392459',
    'X-FB-LSD': lsd,
    'X-ASBD-ID': '129477',
    'X-FB-Friendly-Name': 'PolarisLoggedOutDesktopWWWPostRootContentQuery',
    'Sec-Fetch-Site': 'same-origin',
    Origin: 'https://www.instagram.com',
    Referer: `https://www.instagram.com/reel/${shortcode}/`,
  };
  if (auth?.cookie) headers.Cookie = auth.cookie;
  if (auth?.csrfToken) headers['X-CSRFToken'] = auth.csrfToken;

  try {
    const res = await fetchWithTimeout(
      'https://www.instagram.com/api/graphql',
      {
        method: 'POST',
        headers,
        body: fetch.body.form({
          lsd,
          fb_api_caller_class: 'RelayModern',
          fb_api_req_friendly_name: 'PolarisLoggedOutDesktopWWWPostRootContentQuery',
          server_timestamps: 'true',
          variables: JSON.stringify({ media_id: mediaId }),
          doc_id: '27130156389949648',
        }),
      },
      10000
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const root = data?.data?.xig_polaris_media;
    const media = root?.if_not_gated_logged_out || root;
    if (!media || typeof media !== 'object') return null;
    return parseIgMediaObject(media, shortcode);
  } catch {
    return null;
  }
}

export async function extractViaInstagramEmbedOrGraphql(shortcode, isReelUrl = false) {
  let embedResult = null;
  let metaAuthor = '';
  let metaCaption = '';

  // 0. Primary: PolarisLoggedOutDesktopWWWPostRootContentQuery (by numeric media_id)
  // Returns exact XIGPolarisVideoMedia (even with licensed music!) & XIGPolarisCarouselMedia / XIGPolarisImageMedia cleanly.
  const polaris = await queryInstagramPolarisMedia(shortcode);
  if (polaris) {
    metaAuthor = polaris.authorTitle || '';
    metaCaption = polaris.postCaption || '';
    if (polaris.slides.length && !polaris.hasMissingVideo) {
      return { ...polaris, metaAuthor, metaCaption };
    }
  }

  const embedUrls = isReelUrl
    ? [
        `https://www.instagram.com/reel/${shortcode}/embed/captioned/`,
        `https://www.instagram.com/p/${shortcode}/embed/captioned/`,
      ]
    : [`https://www.instagram.com/p/${shortcode}/embed/captioned/`];

  for (const embUrl of embedUrls) {
    // Prefer FB_UA / BOT_UA first: Meta increasingly returns login shells to desktop Chrome UA on /embed/captioned/
    for (const ua of [FB_UA, BOT_UA, USER_AGENT]) {
      try {
        const embRes = await fetchWithTimeout(embUrl, { headers: { 'User-Agent': ua, Accept: 'text/html' } }, 10000);
        if (!embRes.ok) continue;
        const html = await embRes.text();
        const mediaObj =
          extractJsonAfterKey(html, 'xdt_shortcode_media') ||
          extractJsonAfterKey(html, 'shortcode_media') ||
          extractJsonAfterKey(html, 'xdt_api__v1__media__shortcode__web_info')?.items?.[0] ||
          null;
        if (mediaObj) {
          const parsed = parseIgMediaObject(mediaObj, shortcode);
          metaAuthor = metaAuthor || parsed.authorTitle;
          metaCaption = metaCaption || parsed.postCaption;
          if (parsed.slides.length && !parsed.hasMissingVideo) {
            embedResult = parsed;
            if (parsed.slides.some(s => s.type === 'video') || parsed.audioTrack) {
              return { ...parsed, metaAuthor, metaCaption };
            }
            break;
          }
          if (parsed.hasMissingVideo) break;
        }
        if (!embedResult) {
          const htmlFallback = parseEmbedHtmlFallback(html, shortcode);
          metaAuthor = metaAuthor || htmlFallback.authorTitle;
          metaCaption = metaCaption || htmlFallback.postCaption;
          if (htmlFallback.slides.length && !htmlFallback.hasMissingVideo) {
            embedResult = htmlFallback;
            if (htmlFallback.slides[0].type === 'video') {
              return { ...htmlFallback, metaAuthor, metaCaption };
            }
            break;
          }
          if (htmlFallback.hasMissingVideo) break;
        }
      } catch {}
    }
    if (embedResult?.slides?.length) break;
  }

  for (const docId of IG_GRAPHQL_DOC_IDS.slice(0, 2)) {
    const gqlResult = await queryInstagramGraphql(shortcode, docId).catch(() => null);
    if (gqlResult?.slides?.length) {
      const richer = pickRicherIgResult(gqlResult, embedResult);
      return {
        ...richer,
        metaAuthor: richer.authorTitle || metaAuthor,
        metaCaption: richer.postCaption || metaCaption,
      };
    }
  }

  return embedResult
    ? { ...embedResult, metaAuthor, metaCaption }
    : { slides: [], authorTitle: '', postCaption: '', audioTrack: null, metaAuthor, metaCaption };
}

function decodeSnapSavePayload(jsText) {
  const argsMatch = String(jsText || '').match(/\}\("([^"]+)",\s*(\d+),\s*"([^"]+)",\s*(\d+),\s*(\d+),\s*(\d+)\)+/);
  if (!argsMatch) return String(jsText || '');
  const h = argsMatch[1];
  const n = argsMatch[3];
  const t = Number(argsMatch[4]);
  const e = Number(argsMatch[5]);
  const alpha = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/';
  const src = alpha.slice(0, e);
  const charMap = new Map();
  for (let j = 0; j < n.length; j++) charMap.set(n[j], String(j));

  const bytes = [];
  const delim = n[e];
  for (let i = 0; i < h.length; i++) {
    let s = '';
    while (i < h.length && h[i] !== delim) {
      s += charMap.get(h[i]) ?? h[i];
      i++;
    }
    if (!s) continue;
    let val = 0;
    for (let k = s.length - 1, p = 0; k >= 0; k--, p++) {
      const idx = src.indexOf(s[k]);
      if (idx !== -1) val += idx * Math.pow(e, p);
    }
    bytes.push((val - t) & 0xff);
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

function parseSnapSaveHtml(html, shortcode) {
  const cleanHtml = String(html || '').replace(/\\"/g, '"').replace(/\\\//g, '/');
  const hrefMatches = [...cleanHtml.matchAll(/href="(https?:\/\/(?:d\.rapidcdn\.app|[^"]*cdninstagram\.com|[^"]*fbcdn\.net|[^"]*snapsave[^"]*)[^"]*)"/gi)];
  const byKey = new Map();

  for (let i = 0; i < hrefMatches.length; i++) {
    const rawHref = decodeHtmlEntities(hrefMatches[i][1]);
    if (/play\.google\.com/i.test(rawHref)) continue;

    let jwt = null;
    const tokMatch = rawHref.match(/[?&]token=([^&]+)/);
    if (tokMatch?.[1]) {
      const parts = tokMatch[1].split('.');
      if (parts[1]) {
        try {
          jwt = decodeBase64UrlJson(parts[1]);
        } catch {}
      }
    }

    const innerUrl = jwt?.url || rawHref;
    const fnameHint = jwt?.filename || '';
    const isVideo = /\.mp4(?:[?#]|$)/i.test(fnameHint) || /\.mp4(?:[?#]|$)/i.test(innerUrl);
    const ext = isVideo ? 'mp4' : getIgExtFromUrl(fnameHint || innerUrl, 'jpg');

    const stemMatch = fnameHint.match(/(?:^|_)(\d{10,})_/);
    const dedupKey = stemMatch ? `id:${stemMatch[1]}` : `url:${innerUrl.split('?')[0]}`;
    const existing = byKey.get(dedupKey);
    if (!existing || (!existing.isVideo && isVideo)) {
      byKey.set(dedupKey, { isVideo, type: isVideo ? 'video' : 'photo', url: rawHref, ext });
    }
  }

  const entries = [...byKey.values()];
  return entries.map((item, idx) => ({
    type: item.type,
    url: item.url,
    filename: entries.length > 1 ? `ig_${shortcode}_${idx + 1}.${item.ext}` : `ig_${shortcode}.${item.ext}`,
  }));
}

async function extractViaSnapSave(targetUrls, shortcode) {
  const urlList = Array.isArray(targetUrls) ? targetUrls : [targetUrls];
  for (const targetUrl of urlList) {
    if (!targetUrl) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchWithTimeout(
          'https://snapsave.app/action.php?lang=en',
          {
            method: 'POST',
            headers: {
              'User-Agent': USER_AGENT,
              Origin: 'https://snapsave.app',
              Referer: 'https://snapsave.app/',
            },
            body: fetch.body.form({ url: targetUrl }),
          },
          12000
        );
        if (!res.ok) continue;
        const decoded = decodeSnapSavePayload(await res.text());
        if (!decoded) continue;
        if (/Unable to connect to Instagram server/i.test(decoded)) {
          continue;
        }
        const slides = parseSnapSaveHtml(decoded, shortcode);
        if (slides.length) return slides;
        break;
      } catch {}
    }
  }
  return [];
}

async function fetchIgOembedMeta(shortcode) {
  try {
    const oRes = await fetchWithTimeout(
      `https://i.instagram.com/api/v1/oembed/?url=${encodeURIComponent(`https://www.instagram.com/p/${shortcode}/`)}`,
      { headers: { 'User-Agent': USER_AGENT } },
      4500
    );
    if (!oRes.ok) return { authorTitle: '', postCaption: '' };
    const oj = await oRes.json().catch(() => null);
    return {
      authorTitle: oj?.author_name || '',
      postCaption: oj?.title || '',
    };
  } catch {
    return { authorTitle: '', postCaption: '' };
  }
}

async function extractWithIgCookie(shortcode, isReelUrl, rawCookie) {
  const cookie = normalizeIgCookie(rawCookie);
  if (!cookie) return { slides: [], authorTitle: '', postCaption: '', audioTrack: null, authRejected: false };
  const csrfToken = parseCsrfFromCookie(cookie);
  let authRejected = false;

  // 1. Authenticated Mobile Media Info API (works directly on MIN_AGE_ACCOUNT & region blocks)
  const mediaId = shortcodeToMediaId(shortcode);
  if (mediaId) {
    try {
      const mRes = await fetchWithTimeout(
        `https://i.instagram.com/api/v1/media/${mediaId}/info/`,
        {
          headers: {
            'User-Agent': IG_MOBILE_UA,
            'X-IG-App-ID': '936619743392459',
            ...(csrfToken ? { 'X-CSRFToken': csrfToken } : {}),
            Cookie: cookie,
          },
        },
        10000
      );
      const rawText = await mRes.text();
      if (mRes.status === 401 || mRes.status === 403 || /login_required|challenge_required|checkpoint_required/i.test(rawText)) {
        authRejected = true;
      }
      if (mRes.ok) {
        const mj = JSON.parse(rawText);
        const item = mj?.items?.[0];
        if (item) {
          const parsed = parseIgMediaObject(item, shortcode);
          if (parsed.slides.length) return { ...parsed, authRejected: false };
        }
      }
    } catch {}
  }

  // 2. Authenticated Web GraphQL fallback
  for (const docId of IG_GRAPHQL_DOC_IDS) {
    const parsed = await queryInstagramGraphql(shortcode, docId, { cookie, csrfToken }).catch(() => null);
    if (parsed?.slides?.length) return { ...parsed, authRejected: false };
  }

  // 3. Authenticated Web ?__a=1&__d=dis fallback
  try {
    const pathKind = isReelUrl ? 'reel' : 'p';
    const wRes = await fetchWithTimeout(
      `https://www.instagram.com/${pathKind}/${shortcode}/?__a=1&__d=dis`,
      {
        headers: {
          'User-Agent': USER_AGENT,
          'X-IG-App-ID': '936619743392459',
          ...(csrfToken ? { 'X-CSRFToken': csrfToken } : {}),
          Cookie: cookie,
        },
      },
      10000
    );
    if (wRes.status === 401 || wRes.status === 403) authRejected = true;
    if (wRes.ok) {
      const wj = await wRes.json().catch(() => null);
      const mediaObj = wj?.items?.[0] || wj?.graphql?.shortcode_media || null;
      if (mediaObj) {
        const parsed = parseIgMediaObject(mediaObj, shortcode);
        if (parsed.slides.length) return { ...parsed, authRejected: false };
      }
    }
  } catch {}

  return { slides: [], authorTitle: '', postCaption: '', audioTrack: null, authRejected };
}

async function diagnoseInstagramFailure(shortcode, { hasCookie = false, authRejected = false } = {}) {
  try {
    const oRes = await fetchWithTimeout(
      `https://i.instagram.com/api/v1/oembed/?url=${encodeURIComponent(`https://www.instagram.com/p/${shortcode}/`)}`,
      { headers: { 'User-Agent': USER_AGENT } },
      8000
    );
    const bodyText = await oRes.text();
    if (bodyText.includes('MIN_AGE_ACCOUNT') || bodyText.includes('geoblock_required')) {
      if (hasCookie && authRejected) {
        return '🔒 <b>Instagram Session Expired</b>\nThis post is age/region restricted (<code>MIN_AGE_ACCOUNT</code>), and the configured Instagram session cookie was rejected. Please update it via <code>/igcookie</code>.';
      }
      return '🔒 <b>Instagram Age / Region Restriction</b>\nThis post requires a logged-in 19+ Instagram account (<code>MIN_AGE_ACCOUNT</code>). Public anonymous extractors were blocked on this post.';
    }
    if (bodyText.includes('login_required')) {
      if (hasCookie && authRejected) {
        return '🔒 <b>Instagram Session Expired</b>\nThe configured Instagram session cookie was rejected (<code>login_required</code>). Please update it via <code>/igcookie</code>.';
      }
      return '🔒 <b>Instagram Login Required</b>\nInstagram refused public access to this post (private or restricted account).';
    }
  } catch {}
  return '❌ Could not find media in this Instagram link. The post may be private, deleted, or age-restricted.';
}

function buildInstagramCaption(authorTitle, postCaption) {
  const linkedAuthor = authorTitle ? linkifyPlatformMentions(escapeHtml(authorTitle), 'instagram') : '';
  const header = linkedAuthor ? `📸 <b>Instagram (${linkedAuthor})</b>` : '📸 <b>Instagram</b>';
  const linkedCaption = postCaption ? linkifyPlatformMentions(escapeHtml(postCaption), 'instagram') : '';
  return linkedCaption ? `${header}\n\n${linkedCaption}` : header;
}

async function resolveEeOriginalImage(shortcode, idx) {
  try {
    const imgUrl = `https://www.eeinstagram.com/images/${shortcode}/${idx}`;
    const res = await fetchWithTimeout(imgUrl, { headers: { 'User-Agent': USER_AGENT } }, 6000);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (res.ok && ct.startsWith('image/')) {
      const finalUrl = res.url || imgUrl;
      const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : getIgExtFromUrl(finalUrl, 'jpg');
      return { url: finalUrl, ext };
    }
  } catch {}
  return null;
}

export async function resolveEeMediaSlide(shortcode, idx, info, seenSlideUrls, options = {}) {
  if (!info || info.outOfRange || info.notFound) return null;
  const { isReelUrl = false } = options;
  const vidUrl = info.videoUrl || '';
  const imgUrl = info.imageUrl && !info.imageUrl.includes('/grid/') ? info.imageUrl : '';
  const suffix = idx > 1 ? `_${idx}` : '';

  // eeinstagram appends ?audio=1 to BOTH real videos AND photo+music posts!
  // Only unwrap to raw /images/<sc>/<idx> when NOT a reel AND the resolved image is NOT a video cover thumbnail.
  if (vidUrl && !isReelUrl && /\/videos\/[^/?#]+(?:\/\d+)?(?:\?.*audio=|$)/i.test(vidUrl)) {
    const origPhoto = await resolveEeOriginalImage(shortcode, idx);
    if (origPhoto && !isIgVideoThumbnailUrl(origPhoto.url) && !seenSlideUrls.has(origPhoto.url)) {
      seenSlideUrls.add(origPhoto.url);
      return { type: 'photo', url: origPhoto.url, filename: `ig_${shortcode}${suffix}.${origPhoto.ext}` };
    }
  }

  const chosen = vidUrl || imgUrl;
  if (!chosen || seenSlideUrls.has(chosen)) return null;
  seenSlideUrls.add(chosen);
  return {
    type: vidUrl ? 'video' : 'photo',
    url: chosen,
    filename: vidUrl ? `ig_${shortcode}${suffix}.mp4` : `ig_${shortcode}${suffix}.${getIgExtFromUrl(chosen, 'jpg')}`,
  };
}

export async function handleInstagram(chatId, url, replyToMsgId = null) {
  const showStatus = shouldSendStatusMessage(chatId);
  const taskToken = showStatus ? await createDownloadTask(chatId) : null;
  const shouldCancel = showStatus && taskToken ? () => isTaskCancelled(chatId, taskToken) : null;

  const statusMsg = showStatus
    ? await tgCall('sendMessage', {
        chat_id: chatId,
        text: '⏳ <b>Fetching Instagram media...</b>',
        parse_mode: 'HTML',
        reply_markup: cancelKeyboard(taskToken),
        ...(replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {}),
      }).catch(() => null)
    : null;

  try {
    let targetUrl = url;
    if (/instagram\.com\/share\//i.test(targetUrl)) {
      try {
        const shareRes = await fetchWithRetry(targetUrl, { headers: { 'User-Agent': FB_UA } }, 2);
        if (shareRes.url && !/instagram\.com\/share\//i.test(shareRes.url)) {
          targetUrl = shareRes.url;
        }
      } catch {}
    }

    const scMatch = targetUrl.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv|share)\/([A-Za-z0-9_-]+)/i);
    if (!scMatch) {
      await sendOrEditStatusError(chatId, statusMsg?.message_id, '❌ Invalid Instagram post or reel link.', replyToMsgId);
      return;
    }

    const shortcode = scMatch[1];
    const isReelUrl = /\/(?:reel|reels|tv)\//i.test(targetUrl);

    // Tier 1: Direct Instagram /embed/captioned/ + GraphQL (preserves original max-res images & separates Photo+Music from MP4 videos)
    const direct = await extractViaInstagramEmbedOrGraphql(shortcode, isReelUrl);
    if (direct.slides.length) {
      const fullCaption = buildInstagramCaption(direct.authorTitle, direct.postCaption);
      await sendSlidesAndCache(
        chatId,
        url,
        direct.slides,
        fullCaption,
        { 'User-Agent': USER_AGENT },
        replyToMsgId,
        statusMsg?.message_id || null,
        shouldCancel,
        direct.audioTrack ? { audioTrack: direct.audioTrack } : {}
      );
      return;
    }

    const slides = [];
    const seenSlideUrls = new Set();
    let authorTitle = direct.metaAuthor || '';
    let postCaption = direct.metaCaption || '';
    let slideHeaders = { 'User-Agent': BOT_UA };
    let audioTrack = null;

    // Tier 2: eeinstagram (Reels & multi-slide carousels; unwraps ?audio=1 photo slides back to original JPEGs)
    try {
      const baseInfo = await fetchEeInstagramBase(shortcode, isReelUrl);
      if (baseInfo) {
        if (baseInfo.rawTitle) authorTitle = baseInfo.rawTitle;
        if (baseInfo.rawDesc) postCaption = baseInfo.rawDesc;

        let isCarousel = baseInfo.isGrid;
        let slide2Info = null;
        if (!isReelUrl && !isCarousel && (baseInfo.videoUrl || baseInfo.imageUrl)) {
          try {
            const res2 = await fetchWithRetry(`https://www.eeinstagram.com/p/${shortcode}/2`, { headers: { 'User-Agent': BOT_UA } }, 2);
            if (res2.ok) {
              const info2 = parseEeInstagramHtml(await res2.text());
              const m2 = info2.videoUrl || info2.imageUrl;
              const m1 = baseInfo.videoUrl || baseInfo.imageUrl;
              if (!info2.outOfRange && !info2.notFound && m2 && m2 !== m1) {
                isCarousel = true;
                slide2Info = info2;
              }
            }
          } catch {}
        }

        if (isCarousel) {
          for (let idx = 1; idx <= 20; idx++) {
            let info;
            if (idx === 1 && !baseInfo.isGrid && (baseInfo.videoUrl || baseInfo.imageUrl)) info = baseInfo;
            else if (idx === 2 && slide2Info) info = slide2Info;
            else {
              const sRes = await fetchWithRetry(`https://www.eeinstagram.com/p/${shortcode}/${idx}`, { headers: { 'User-Agent': BOT_UA } }, 2);
              if (!sRes.ok) break;
              info = parseEeInstagramHtml(await sRes.text());
            }
            const slide = await resolveEeMediaSlide(shortcode, idx, info, seenSlideUrls, { isReelUrl: false });
            if (!slide) break;
            slides.push(slide);
          }
        } else {
          const single = await resolveEeMediaSlide(shortcode, 1, baseInfo, seenSlideUrls, { isReelUrl });
          if (single) slides.push(single);
        }
      }
    } catch {}

    // Tier 3: SnapSave external server pool (resilient carousel/reel extraction independent of embed rate limits)
    if (!slides.length) {
      const snapUrls = isReelUrl
        ? [`https://www.instagram.com/reel/${shortcode}/`, `https://www.instagram.com/p/${shortcode}/`]
        : [`https://www.instagram.com/p/${shortcode}/`, `https://www.instagram.com/reel/${shortcode}/`];
      const snapSlides = await extractViaSnapSave(snapUrls, shortcode);
      if (snapSlides.length) {
        slides.push(...snapSlides);
        slideHeaders = { 'User-Agent': USER_AGENT };
      }
    }

    // Tier 4: vxinstagram offload (supporting up to 48 MB videos via fetchMediaBuffer)
    if (!slides.length) {
      const maxVxSlides = isReelUrl ? 1 : 10;
      const seenVxFp = new Set();
      for (let idx = 0; idx < maxVxSlides; idx++) {
        try {
          const offloadUrl = `https://www.vxinstagram.com/offload/${shortcode}/${idx}`;
          const bytes = await fetchMediaBuffer(offloadUrl, { 'User-Agent': BOT_UA }, { maxBytes: TG_MAX_UPLOAD_BYTES, shouldCancel });
          const fp = computeByteFingerprint(bytes);
          if (!fp || seenVxFp.has(fp)) break;
          seenVxFp.add(fp);
          const isMp4 = bytes.length > 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
          slides.push({
            type: isMp4 ? 'video' : 'photo',
            url: offloadUrl,
            bytes,
            filename: `ig_${shortcode}_${idx + 1}.${isMp4 ? 'mp4' : 'jpg'}`,
          });
        } catch {
          break;
        }
      }
    }

    // Tier 5: Authenticated 19+ Session Cookie bypass for MIN_AGE_ACCOUNT / region / login gates
    let hasCookie = false;
    let authRejected = false;
    if (!slides.length) {
      const cookieRow = await getCachedEntry('setting:ig_cookie', 'config').catch(() => null);
      if (cookieRow?.fileId) {
        hasCookie = true;
        const authRes = await extractWithIgCookie(shortcode, isReelUrl, cookieRow.fileId);
        authRejected = authRes.authRejected;
        if (authRes.slides.length) {
          slides.push(...authRes.slides);
          authorTitle = authRes.authorTitle || authorTitle;
          postCaption = authRes.postCaption || postCaption;
          audioTrack = authRes.audioTrack || null;
          slideHeaders = { 'User-Agent': USER_AGENT };
        }
      }
    }

    if (!slides.length) {
      const diagReason = await diagnoseInstagramFailure(shortcode, { hasCookie, authRejected });
      await sendOrEditStatusError(chatId, statusMsg?.message_id, diagReason, replyToMsgId);
      return;
    }

    if (!authorTitle && !postCaption) {
      const meta = await fetchIgOembedMeta(shortcode);
      authorTitle = meta.authorTitle || '';
      postCaption = meta.postCaption || '';
    }

    const fullCaption = buildInstagramCaption(authorTitle, postCaption);

    await sendSlidesAndCache(
      chatId,
      url,
      slides,
      fullCaption,
      slideHeaders,
      replyToMsgId,
      statusMsg?.message_id || null,
      shouldCancel,
      audioTrack ? { audioTrack } : {}
    );
  } catch (err) {
    if (err?.code === 'CANCELLED' || String(err?.message || '').includes('CANCELLED_BY_USER')) {
      if (statusMsg?.message_id) {
        await safeEditMessage(chatId, statusMsg.message_id, '🛑 <b>Download cancelled.</b>');
      }
      return;
    }
    await sendOrEditStatusError(
      chatId,
      statusMsg?.message_id,
      `❌ Failed to fetch from Instagram: ${escapeHtml(err?.description || err?.message || 'Error')}`,
      replyToMsgId
    );
  } finally {
    if (taskToken) await cleanupDownloadTask(chatId, taskToken);
  }
}
