import { api, fetch, InputFile } from 'sdk';
import { cachedMedia } from '../schema.js';
import db from 'sdk/db';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BOT_UA = 'TelegramBot (like TwitterBot)';
const YT_VR_UA = 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 14; en_US; Quest 3; Build/UP1A.231005.007.A1; Cronet/132.0.6808.3)';

async function fetchStreamBytes(url, userAgent = BROWSER_UA, maxBytes = 45 * 1024 * 1024) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': userAgent,
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const chunks = [];
  let totalLength = 0;

  for await (const chunk of res.body) {
    totalLength += chunk.length;
    if (totalLength > maxBytes) {
      throw new Error('FILE_TOO_LARGE_FOR_MEMORY');
    }
    chunks.push(chunk);
  }

  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
}

async function sendVideoWithFallback(chatId, videoUrl, caption, userAgent = BROWSER_UA, filename = 'video.mp4') {
  try {
    const bytes = await fetchStreamBytes(videoUrl, userAgent);
    const file = new InputFile(bytes, filename, { type: 'video/mp4' });
    return await api.sendVideo({
      chat_id: chatId,
      video: file,
      caption: caption,
      parse_mode: 'HTML',
      supports_streaming: true,
    });
  } catch (err) {
    // Fallback to direct URL if stream is larger than memory buffer
    return await api.sendVideo({
      chat_id: chatId,
      video: videoUrl,
      caption: caption,
      parse_mode: 'HTML',
      supports_streaming: true,
    });
  }
}

async function sendPhotoWithFallback(chatId, photoUrl, caption, userAgent = BROWSER_UA, filename = 'photo.jpg') {
  try {
    const bytes = await fetchStreamBytes(photoUrl, userAgent, 10 * 1024 * 1024);
    const file = new InputFile(bytes, filename, { type: 'image/jpeg' });
    return await api.sendPhoto({
      chat_id: chatId,
      photo: file,
      caption: caption,
      parse_mode: 'HTML',
    });
  } catch (err) {
    return await api.sendPhoto({
      chat_id: chatId,
      photo: photoUrl,
      caption: caption,
      parse_mode: 'HTML',
    });
  }
}

async function saveCache(url, formatId, fileId, mediaType, caption) {
  if (!fileId) return;
  try {
    await db.insert(cachedMedia).values({
      url: url,
      formatId: formatId || '',
      fileId: fileId,
      mediaType: mediaType,
      caption: caption || '',
      createdAt: Math.floor(Date.now() / 1000),
    }).run();
  } catch (e) {
    // Ignore cache write errors
  }
}

// -------------------------------------------------------------
// TIKTOK
// -------------------------------------------------------------
export async function handleTikTok(chatId, url) {
  const statusMsg = await api.sendMessage({
    chat_id: chatId,
    text: '⏳ <b>Fetching TikTok video...</b>',
    parse_mode: 'HTML',
  });

  try {
    const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
      headers: { 'User-Agent': BROWSER_UA },
    });
    const data = await res.json();

    if (!data || !data.data || (!data.data.play && !data.data.images)) {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: '❌ Video not found or post is private.',
      });
    }

    const title = (data.data.title || 'TikTok').slice(0, 800);
    const caption = `🎬 <b>${title}</b>`;

    // Handle TikTok photo slideshow if applicable
    if (!data.data.play && data.data.images && data.data.images.length > 0) {
      const sent = await sendPhotoWithFallback(chatId, data.data.images[0], caption);
      if (sent && sent.photo && sent.photo.length > 0) {
        await saveCache(url, '', sent.photo[sent.photo.length - 1].file_id, 'photo', caption);
      }
      return await api.deleteMessage({ chat_id: chatId, message_id: statusMsg.message_id });
    }

    const videoUrl = data.data.play;
    const sent = await sendVideoWithFallback(chatId, videoUrl, caption, BROWSER_UA, 'tiktok.mp4');

    if (sent && sent.video) {
      await saveCache(url, '', sent.video.file_id, 'video', caption);
    }

    await api.deleteMessage({ chat_id: chatId, message_id: statusMsg.message_id });
  } catch (err) {
    await api.editMessageText({
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `❌ Failed to download TikTok video: ${err.description || err.message || 'Error'}`,
    });
  }
}

