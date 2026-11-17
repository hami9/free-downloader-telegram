import { api } from 'sdk';
import {
  handleYouTubeDownload,
  handleMediaPartCallback,
  handleOriginalFileCallback,
  handleAudioCallback,
  cancelDownloadTask,
  sendCachedEntry,
  runWithSingleflight,
  getCachedEntry,
  claimUpdateLock,
  releaseUpdateLock,
  safeDeleteMessage,
  safeEditMessageText,
} from '../lib/media.js';

export default async function (query, ctx) {
  const data = query.data || '';
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  // Maintain original user's link reply thread if present
  const replyToMsgId = query.message?.reply_to_message?.message_id || messageId;

  // 1. Handle Cancel Download button
  if (data.startsWith('ytc|')) {
    const [, token] = data.split('|');
    if (chatId && token) {
      await cancelDownloadTask(chatId, token);
    }
    try {
      await api.answerCallbackQuery({
        callback_query_id: query.id,
        text: '🛑 Cancelling download...',
      });
    } catch (e) {}
    if (chatId && messageId) {
      await safeEditMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: '🛑 <b>Download cancelled.</b>',
        parse_mode: 'HTML',
      });
    }
    return;
  }

  const isYtQuality = data.startsWith('ytq|');
  const isYtPart = data.startsWith('ytp|');
  const isMediaPart = data.startsWith('mp|');
  const isOrigPhoto = data.startsWith('orig|');
  const isPostAudio = data.startsWith('aud|');

  if ((!isYtQuality && !isYtPart && !isMediaPart && !isOrigPhoto && !isPostAudio) || !chatId) {
    try {
      await api.answerCallbackQuery({ callback_query_id: query.id });
    } catch (e) {}
    return;
  }

  // 2. Prevent Telegram webhook retries for the exact same callback_query.id
  if (query.id) {
    const cbqAcquired = await claimUpdateLock(chatId, `cbq_${query.id}`, 3600);
    if (!cbqAcquired) {
      return;
    }
  }

  // 3. Prevent concurrent double-tap of the same button on the same message
  const lockSuffix = isYtPart || isMediaPart || isOrigPhoto || isPostAudio ? data : messageId;
  const activeMsgLock = lockSuffix ? `ytdl_${lockSuffix}` : null;
  if (activeMsgLock) {
    const msgAcquired = await claimUpdateLock(chatId, activeMsgLock, 300);
    if (!msgAcquired) {
      try {
        await api.answerCallbackQuery({
          callback_query_id: query.id,
          text: '⏳ Download is already in progress...',
        });
      } catch (e) {}
      return;
    }
  }

  try {
    await api.answerCallbackQuery({ callback_query_id: query.id });
  } catch (e) {}

  try {
    if (isOrigPhoto) {
      const [, target, refId] = data.split('|');
      await handleOriginalFileCallback({ chatId, target, refId, replyToMsgId });
      return;
    }

    if (isPostAudio) {
      const [, refId] = data.split('|');
      await handleAudioCallback({ chatId, refId, replyToMsgId });
      return;
    }

    if (isMediaPart) {
      const [, partStr, refId] = data.split('|');
      const partIndex = Math.max(1, Number(partStr) || 1);
      await handleMediaPartCallback({ chatId, partIndex, refId, messageId, replyToMsgId });
      return;
    }

    let quality;
    let videoId;
    let partIndex = 1;
    if (isYtPart) {
      const [, q, partStr, vid] = data.split('|');
      quality = q;
      partIndex = Math.max(1, Number(partStr) || 1);
      videoId = vid;
    } else {
      const [, q, vid] = data.split('|');
      quality = q;
      videoId = vid;
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const statusMsgId = isYtQuality ? messageId : null;

    // 4. Check SQLite + memory cache & singleflight stampede lock
    const cacheKey = partIndex > 1 ? `${quality}_p${partIndex}` : quality;
    const cached = await getCachedEntry(url, cacheKey);
    if (cached) {
      if (statusMsgId) {
        await safeDeleteMessage(chatId, statusMsgId);
      }
      return await sendCachedEntry(chatId, cached, replyToMsgId);
    }

    const sf = await runWithSingleflight(
      url,
      () => handleYouTubeDownload(chatId, url, quality, statusMsgId, replyToMsgId, partIndex),
      { formatId: cacheKey, lockSuffix: cacheKey }
    );
    if (sf.role === 'hit' && sf.cached) {
      if (statusMsgId) {
        await safeDeleteMessage(chatId, statusMsgId);
      }
      return await sendCachedEntry(chatId, sf.cached, replyToMsgId);
    }
  } finally {
    if (activeMsgLock) {
      await releaseUpdateLock(chatId, activeMsgLock);
    }
  }
}
