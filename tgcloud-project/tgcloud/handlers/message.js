import { api } from 'sdk';
import db, { and, eq } from 'sdk/db';
import { cachedMedia } from '../schema.js';
import { handleTikTok, handleTwitter, handlePinterest, handleCobalt } from '../lib/media.js';

const URL_REGEX = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)/i;

export default async function (message, ctx) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  // /start command
  if (text === '/start') {
    return await api.sendMessage({
      chat_id: chatId,
      text: (
        `👋 <b>Hello ${message.from.first_name || 'there'}!</b>\n\n` +
        `Send me a link from any of the following platforms:\n` +
        `• <b>YouTube</b> (Multiple qualities & MP3)\n` +
        `• <b>Instagram</b> (Reels & Posts)\n` +
        `• <b>TikTok</b> (No watermark)\n` +
        `• <b>Twitter / X</b> (Videos & GIFs)\n` +
        `• <b>Pinterest</b> (Videos)\n\n` +
        `📥 <i>Just send the link to download!</i>`
      ),
      parse_mode: 'HTML',
    });
  }

  const match = text.match(URL_REGEX);
  if (!match) {
    return await api.sendMessage({
      chat_id: chatId,
      text: '⚠️ Please send a valid link from YouTube, Instagram, TikTok, Twitter/X, or Pinterest.',
    });
  }

  const url = match[0];

  // 1. Check built-in SQLite cache first
  try {
    const cached = await db.select()
      .from(cachedMedia)
      .where(and(eq(cachedMedia.url, url), eq(cachedMedia.formatId, '')))
      .get();

    if (cached) {
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
    // DB cache check error ignored
  }

  // 2. Identify platform
  const lowerUrl = url.toLowerCase();

  if (lowerUrl.includes('tiktok.com')) {
    return await handleTikTok(chatId, url);
  }

  if (lowerUrl.includes('twitter.com') || lowerUrl.includes('x.com')) {
    return await handleTwitter(chatId, url);
  }

  if (lowerUrl.includes('pinterest.com') || lowerUrl.includes('pin.it')) {
    return await handlePinterest(chatId, url);
  }

  if (lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be')) {
    const encodedUrl = encodeURIComponent(url);
    const inlineKeyboard = [
      [
        { text: '🎬 1080p (FHD)', callback_data: `ytq|1080|${encodedUrl}` },
        { text: '🎬 720p (HD)', callback_data: `ytq|720|${encodedUrl}` },
      ],
      [
        { text: '📺 480p (SD)', callback_data: `ytq|480|${encodedUrl}` },
        { text: '📱 360p', callback_data: `ytq|360|${encodedUrl}` },
      ],
      [
        { text: '🎵 Audio (MP3)', callback_data: `ytq|audio|${encodedUrl}` },
      ],
    ];

    return await api.sendMessage({
      chat_id: chatId,
      text: '📺 <b>Select video quality:</b>',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  }

  if (lowerUrl.includes('instagram.com') || lowerUrl.includes('instagr.am')) {
    return await handleCobalt(chatId, url, 'auto', 'Instagram');
  }

  return await api.sendMessage({
    chat_id: chatId,
    text: '⚠️ This platform is currently not supported.',
  });
}
