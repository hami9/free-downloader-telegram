import { api, InputFile } from 'sdk';
import {
  fetchByteRangeSlice,
  fetchMediaBuffer,
  mapWithConcurrency,
  probeRemoteMedia,
} from './http.js';
import {
  buildProgressiveMp4PartFromSpans,
  fetchRemoteMp4Metadata,
  findBox,
  parseProgressiveMoov,
  planProgressiveMp4Splits,
} from './mp4.js';
import {
  TG_MAX_PHOTO_BYTES,
  TG_MAX_UPLOAD_BYTES,
  TG_SPLIT_PART_BYTES,
  USER_AGENT,
  computeByteFingerprint,
  escapeHtml,
  formatDuration,
  getCachedEntry,
  resolveMediaRef,
  safeDeleteMessage,
  safeEditMessage,
  saveCache,
  sendFullCaptionOverflow,
  sendOrEditStatusError,
  splitCaption,
  storeMediaRef,
  tgCall,
} from './extractors/common.js';

function normalizeHeaders(headersOrUa) {
  if (!headersOrUa) return { 'User-Agent': USER_AGENT };
  if (typeof headersOrUa === 'string') return { 'User-Agent': headersOrUa };
  return { 'User-Agent': USER_AGENT, ...headersOrUa };
}

function tryInspectMp4Dims(buf) {
  try {
    if (!buf || buf.length < 32) return null;
    const headEnd = Math.min(buf.length, 4 * 1024 * 1024);
    let moov = findBox(buf, 'moov', 0, headEnd);
    if (!moov && buf.length > headEnd) {
      moov = findBox(buf, 'moov', Math.max(0, buf.length - 4 * 1024 * 1024), buf.length);
    }
    if (!moov) return null;
    const meta = parseProgressiveMoov(buf.subarray(moov.off, moov.end), buf.length);
    return {
      width: meta.videoTrack?.width || 0,
      height: meta.videoTrack?.height || 0,
      duration: Math.round(meta.durationSec || meta.videoTrack?.durationSec || 0),
    };
  } catch {
    return null;
  }
}