// -------------------------------------------------------------
// X (formerly Twitter)
// -------------------------------------------------------------
export async function handleX(chatId, url) {
  const statusMsg = await api.sendMessage({
    chat_id: chatId,
    text: '⏳ <b>Fetching X media...</b>',
    parse_mode: 'HTML',
  });

  try {
    const pathMatch = url.match(/https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)(\/[^?#\s]+)/i);
    if (!pathMatch) {
      throw new Error('Invalid X link format');
    }

    const cleanPath = pathMatch[1];
    const fxUrl = `https://api.fxtwitter.com${cleanPath}`;

    const res = await fetch(fxUrl, {
      headers: { 'User-Agent': BROWSER_UA },
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

    const caption = `🎬 <b>${tweet.author?.name || 'X'}:</b>\n${(tweet.text || '').slice(0, 800)}`;

    const videos = tweet.media?.videos || [];
    if (videos.length === 0) {
      const photos = tweet.media?.photos || [];
      if (photos.length > 0) {
        const photoUrl = photos[0].url;
        const sent = await sendPhotoWithFallback(chatId, photoUrl, caption, BROWSER_UA, 'x_photo.jpg');
        if (sent && sent.photo && sent.photo.length > 0) {
          await saveCache(url, '', sent.photo[sent.photo.length - 1].file_id, 'photo', caption);
        }
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

    let targetUrl = videoObj.url;
    if (videoObj.variants && videoObj.variants.length > 0) {
      const mp4s = videoObj.variants.filter(v => v.content_type === 'video/mp4');
      mp4s.sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));

      const maxBits = 25 * 1024 * 1024 * 8;
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

    const sent = await sendVideoWithFallback(chatId, targetUrl, caption, BROWSER_UA, 'x_video.mp4');

    if (sent && sent.video) {
      await saveCache(url, '', sent.video.file_id, 'video', caption);
    }

    await api.deleteMessage({ chat_id: chatId, message_id: statusMsg.message_id });
  } catch (err) {
    await api.editMessageText({
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `❌ Failed to download X media: ${err.description || err.message || 'Error'}`,
    });
  }
}

export const handleTwitter = handleX;

// -------------------------------------------------------------
// INSTAGRAM (Reels, Videos & Photo Posts)
// -------------------------------------------------------------
export async function handleInstagram(chatId, url) {
  const statusMsg = await api.sendMessage({
    chat_id: chatId,
    text: '⏳ <b>Fetching Instagram media...</b>',
    parse_mode: 'HTML',
  });

  try {
    // Extract shortcode from /p/SHORTCODE, /reel/SHORTCODE, /reels/SHORTCODE, /tv/SHORTCODE
    const scMatch = url.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
    if (!scMatch) {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: '❌ Invalid Instagram post or reel link.',
      });
    }

    const shortcode = scMatch[1];
    const proxyUrl = `https://www.eeinstagram.com/p/${shortcode}`;

    const res = await fetch(proxyUrl, {
      headers: { 'User-Agent': BOT_UA },
    });

    if (!res.ok) {
      throw new Error(`Instagram service returned HTTP ${res.status}`);
    }

    const html = await res.text();

    const vidMatch = html.match(/<meta property="og:video(?::secure_url)?" content="([^"]+)"/i);
    const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
    const descMatch = html.match(/<meta property="og:description" content="([^"]*)"/i);

    const rawDesc = descMatch && descMatch[1] ? descMatch[1].slice(0, 600) : '';
    const caption = rawDesc ? `📸 <b>Instagram</b>\n${rawDesc}` : '📸 <b>Instagram</b>';

    if (vidMatch && vidMatch[1]) {
      let videoUrl = vidMatch[1];
      if (videoUrl.startsWith('/')) {
        videoUrl = `https://www.eeinstagram.com${videoUrl}`;
      }

      const sent = await sendVideoWithFallback(chatId, videoUrl, caption, BOT_UA, `ig_${shortcode}.mp4`);
      if (sent && sent.video) {
        await saveCache(url, '', sent.video.file_id, 'video', caption);
      }

      return await api.deleteMessage({ chat_id: chatId, message_id: statusMsg.message_id });
    }

    if (imgMatch && imgMatch[1]) {
      let imageUrl = imgMatch[1];
      if (imageUrl.startsWith('/')) {
        imageUrl = `https://www.eeinstagram.com${imageUrl}`;
      }

      const sent = await sendPhotoWithFallback(chatId, imageUrl, caption, BOT_UA, `ig_${shortcode}.jpg`);
      if (sent && sent.photo && sent.photo.length > 0) {
        await saveCache(url, '', sent.photo[sent.photo.length - 1].file_id, 'photo', caption);
      }

      return await api.deleteMessage({ chat_id: chatId, message_id: statusMsg.message_id });
    }

    await api.editMessageText({
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: '❌ Could not find media in this Instagram link. The account may be private.',
    });
  } catch (err) {
    await api.editMessageText({
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `❌ Failed to fetch from Instagram: ${err.description || err.message || 'Error'}`,
    });
  }
}

// -------------------------------------------------------------
// PINTEREST (Videos & Images)
// -------------------------------------------------------------
export async function handlePinterest(chatId, url) {
  const statusMsg = await api.sendMessage({
    chat_id: chatId,
    text: '⏳ <b>Fetching Pinterest media...</b>',
    parse_mode: 'HTML',
  });

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA },
    });
    const html = await res.text();

    const videoMatch = html.match(/https:\/\/[^"'\s\\]+\.pinimg\.com\/videos\/[^"'\s\\]+\.mp4/i) ||
                       html.match(/<meta property="og:video(?::secure_url)?" content="([^"]+)"/i) ||
                       html.match(/"contentUrl"\s*:\s*"(https:\/\/[^"]+\.mp4)"/i);

    const caption = '📌 <b>Pinterest</b>';

    if (videoMatch) {
      const videoUrl = (videoMatch[1] || videoMatch[0]).replace(/\\u002F/g, '/').replace(/\\\//g, '/');
      const sent = await sendVideoWithFallback(chatId, videoUrl, caption, BROWSER_UA, 'pinterest.mp4');

      if (sent && sent.video) {
        await saveCache(url, '', sent.video.file_id, 'video', caption);
      }

      return await api.deleteMessage({ chat_id: chatId, message_id: statusMsg.message_id });
    }

    const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/i) ||
                     html.match(/https:\/\/i\.pinimg\.com\/originals\/[^"'\s\\]+\.(?:jpg|png|webp)/i);

    if (imgMatch) {
      const imgUrl = imgMatch[1] || imgMatch[0];
      const sent = await sendPhotoWithFallback(chatId, imgUrl, caption, BROWSER_UA, 'pinterest.jpg');
      if (sent && sent.photo && sent.photo.length > 0) {
        await saveCache(url, '', sent.photo[sent.photo.length - 1].file_id, 'photo', caption);
      }
      return await api.deleteMessage({ chat_id: chatId, message_id: statusMsg.message_id });
    }

    await api.editMessageText({
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: '❌ No video or image found in this Pinterest link.',
    });
  } catch (err) {
    await api.editMessageText({
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `❌ Failed to download Pinterest media: ${err.description || err.message || 'Error'}`,
    });
  }
}

