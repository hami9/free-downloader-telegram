import { fetchAndRemuxHlsToMp4 } from '../hls.js';
import { mapWithConcurrency, probeRemoteMedia } from '../http.js';
import { sendSlidesAndCache } from '../delivery.js';
import {
  TG_MAX_UPLOAD_BYTES,
  USER_AGENT,
  cancelKeyboard,
  cleanupDownloadTask,
  createDownloadTask,
  escapeHtml,
  fetchWithRetry,
  isTaskCancelled,
  linkifyPlatformMentions,
  safeEditMessage,
  sendOrEditStatusError,
  shouldSendStatusMessage,
  tgCall,
} from './common.js';

export function upgradeTwitterPhotoUrl(rawUrl) {
  if (!rawUrl || !/pbs\.twimg\.com\/media\//i.test(rawUrl)) return rawUrl;
  const qIdx = rawUrl.indexOf('?');
  const base = (qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl).replace(/:(small|medium|large|thumb|orig)$/i, '');
  const query = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '';
  const extMatch = base.match(/\.(jpg|jpeg|png|webp)$/i);
  const parts = query ? query.split('&').filter(p => p && !/^name=/i.test(p)) : [];
  if (extMatch && !parts.some(p => /^format=/i.test(p))) {
    parts.push(`format=${extMatch[1].toLowerCase().replace('jpeg', 'jpg')}`);
  }
  parts.push('name=orig');
  return `${base}?${parts.join('&')}`;
}

async function chooseBestMp4Variant(variants, durationSec = 30) {
  const mp4s = (variants || [])
    .filter(v => v.url && (!v.content_type || v.content_type === 'video/mp4'))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  if (!mp4s.length) return null;

  // Probe top 3 bitrate MP4 variants concurrently to save roundtrips
  const maxBits = TG_MAX_UPLOAD_BYTES * 8;
  const topCandidates = mp4s.slice(0, 3);
  const probes = await mapWithConcurrency(topCandidates, 3, v =>
    probeRemoteMedia(v.url, { 'User-Agent': USER_AGENT }).catch(() => null)
  );
  for (let i = 0; i < topCandidates.length; i++) {
    const p = probes[i];
    if (p?.ok && p.contentLength > 0 && p.contentLength <= TG_MAX_UPLOAD_BYTES) {
      return topCandidates[i].url;
    }
    if (topCandidates[i].bitrate && topCandidates[i].bitrate * durationSec <= maxBits && (!p?.contentLength || p.contentLength <= TG_MAX_UPLOAD_BYTES)) {
      return topCandidates[i].url;
    }
  }
  return mp4s[0].url;
}

async function fetchFromFxTwitter(cleanPath) {
  const res = await fetchWithRetry(`https://api.fxtwitter.com${cleanPath}`, { headers: { 'User-Agent': USER_AGENT } }, 2);
  if (!res.ok) return null;
  const data = await res.json();
  return data?.tweet || null;
}

async function fetchFromVxTwitter(cleanPath) {
  const res = await fetchWithRetry(`https://api.vxtwitter.com${cleanPath}`, { headers: { 'User-Agent': USER_AGENT } }, 2);
  if (!res.ok) return null;
  const d = await res.json();
  if (!d || (!d.media_extended?.length && !d.text)) return null;
  return {
    author: { name: d.user_name || 'X', screen_name: d.user_screen_name || '' },
    text: d.text || '',
    media: {
      all: (d.media_extended || []).map(m => ({
        type: m.type === 'gif' || m.type === 'video' ? 'video' : 'photo',
        url: m.url,
        duration: m.duration_millis ? m.duration_millis / 1000 : 30,
      })),
    },
  };
}

async function fetchFromSyndication(tweetId) {
  if (!tweetId) return null;
  const res = await fetchWithRetry(
    `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=a`,
    { headers: { 'User-Agent': USER_AGENT } },
    2
  );
  if (!res.ok) return null;
  const d = await res.json();
  if (!d || (!d.mediaDetails?.length && !d.text)) return null;
  const mediaAll = (d.mediaDetails || []).map(m => {
    if (m.type === 'video' || m.type === 'animated_gif') {
      const dur = m.video_info?.duration_millis ? m.video_info.duration_millis / 1000 : 30;
      const variants = m.video_info?.variants || [];
      const hls = variants.find(v => v.content_type === 'application/x-mpegURL' || /\.m3u8/i.test(v.url || ''));
      return {
        type: 'video',
        url: variants.find(v => v.content_type === 'video/mp4')?.url || hls?.url || '',
        variants,
        hlsUrl: hls?.url || '',
        duration: dur,
      };
    }
    return { type: 'photo', url: m.media_url_https || m.url };
  });
  return {
    author: { name: d.user?.name || 'X', screen_name: d.user?.screen_name || '' },
    text: d.text || '',
    media: { all: mediaAll },
  };
}

export async function handleX(chatId, url, replyToMsgId = null) {
  const showStatus = shouldSendStatusMessage(chatId);
  const taskToken = showStatus ? await createDownloadTask(chatId) : null;
  const shouldCancel = showStatus && taskToken ? () => isTaskCancelled(chatId, taskToken) : null;

  const statusMsg = showStatus
    ? await tgCall('sendMessage', {
        chat_id: chatId,
        text: '⏳ <b>Fetching X media...</b>',
        parse_mode: 'HTML',
        reply_markup: cancelKeyboard(taskToken),
        ...(replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {}),
      }).catch(() => null)
    : null;

  try {
    const pathMatch = url.match(/https?:\/\/(?:www\.|mobile\.|fx|vx)?(?:x\.com|twitter\.com)(\/[^?#\s]+)/i);
    if (!pathMatch) throw new Error('Invalid X link format');
    const cleanPath = pathMatch[1];
    const idMatch = cleanPath.match(/\/status\/(\d+)/);
    const tweetId = idMatch ? idMatch[1] : null;

    const tweet =
      (await fetchFromFxTwitter(cleanPath).catch(() => null)) ||
      (await fetchFromVxTwitter(cleanPath).catch(() => null)) ||
      (await fetchFromSyndication(tweetId).catch(() => null));

    if (!tweet) {
      await sendOrEditStatusError(chatId, statusMsg?.message_id, '❌ Post not found or account is private.', replyToMsgId);
      return;
    }

    const author = escapeHtml(tweet.author?.name || 'X');
    const screenName = tweet.author?.screen_name;
    const handle = screenName
      ? ` (<a href="https://x.com/${escapeHtml(screenName)}">@${escapeHtml(screenName)}</a>)`
      : '';
    const text = tweet.text ? linkifyPlatformMentions(escapeHtml(tweet.text), 'x') : '';
    const caption = text ? `🐦 <b>${author}${handle}:</b>\n\n${text}` : `🐦 <b>${author}${handle}</b>`;

    const allMedia = tweet.media?.all || [
      ...(tweet.media?.videos || []).map(v => ({ ...v, type: 'video' })),
      ...(tweet.media?.photos || []).map(p => ({ ...p, type: 'photo' })),
    ];

    if (!allMedia.length) {
      if (text) {
        await sendOrEditStatusError(chatId, statusMsg?.message_id, caption.slice(0, 4000), replyToMsgId);
        return;
      }
      await sendOrEditStatusError(chatId, statusMsg?.message_id, '❌ No video or media found in this post.', replyToMsgId);
      return;
    }

    const slides = [];
    for (let i = 0; i < allMedia.length; i++) {
      const m = allMedia[i];
      if (m.type === 'video' || m.type === 'gif') {
        const dur = m.duration || 30;
        let targetUrl = m.url;
        if (Array.isArray(m.variants) && m.variants.length) {
          targetUrl = (await chooseBestMp4Variant(m.variants, dur)) || targetUrl;
        }
        if ((!targetUrl || /\.m3u8(?:\?|$)/i.test(targetUrl)) && (m.hlsUrl || targetUrl)) {
          const hlsUrl = m.hlsUrl || targetUrl;
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
            filename: `x_video_${i + 1}.mp4`,
          });
        } else if (targetUrl) {
          slides.push({ type: 'video', url: targetUrl, filename: `x_video_${i + 1}.mp4` });
        }
      } else if (m.url) {
        const origUrl = upgradeTwitterPhotoUrl(m.url);
        const ext = /[?&]format=png|\.png(?:\?|$)/i.test(origUrl) ? 'png' : 'jpg';
        slides.push({ type: 'photo', url: origUrl, filename: `x_photo_${i + 1}.${ext}` });
      }
    }

    await sendSlidesAndCache(
      chatId,
      url,
      slides,
      caption,
      { 'User-Agent': USER_AGENT },
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
      `❌ Failed to download X media: ${escapeHtml(err?.description || err?.message || 'Error')}`,
      replyToMsgId
    );
  } finally {
    if (taskToken) await cleanupDownloadTask(chatId, taskToken);
  }
}

export const handleTwitter = handleX;
