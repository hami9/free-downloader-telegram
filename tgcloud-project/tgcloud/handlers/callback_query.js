import { api } from 'sdk';
import db, { and, eq } from 'sdk/db';
import { cachedMedia } from '../schema.js';
import { handleYouTubeDownload } from '../lib/media.js';

export default async function (query, ctx) {
  await api.answerCallbackQuery({ callback_query_id: query.id });

  const data = query.data || '';
  if (!data.startsWith('ytq|')) return;

  const [, quality, videoId] = data.split('|');
  const url = `https://www.youtube.com/watch?v=${videoId}`;
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
          parse_mode: 'HTML',
        });
      } else {
        return await api.sendVideo({
          chat_id: chatId,
          video: cached.fileId,
          caption: cached.caption || '',
          parse_mode: 'HTML',
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
    text: `⏳ <b>Fetching YouTube ${label}...</b>`,
    parse_mode: 'HTML',
  });

  await handleYouTubeDownload(chatId, url, quality, statusMsg.message_id);
}