// -------------------------------------------------------------
// YOUTUBE (Direct InnerTube ANDROID_VR Engine)
// -------------------------------------------------------------
function extractYouTubeId(url) {
  const m = url.match(/(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
  return m ? m[1] : null;
}

export async function handleYouTubeDownload(chatId, url, quality = '720', statusMsgId = null) {
  let activeStatusId = statusMsgId;
  if (!activeStatusId) {
    const s = await api.sendMessage({
      chat_id: chatId,
      text: '⏳ <b>Fetching from YouTube...</b>',
      parse_mode: 'HTML',
    });
    activeStatusId = s.message_id;
  }

  try {
    const videoId = extractYouTubeId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube video URL');
    }

    const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': YT_VR_UA,
      },
      body: JSON.stringify({
        videoId: videoId,
        context: {
          client: {
            clientName: 'ANDROID_VR',
            clientVersion: '1.60.19',
            androidSdkVersion: 34,
            osName: 'Android',
            osVersion: '14',
            hl: 'en',
            gl: 'US',
          },
        },
      }),
    });

    if (!r.ok) {
      throw new Error(`YouTube API returned HTTP ${r.status}`);
    }

    const data = await r.json();
    if (data.playabilityStatus?.status !== 'OK') {
      throw new Error(data.playabilityStatus?.reason || 'Video is unavailable or age-restricted');
    }

    const title = (data.videoDetails?.title || 'YouTube Video').slice(0, 600);
    const author = data.videoDetails?.author || 'YouTube';
    const formats = data.streamingData?.formats || [];
    const adaptive = data.streamingData?.adaptiveFormats || [];

    const isAudio = quality === 'audio';

    if (isAudio) {
      // Pick m4a audio format (itag 140) or any audio stream under 45 MB
      const audioStreams = adaptive.filter(
        f => f.url && f.mimeType && f.mimeType.includes('audio/')
      );
      audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      const chosenAudio = audioStreams.find(f => f.mimeType.includes('mp4')) || audioStreams[0];
      if (!chosenAudio) {
        throw new Error('No audio stream available for this video');
      }

      const caption = `🎵 <b>${title}</b>\n👤 ${author}`;
      const bytes = await fetchStreamBytes(chosenAudio.url, YT_VR_UA, 45 * 1024 * 1024);
      const audioFile = new InputFile(bytes, `${title.replace(/[^\w\s-]/g, '') || 'audio'}.m4a`, { type: 'audio/mp4' });

      const sent = await api.sendAudio({
        chat_id: chatId,
        audio: audioFile,
        title: title,
        performer: author,
        caption: caption,
        parse_mode: 'HTML',
      });

      if (sent && sent.audio) {
        await saveCache(url, quality, sent.audio.file_id, 'audio', caption);
      }

      return await api.deleteMessage({ chat_id: chatId, message_id: activeStatusId });
    }

    // For video: prefer muxed formats (which include audio), or matching mp4 format within size limit
    const targetHeight = parseInt(quality, 10) || 720;
    let chosenVideo = formats.find(f => f.url && f.height === targetHeight) || formats.find(f => f.url);

    // If user explicitly picked a resolution and muxed format doesn't match, check if adaptive mp4 fits if no muxed exists
    if (!chosenVideo) {
      const mp4Videos = adaptive.filter(
        f => f.url && f.mimeType && f.mimeType.includes('video/mp4') && (!f.contentLength || parseInt(f.contentLength, 10) < 44 * 1024 * 1024)
      );
      chosenVideo = mp4Videos.find(f => f.height === targetHeight) || mp4Videos[0];
    }

    if (!chosenVideo || !chosenVideo.url) {
      throw new Error('No downloadable video stream found');
    }

    const caption = `🎬 <b>${title}</b>\n👤 ${author}`;
    const sent = await sendVideoWithFallback(chatId, chosenVideo.url, caption, YT_VR_UA, 'youtube.mp4');

    if (sent && sent.video) {
      await saveCache(url, quality, sent.video.file_id, 'video', caption);
    }

    await api.deleteMessage({ chat_id: chatId, message_id: activeStatusId });
  } catch (err) {
    await api.editMessageText({
      chat_id: chatId,
      message_id: activeStatusId,
      text: `❌ Failed to download from YouTube: ${err.description || err.message || 'Error'}`,
    });
  }
}

export const handleCobalt = handleYouTubeDownload;