export async function sendBufferAsVideo(chatId, buffer, options = {}) {
  const {
    caption = '',
    replyToMsgId = null,
    filename = 'video.mp4',
    width = 0,
    height = 0,
    duration = 0,
    replyMarkup = undefined,
    cacheUrl = null,
    cacheFormatId = '',
    cacheCaption = null,
    skipOverflow = false,
  } = options;

  const { shortCaption, overflowText } = splitCaption(caption);
  const replyParams = replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {};
  const dims = (width && height && duration) ? { width, height, duration } : (tryInspectMp4Dims(buffer) || {});
  const vidMeta = {
    ...(width || dims.width ? { width: width || dims.width } : {}),
    ...(height || dims.height ? { height: height || dims.height } : {}),
    ...(duration || dims.duration ? { duration: duration || dims.duration } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };

  let sent;
  try {
    sent = await tgCall(() =>
      api.sendVideo({
        chat_id: chatId,
        video: new InputFile(buffer, filename, { type: 'video/mp4' }),
        caption: shortCaption,
        parse_mode: 'HTML',
        supports_streaming: true,
        ...vidMeta,
        ...replyParams,
      })
    );
  } catch (err) {
    if ((err?.description || '').toLowerCase().includes('parse entities')) {
      sent = await tgCall(() =>
        api.sendVideo({
          chat_id: chatId,
          video: new InputFile(buffer, filename, { type: 'video/mp4' }),
          caption: (shortCaption || '').replace(/<\/?[^>]+>/g, ''),
          supports_streaming: true,
          ...vidMeta,
          ...replyParams,
        })
      );
    } else {
      throw err;
    }
  }

  if (sent?.video && cacheUrl) {
    await saveCache(cacheUrl, cacheFormatId, sent.video.file_id, 'video', cacheCaption ?? caption);
  }
  if (!skipOverflow && overflowText) {
    await sendFullCaptionOverflow(chatId, overflowText, replyToMsgId);
  }
  return sent;
}

export async function sendBufferAsAudio(chatId, buffer, options = {}) {
  const {
    caption = '',
    replyToMsgId = null,
    filename = 'audio.m4a',
    mimeType = 'audio/mp4',
    duration = 0,
    title = 'Audio',
    performer = '',
    replyMarkup = undefined,
    cacheUrl = null,
    cacheFormatId = 'audio',
    cacheCaption = null,
  } = options;

  const { shortCaption, overflowText } = splitCaption(caption);
  const replyParams = replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {};
  const audioMeta = {
    ...(duration ? { duration: Math.round(duration) } : {}),
    ...(title ? { title: String(title).slice(0, 64) } : {}),
    ...(performer ? { performer: String(performer).slice(0, 64) } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };

  let sent;
  try {
    sent = await tgCall(() =>
      api.sendAudio({
        chat_id: chatId,
        audio: new InputFile(buffer, filename, { type: mimeType }),
        caption: shortCaption,
        parse_mode: 'HTML',
        ...audioMeta,
        ...replyParams,
      })
    );
  } catch (err) {
    if ((err?.description || '').toLowerCase().includes('parse entities')) {
      sent = await tgCall(() =>
        api.sendAudio({
          chat_id: chatId,
          audio: new InputFile(buffer, filename, { type: mimeType }),
          caption: (shortCaption || '').replace(/<\/?[^>]+>/g, ''),
          ...audioMeta,
          ...replyParams,
        })
      );
    } else {
      throw err;
    }
  }

  if (sent?.audio && cacheUrl) {
    await saveCache(cacheUrl, cacheFormatId, sent.audio.file_id, 'audio', cacheCaption ?? caption);
  }
  if (overflowText) {
    await sendFullCaptionOverflow(chatId, overflowText, replyToMsgId);
  }
  return sent;
}

export function buildPartKeyboard({ totalParts, partIndex, ytSpec = null, refId = null, isAudio = false }) {
  if (!totalParts || totalParts <= 1) return undefined;
  const makeCb = k =>
    ytSpec
      ? `ytp|${ytSpec.quality}|${k}|${ytSpec.videoId}`
      : `mp|${k}|${refId}`;

  const rows = [];
  if (partIndex < totalParts) {
    const nextIdx = partIndex + 1;
    rows.push([{
      text: `▶ ${isAudio ? 'Next Audio' : 'Next'}: Part ${nextIdx}/${totalParts}`,
      callback_data: makeCb(nextIdx),
    }]);
  }

  const others = [];
  for (let k = 1; k <= totalParts && others.length < 12; k++) {
    if (k === partIndex || k === partIndex + 1) continue;
    others.push({ text: `Part ${k}`, callback_data: makeCb(k) });
  }
  for (let i = 0; i < others.length; i += 4) {
    rows.push(others.slice(i, i + 4));
  }

  return rows.length ? { inline_keyboard: rows } : undefined;
}

export async function sendLargeRemoteMp4Part({
  chatId,
  streamUrl,
  headers = {},
  pageUrl,
  fullCaption = '',
  statusMsgId = null,
  replyToMsgId = null,
  partIndex = 1,
  filenameBase = 'video',
  shouldCancel = null,
  cancelMarkup = undefined,
  ytSpec = null,
  refId = null,
  knownTotalLength = 0,
  useQueryRange = false,
}) {
  const reqHeaders = normalizeHeaders(headers);
  let totalLength = knownTotalLength || 0;
  let supportsRange = useQueryRange;
  let resolvedUrl = streamUrl;

  if (!totalLength || !supportsRange) {
    const probed = await probeRemoteMedia(resolvedUrl, reqHeaders);
    if (probed.url) resolvedUrl = probed.url;
    if (!totalLength && probed.contentLength) totalLength = probed.contentLength;
    if (!supportsRange) supportsRange = probed.supportsRange;
  }

  const cacheFormatId = ytSpec ? ytSpec.quality : '';

  // Direct single-file transfer up to 48 MB (chunked via Range when > 20 MB)
  if (!totalLength || totalLength <= TG_MAX_UPLOAD_BYTES) {
    try {
      const buf = await fetchMediaBuffer(resolvedUrl, reqHeaders, {
        maxBytes: TG_MAX_UPLOAD_BYTES,
        knownLength: totalLength,
        concurrency: 3,
        useQueryRange,
        shouldCancel,
      });
      const actualImgExt = detectImageMagic(buf);
      if (actualImgExt && !ytSpec) {
        const imgErr = new Error('ACTUAL_IMAGE');
        imgErr.code = 'ACTUAL_IMAGE';
        imgErr.bytes = buf;
        imgErr.resolvedUrl = resolvedUrl;
        imgErr.imgExt = actualImgExt;
        throw imgErr;
      }
      const sent = await sendBufferAsVideo(chatId, buf, {
        caption: fullCaption,
        replyToMsgId,
        filename: `${filenameBase}.mp4`,
        cacheUrl: pageUrl,
        cacheFormatId,
      });
      if (statusMsgId) await safeDeleteMessage(chatId, statusMsgId);
      return sent;
    } catch (err) {
      if (err?.code === 'FILE_TOO_LARGE' && err.totalLength) {
        totalLength = err.totalLength;
        supportsRange = true;
      } else {
        throw err;
      }
    }
  }

  if (!supportsRange) {
    throw new Error(
      `Video is ${(totalLength / 1048576).toFixed(1)} MB (> 48 MB Telegram limit) and host does not support HTTP Range splitting.`
    );
  }

  const fetchSlice = (s, e) =>
    fetchByteRangeSlice(resolvedUrl, reqHeaders, s, e, {
      chunkSize: 8 * 1024 * 1024,
      concurrency: 3,
      useQueryRange,
      shouldCancel,
    });

  if (statusMsgId) {
    await safeEditMessage(
      chatId,
      statusMsgId,
      `⏳ <b>Analyzing long video (${(totalLength / 1048576).toFixed(1)} MB) & preparing Part ${partIndex}...</b>`,
      cancelMarkup
    );
  }

  const meta = await fetchRemoteMp4Metadata(fetchSlice, totalLength);
  const parts = planProgressiveMp4Splits(meta, TG_SPLIT_PART_BYTES);
  const targetIdx = Math.max(1, Math.min(partIndex, parts.length));
  const part = parts[targetIdx - 1];

  const activeRefId = ytSpec
    ? null
    : refId ||
      (await storeMediaRef(
        {
          streamUrl: resolvedUrl,
          headers: reqHeaders,
          pageUrl,
          caption: fullCaption,
          filenameBase,
          knownTotalLength: totalLength,
        },
        'mp'
      ));

  const partRangeLabel = `${formatDuration(part.startSec)} – ${formatDuration(part.endSec)}`;
  if (statusMsgId) {
    await safeEditMessage(
      chatId,
      statusMsgId,
      `📥 <b>Downloading Part ${targetIdx}/${parts.length}</b> (${partRangeLabel} · ~${(part.estimatedBytes / 1048576).toFixed(1)} MB)...`,
      cancelMarkup
    );
  }

  const fetchedSpans = await Promise.all(
    part.spans.map(async ([s, e]) => ({
      start: s,
      buf: await fetchSlice(s, e),
    }))
  );

  if (shouldCancel && (await shouldCancel())) {
    const err = new Error('CANCELLED_BY_USER');
    err.code = 'CANCELLED';
    throw err;
  }

  if (statusMsgId) {
    await safeEditMessage(
      chatId,
      statusMsgId,
      `📤 <b>Uploading Part ${targetIdx}/${parts.length}...</b>`
    );
  }

  const partBuffer = buildProgressiveMp4PartFromSpans(meta, part, fetchedSpans);
  const partHeader = `🎬 <b>Part ${targetIdx}/${parts.length}</b> (${partRangeLabel})`;
  const partCaption = fullCaption ? `${partHeader}\n\n${fullCaption}` : partHeader;
  const partCacheFormatId = ytSpec ? `${ytSpec.quality}_p${targetIdx}` : `p${targetIdx}`;
  const replyMarkup = buildPartKeyboard({
    totalParts: parts.length,
    partIndex: targetIdx,
    ytSpec,
    refId: activeRefId,
  });

  const sent = await sendBufferAsVideo(chatId, partBuffer, {
    caption: partCaption,
    replyToMsgId,
    filename: `${filenameBase}_part${targetIdx}.mp4`,
    width: meta.videoTrack?.width || 0,
    height: meta.videoTrack?.height || 0,
    duration: Math.max(1, Math.round(part.durationSec)),
    replyMarkup,
    cacheUrl: pageUrl,
    cacheFormatId: partCacheFormatId,
    skipOverflow: targetIdx > 1,
  });
  if (statusMsgId) await safeDeleteMessage(chatId, statusMsgId);
  return sent;
}

function detectImageMagic(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'webp';
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1' || brand === 'msf1') return 'heic';
  }
  return null;
}

function detectImageFormat(bytes, fallbackName = 'photo.jpg') {
  const magicExt = detectImageMagic(bytes);
  if (magicExt) {
    const mimeMap = {
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      heic: 'image/heic',
      jpg: 'image/jpeg',
    };
    return { ext: magicExt, mime: mimeMap[magicExt] || 'image/jpeg' };
  }
  const m = String(fallbackName || '').match(/\.(png|webp|gif|heic|jpeg|jpg)$/i);
  const ext = m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
  return { ext, mime };
}

function buildOrigFilename(baseName, ext) {
  const stem = String(baseName || 'photo').replace(/\.[a-z0-9]{2,5}$/i, '');
  return `${stem}.${ext}`;
}

function buildPhotoActionKeyboard(photoCount, refId, hasAudio = false) {
  if (!refId && !hasAudio) return undefined;
  const row = [];
  if (refId && photoCount > 0) {
    row.push({
      text: photoCount === 1
        ? '📎 Original (Lossless)'
        : `📎 Original Quality (${photoCount} Files)`,
      callback_data: photoCount === 1 ? `orig|0|${refId}` : `orig|all|${refId}`,
    });
  }
  if (refId && hasAudio) {
    row.push({ text: '🎵 Post Audio', callback_data: `aud|${refId}` });
  }
  return row.length ? { inline_keyboard: [row] } : undefined;
}

function getOriginalActionPrompt(photoCount, hasAudio) {
  if (photoCount > 0 && hasAudio) return '🖼 <b>Original Quality & Audio:</b>';
  if (hasAudio) return '🎵 <b>Post Audio:</b>';
  return '🖼 <b>Original Lossless Quality:</b>';
}

async function sendDocumentPhoto(chatId, bytes, caption, filename, replyToMsgId, replyMarkup, cacheUrl) {
  const { shortCaption, overflowText } = splitCaption(caption);
  const replyParams = replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {};
  const fmt = detectImageFormat(bytes, filename);
  const finalName = buildOrigFilename(filename, fmt.ext);

  let sent;
  try {
    sent = await tgCall(() =>
      api.sendDocument({
        chat_id: chatId,
        document: new InputFile(bytes, finalName, { type: fmt.mime }),
        disable_content_type_detection: true,
        ...(shortCaption ? { caption: shortCaption, parse_mode: 'HTML' } : {}),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...replyParams,
      })
    );
  } catch (err) {
    if ((err?.description || '').toLowerCase().includes('parse entities')) {
      sent = await tgCall(() =>
        api.sendDocument({
          chat_id: chatId,
          document: new InputFile(bytes, finalName, { type: fmt.mime }),
          disable_content_type_detection: true,
          caption: (shortCaption || '').replace(/<\/?[^>]+>/g, ''),
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          ...replyParams,
        })
      );
    } else {
      throw err;
    }
  }
  if (sent?.document && cacheUrl) {
    await saveCache(cacheUrl, '', sent.document.file_id, 'document', caption);
  }
  if (overflowText) await sendFullCaptionOverflow(chatId, overflowText, replyToMsgId);
  return sent;
}

async function sendPhotoWithFallback(
  chatId,
  photoUrl,
  caption,
  headers,
  filename,
  replyToMsgId,
  preloadedBytes,
  cacheUrl,
  replyMarkup = undefined
) {
  const { shortCaption, overflowText } = splitCaption(caption);
  const replyParams = replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {};
  let bytes = preloadedBytes;
  const resolvedUrl = photoUrl;

  try {
    if (!bytes && photoUrl) {
      bytes = await fetchMediaBuffer(photoUrl, headers, { maxBytes: TG_MAX_UPLOAD_BYTES, concurrency: 2 });
    }
    if (bytes) {
      const fmt = detectImageFormat(bytes, filename);
      // Telegram sendPhoto caps at ~10 MB and rejects HEIC -> send lossless document directly!
      if (bytes.length > TG_MAX_PHOTO_BYTES || fmt.ext === 'heic') {
        return await sendDocumentPhoto(chatId, bytes, caption, filename, replyToMsgId, replyMarkup, cacheUrl);
      }
      const sendName = buildOrigFilename(filename, fmt.ext === 'webp' ? 'jpg' : fmt.ext);
      const sent = await tgCall(() =>
        api.sendPhoto({
          chat_id: chatId,
          photo: new InputFile(bytes, sendName, { type: fmt.mime }),
          caption: shortCaption,
          parse_mode: 'HTML',
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          ...replyParams,
        })
      );
      if (sent?.photo?.length && cacheUrl) {
        await saveCache(cacheUrl, '', sent.photo[sent.photo.length - 1].file_id, 'photo', caption);
      }
      if (overflowText) await sendFullCaptionOverflow(chatId, overflowText, replyToMsgId);
      return sent;
    }
  } catch (err) {
    if (bytes && (err?.description || '').toLowerCase().includes('parse entities')) {
      const sent = await tgCall(() =>
        api.sendPhoto({
          chat_id: chatId,
          photo: new InputFile(bytes, filename || 'photo.jpg', { type: 'image/jpeg' }),
          caption: (shortCaption || '').replace(/<\/?[^>]+>/g, ''),
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          ...replyParams,
        })
      );
      if (sent?.photo?.length && cacheUrl) {
        await saveCache(cacheUrl, '', sent.photo[sent.photo.length - 1].file_id, 'photo', caption);
      }
      return sent;
    }
    // If Telegram rejected dimensions/webp/photo constraints even on bytes <= 9.5 MB, fall back to lossless document!
    if (bytes) {
      return await sendDocumentPhoto(chatId, bytes, caption, filename, replyToMsgId, replyMarkup, cacheUrl);
    }
  }

  const sent = await tgCall('sendPhoto', {
    chat_id: chatId,
    photo: resolvedUrl,
    caption: shortCaption,
    parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...replyParams,
  });
  if (sent?.photo?.length && cacheUrl) {
    await saveCache(cacheUrl, '', sent.photo[sent.photo.length - 1].file_id, 'photo', caption);
  }
  if (overflowText) await sendFullCaptionOverflow(chatId, overflowText, replyToMsgId);
  return sent;
}

export async function sendSlidesAndCache(
  chatId,
  url,
  rawItems,
  fullCaptionHtml,
  headersOrUa = USER_AGENT,
  replyToMsgId = null,
  statusMsgId = null,
  shouldCancel = null,
  extraOptions = {}
) {
  const reqHeaders = normalizeHeaders(headersOrUa);
  const { shortCaption, overflowText } = splitCaption(fullCaptionHtml);
  const replyParams = replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {};
  const audioTrack = extraOptions?.audioTrack || null;

  // Deduplicate items by URL first
  const seenUrls = new Set();
  const items = [];
  for (const it of rawItems || []) {
    if (!it || (!it.url && !it.bytes)) continue;
    const key = it.url ? it.url.split('#')[0] : `bytes_${items.length}`;
    if (it.url && seenUrls.has(key)) continue;
    if (it.url) seenUrls.add(key);
    items.push(it);
  }
  if (!items.length) return;

  const maybeStorePhotoRef = async photoSlides => {
    if (!photoSlides.length && !audioTrack) return null;
    const payload = {
      pageUrl: url,
      headers: reqHeaders,
      photos: photoSlides.map((s, idx) => ({
        url: s.resolvedUrl || s.url,
        filename: s.filename || `photo_${idx + 1}.jpg`,
      })),
      ...(audioTrack ? { audioTrack } : {}),
    };
    const refId = await storeMediaRef(payload, 'og');
    await saveCache(url, 'ogref', refId, 'ref', '');
    return refId;
  };

  const deliverSingle = async item => {
    const inlineImgExt = item.bytes ? detectImageMagic(item.bytes) : null;
    if (item.type === 'video' && inlineImgExt) {
      item = { ...item, type: 'photo', filename: buildOrigFilename(item.filename || 'photo', inlineImgExt) };
    }
    if (item.type === 'video') {
      if (item.bytes) {
        const sent = await sendBufferAsVideo(chatId, item.bytes, {
          caption: fullCaptionHtml,
          replyToMsgId,
          filename: item.filename || 'video.mp4',
          width: item.width || 0,
          height: item.height || 0,
          duration: item.duration || 0,
          cacheUrl: url,
          cacheFormatId: '',
        });
        if (statusMsgId) await safeDeleteMessage(chatId, statusMsgId);
        return sent;
      }
      try {
        return await sendLargeRemoteMp4Part({
          chatId,
          streamUrl: item.resolvedUrl || item.url,
          headers: reqHeaders,
          pageUrl: url,
          fullCaption: fullCaptionHtml,
          statusMsgId,
          replyToMsgId,
          partIndex: 1,
          filenameBase: (item.filename || 'video').replace(/\.mp4$/i, ''),
          shouldCancel,
        });
      } catch (err) {
        if (err?.code === 'CANCELLED') throw err;
        if (err?.code === 'ACTUAL_IMAGE') {
          item = {
            ...item,
            type: 'photo',
            bytes: err.bytes,
            resolvedUrl: err.resolvedUrl || item.url,
            filename: buildOrigFilename(item.filename || 'photo', err.imgExt || 'jpg'),
          };
        } else {
          const sent = await tgCall('sendVideo', {
            chat_id: chatId,
            video: item.resolvedUrl || item.url,
            caption: shortCaption,
            parse_mode: 'HTML',
            supports_streaming: true,
            ...replyParams,
          });
          if (statusMsgId) await safeDeleteMessage(chatId, statusMsgId);
          if (sent?.video) await saveCache(url, '', sent.video.file_id, 'video', fullCaptionHtml);
          if (overflowText) await sendFullCaptionOverflow(chatId, overflowText, replyToMsgId);
          return sent;
        }
      }
    }

    const refId = item.url ? await maybeStorePhotoRef([item]) : null;
    const kb = buildPhotoActionKeyboard(refId ? 1 : 0, refId, Boolean(audioTrack));
    const sent = await sendPhotoWithFallback(
      chatId,
      item.resolvedUrl || item.url,
      fullCaptionHtml,
      reqHeaders,
      item.filename || 'photo.jpg',
      replyToMsgId,
      item.bytes,
      url,
      kb
    );
    if (statusMsgId) await safeDeleteMessage(chatId, statusMsgId);
    return sent;
  };

  if (items.length === 1) {
    return await deliverSingle(items[0]);
  }

  // Multi-slide carousel: bounded worker concurrency (2) & cumulative RAM cap (~96 MB) to prevent V8 isolate OOM
  const MAX_CAROUSEL_BUFFERED_BYTES = 96 * 1024 * 1024;
  let bufferedBytes = 0;
  const prepared = await mapWithConcurrency(items, 2, async item => {
    if (item.bytes) {
      bufferedBytes += item.bytes.length;
      const magicExt = item.type === 'video' ? detectImageMagic(item.bytes) : null;
      const normalizedItem = magicExt
        ? { ...item, type: 'photo', filename: buildOrigFilename(item.filename || 'photo', magicExt) }
        : item;
      return { ...normalizedItem, fp: computeByteFingerprint(normalizedItem.bytes) };
    }
    if (item.type === 'video' && bufferedBytes >= MAX_CAROUSEL_BUFFERED_BYTES) {
      return { ...item, oversizedVideo: true, fp: null };
    }
    try {
      const bytes = await fetchMediaBuffer(item.url, reqHeaders, {
        maxBytes: TG_MAX_UPLOAD_BYTES,
        concurrency: 1,
        shouldCancel,
      });
      bufferedBytes += bytes.length;
      const magicExt = item.type === 'video' ? detectImageMagic(bytes) : null;
      const actualType = magicExt ? 'photo' : item.type;
      const actualName = magicExt ? buildOrigFilename(item.filename || 'photo', magicExt) : item.filename;
      const isLargePhoto =
        actualType !== 'video' && (bytes.length > TG_MAX_PHOTO_BYTES || detectImageFormat(bytes, actualName).ext === 'heic');
      return { ...item, type: actualType, filename: actualName, bytes, largePhoto: isLargePhoto, fp: computeByteFingerprint(bytes) };
    } catch (e) {
      return { ...item, oversizedVideo: item.type === 'video' && e?.code === 'FILE_TOO_LARGE', fp: null };
    }
  });

  const seenFp = new Set();
  const uniqueItems = [];
  for (const item of prepared) {
    if (item.fp) {
      if (seenFp.has(item.fp)) continue;
      seenFp.add(item.fp);
    }
    uniqueItems.push(item);
  }

  if (uniqueItems.length === 1) {
    return await deliverSingle(uniqueItems[0]);
  }

  const cachedAlbumItems = [];
  if (statusMsgId) await safeDeleteMessage(chatId, statusMsgId);

  for (let batchStart = 0; batchStart < uniqueItems.length; batchStart += 10) {
    const batch = uniqueItems.slice(batchStart, batchStart + 10);
    if (batch.some(x => x.oversizedVideo || x.largePhoto)) {
      for (let idx = 0; idx < batch.length; idx++) {
        const item = batch[idx];
        const cap = batchStart === 0 && idx === 0 ? fullCaptionHtml : '';
        if (item.oversizedVideo) {
          await sendLargeRemoteMp4Part({
            chatId,
            streamUrl: item.url,
            headers: reqHeaders,
            pageUrl: `${url}#slide${batchStart + idx + 1}`,
            fullCaption: cap,
            replyToMsgId,
            partIndex: 1,
            filenameBase: `slide_${batchStart + idx + 1}`,
          });
        } else if (item.largePhoto && item.bytes) {
          await sendDocumentPhoto(chatId, item.bytes, cap, item.filename || `slide_${batchStart + idx + 1}`, replyToMsgId);
        } else {
          await sendSlidesAndCache(chatId, `${url}#slide${batchStart + idx + 1}`, [item], cap, reqHeaders, replyToMsgId);
        }
      }
      continue;
    }

    const makeMediaGroup = () =>
      batch.map((item, idx) => {
        const isFirst = batchStart === 0 && idx === 0;
        const entry = {
          type: item.type === 'video' ? 'video' : 'photo',
          ...(isFirst && shortCaption ? { caption: shortCaption, parse_mode: 'HTML' } : {}),
          ...(item.type === 'video' ? { supports_streaming: true } : {}),
        };
        if (item.bytes) {
          const fmt = item.type === 'video' ? { ext: 'mp4', mime: 'video/mp4' } : detectImageFormat(item.bytes, item.filename);
          const sendExt = fmt.ext === 'webp' ? 'jpg' : fmt.ext;
          entry.media = new InputFile(item.bytes, `slide_${batchStart + idx + 1}.${sendExt}`, { type: fmt.mime });
        } else {
          entry.media = item.resolvedUrl || item.url;
        }
        return entry;
      });

    try {
      const sentMsgs = await tgCall(() =>
        api.sendMediaGroup({
          chat_id: chatId,
          media: makeMediaGroup(),
          ...replyParams,
        })
      );
      if (Array.isArray(sentMsgs)) {
        for (const m of sentMsgs) {
          if (m.video) cachedAlbumItems.push({ type: 'video', file_id: m.video.file_id });
          else if (m.photo?.length) cachedAlbumItems.push({ type: 'photo', file_id: m.photo[m.photo.length - 1].file_id });
        }
      }
    } catch {
      for (let idx = 0; idx < batch.length; idx++) {
        const item = batch[idx];
        const cap = batchStart === 0 && idx === 0 ? fullCaptionHtml : '';
        if (item.type === 'video') {
          const s = item.bytes
            ? await sendBufferAsVideo(chatId, item.bytes, { caption: cap, replyToMsgId, filename: `slide_${batchStart + idx + 1}.mp4` })
            : await tgCall('sendVideo', { chat_id: chatId, video: item.url, caption: cap, parse_mode: 'HTML', supports_streaming: true, ...replyParams });
          if (s?.video) cachedAlbumItems.push({ type: 'video', file_id: s.video.file_id });
        } else {
          const s = await sendPhotoWithFallback(chatId, item.url, cap, reqHeaders, `slide_${batchStart + idx + 1}.jpg`, replyToMsgId, item.bytes);
          if (s?.photo?.length) cachedAlbumItems.push({ type: 'photo', file_id: s.photo[s.photo.length - 1].file_id });
        }
      }
    }
  }

  if (overflowText) {
    await sendFullCaptionOverflow(chatId, overflowText, replyToMsgId);
  }
  if (cachedAlbumItems.length) {
    await saveCache(url, '', JSON.stringify(cachedAlbumItems), 'album', fullCaptionHtml);
  }

  const photoSlides = uniqueItems.filter(it => it.type !== 'video' && it.url);
  if (photoSlides.length || audioTrack) {
    const refId = await maybeStorePhotoRef(photoSlides);
    const kb = buildPhotoActionKeyboard(photoSlides.length, refId, Boolean(audioTrack));
    if (kb) {
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: getOriginalActionPrompt(photoSlides.length, Boolean(audioTrack)),
        parse_mode: 'HTML',
        reply_markup: kb,
        ...replyParams,
      }).catch(() => {});
    }
  }
}

