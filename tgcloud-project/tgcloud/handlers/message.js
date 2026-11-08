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
        `👋 <b>سلام ${message.from.first_name || 'کاربر'}، به ربات دانلودر خوش آمدید!</b>\n\n` +
        `⚡️ این ربات <b>۱۰۰٪ سرورلس (Serverless)</b> روی کلود رسمی تلگرام فعال است.\n\n` +
        `پلتفرم‌های پشتیبانی‌شده:\n` +
        `▫️ <b>یوتیوب (YouTube):</b> با انتخاب کیفیت (1080p, 720p, 480p, 360p و MP3)\n` +
        `▫️ <b>تیک‌تاک (TikTok):</b> بدون واترمارک و با بالاترین کیفیت\n` +
        `▫️ <b>اینستاگرام (Instagram):</b> ریلزها و پست‌ها\n` +
        `▫️ <b>توییتر / ایکس (Twitter/X):</b> ویدیوها و گیف‌ها\n` +
        `▫️ <b>پینترست (Pinterest):</b> ویدیوها\n\n` +
        `📥 <b>کافیست لینک مد نظرت را بفرستی تا در چند ثانیه تحویل بگیری!</b>`
      ),
      parse_mode: 'HTML',
    });
  }

  const match = text.match(URL_REGEX);
  if (!match) {
    return await api.sendMessage({
      chat_id: chatId,
      text: '⚠️ لطفاً یک لینک معتبر از یوتیوب، اینستاگرام، تیک‌تاک، توییتر یا پینترست ارسال کنید.',
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
          caption: cached.caption || '🎬 دانلود شده با ربات سرورلس',
        });
      } else {
        return await api.sendVideo({
          chat_id: chatId,
          video: cached.fileId,
          caption: cached.caption || '🎬 دانلود شده با ربات سرورلس',
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
        { text: '🎵 صوتی (MP3)', callback_data: `ytq|audio|${encodedUrl}` },
      ],
    ];

    return await api.sendMessage({
      chat_id: chatId,
      text: (
        `📺 <b>ویدیو یوتیوب دریافت شد!</b>\n\n` +
        `👇 <b>کیفیت مورد نظر خود را جهت دانلود انتخاب کنید:</b>`
      ),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  }

  if (lowerUrl.includes('instagram.com') || lowerUrl.includes('instagr.am')) {
    return await handleCobalt(chatId, url, 'auto', 'Instagram');
  }

  return await api.sendMessage({
    chat_id: chatId,
    text: '⚠️ این پلتفرم در حال حاضر پشتیبانی نمی‌شود.',
  });
}
