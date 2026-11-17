import { probeRemoteMedia } from '../http.js';
import { fetchAndRemuxHlsToMp4 } from '../hls.js';
import { sendSlidesAndCache } from '../delivery.js';
import {
  FB_UA,
  TG_MAX_UPLOAD_BYTES,
  USER_AGENT,
  cancelKeyboard,
  cleanupDownloadTask,
  createDownloadTask,
  decodeHtmlEntities,
  escapeHtml,
  fetchWithRetry,
  isTaskCancelled,
  linkifyPlatformMentions,
  safeEditMessage,
  sendOrEditStatusError,
  shouldSendStatusMessage,
  tgCall,
} from './common.js';

function cleanPinUrl(raw) {
  return decodeHtmlEntities(String(raw || '').replace(/\\u002F/gi, '/').replace(/\\\//g, '/'));
}

function extractPinImageStem(imgUrl) {
  if (!imgUrl) return '';
  const clean = imgUrl.split('?')[0].split('#')[0];
  const m = clean.match(/\/([a-f0-9]{16,})(?:_[a-z0-9]+)?\.[a-z0-9]+$/i);
  return m ? m[1].toLowerCase() : '';
}

function getPinExt(imgUrl) {
  const m = String(imgUrl || '').split('?')[0].match(/\.(png|webp|gif|jpe?g)$/i);
  return m ? (m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()) : 'jpg';
}

function extractBalancedBraceObject(text, openIdx) {
  if (openIdx < 0 || text[openIdx] !== '{') return '';
  let depth = 0;
  let inStr = false;
  let escaped = false;
  const maxEnd = Math.min(text.length, openIdx + 250000);
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

function extractStoryPinOrigUrls(html, pinId) {
  const results = [];
  const seen = new Set();
  const key = '"story_pin_data"';
  let searchFrom = 0;
  while (searchFrom < html.length) {
    const idx = html.indexOf(key, searchFrom);
    if (idx < 0) break;
    searchFrom = idx + key.length;
    if (pinId) {
      const windowBefore = html.slice(Math.max(0, idx - 4000), idx);
      if (!windowBefore.includes(`"${pinId}"`)) continue;
    }
    const braceStart = html.indexOf('{', idx + key.length);
    if (braceStart < 0 || braceStart - idx > 20) continue;
    const block = extractBalancedBraceObject(html, braceStart);
    if (!block) continue;
    for (const m of block.matchAll(/"orig"\s*:\s*\{[^}]*?"url"\s*:\s*"(https?:[^"]+)"/gi)) {
      const u = cleanPinUrl(m[1]);
      if (u && !seen.has(u)) {
        seen.add(u);
        results.push(u);
      }
    }
    if (results.length > 0) break;
  }
  return results;
}

export async function resolvePinterestPhotoUrls(html, pinId = '', probeFn = probeRemoteMedia) {
  const imgMatch =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) ||
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i) ||
    html.match(/<meta[^>]+name="twitter:image:src"[^>]+content="([^"]+)"/i) ||
    html.match(/<meta[^>]+content="([^"]+)"[^>]+name="twitter:image:src"/i);
  const metaImgUrl = imgMatch?.[1] ? decodeHtmlEntities(imgMatch[1]) : '';
  const metaStem = extractPinImageStem(metaImgUrl);

  const storyUrls = extractStoryPinOrigUrls(html, pinId);
  if (storyUrls.length > 0) return storyUrls;

  const allOrig = [];
  const seenOrig = new Set();
  for (const m of html.matchAll(/"orig"\s*:\s*\{[^}]*?"url"\s*:\s*"(https?:[^"]+)"/gi)) {
    const u = cleanPinUrl(m[1]);
    if (u && !seenOrig.has(u)) {
      seenOrig.add(u);
      allOrig.push(u);
    }
  }
  for (const m of html.matchAll(/https?:\/\/i\.pinimg\.com\/originals\/[^"'\s\\]+\.(?:jpg|jpeg|png|webp|gif)/gi)) {
    const u = cleanPinUrl(m[0]);
    if (u && !seenOrig.has(u)) {
      seenOrig.add(u);
      allOrig.push(u);
    }
  }

  if (metaStem) {
    const stemMatch = allOrig.find(u => extractPinImageStem(u) === metaStem);
    if (stemMatch) return [stemMatch];

    const scaledMatch = metaImgUrl.match(/^(https?:\/\/i\.pinimg\.com)\/\d+x(?:_[a-z0-9]+)?\/(.+)$/i);
    if (scaledMatch) {
      const headers = { 'User-Agent': USER_AGENT, Referer: 'https://www.pinterest.com/' };
      const origSameExt = `${scaledMatch[1]}/originals/${scaledMatch[2]}`;
      try {
        const probe = await probeFn(origSameExt, headers);
        if (probe?.ok) return [origSameExt];
      } catch {}
      if (/\.jpe?g(?:[?#]|$)/i.test(origSameExt)) {
        const origPng = origSameExt.replace(/\.jpe?g(?=[?#]|$)/i, '.png');
        try {
          const probePng = await probeFn(origPng, headers);
          if (probePng?.ok) return [origPng];
        } catch {}
      }
    }
    if (metaImgUrl) return [metaImgUrl];
  }

  if (metaImgUrl) return [metaImgUrl];
  return allOrig.length > 0 ? [allOrig[0]] : [];
}

export async function handlePinterest(chatId, url, replyToMsgId = null) {
  const showStatus = shouldSendStatusMessage(chatId);
  const taskToken = showStatus ? await createDownloadTask(chatId) : null;
  const shouldCancel = showStatus && taskToken ? () => isTaskCancelled(chatId, taskToken) : null;

  const statusMsg = showStatus
    ? await tgCall('sendMessage', {
        chat_id: chatId,
        text: '⏳ <b>Fetching Pinterest media...</b>',
        parse_mode: 'HTML',
        reply_markup: cancelKeyboard(taskToken),
        ...(replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {}),
      }).catch(() => null)
    : null;

  try {
    const res = await fetchWithRetry(url, { headers: { 'User-Agent': FB_UA }, timeoutMs: 12000 }, 2);
    let html = await res.text();

    const pinIdMatch = (res.url || url).match(/\/pin\/(\d+)/) || html.match(/\/pin\/(\d+)/);
    if (pinIdMatch && (res.url || '').includes('/sent/')) {
      const cleanRes = await fetchWithRetry(
        `https://www.pinterest.com/pin/${pinIdMatch[1]}/`,
        { headers: { 'User-Agent': FB_UA } },
        2
      );
      if (cleanRes.ok) html = await cleanRes.text();
    }

    const titleMatch =
      html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i) ||
      html.match(/<meta[^>]+content="([^"]*)"[^>]+property="og:title"/i);
    const descMatch =
      html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i) ||
      html.match(/<meta[^>]+content="([^"]*)"[^>]+property="og:description"/i);

    const rawTitle = titleMatch?.[1] && titleMatch[1] !== 'Pinterest' ? decodeHtmlEntities(titleMatch[1]) : '';
    const rawDesc = descMatch?.[1] ? decodeHtmlEntities(descMatch[1]) : '';
    const linkedTitle = rawTitle ? linkifyPlatformMentions(escapeHtml(rawTitle), 'pinterest') : '';
    const linkedDesc = rawDesc ? linkifyPlatformMentions(escapeHtml(rawDesc), 'pinterest') : '';

    let caption = '📌 <b>Pinterest</b>';
    if (linkedTitle && linkedDesc && linkedDesc !== linkedTitle) {
      caption = `📌 <b>${linkedTitle}</b>\n\n${linkedDesc}`;
    } else if (linkedTitle || linkedDesc) {
      caption = `📌 <b>${linkedTitle || linkedDesc}</b>`;
    }

    const slides = [];
    const seenUrls = new Set();

    // 1. Direct MP4 URLs (including 720p, > 48 MB split automatically via delivery.js)
    const mp4Matches = [...html.matchAll(/https:\/\/v\d*\.pinimg\.com\/videos\/[^"'\s\\]+\.mp4/gi)];
    const candidateVideos = [];
    for (const m of mp4Matches) {
      const cleanVid = cleanPinUrl(m[0]);
      if (!seenUrls.has(cleanVid)) {
        seenUrls.add(cleanVid);
        candidateVideos.push(cleanVid);
      }
    }
    if (candidateVideos.length > 0) {
      const bestVid = candidateVideos.find(v => v.includes('/720p/')) || candidateVideos[0];
      slides.push({ type: 'video', url: bestVid, filename: 'pinterest_1.mp4' });
    }

    // 2. Native HLS (.m3u8) remux via pure-JS hls.js (with /720p/*.mp4 fallback)
    if (slides.length === 0) {
      const m3u8Matches = [...html.matchAll(/https:\/\/v\d*\.pinimg\.com\/videos\/[^"'\s\\]+\.m3u8/gi)];
      if (m3u8Matches.length > 0) {
        const hlsUrl = cleanPinUrl(m3u8Matches[0][0]);
        try {
          const remuxed = await fetchAndRemuxHlsToMp4(hlsUrl, { 'User-Agent': USER_AGENT }, {
            maxBytes: TG_MAX_UPLOAD_BYTES - 1024 * 1024,
            shouldCancel,
          });
          slides.push({
            type: 'video',
            bytes: remuxed.buffer,
            width: remuxed.width,
            height: remuxed.height,
            duration: remuxed.durationSec,
            filename: 'pinterest_1.mp4',
          });
        } catch {
          const fallbackMp4 = hlsUrl.replace('/hls/', '/720p/').replace(/\.m3u8$/i, '.mp4');
          slides.push({ type: 'video', url: fallbackMp4, filename: 'pinterest_1.mp4' });
        }
      }
    }

    // 3. Multi-slide / original images scoped to the requested pin (never recommended pins)
    if (slides.length === 0) {
      const photoUrls = await resolvePinterestPhotoUrls(html, pinIdMatch?.[1] || '');
      photoUrls.forEach((photoUrl, idx) => {
        if (!seenUrls.has(photoUrl)) {
          seenUrls.add(photoUrl);
          const ext = getPinExt(photoUrl);
          slides.push({
            type: 'photo',
            url: photoUrl,
            filename: photoUrls.length > 1 ? `pinterest_${idx + 1}.${ext}` : `pinterest.${ext}`,
          });
        }
      });
    }

    if (slides.length === 0) {
      await sendOrEditStatusError(
        chatId,
        statusMsg?.message_id,
        '❌ No downloadable media found on this Pinterest link.',
        replyToMsgId
      );
      return;
    }

    await sendSlidesAndCache(
      chatId,
      url,
      slides,
      caption,
      { 'User-Agent': USER_AGENT, Referer: 'https://www.pinterest.com/' },
      replyToMsgId,
      statusMsg?.message_id || null,
      shouldCancel
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
      `❌ Failed to download Pinterest media: ${escapeHtml(err?.description || err?.message || 'Error')}`,
      replyToMsgId
    );
  } finally {
    if (taskToken) await cleanupDownloadTask(chatId, taskToken);
  }
}