export async function handleMediaPartCallback({ chatId, partIndex, refId, messageId, replyToMsgId }) {
  const ref = await resolveMediaRef(refId);
  if (!ref || !ref.streamUrl) {
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: '⚠️ This split link has expired. Please re-send the post link.',
      ...(replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {}),
    });
  }

  const cached = await getCachedEntry(ref.pageUrl, `p${partIndex}`);
  if (cached) {
    return await sendCachedEntry(chatId, cached, replyToMsgId);
  }

  const statusMsg = await tgCall('sendMessage', {
    chat_id: chatId,
    text: `⏳ <b>Fetching Part ${partIndex}...</b>`,
    parse_mode: 'HTML',
    ...(replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {}),
  }).catch(() => null);

  try {
    await sendLargeRemoteMp4Part({
      chatId,
      streamUrl: ref.streamUrl,
      headers: ref.headers || {},
      pageUrl: ref.pageUrl,
      fullCaption: ref.caption || '',
      statusMsgId: statusMsg?.message_id || null,
      replyToMsgId,
      partIndex,
      filenameBase: ref.filenameBase || 'video',
      refId,
      knownTotalLength: ref.knownTotalLength || 0,
    });
  } catch (err) {
    await sendOrEditStatusError(
      chatId,
      statusMsg?.message_id,
      `❌ Failed to fetch Part ${partIndex}: ${escapeHtml(err?.description || err?.message || 'Error')}`,
      replyToMsgId
    );
  }
}

