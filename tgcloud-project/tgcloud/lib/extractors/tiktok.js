import { fetchWithTimeout, probeRemoteMedia } from '../http.js';
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

let tikwmCooldownUntil = 0;

async function extractFromTikwm(url) {
  if (Date.now() < tikwmCooldownUntil) return null;
  const res = await fetchWithRetry(
    `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`,
    { headers: { 'User-Agent': USER_AGENT }, timeoutMs: 10000 },
    2
  );
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) {
      tikwmCooldownUntil = Date.now() + 30000;
    }
    return null;
  }
  const json = await res.json();
  const d = json?.data;
  if (!d || (!d.play && !d.hdplay && !d.images?.length)) return null;

  // For explicit /photo/ URLs, only accept Tikwm if it actually preserved the image list
  if (/\/photo\/\d+/i.test(url) && !(Array.isArray(d.images) && d.images.length > 0)) {
    return null;
  }

  const uniqueId = d.author?.unique_id;
  const nickname = escapeHtml(d.author?.nickname || uniqueId || 'TikTok');
  const authorHeader = uniqueId
    ? `<a href="https://www.tiktok.com/@${escapeHtml(uniqueId)}">${nickname}</a>`
    : nickname;
  const linkedTitle = d.title ? linkifyPlatformMentions(escapeHtml(d.title), 'tiktok') : '';
  const caption = linkedTitle ? `🎬 <b>${authorHeader}</b>\n\n${linkedTitle}` : `🎬 <b>${authorHeader}</b>`;

  if (Array.isArray(d.images) && d.images.length > 0) {
    return {
      caption,
      slides: d.images.map((imgUrl, idx) => ({
        type: 'photo',
        url: imgUrl,
        filename: `tiktok_${idx + 1}.jpg`,
      })),
      musicUrl: d.music || null,
      musicTitle: d.music_info?.title || 'TikTok Audio',
      musicAuthor: d.music_info?.author || d.author?.nickname || 'TikTok',
      headers: { 'User-Agent': USER_AGENT },
    };
  }

  let videoUrl = d.play;
  if (d.hdplay && d.hdplay !== d.play) {
    // Prefer HD whenever it fits cleanly in <= 48 MB OR when SD itself also exceeds 48 MB
    const hdProbe = await probeRemoteMedia(d.hdplay, { 'User-Agent': USER_AGENT });
    if (hdProbe.ok && (!hdProbe.contentLength || hdProbe.contentLength <= TG_MAX_UPLOAD_BYTES)) {
      videoUrl = d.hdplay;
    } else if (!d.play) {
      videoUrl = d.hdplay;
    } else if (hdProbe.contentLength > TG_MAX_UPLOAD_BYTES) {
      const sdProbe = await probeRemoteMedia(d.play, { 'User-Agent': USER_AGENT });
      if (!sdProbe.ok || sdProbe.contentLength > TG_MAX_UPLOAD_BYTES) {
        videoUrl = d.hdplay;
      }
    }
  }

  return {
    caption,
    slides: [{ type: 'video', url: videoUrl, filename: 'tiktok.mp4' }],
    musicUrl: null,
    headers: { 'User-Agent': USER_AGENT },
  };
}

async function extractFromTikTokWeb(url) {
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    },
    12000
  );
  if (!res.ok) return null;
  const setCookie = res.headers?.get?.('set-cookie') || '';
  const cookieHeader = setCookie
    .split(/,(?=[^;]+=[^;]+)/)
    .map(c => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
  const html = await res.text();
  const m = html.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;

  let parsed;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return null;
  }

  const item = parsed?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
  if (!item) return null;

  const uniqueId = item.author?.uniqueId || '';
  const nickname = escapeHtml(item.author?.nickname || uniqueId || 'TikTok');
  const authorHeader = uniqueId
    ? `<a href="https://www.tiktok.com/@${escapeHtml(uniqueId)}">${nickname}</a>`
    : nickname;
  const linkedDesc = item.desc ? linkifyPlatformMentions(escapeHtml(item.desc), 'tiktok') : '';
  const caption = linkedDesc ? `🎬 <b>${authorHeader}</b>\n\n${linkedDesc}` : `🎬 <b>${authorHeader}</b>`;
  const headers = {
    'User-Agent': USER_AGENT,
    Referer: 'https://www.tiktok.com/',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };

  if (Array.isArray(item.imagePost?.images) && item.imagePost.images.length > 0) {
    const slides = item.imagePost.images
      .map((img, idx) => {
        const list = [
          ...(img?.imageURL?.urlList || []),
          ...(img?.displayImage?.urlList || []),
        ].filter(Boolean);
        const imgUrl = list.find(u => !/\.heic(?:\?|$)/i.test(u)) || list[0];
        return imgUrl ? { type: 'photo', url: imgUrl, filename: `tiktok_${idx + 1}.jpg` } : null;
      })
      .filter(Boolean);
    if (slides.length) {
      return {
        caption,
        slides,
        musicUrl: item.music?.playUrl || null,
        musicTitle: item.music?.title || 'TikTok Audio',
        musicAuthor: item.music?.authorName || item.author?.nickname || 'TikTok',
        headers,
      };
    }
  }

  const playUrl = item.video?.playAddr || item.video?.downloadAddr || '';
  if (!playUrl) return null;
  return {
    caption,
    slides: [{ type: 'video', url: playUrl, filename: 'tiktok.mp4' }],
    musicUrl: null,
    headers,
  };
}

export async function handleTikTok(chatId, url, replyToMsgId = null) {
  const showStatus = shouldSendStatusMessage(chatId);
  const taskToken = showStatus ? await createDownloadTask(chatId) : null;
  const shouldCancel = showStatus && taskToken ? () => isTaskCancelled(chatId, taskToken) : null;

  const statusMsg = showStatus
    ? await tgCall('sendMessage', {
        chat_id: chatId,
        text: '⏳ <b>Fetching TikTok media...</b>',
        parse_mode: 'HTML',
        reply_markup: cancelKeyboard(taskToken),
        ...(replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {}),
      }).catch(() => null)
    : null;

  try {
    let extracted = null;
    try {
      extracted = await extractFromTikwm(url);
    } catch {
      tikwmCooldownUntil = Date.now() + 20000;
    }
    if (!extracted) {
      try {
        extracted = await extractFromTikTokWeb(url);
      } catch {}
    }

    if (!extracted || !extracted.slides?.length) {
      await sendOrEditStatusError(chatId, statusMsg?.message_id, '❌ Video not found or post is private.', replyToMsgId);
      return;
    }

    const audioTrack = extracted.musicUrl
      ? {
          url: extracted.musicUrl,
          headers: extracted.headers,
          title: extracted.musicTitle,
          performer: extracted.musicAuthor,
          filename: 'tiktok_audio.mp3',
          mimeType: 'audio/mpeg',
        }
      : null;

    await sendSlidesAndCache(
      chatId,
      url,
      extracted.slides,
      extracted.caption,
      extracted.headers,
      replyToMsgId,
      statusMsg?.message_id || null,
      shouldCancel,
      { audioTrack }
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
      `❌ Failed to download TikTok media: ${escapeHtml(err?.description || err?.message || 'Error')}`,
      replyToMsgId
    );
  } finally {
    if (taskToken) await cleanupDownloadTask(chatId, taskToken);
  }
}
