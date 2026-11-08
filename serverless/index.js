import { api, db, fetch } from 'sdk';
import { cachedMedia } from './schema.js';
import { eq, and } from 'sdk/db';

const URL_REGEX = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)/i;

// Public Cobalt instances for YouTube & Instagram with automatic fallback
const COBALT_INSTANCES = [
  'https://cobalt-api.kwiatekm.tokyo',
  'https://api.cobalt.tools',
  'https://cobalt.hyonsu.com'
];

export default async function (update) {
  try {
    if (update.callback_query) {
      return await handleCallbackQuery(update.callback_query);
    }
    if (update.message && update.message.text) {
      return await handleMessage(update.message);
    }
  } catch (error) {
    // Graceful error logging
  }
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text.trim();

  // /start command
  if (text === '/start') {
    return await api.sendMessage({
      chat_id: chatId,
      text: (
        `👋 <b>سلام ${message.from.first_name}، به ربات دانلودر خوش آمدید!</b>\n\n` +
        `⚡️ این ربات <b>۱۰۰٪ سرورلس (Serverless)</b> روی کلود اختصاصی تلگرام اجرا می‌شود.\n\n` +
        `پلتفرم‌های پشتیبانی‌شده:\n` +
        `▫️ <b>یوتیوب (YouTube):</b> با انتخاب کیفیت (1080p, 720p, 480p, 360p و MP3)\n` +
        `▫️ <b>تیک‌تاک (TikTok):</b> بدون واترمارک و کیفیت اصلی\n` +
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
  const [cached] = await db.select()
    .from(cachedMedia)
    .where(and(eq(cachedMedia.url, url), eq(cachedMedia.formatId, '')))
    .limit(1);

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

  // 2. Identify platform
  const lowerUrl = url.toLowerCase();

  // --- TikTok Handler (100% Serverless via tikwm) ---
  if (lowerUrl.includes('tiktok.com')) {
    return await handleTikTok(chatId, url);
  }

  // --- Twitter / X Handler (100% Serverless via vxtwitter) ---
  if (lowerUrl.includes('twitter.com') || lowerUrl.includes('x.com')) {
    return await handleTwitter(chatId, url);
  }

  // --- Pinterest Handler (100% Serverless Direct Extraction) ---
  if (lowerUrl.includes('pinterest.com') || lowerUrl.includes('pin.it')) {
    return await handlePinterest(chatId, url);
  }

  // --- YouTube Handler (With Quality Buttons) ---
  if (lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be')) {
    return await handleYouTubeButtons(chatId, url);
  }

  // --- Instagram Handler ---
  if (lowerUrl.includes('instagram.com') || lowerUrl.includes('instagr.am')) {
    return await handleCobaltMedia(chatId, url, 'auto', 'Instagram');
  }

  return await api.sendMessage({
    chat_id: chatId,
    text: '⚠️ این پلتفرم در حال حاضر پشتیبانی نمی‌شود.',
  });
}

// -------------------------------------------------------------
// TIKTOK (100% Serverless, No Watermark)
// -------------------------------------------------------------
async function handleTikTok(chatId, url) {
  const statusMsg = await api.sendMessage({
    chat_id: chatId,
    text: '⏳ <b>در حال استخراج ویدیوی تیک‌تاک بدون واترمارک...</b>',
    parse_mode: 'HTML',
  });

  try {
    const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (!data || !data.data || !data.data.play) {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: '❌ ویدیوی تیک‌تاک یافت نشد یا ممکن است خصوصی باشد.',
      });
    }

    const videoUrl = data.data.play;
    const title = data.data.title || 'TikTok Video';
    const caption = `🎬 <b>${title}</b>\n\n🤖 @FreeDownloadsBot`;

    // Telegram's servers will download directly from CDN!
    const sent = await api.sendVideo({
      chat_id: chatId,
      video: videoUrl,
      caption: caption,
      parse_mode: 'HTML',
      supports_streaming: true,
    });

    if (sent && sent.video) {
      await db.insert(cachedMedia).values({
        url: url,
        fileId: sent.video.file_id,
        mediaType: 'video',
        caption: caption,
        createdAt: Math.floor(Date.now() / 1000),
      }).run();
    }

    await api.deleteMessage({ chat_id: chatId, message_id: statusMsg.message_id });
  } catch (err) {
    await api.editMessageText({
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: '❌ خطا در دریافت ویدیوی تیک‌تاک.',
    });
  }
}

// -------------------------------------------------------------
// TWITTER / X (100% Serverless via vxTwitter API)
// -------------------------------------------------------------
async function handleTwitter(chatId, url) {
  const statusMsg = await api.sendMessage({
    chat_id: chatId,
    text: '⏳ <b>در حال دریافت ویدیوی توییتر / X...</b>',
    parse_mode: 'HTML',
  });

  try {
    // Convert to vxTwitter API endpoint
    const parsed = new URL(url);
    const vxUrl = `https://api.vxtwitter.com${parsed.pathname}`;

    const res = await fetch(vxUrl);
    const data = await res.json();

    if (!data || !data.media_urls || data.media_urls.length === 0) {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: '❌ ویدیویی در این توییت یافت نشد.',
      });
    }

    const videoUrl = data.media_urls[0];
    const caption = `🐦 <b>${data.user_name || 'Twitter'}:</b>\n${data.text || ''}\n\n🤖 @FreeDownloadsBot`;

    const sent = await api.sendVideo({
      chat_id: chatId,
      video: videoUrl,
      caption: caption,
      parse_mode: 'HTML',
      supports_streaming: true,
    });

    if (sent && sent.video) {
      await db.insert(cachedMedia).values({
        url: url,
        fileId: sent.video.file_id,
        mediaType: 'video',
        caption: caption,
        createdAt: Math.floor(Date.now() / 1000),
      }).run();
    }

    await api.deleteMessage({ chat_id: chatId, message_id: statusMsg.message_id });
  } catch (err) {
    await api.editMessageText({
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: '❌ خطا در دریافت ویدیوی توییتر.',
    });
  }
}