export async function handleOriginalFileCallback({ chatId, target, refId, replyToMsgId }) {
  const ref = await resolveMediaRef(refId);
  const photos = ref?.photos || [];
  if (!photos.length) {
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: '⚠️ Original photo link expired. Please re-send the post link.',
      ...(replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {}),
    });
  }

  const headers = normalizeHeaders(ref.headers);
  const replyParams = replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {};
  const list = target === 'all' ? photos : [photos[Number(target) || 0]].filter(Boolean);

  const statusMsg = await tgCall('sendMessage', {
    chat_id: chatId,
    text: `📎 <b>Downloading original lossless ${list.length > 1 ? `files (${list.length})` : 'file'}...</b>`,
    parse_mode: 'HTML',
    ...replyParams,
  });

  try {
    // Download and upload in bounded batches of 4 with worker concurrency 2 to bound V8 heap usage
    const WAVE_SIZE = 4;
    for (let waveStart = 0; waveStart < list.length; waveStart += WAVE_SIZE) {
      const wave = list.slice(waveStart, waveStart + WAVE_SIZE);
      const docs = await mapWithConcurrency(wave, 2, async (item, offset) => {
        const bytes = await fetchMediaBuffer(item.url, headers, { maxBytes: TG_MAX_UPLOAD_BYTES, concurrency: 1 });
        const fmt = detectImageFormat(bytes, item.filename);
        const name = buildOrigFilename(item.filename || `original_${waveStart + offset + 1}`, fmt.ext);
        return { bytes, name, mime: fmt.mime };
      });

      if (docs.length === 1) {
        await tgCall(() =>
          api.sendDocument({
            chat_id: chatId,
            document: new InputFile(docs[0].bytes, docs[0].name, { type: docs[0].mime }),
            disable_content_type_detection: true,
            ...replyParams,
          })
        );
      } else {
        try {
          await tgCall(() =>
            api.sendMediaGroup({
              chat_id: chatId,
              media: docs.map(d => ({
                type: 'document',
                media: new InputFile(d.bytes, d.name, { type: d.mime }),
                disable_content_type_detection: true,
              })),
              ...replyParams,
            })
          );
        } catch {
          for (const d of docs) {
            await tgCall(() =>
              api.sendDocument({
                chat_id: chatId,
                document: new InputFile(d.bytes, d.name, { type: d.mime }),
                disable_content_type_detection: true,
                ...replyParams,
              })
            );
          }
        }
      }
    }
    await safeDeleteMessage(chatId, statusMsg?.message_id);
  } catch (err) {
    await safeEditMessage(
      chatId,
      statusMsg?.message_id,
      `❌ Failed to send original file: ${escapeHtml(err?.description || err?.message || 'Error')}`
    );
  }
}

