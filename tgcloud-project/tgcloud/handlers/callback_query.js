import { api } from 'sdk';
import db, { and, eq } from 'sdk/db';
import { cachedMedia } from '../schema.js';
import { handleCobalt } from '../lib/media.js';

export default async function (query, ctx) {
  await api.answerCallbackQuery({ callback_query_id: query.id });

  const data = query.data || '';
  if (!data.startsWith('ytq|')) return;

  const [, quality, encodedUrl] = data.split('|');
  const url = decodeURIComponent(encodedUrl);
  const chatId = query.message.chat.id;

  const isAudio = quality === 'audio';
  const label = isAudio ? 'MP3' : `${quality}p`;

  // Check SQLite cache for this quality
  try {
    const cached = await db.select()
      .from(cachedMedia)
      .where(and(eq(cachedMedia.url, url), eq(cachedMedia.formatId, quality)))
      .get();

    if (cached) {
      await api.deleteMessage({ chat_id: chatId, message_id: query.message.message_id });
      if (cached.mediaType === 'audio') {
        return await api.sendAudio({
          chat_id: chatId,
          audio: cached.fileId,
          caption: cached.caption || '',
        });
      } else {
        return await api.sendVideo({
          chat_id: chatId,
          video: cached.fileId,
          caption: cached.caption || '',
          supports_streaming: true,
        });
      }
    }
  } catch (err) {
    // DB check error ignored
  }

  const statusMsg = await api.editMessageText({
    chat_id: chatId,
    message_id: query.message.message_id,
    text: `⏳ <b>Fetching video in ${label}...</b>`,
    parse_mode: 'HTML',
  });

  await handleCobalt(chatId, url, quality, 'YouTube', statusMsg.message_id);
}
