import { api, db, fetch } from 'sdk';
import { cachedMedia } from './schema.js';
import { eq, and } from 'sdk/db';

// URL of your distributed download cluster (Worker API)
const CLUSTER_API_URL = process.env.CLUSTER_API_URL || 'https://your-worker-cluster.com';

const URL_REGEX = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)/i;

export default async function (update) {
  // Handle Callback Queries (e.g., YouTube quality selection button click)
  if (update.callback_query) {
    return await handleCallbackQuery(update.callback_query);
  }

  // Handle incoming messages
  if (update.message && update.message.text) {
    return await handleMessage(update.message);
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
        `این ربات به‌صورت کاملاً <b>سرورلس</b> روی زیرساخت رسمی تلگرام فعال است.\n\n` +
        `▫️ <b>یوتیوب (YouTube):</b> با قابلیت انتخاب کیفیت (1080p, 720p, 480p, 360p و MP3)\n` +
        `▫️ <b>اینستاگرام (Instagram):</b> پست‌ها و ریلزها\n` +
        `▫️ <b>تیک‌تاک (TikTok):</b> بدون واترمارک\n` +
        `▫️ <b>توییتر / ایکس (Twitter/X):</b> ویدیوها و گیف‌ها\n` +
        `▫️ <b>پینترست (Pinterest):</b> ویدیوها\n\n` +
        `📥 کافیست لینک مورد نظر را ارسال کنید!`
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
  const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');

  // Check built-in SQLite cache first
  const [cached] = await db.select()
    .from(cachedMedia)
    .where(and(eq(cachedMedia.url, url), eq(cachedMedia.formatId, '')))
    .limit(1);

  if (cached) {
    if (cached.mediaType === 'audio') {
      return await api.sendAudio({
        chat_id: chatId,
        audio: cached.fileId,
        caption: cached.caption || '🎬 دانلود شده با ربات',
      });
    } else {
      return await api.sendVideo({
        chat_id: chatId,
        video: cached.fileId,
        caption: cached.caption || '🎬 دانلود شده با ربات',
        supports_streaming: true,
      });
    }
  }

  // If YouTube -> Fetch available qualities from Cluster API
  if (isYoutube) {
    const statusMsg = await api.sendMessage({
      chat_id: chatId,
      text: '🔍 <b>در حال بررسی کیفیت‌های ویدیو یوتیوب...</b>',
      parse_mode: 'HTML',
    });

    try {
      const res = await fetch(`${CLUSTER_API_URL}/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();
      if (!data.success || !data.formats || data.formats.length === 0) {
        return await api.editMessageText({
          chat_id: chatId,
          message_id: statusMsg.message_id,
          text: '❌ دریافت اطلاعات این ویدیو ناموفق بود یا ویدیو خصوصی است.',
        });
      }

      // Build Inline Buttons
      const inlineKeyboard = [];
      let currentRow = [];

      data.formats.forEach((fmt, index) => {
        currentRow.push({
          text: fmt.label + (fmt.size ? ` (${fmt.size})` : ''),
          callback_data: `yt|${data.session_id}|${index}`,
        });
        if (currentRow.length === 2) {
          inlineKeyboard.push(currentRow);
          currentRow = [];
        }
      });
      if (currentRow.length > 0) inlineKeyboard.push(currentRow);

      return await api.editMessageText({
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: (
          `🎬 <b>${data.title}</b>\n\n` +
          `⏱ مدت زمان: <code>${data.duration_str}</code>\n` +
          `👤 کانال: <code>${data.uploader}</code>\n\n` +
          `👇 <b>کیفیت مورد نظر خود را برای دانلود انتخاب کنید:</b>`
        ),
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });

    } catch (e) {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: '❌ خطا در برقراری ارتباط با کلاستر دانلود.',
      });
    }
  }

  // Other Platforms (Instagram, TikTok, Twitter, Pinterest)
  const statusMsg = await api.sendMessage({
    chat_id: chatId,
    text: '⏳ <b>در حال ثبت در صف پخش دانلود...</b>',
    parse_mode: 'HTML',
  });

  try {
    const res = await fetch(`${CLUSTER_API_URL}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        chat_id: chatId,
        user_id: message.from.id,
        status_message_id: statusMsg.message_id,
      }),
    });

    const data = await res.json();
    return await api.editMessageText({
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: (
        `📥 <b>به صف دانلود اضافه شد!</b>\n\n` +
        `📊 نوبت شما در صف: <b>#${data.position || 1}</b>\n` +
        `⚡️ به محض آماده شدن فایل مستقیماً برای شما ارسال می‌شود.`
      ),
      parse_mode: 'HTML',
    });
  } catch (err) {
    return await api.editMessageText({
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: '❌ خطا در ارسال درخواست به سرور دانلود.',
    });
  }
}

async function handleCallbackQuery(query) {
  await api.answerCallbackQuery({ callback_query_id: query.id });

  const data = query.data;
  if (!data.startsWith('yt|')) return;

  const [, sessionId, formatIndex] = data.split('|');
  const chatId = query.message.chat.id;

  const statusMsg = await api.editMessageText({
    chat_id: chatId,
    message_id: query.message.message_id,
    text: '⏳ <b>کیفیت تایید شد. در حال ارسال به صف دانلود کلاستر...</b>',
    parse_mode: 'HTML',
  });

  try {
    const res = await fetch(`${CLUSTER_API_URL}/download_session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        format_index: parseInt(formatIndex),
        chat_id: chatId,
        user_id: query.from.id,
        status_message_id: statusMsg.message_id,
      }),
    });

    const resData = await res.json();
    await api.editMessageText({
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: (
        `📥 <b>ویدیو به صف پردازش کلاستر اضافه شد!</b>\n\n` +
        `📊 موقعیت در صف: <b>#${resData.position || 1}</b>\n` +
        `⏳ لطفاً منتظر بمانید تا دانلود و آپلود شود...`
      ),
      parse_mode: 'HTML',
    });
  } catch (err) {
    await api.editMessageText({
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: '❌ خطا در ثبت تسک در کلاستر.',
    });
  }
}