export async function handleAudioCallback({ chatId, refId, replyToMsgId }) {
  const ref = await resolveMediaRef(refId);
  const aud = ref?.audioTrack;
  if (!aud || !aud.url) {
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: '⚠️ Audio link expired. Please re-send the post link.',
      ...(replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {}),
    });
  }

  const replyParams = replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {};
  const statusMsg = await tgCall('sendMessage', {
    chat_id: chatId,
    text: '🎵 <b>Downloading post audio...</b>',
    parse_mode: 'HTML',
    ...replyParams,
  });

  try {
    let bytes = await fetchMediaBuffer(aud.url, normalizeHeaders(aud.headers || ref.headers), {
      maxBytes: 35 * 1024 * 1024,
      concurrency: 2,
    });
    let outName = aud.filename || 'post_audio.mp3';
    let outMime = aud.mimeType || 'audio/mpeg';
    if (aud.extractFromMp4) {
      const sliceFromBuf = async (s, e) => bytes.subarray(s, Math.min(bytes.length, e + 1));
      const meta = await fetchRemoteMp4Metadata(sliceFromBuf, bytes.length);
      const audioParts = meta?.audioTrack ? await extractAudioPartsFromRemoteMp4(meta, sliceFromBuf) : [];
      if (!audioParts.length || !audioParts[0]?.buffer) {
        throw new Error('No separate audio track found in media');
      }
      bytes = audioParts[0].buffer;
      outName = outName.replace(/\.[a-z0-9]+$/i, '.m4a');
      outMime = 'audio/mp4';
    }
    const sent = await sendBufferAsAudio(chatId, bytes, {
      replyToMsgId,
      filename: outName,
      mimeType: outMime,
      title: aud.title || 'Post Audio',
      performer: aud.performer || '',
    });
    await safeDeleteMessage(chatId, statusMsg?.message_id);
    return sent;
  } catch (err) {
    await safeEditMessage(
      chatId,
      statusMsg?.message_id,
      `❌ Failed to download audio: ${escapeHtml(err?.description || err?.message || 'Error')}`
    );
  }
}