// -------------------------------------------------------------
// PINTEREST (100% Serverless Direct Extraction)
// -------------------------------------------------------------
async function handlePinterest(chatId, url) {
  const statusMsg = await api.sendMessage({
    chat_id: chatId,
    text: '⏳ <b>در حال استخراج ویدیوی پینترست...</b>',
    parse_mode: 'HTML',
  });

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    const html = await res.text();

    // Search for mp4 video stream
    const videoMatch = html.match(/https:\/\/[^"'\s]+\.pinimg\.com\/videos\/[^"'\s]+\.mp4/i) ||
                       html.match(/<meta property="og:video" content="([^"]+)"/i);

    if (!videoMatch) {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: '❌ ویدیویی در این لینک پینترست یافت نشد (ممکن است فقط تصویر باشد).',
      });
    }

    const videoUrl = videoMatch[1] || videoMatch[0];
    const caption = '📌 <b>ویدیوی پینترست</b>\n\n🤖 @FreeDownloadsBot';

    const sent = await api.sendVideo({
      chat_id: chatId,
      video: videoUrl,
      caption: caption,
      parse_mode: 'HTML',
      supports_streaming: true,
    });

    if (sent && sent.video) {
      await db.insert(cachedMedia).values({
        url: url,
        fileId: sent.video.file_id,
        mediaType: 'video',
        caption: caption,
        createdAt: Math.floor(Date.now() / 1000),
      }).run();
    }

    await api.deleteMessage({ chat_id: chatId, message_id: statusMsg.message_id });
  } catch (err) {
    await api.editMessageText({
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: '❌ خطا در استخراج ویدیوی پینترست.',
    });
  }
}

