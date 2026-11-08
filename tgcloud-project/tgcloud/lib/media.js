import { api, fetch, InputFile } from 'sdk';
import { cachedMedia } from '../schema.js';
import db from 'sdk/db';

export const COBALT_INSTANCES = [
  'https://cobalt.hyonsu.com',
  'https://api.cobalt.tools',
  'https://cobalt-api.kwiatekm.tokyo'
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
      text: `❌ Failed to download TikTok video: ${err.message || ''}`,
    });
  }
}

export async function handleX(chatId, url) {
  const statusMsg = await api.sendMessage({
    chat_id: chatId,
    text: '⏳ <b>Fetching X video...</b>',
    parse_mode: 'HTML',
  });

  try {
    const parsed = new URL(url);
    const cleanPath = parsed.pathname;
    const fxUrl = `https://api.fxtwitter.com${cleanPath}`;

    const res = await fetch(fxUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!res.ok) {
      throw new Error(`X API returned HTTP ${res.status}`);
    }

    const data = await res.json();
    const tweet = data.tweet;

    if (!tweet) {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: '❌ Post not found or account is private.',
      });
    }

    const videos = tweet.media?.videos || [];
    if (videos.length === 0) {
      const photos = tweet.media?.photos || [];
      if (photos.length > 0) {
        const photoUrl = photos[0].url;
        const caption = `🎬 <b>${tweet.author?.name || 'X'}:</b>\n${tweet.text || ''}`;
        await api.sendPhoto({
          chat_id: chatId,
          photo: photoUrl,
          caption: caption,
          parse_mode: 'HTML',
        });
        return await api.deleteMessage({ chat_id: chatId, message_id: statusMsg.message_id });
      }

      return await api.editMessageText({
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: '❌ No video or media found in this post.',
      });
    }

    const videoObj = videos[0];
    const duration = videoObj.duration || 30;

    // Filter mp4 variants and choose the best quality that fits in memory (< 25 MB)
    let targetUrl = videoObj.url;
    if (videoObj.variants && videoObj.variants.length > 0) {
      const mp4s = videoObj.variants.filter(v => v.content_type === 'video/mp4');
      mp4s.sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));

      const maxBits = 25 * 1024 * 1024 * 8; // 25 MB
      let chosen = null;

      for (const variant of mp4s) {
        const estBits = (variant.bitrate || 0) * duration;
        if (estBits <= maxBits || !chosen) {
          chosen = variant;
        }
      }
      if (chosen) {
        targetUrl = chosen.url;
      }
    }

    const caption = `🎬 <b>${tweet.author?.name || 'X'}:</b>\n${tweet.text || ''}`;

    // Fetch video bytes with browser User-Agent to bypass Twitter's 403 hotlink protection
    const vidRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!vidRes.ok) {
      throw new Error(`Failed to fetch video stream: HTTP ${vidRes.status}`);
    }

    const chunks = [];
    for await (const chunk of vidRes.body) {
      chunks.push(chunk);
    }
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    const videoFile = new InputFile(bytes, 'x_video.mp4', { type: 'video/mp4' });

    const sent = await api.sendVideo({
      chat_id: chatId,
      video: videoFile,
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
      text: `❌ Failed to download X video: ${err.message || 'Error'}`,
    });
  }
}

export const handleTwitter = handleX;

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
      text: `❌ Failed to download Pinterest video: ${err.message || ''}`,
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