export async function sendCachedEntry(chatId, cached, replyToMsgId = null) {
  const { shortCaption, overflowText } = splitCaption(cached.caption || '');
  const replyParams = replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {};

  let photoKb;
  if (cached.mediaType === 'photo' || cached.mediaType === 'album' || cached.mediaType === 'document') {
    const ogRefRow = await getCachedEntry(cached.url, 'ogref');
    if (ogRefRow?.fileId) {
      const refData = await resolveMediaRef(ogRefRow.fileId);
      if (refData) {
        photoKb = buildPhotoActionKeyboard(
          refData.photos?.length || (cached.mediaType === 'photo' ? 1 : 0),
          ogRefRow.fileId,
          Boolean(refData.audioTrack)
        );
      }
    }
  }

  if (cached.mediaType === 'album') {
    const items = JSON.parse(cached.fileId);
    for (let i = 0; i < items.length; i += 10) {
      const batch = items.slice(i, i + 10);
      await tgCall('sendMediaGroup', {
        chat_id: chatId,
        media: batch.map((it, idx) => ({
          type: it.type,
          media: it.file_id,
          ...(i === 0 && idx === 0 && shortCaption ? { caption: shortCaption, parse_mode: 'HTML' } : {}),
          ...(it.type === 'video' ? { supports_streaming: true } : {}),
        })),
        ...replyParams,
      });
    }
    if (overflowText) await sendFullCaptionOverflow(chatId, overflowText, replyToMsgId);
    if (photoKb) {
      const hasOrigPhotos = photoKb.inline_keyboard?.[0]?.some(b => String(b.callback_data || '').startsWith('orig|'));
      const hasAudioBtn = photoKb.inline_keyboard?.[0]?.some(b => String(b.callback_data || '').startsWith('aud|'));
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: getOriginalActionPrompt(hasOrigPhotos ? 1 : 0, hasAudioBtn),
        parse_mode: 'HTML',
        reply_markup: photoKb,
        ...replyParams,
      }).catch(() => {});
    }
    return;
  }

  if (cached.mediaType === 'audio') {
    await tgCall('sendAudio', {
      chat_id: chatId,
      audio: cached.fileId,
      caption: shortCaption,
      parse_mode: 'HTML',
      ...replyParams,
    });
  } else if (cached.mediaType === 'document') {
    await tgCall('sendDocument', {
      chat_id: chatId,
      document: cached.fileId,
      caption: shortCaption,
      parse_mode: 'HTML',
      ...(photoKb ? { reply_markup: photoKb } : {}),
      ...replyParams,
    });
  } else if (cached.mediaType === 'photo') {
    await tgCall('sendPhoto', {
      chat_id: chatId,
      photo: cached.fileId,
      caption: shortCaption,
      parse_mode: 'HTML',
      ...(photoKb ? { reply_markup: photoKb } : {}),
      ...replyParams,
    });
  } else {
    await tgCall('sendVideo', {
      chat_id: chatId,
      video: cached.fileId,
      caption: shortCaption,
      parse_mode: 'HTML',
      supports_streaming: true,
      ...replyParams,
    });
  }

  if (overflowText) {
    await sendFullCaptionOverflow(chatId, overflowText, replyToMsgId);
  }
}
