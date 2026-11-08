import { api, fetch } from 'sdk';
import { cachedMedia } from '../schema.js';
import db from 'sdk/db';

export const COBALT_INSTANCES = [
  'https://cobalt-api.kwiatekm.tokyo',
  'https://api.cobalt.tools',
  'https://cobalt.hyonsu.com'
];

export async function handleTikTok(chatId, url) {
  const statusMsg = await api.sendMessage({
    chat_id: chatId,
    text: '⏳ <b>Fetching TikTok video...</b>',
    parse_mode: 'HTML',
  });

  try {
    const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (!data || !data.data || !data.data.play) {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: '❌ Video not found or post is private.',
      });
    }

    const videoUrl = data.data.play;
    const title = data.data.title || 'TikTok Video';
    const caption = `🎬 <b>${title}</b>`;

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
      text: '❌ Failed to download TikTok video.',
    });
  }
}

export async function handleTwitter(chatId, url) {
  const statusMsg = await api.sendMessage({
    chat_id: chatId,
    text: '⏳ <b>Fetching Twitter / X video...</b>',
    parse_mode: 'HTML',
  });

  try {
    const parsed = new URL(url);
    const vxUrl = `https://api.vxtwitter.com${parsed.pathname}`;

    const res = await fetch(vxUrl);
    const data = await res.json();

    if (!data || !data.media_urls || data.media_urls.length === 0) {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: '❌ No video found in this tweet.',
      });
    }

    const videoUrl = data.media_urls[0];
    const caption = `🐦 <b>${data.user_name || 'Twitter'}:</b>\n${data.text || ''}`;

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
      text: '❌ Failed to download Twitter video.',
    });
  }
}

export async function handlePinterest(chatId, url) {
  const statusMsg = await api.sendMessage({
    chat_id: chatId,
    text: '⏳ <b>Fetching Pinterest video...</b>',
    parse_mode: 'HTML',
  });

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    const html = await res.text();

    const videoMatch = html.match(/https:\/\/[^"'\s]+\.pinimg\.com\/videos\/[^"'\s]+\.mp4/i) ||
                       html.match(/<meta property="og:video" content="([^"]+)"/i);

    if (!videoMatch) {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: '❌ No video stream found in this pin.',
      });
    }

    const videoUrl = videoMatch[1] || videoMatch[0];
    const caption = '📌 <b>Pinterest Video</b>';

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
      text: '❌ Failed to download Pinterest video.',
    });
  }
}

export async function handleCobalt(chatId, url, quality = 'auto', platform = 'Media', statusMsgId = null) {
  let activeStatusId = statusMsgId;
  if (!activeStatusId) {
    const s = await api.sendMessage({
      chat_id: chatId,
      text: `⏳ <b>Fetching from ${platform}...</b>`,
      parse_mode: 'HTML',
    });
    activeStatusId = s.message_id;
  }

  const isAudio = quality === 'audio';

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
        const caption = `🎬 <b>${platform}</b>`;

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
    text: `❌ Failed to fetch media from ${platform}. It may be private or too large.`,
  });
}