// -------------------------------------------------------------
// YOUTUBE (Quality Selector Buttons)
// -------------------------------------------------------------
async function handleYouTubeButtons(chatId, url) {
  // Offer standard qualities: 1080p, 720p, 480p, 360p, MP3
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

  await api.sendMessage({
    chat_id: chatId,
    text: (
      `📺 <b>ویدیو یوتیوب دریافت شد!</b>\n\n` +
      `👇 <b>کیفیت مورد نظر خود را جهت دانلود انتخاب کنید:</b>`
    ),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

// -------------------------------------------------------------
// CALLBACK QUERY HANDLER FOR YOUTUBE QUALITY
// -------------------------------------------------------------
async function handleCallbackQuery(query) {
  await api.answerCallbackQuery({ callback_query_id: query.id });

  const data = query.data;
  if (!data.startsWith('ytq|')) return;

  const [, quality, encodedUrl] = data.split('|');
  const url = decodeURIComponent(encodedUrl);
  const chatId = query.message.chat.id;

  const isAudio = quality === 'audio';
  const label = isAudio ? 'MP3' : `${quality}p`;

  // Check SQLite cache for this quality
  const [cached] = await db.select()
    .from(cachedMedia)
    .where(and(eq(cachedMedia.url, url), eq(cachedMedia.formatId, quality)))
    .limit(1);

  if (cached) {
    await api.deleteMessage({ chat_id: chatId, message_id: query.message.message_id });
    if (cached.mediaType === 'audio') {
      return await api.sendAudio({
        chat_id: chatId,
        audio: cached.fileId,
        caption: cached.caption || '🎵 دانلود شده با ربات سرورلس',
      });
    } else {
      return await api.sendVideo({
        chat_id: chatId,
        video: cached.fileId,
        caption: cached.caption || `🎬 کیفیت: ${label}`,
        supports_streaming: true,
      });
    }
  }

  const statusMsg = await api.editMessageText({
    chat_id: chatId,
    message_id: query.message.message_id,
    text: `⏳ <b>در حال آماده‌سازی و ارسال با کیفیت ${label}...</b>`,
    parse_mode: 'HTML',
  });

  await handleCobaltMedia(chatId, url, quality, 'YouTube', statusMsg.message_id);
}

// -------------------------------------------------------------
// COBALT MEDIA EXTRACTOR (YouTube & Instagram)
// -------------------------------------------------------------
async function handleCobaltMedia(chatId, url, quality = 'auto', platform = 'Media', statusMsgId = null) {
  let activeStatusId = statusMsgId;
  if (!activeStatusId) {
    const s = await api.sendMessage({
      chat_id: chatId,
      text: `⏳ <b>در حال استخراج و آماده‌سازی از ${platform}...</b>`,
      parse_mode: 'HTML',
    });
    activeStatusId = s.message_id;
  }

  const isAudio = quality === 'audio';

  // Try each Cobalt instance with automatic failover
  for (const instance of COBALT_INSTANCES) {
    try {
      const res = await fetch(`${instance}/`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: url,
          videoQuality: isAudio ? '720' : quality,
          downloadMode: isAudio ? 'audio' : 'auto',
        }),
      });

      const data = await res.json();
      if (data && data.url) {
        const directMediaUrl = data.url;
        const caption = `🎬 <b>${platform}</b>\n\n🤖 @FreeDownloadsBot`;

        let sent;
        if (isAudio) {
          sent = await api.sendAudio({
            chat_id: chatId,
            audio: directMediaUrl,
            caption: caption,
            parse_mode: 'HTML',
          });
        } else {
          sent = await api.sendVideo({
            chat_id: chatId,
            video: directMediaUrl,
            caption: caption,
            parse_mode: 'HTML',
            supports_streaming: true,
          });
        }

        // Cache the file_id inside Telegram's SQLite
        if (sent) {
          const fileId = isAudio ? sent.audio?.file_id : sent.video?.file_id;
          if (fileId) {
            await db.insert(cachedMedia).values({
              url: url,
              formatId: quality,
              fileId: fileId,
              mediaType: isAudio ? 'audio' : 'video',
              caption: caption,
              createdAt: Math.floor(Date.now() / 1000),
            }).run();
          }
        }

        await api.deleteMessage({ chat_id: chatId, message_id: activeStatusId });
        return;
      }
    } catch (e) {
      // Try next instance
    }
  }

  await api.editMessageText({
    chat_id: chatId,
    message_id: activeStatusId,
    text: `❌ خطا در دریافت مدیا از ${platform}. ممکن است فایل سنگین یا خصوصی باشد.`,
  });
}
