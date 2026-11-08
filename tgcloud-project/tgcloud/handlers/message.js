import { api } from 'sdk';
import db, { and, eq } from 'sdk/db';
import { cachedMedia } from '../schema.js';
import { handleTikTok, handleX, handleInstagram, handlePinterest } from '../lib/media.js';

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
        `• <b>X</b> (Videos & Photos)\n` +
        `• <b>Pinterest</b> (Videos & Pins)\n\n` +
        `📥 <i>Just send the link to download!</i>`
      ),
      parse_mode: 'HTML',
    });
  }

  const match = text.match(URL_REGEX);
  if (!match) {
    return await api.sendMessage({
      chat_id: chatId,
      text: '⚠️ Please send a valid link from YouTube, Instagram, TikTok, X, or Pinterest.',
    });
  }

  const url = match[0];

  // 1. Check built-in SQLite cache first (for non-YouTube links)
  const lowerUrl = url.toLowerCase();
  const isYouTube = lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be');

  if (!isYouTube) {
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
            parse_mode: 'HTML',
          });
        } else if (cached.mediaType === 'photo') {
          return await api.sendPhoto({
            chat_id: chatId,
            photo: cached.fileId,
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
      // DB cache check error ignored
    }
  }

  // 2. Route by platform
  if (lowerUrl.includes('tiktok.com')) {
    return await handleTikTok(chatId, url);
  }

  if (lowerUrl.includes('x.com') || lowerUrl.includes('twitter.com')) {
    return await handleX(chatId, url);
  }

  if (lowerUrl.includes('instagram.com') || lowerUrl.includes('instagr.am')) {
    return await handleInstagram(chatId, url);
  }

  if (lowerUrl.includes('pinterest.com') || lowerUrl.includes('pin.it')) {
    return await handlePinterest(chatId, url);
  }

  if (isYouTube) {
    const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
    if (!ytMatch) {
      return await api.sendMessage({
        chat_id: chatId,
        text: '❌ Invalid YouTube video link.',
      });
    }

    const videoId = ytMatch[1];
    const inlineKeyboard = [
      [
        { text: '🎬 1080p (FHD)', callback_data: `ytq|1080|${videoId}` },
        { text: '🎬 720p (HD)', callback_data: `ytq|720|${videoId}` },
      ],
      [
        { text: '📺 480p (SD)', callback_data: `ytq|480|${videoId}` },
        { text: '📱 360p', callback_data: `ytq|360|${videoId}` },
      ],
      [
        { text: '🎵 Audio (MP3)', callback_data: `ytq|audio|${videoId}` },
      ],
    ];

    return await api.sendMessage({
      chat_id: chatId,
      text: '📺 <b>Select video quality:</b>',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  }

  return await api.sendMessage({
    chat_id: chatId,
    text: '⚠️ This platform is currently not supported.',
  });
}
