import { api } from 'sdk';
import { fetchByteRangeSlice, fetchWithTimeout, probeRemoteMedia, readBodyBytes } from '../http.js';
import {
  extractAudioPartsFromRemoteMp4,
  fetchRemoteMp4Metadata,
  muxFmp4StreamsToProgressive,
} from '../mp4.js';
import {
  buildPartKeyboard,
  sendBufferAsAudio,
  sendBufferAsVideo,
  sendCachedEntry,
  sendLargeRemoteMp4Part,
} from '../delivery.js';
import {
  TG_MAX_UPLOAD_BYTES,
  TG_SPLIT_PART_BYTES,
  YTINFO_TTL_SEC,
  cancelKeyboard,
  cleanupDownloadTask,
  createDownloadTask,
  escapeHtml,
  extractYouTubeId,
  formatDuration,
  getCachedEntry,
  invalidateCacheEntry,
  isTaskCancelled,
  safeDeleteMessage,
  safeEditMessage,
  saveCache,
  sendOrEditStatusError,
  shouldSendStatusMessage,
  tgCall,
} from './common.js';

const YT_IOS_UA = 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)';
const YT_AND_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip';
const PO_SAFE_LIMIT = 4_900_000;

async function fetchInnertubePlayer(videoId, client, ua) {
  try {
    const res = await fetchWithTimeout(
      'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': ua,
        },
        body: JSON.stringify({
          videoId,
          context: { client },
        }),
      },
      12000
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchBothClients(videoId) {
  const [iosData, andData] = await Promise.all([
    fetchInnertubePlayer(
      videoId,
      {
        clientName: 'IOS',
        clientVersion: '20.10.4',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        osName: 'iPhone',
        osVersion: '18.3.2.22D82',
        hl: 'en',
        gl: 'US',
      },
      YT_IOS_UA
    ),
    fetchInnertubePlayer(
      videoId,
      {
        clientName: 'ANDROID',
        clientVersion: '20.10.38',
        androidSdkVersion: 34,
        osName: 'Android',
        osVersion: '14',
        hl: 'en',
        gl: 'US',
      },
      YT_AND_UA
    ),
  ]);
  return { iosData, andData };
}

function selectAdaptivePair(data, targetHeight, ua) {
  const adaptive = data?.streamingData?.adaptiveFormats || [];
  const avcVideos = adaptive
    .filter(f => f.url && /avc1/i.test(f.mimeType || '') && Number(f.contentLength || 0) > 0)
    .map(f => ({
      ...f,
      bytes: Number(f.contentLength),
      h: Number(f.height || 0),
    }))
    .sort((a, b) => Math.abs(a.h - targetHeight) - Math.abs(b.h - targetHeight) || b.h - a.h);

  const exactOrClosest = avcVideos.find(v => v.h <= targetHeight) || avcVideos[0] || null;
  const audios = adaptive
    .filter(f => f.url && /mp4a/i.test(f.mimeType || '') && Number(f.contentLength || 0) > 0)
    .map(f => ({ ...f, bytes: Number(f.contentLength) }))
    .sort((a, b) => Number(b.averageBitrate || b.bitrate || 0) - Number(a.averageBitrate || a.bitrate || 0));

  const bestAudio = audios.find(a => a.bytes <= PO_SAFE_LIMIT) || audios[0] || null;
  return { video: exactOrClosest, audio: bestAudio, ua };
}

function getAndroidItag18(andData) {
  const fmts = andData?.streamingData?.formats || [];
  return fmts.find(f => Number(f.itag) === 18 && f.url) || null;
}

function extractVideoMeta(iosData, andData, videoId) {
  const det = iosData?.videoDetails || andData?.videoDetails || {};
  const play = andData?.playabilityStatus?.status === 'OK'
    ? andData.playabilityStatus
    : iosData?.playabilityStatus || andData?.playabilityStatus || {};
  return {
    videoId,
    title: det.title || 'YouTube Video',
    author: det.author || '',
    lengthSeconds: Number(det.lengthSeconds || 0),
    isLive: Boolean(det.isLiveContent && !Number(det.lengthSeconds)),
    playable: play.status === 'OK',
    reason: play.reason || play.messages?.[0] || '',
  };
}

function trimStreamFmt(f) {
  if (!f?.url) return null;
  return {
    url: f.url,
    contentLength: String(f.contentLength || ''),
    bytes: Number(f.contentLength || f.bytes || 0),
    h: Number(f.height || f.h || 0),
    width: Number(f.width || 0),
    ...(f.initRange ? { initRange: { end: f.initRange.end } } : {}),
  };
}

function packYouTubeBundle(iosData, andData, videoId) {
  const meta = extractVideoMeta(iosData, andData, videoId);
  const f18 = trimStreamFmt(getAndroidItag18(andData));
  const pairs = {};
  for (const h of ['1080', '720', '480', '360']) {
    const p = selectAdaptivePair(iosData, Number(h), YT_IOS_UA);
    pairs[h] = { video: trimStreamFmt(p.video), audio: trimStreamFmt(p.audio) };
  }
  const hasAnyAdaptive = Boolean(
    iosData?.streamingData?.adaptiveFormats?.length ||
    pairs['720']?.audio ||
    pairs['360']?.video
  );
  return { meta, f18, pairs, hasAnyAdaptive };
}

async function getYouTubeBundle(videoId, forceFresh = false) {
  const key = `ytinfo:${videoId}`;
  if (!forceFresh) {
    const cachedRow = await getCachedEntry(key, 'ref', YTINFO_TTL_SEC);
    if (cachedRow?.fileId) {
      try {
        const parsed = JSON.parse(cachedRow.fileId);
        if (parsed?.meta) return { ...parsed, fromCache: true };
      } catch {}
    }
  }
  const { iosData, andData } = await fetchBothClients(videoId);
  const bundle = packYouTubeBundle(iosData, andData, videoId);
  if (bundle.meta?.playable || bundle.f18 || bundle.hasAnyAdaptive) {
    await saveCache(key, 'ref', JSON.stringify(bundle), 'ref', '');
  }
  return { ...bundle, fromCache: false };
}

async function fetchIosFmp4Stream(fmt, ua) {
  const total = Number(fmt.contentLength);
  if (!total || total > PO_SAFE_LIMIT) {
    throw new Error('STREAM_REQUIRES_PO_TOKEN');
  }
  const initEnd = fmt.initRange?.end !== undefined ? Number(fmt.initRange.end) : null;
  const sep = fmt.url.includes('?') ? '&' : '?';

  if (initEnd !== null && initEnd > 0 && initEnd < total - 1) {
    const [rInit, rFrag] = await Promise.all([
      fetchWithTimeout(`${fmt.url}${sep}range=0-${initEnd}`, { headers: { 'User-Agent': ua } }, 20000),
      fetchWithTimeout(`${fmt.url}${sep}range=${initEnd + 1}-${total - 1}`, { headers: { 'User-Agent': ua } }, 20000),
    ]);
    if (!rInit.ok || !rFrag.ok) {
      throw new Error(`HTTP ${!rInit.ok ? rInit.status : rFrag.status}`);
    }
    const [init, fragments] = await Promise.all([readBodyBytes(rInit), readBodyBytes(rFrag)]);
    return { init, fragments };
  }

  const r = await fetchWithTimeout(`${fmt.url}${sep}range=0-${total - 1}`, { headers: { 'User-Agent': ua } }, 20000);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const full = await readBodyBytes(r);
  return { init: full, fragments: new Uint8Array(0) };
}

function buildCaption(meta, videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const author = meta.author ? `👤 <b>${escapeHtml(meta.author)}</b>\n` : '';
  const dur = meta.lengthSeconds ? ` (${formatDuration(meta.lengthSeconds)})` : '';
  return `🎬 <b><a href="${url}">${escapeHtml(meta.title)}</a></b>${dur}\n${author}`;
}

/**
 * Inspect a YouTube link before presenting quality choices so we only show
 * actually downloadable qualities (HD muxed when <= 4.9 MB/track, 360p full/split, and Audio).
 */
export async function inspectYouTubeVideo(urlOrId) {
  const videoId = /^[A-Za-z0-9_-]{11}$/.test(urlOrId) ? urlOrId : extractYouTubeId(urlOrId);
  if (!videoId) return null;

  const bundle = await getYouTubeBundle(videoId);
  const { meta, f18, pairs } = bundle;
  let f18Bytes = Number(f18?.contentLength || 0);
  if (f18 && !f18Bytes) {
    const probed = await probeRemoteMedia(f18.url, { 'User-Agent': YT_AND_UA }).catch(() => null);
    if (probed?.contentLength) f18Bytes = probed.contentLength;
  }
  const pair720 = pairs['720'] || {};
  const pair1080 = pairs['1080'] || {};
  const pair480 = pairs['480'] || {};
  const pair360 = pairs['360'] || {};

  const audioFitsDirect = Boolean(pair720.audio && pair720.audio.bytes <= PO_SAFE_LIMIT);
  const canMux = p => Boolean(p?.video && p?.audio && p.video.bytes <= PO_SAFE_LIMIT && p.audio.bytes <= PO_SAFE_LIMIT);

  const rows = [];
  const hdRow = [];
  if (canMux(pair1080) && pair1080.video.h >= 1080) {
    const mb = ((pair1080.video.bytes + pair1080.audio.bytes) / 1048576).toFixed(1);
    hdRow.push({ text: `🎬 1080p (${mb} MB)`, callback_data: `ytq|1080|${videoId}` });
  }
  if (canMux(pair720) && pair720.video.h >= 720) {
    const mb = ((pair720.video.bytes + pair720.audio.bytes) / 1048576).toFixed(1);
    hdRow.push({ text: `🎬 720p HD (${mb} MB)`, callback_data: `ytq|720|${videoId}` });
  }
  if (hdRow.length) rows.push(hdRow);

  const sdRow = [];
  if (canMux(pair480) && pair480.video.h >= 480 && pair480.video.h < 720) {
    const mb = ((pair480.video.bytes + pair480.audio.bytes) / 1048576).toFixed(1);
    sdRow.push({ text: `📺 480p (${mb} MB)`, callback_data: `ytq|480|${videoId}` });
  }

  if (f18) {
    if (f18Bytes > TG_MAX_UPLOAD_BYTES) {
      const estParts = Math.max(2, Math.ceil(f18Bytes / TG_SPLIT_PART_BYTES));
      const mb = Math.round(f18Bytes / 1048576);
      sdRow.push({ text: `📱 360p (${mb} MB · ${estParts} Parts)`, callback_data: `ytq|360|${videoId}` });
    } else if (f18Bytes > 0) {
      const mb = (f18Bytes / 1048576).toFixed(1);
      sdRow.push({ text: `📱 360p (${mb} MB)`, callback_data: `ytq|360|${videoId}` });
    } else {
      sdRow.push({ text: '📱 360p', callback_data: `ytq|360|${videoId}` });
    }
  } else if (canMux(pair360)) {
    sdRow.push({ text: '📱 360p', callback_data: `ytq|360|${videoId}` });
  }
  if (sdRow.length) rows.push(sdRow);

  if (audioFitsDirect || f18) {
    const aLabel = audioFitsDirect
      ? `🎵 Audio .m4a (${(pair720.audio.bytes / 1048576).toFixed(1)} MB)`
      : '🎵 Audio .m4a (Extract)';
    rows.push([{ text: aLabel, callback_data: `ytq|audio|${videoId}` }]);
  }

  return {
    ...meta,
    hasFormats: rows.length > 0,
    inlineKeyboard: rows,
  };
}

export async function handleYouTubeDownload(
  chatId,
  url,
  quality = '720',
  statusMsgId = null,
  replyToMsgId = null,
  partIndex = 1
) {
  const videoId = extractYouTubeId(url);
  if (!videoId) return;
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Check part/single SQLite cache
  const cacheKey = partIndex > 1 ? `${quality}_p${partIndex}` : quality;
  const cached = await getCachedEntry(canonicalUrl, cacheKey);
  if (cached) {
    if (statusMsgId) await safeDeleteMessage(chatId, statusMsgId);
    return await sendCachedEntry(chatId, cached, replyToMsgId);
  }

  let msgId = statusMsgId;
  const showStatus = Boolean(msgId) || shouldSendStatusMessage(chatId);
  const taskToken = showStatus ? await createDownloadTask(chatId) : null;
  const cancelMarkup = taskToken ? cancelKeyboard(taskToken) : null;
  const shouldCancel = taskToken ? () => isTaskCancelled(chatId, taskToken) : null;

  if (!msgId) {
    if (showStatus) {
      const m = await tgCall('sendMessage', {
        chat_id: chatId,
        text: '⏳ <b>Fetching YouTube stream info...</b>',
        parse_mode: 'HTML',
        reply_markup: cancelMarkup,
        ...(replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {}),
      }).catch(() => null);
      msgId = m?.message_id || null;
    }
  } else {
    await safeEditMessage(chatId, msgId, '⏳ <b>Fetching YouTube stream info...</b>', cancelMarkup);
  }

  const runWithBundle = async bundle => {
    const { meta, f18, pairs, hasAnyAdaptive } = bundle;
    const caption = buildCaption(meta, videoId);

    if (meta.isLive) {
      await sendOrEditStatusError(
        chatId,
        msgId,
        '❌ Live streams are not supported for direct file download.',
        replyToMsgId
      );
      return;
    }

    if (!f18 && !hasAnyAdaptive) {
      const reason = meta.reason ? `: ${escapeHtml(meta.reason)}` : '';
      await sendOrEditStatusError(chatId, msgId, `❌ Video unavailable${reason}`, replyToMsgId);
      return;
    }

    // 1. AUDIO (.m4a) EXTRACTION (Direct adaptive <= 4.9 MB OR remote MOOV track extraction on >5 min videos!)
    if (quality === 'audio') {
      const pair = pairs['360'] || pairs['720'] || {};
      if (pair.audio && pair.audio.bytes <= PO_SAFE_LIMIT) {
        await safeEditMessage(chatId, msgId, '📥 <b>Downloading audio track...</b>', cancelMarkup);
        const aStream = await fetchIosFmp4Stream(pair.audio, YT_IOS_UA);
        if (shouldCancel && (await shouldCancel())) throw new Error('CANCELLED_BY_USER');
        const res = muxFmp4StreamsToProgressive([aStream], { audioOnly: true });
        const sent = await sendBufferAsAudio(chatId, res.buffer, {
          caption,
          replyToMsgId,
          filename: `${videoId}.m4a`,
          mimeType: 'audio/mp4',
          duration: meta.lengthSeconds || res.durationSec,
          title: meta.title,
          performer: meta.author,
          cacheUrl: canonicalUrl,
          cacheFormatId: 'audio',
        });
        await safeDeleteMessage(chatId, msgId);
        return sent;
      }

      if (!f18) {
        await sendOrEditStatusError(
          chatId,
          msgId,
          '❌ Audio track is blocked by YouTube PO token on this video.',
          replyToMsgId
        );
        return;
      }

      let totalLen = Number(f18.contentLength || 0);
      if (!totalLen) {
        const probed = await probeRemoteMedia(f18.url, { 'User-Agent': YT_AND_UA }).catch(() => null);
        if (probed?.contentLength) totalLen = probed.contentLength;
      }
      await safeEditMessage(
        chatId,
        msgId,
        `🎵 <b>Extracting AAC audio cleanly from long video${partIndex > 1 ? ` (Part ${partIndex})` : ''}...</b>`,
        cancelMarkup
      );

      const fetchSlice = (s, e) =>
        fetchByteRangeSlice(f18.url, { 'User-Agent': YT_AND_UA }, s, e, {
          chunkSize: 8 * 1024 * 1024,
          concurrency: 3,
          shouldCancel,
        });

      const mp4Meta = await fetchRemoteMp4Metadata(fetchSlice, totalLen);
      const audioParts = await extractAudioPartsFromRemoteMp4(mp4Meta, fetchSlice, TG_SPLIT_PART_BYTES, {
        partIndex,
        shouldCancel,
      });
      const ap = audioParts[0];
      if (!ap) throw new Error('Audio extraction produced no samples');

      const kb = buildPartKeyboard({
        totalParts: ap.totalParts,
        partIndex: ap.partIndex,
        ytSpec: { quality: 'audio', videoId },
        isAudio: true,
      });
      const partCaption = ap.totalParts > 1
        ? `🎵 <b>Audio Part ${ap.partIndex}/${ap.totalParts}</b>\n\n${caption}`
        : caption;

      const sent = await sendBufferAsAudio(chatId, ap.buffer, {
        caption: partCaption,
        replyToMsgId,
        filename: ap.totalParts > 1 ? `${videoId}_part${ap.partIndex}.m4a` : `${videoId}.m4a`,
        mimeType: 'audio/mp4',
        duration: ap.durationSec || meta.lengthSeconds,
        title: ap.totalParts > 1 ? `${meta.title} (Part ${ap.partIndex})` : meta.title,
        performer: meta.author,
        replyMarkup: kb,
        cacheUrl: canonicalUrl,
        cacheFormatId: ap.totalParts > 1 ? `audio_p${ap.partIndex}` : 'audio',
      });
      await safeDeleteMessage(chatId, msgId);
      return sent;
    }

    // 2. HD MUXED VIDEO (IOS adaptive video + audio <= 4.9 MB each)
    const targetKey = pairs[String(quality)] ? String(quality) : '720';
    const pair = pairs[targetKey] || pairs['720'] || {};
    if (quality !== '360' && pair.video && pair.audio && pair.video.bytes <= PO_SAFE_LIMIT && pair.audio.bytes <= PO_SAFE_LIMIT) {
      const totalMb = ((pair.video.bytes + pair.audio.bytes) / 1048576).toFixed(1);
      await safeEditMessage(
        chatId,
        msgId,
        `📥 <b>Downloading ${pair.video.h}p + AAC (${totalMb} MB)...</b>`,
        cancelMarkup
      );

      const [vStream, aStream] = await Promise.all([
        fetchIosFmp4Stream(pair.video, YT_IOS_UA),
        fetchIosFmp4Stream(pair.audio, YT_IOS_UA),
      ]);
      if (shouldCancel && (await shouldCancel())) throw new Error('CANCELLED_BY_USER');

      await safeEditMessage(chatId, msgId, '📤 <b>Muxing & uploading MP4...</b>');
      const muxed = muxFmp4StreamsToProgressive([vStream, aStream]);
      const sent = await sendBufferAsVideo(chatId, muxed.buffer, {
        caption,
        replyToMsgId,
        filename: `yt_${videoId}_${pair.video.h}p.mp4`,
        width: muxed.width || pair.video.width || 0,
        height: muxed.height || pair.video.h || 0,
        duration: meta.lengthSeconds || muxed.durationSec,
        cacheUrl: canonicalUrl,
        cacheFormatId: String(quality),
      });
      await safeDeleteMessage(chatId, msgId);
      return sent;
    }

    // 3. LONG / >5 MB VIDEO -> ANDROID itag 18 (Direct <= 48 MB OR GOP-split < 44 MB parts!)
    if (!f18) {
      await sendOrEditStatusError(
        chatId,
        msgId,
        '❌ YouTube requires a PO token for streams over 5 MB on this video and no progressive format was returned.',
        replyToMsgId
      );
      return;
    }

    return await sendLargeRemoteMp4Part({
      chatId,
      streamUrl: f18.url,
      headers: { 'User-Agent': YT_AND_UA },
      pageUrl: canonicalUrl,
      fullCaption: caption,
      statusMsgId: msgId,
      replyToMsgId,
      partIndex,
      filenameBase: `yt_${videoId}_360p`,
      shouldCancel,
      cancelMarkup,
      ytSpec: { quality: '360', videoId },
      knownTotalLength: Number(f18.contentLength || 0),
    });
  };

  try {
    let bundle = await getYouTubeBundle(videoId, false);
    if (shouldCancel && (await shouldCancel())) throw new Error('CANCELLED_BY_USER');
    try {
      return await runWithBundle(bundle);
    } catch (err) {
      const msg = String(err?.message || '');
      if (bundle.fromCache && /HTTP 403|HTTP 410|HTTP 404/i.test(msg)) {
        await invalidateCacheEntry(`ytinfo:${videoId}`, 'ref');
        bundle = await getYouTubeBundle(videoId, true);
        if (shouldCancel && (await shouldCancel())) throw new Error('CANCELLED_BY_USER');
        return await runWithBundle(bundle);
      }
      throw err;
    }
  } catch (err) {
    if (err?.code === 'CANCELLED' || String(err?.message || '').includes('CANCELLED_BY_USER')) {
      if (msgId) {
        await safeEditMessage(chatId, msgId, '🛑 <b>Download cancelled.</b>');
      }
      return;
    }
    await sendOrEditStatusError(
      chatId,
      msgId,
      `❌ Failed to download YouTube media: ${escapeHtml(err?.description || err?.message || 'Error')}`,
      replyToMsgId
    );
  } finally {
    if (taskToken) await cleanupDownloadTask(chatId, taskToken);
  }
}
