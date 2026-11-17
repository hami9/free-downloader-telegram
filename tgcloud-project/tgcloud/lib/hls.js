import { BROWSER_UA, concatBytes, fetchWithTimeout, readBodyBytes, resolveRelativeUrl } from './http.js';
import { buildProgressiveMp4FromTracks, makeBox, makeFullBox, muxFmp4StreamsToProgressive } from './mp4.js';

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

function parseAttrList(raw) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  }
  return out;
}

function parseByteRangeStr(raw, prevEnd = -1) {
  if (!raw) return null;
  const [lenStr, offStr] = String(raw).trim().split('@');
  const len = Number(lenStr);
  if (!Number.isFinite(len) || len <= 0) return null;
  const start = offStr !== undefined && offStr !== '' ? Number(offStr) : prevEnd + 1;
  if (!Number.isFinite(start) || start < 0) return null;
  return { start, end: start + len - 1 };
}

function parseHlsPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const variants = [];
  const audioGroups = [];
  const segments = [];
  let mapUri = null;
  let mapByteRange = null;
  let pendingInf = null;
  let pendingByteRange = null;
  let pendingStream = null;
  let totalDurationSec = 0;
  let lastSegUri = null;
  let lastSegEnd = -1;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttrList(line.slice(13));
      if (attrs.TYPE === 'AUDIO' && attrs.URI) {
        audioGroups.push({
          groupId: attrs['GROUP-ID'] || '',
          uri: resolveRelativeUrl(baseUrl, attrs.URI),
          isDefault: attrs.DEFAULT === 'YES',
        });
      }
      continue;
    }
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttrList(line.slice(18));
      const resM = String(attrs.RESOLUTION || '').match(/(\d+)x(\d+)/);
      pendingStream = {
        bandwidth: Number(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || 0),
        width: resM ? Number(resM[1]) : 0,
        height: resM ? Number(resM[2]) : 0,
        audioGroup: attrs.AUDIO || '',
        codecs: attrs.CODECS || '',
      };
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttrList(line.slice(11));
      if (attrs.URI) mapUri = resolveRelativeUrl(baseUrl, attrs.URI);
      if (attrs.BYTERANGE) mapByteRange = parseByteRangeStr(attrs.BYTERANGE, -1);
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = line.slice(17).trim();
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      pendingInf = parseFloat(line.slice(8)) || 0;
      totalDurationSec += pendingInf;
      continue;
    }
    if (line.startsWith('#')) continue;

    if (pendingStream) {
      variants.push({ ...pendingStream, uri: resolveRelativeUrl(baseUrl, line) });
      pendingStream = null;
    } else {
      const segUri = resolveRelativeUrl(baseUrl, line);
      const prevEnd = segUri === lastSegUri ? lastSegEnd : -1;
      const byteRange = pendingByteRange ? parseByteRangeStr(pendingByteRange, prevEnd) : null;
      if (byteRange) {
        lastSegUri = segUri;
        lastSegEnd = byteRange.end;
      }
      segments.push({ uri: segUri, duration: pendingInf || 0, byteRange });
      pendingInf = null;
      pendingByteRange = null;
    }
  }

  return { isMaster: variants.length > 0, variants, audioGroups, segments, mapUri, mapByteRange, totalDurationSec };
}

function parseMpegTs(tsBytes) {
  let pmtPid = -1;
  let videoPid = -1;
  let audioPid = -1;
  const pesMap = new Map();
  const videoPes = [];
  const audioPes = [];

  const flushPes = pid => {
    const cur = pesMap.get(pid);
    if (!cur || !cur.chunks.length) return;
    const raw = concatBytes(cur.chunks);
    pesMap.delete(pid);
    if (raw.length < 9 || raw[0] !== 0 || raw[1] !== 0 || raw[2] !== 1) return;
    const flags2 = raw[7];
    const headerLen = raw[8];
    const payloadStart = 9 + headerLen;
    if (payloadStart >= raw.length) return;

    const parseTs90k = off => {
      const hi = (raw[off] & 0x0e) >>> 1;
      const mid1 = raw[off + 1];
      const mid2 = (raw[off + 2] & 0xfe) >>> 1;
      const mid3 = raw[off + 3];
      const lo = (raw[off + 4] & 0xfe) >>> 1;
      return hi * 536870912 + (mid1 << 22) + (mid2 << 15) + (mid3 << 7) + lo;
    };

    let pts = 0;
    let dts = 0;
    if ((flags2 & 0x80) && raw.length >= 14) {
      pts = parseTs90k(9);
      dts = (flags2 & 0x40) && raw.length >= 19 ? parseTs90k(14) : pts;
    }
    const payload = raw.subarray(payloadStart);
    if (pid === videoPid) videoPes.push({ pts, dts, payload });
    else if (pid === audioPid) audioPes.push({ pts, dts, payload });
  };

  for (let off = 0; off + 188 <= tsBytes.length; off += 188) {
    if (tsBytes[off] !== 0x47) {
      const nextSync = tsBytes.indexOf(0x47, off + 1);
      if (nextSync < 0) break;
      off = nextSync - 188;
      continue;
    }
    const pusi = Boolean(tsBytes[off + 1] & 0x40);
    const pid = ((tsBytes[off + 1] & 0x1f) << 8) | tsBytes[off + 2];
    const adaptCtrl = (tsBytes[off + 3] >>> 4) & 0x03;
    if (!(adaptCtrl & 0x01)) continue;
    let p = off + 4;
    if (adaptCtrl & 0x02) {
      const afLen = tsBytes[p];
      p += 1 + afLen;
    }
    if (p >= off + 188) continue;
    const data = tsBytes.subarray(p, off + 188);

    if (pid === 0) {
      const ptr = pusi ? 1 + data[0] : 0;
      const sec = data.subarray(ptr);
      if (sec.length >= 12 && sec[0] === 0x00) {
        const secLen = ((sec[1] & 0x0f) << 8) | sec[2];
        const end = Math.min(sec.length, 3 + secLen - 4);
        for (let i = 8; i + 4 <= end; i += 4) {
          const prog = (sec[i] << 8) | sec[i + 1];
          if (prog !== 0) {
            pmtPid = ((sec[i + 2] & 0x1f) << 8) | sec[i + 3];
            break;
          }
        }
      }
      continue;
    }

    if (pid === pmtPid) {
      const ptr = pusi ? 1 + data[0] : 0;
      const sec = data.subarray(ptr);
      if (sec.length >= 12 && sec[0] === 0x02) {
        const secLen = ((sec[1] & 0x0f) << 8) | sec[2];
        const progInfoLen = ((sec[10] & 0x0f) << 8) | sec[11];
        const end = Math.min(sec.length, 3 + secLen - 4);
        let i = 12 + progInfoLen;
        while (i + 5 <= end) {
          const stype = sec[i];
          const epid = ((sec[i + 1] & 0x1f) << 8) | sec[i + 2];
          const esInfoLen = ((sec[i + 3] & 0x0f) << 8) | sec[i + 4];
          if (stype === 0x1b && videoPid < 0) videoPid = epid;
          else if ((stype === 0x0f || stype === 0x11) && audioPid < 0) audioPid = epid;
          i += 5 + esInfoLen;
        }
      }
      continue;
    }

    if (pid === videoPid || pid === audioPid) {
      if (pusi) {
        flushPes(pid);
        pesMap.set(pid, { chunks: [data] });
      } else {
        const cur = pesMap.get(pid);
        if (cur) cur.chunks.push(data);
      }
    }
  }
  flushPes(videoPid);
  flushPes(audioPid);
  return { videoPes, audioPes };
}

function splitAnnexBNals(buf) {
  const nals = [];
  let i = 0;
  const starts = [];
  while (i + 3 <= buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) {
        starts.push({ scStart: i, nalStart: i + 3 });
        i += 3;
        continue;
      }
      if (i + 3 < buf.length && buf[i + 2] === 0 && buf[i + 3] === 1) {
        starts.push({ scStart: i, nalStart: i + 4 });
        i += 4;
        continue;
      }
    }
    i++;
  }
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k].nalStart;
    const end = k + 1 < starts.length ? starts[k + 1].scStart : buf.length;
    if (end > start) nals.push(buf.subarray(start, end));
  }
  return nals;
}

function buildAvcStsd(sps, pps, width, height) {
  const avcCBody = new Uint8Array(11 + sps.length + pps.length);
  avcCBody[0] = 1;
  avcCBody[1] = sps[1] || 0x64;
  avcCBody[2] = sps[2] || 0x00;
  avcCBody[3] = sps[3] || 0x1f;
  avcCBody[4] = 0xff;
  avcCBody[5] = 0xe1;
  avcCBody[6] = (sps.length >> 8) & 0xff;
  avcCBody[7] = sps.length & 0xff;
  avcCBody.set(sps, 8);
  const ppsOff = 8 + sps.length;
  avcCBody[ppsOff] = 1;
  avcCBody[ppsOff + 1] = (pps.length >> 8) & 0xff;
  avcCBody[ppsOff + 2] = pps.length & 0xff;
  avcCBody.set(pps, ppsOff + 3);
  const avcC = makeBox('avcC', avcCBody);

  const entry = new Uint8Array(78 + avcC.length);
  const dv = new DataView(entry.buffer);
  dv.setUint16(6, 1); // data_reference_index
  dv.setUint16(24, width || 1280);
  dv.setUint16(26, height || 720);
  dv.setUint32(28, 0x00480000);
  dv.setUint32(32, 0x00480000);
  dv.setUint16(40, 1);
  dv.setUint16(74, 0x0018);
  dv.setInt16(76, -1);
  entry.set(avcC, 78);
  const avc1 = makeBox('avc1', entry);
  return makeFullBox('stsd', 0, 0, new Uint8Array([0, 0, 0, 1]), avc1);
}

function buildMp4aStsd(objType, freqIdx, chCfg, sampleRate) {
  const asc0 = ((objType & 0x1f) << 3) | ((freqIdx >> 1) & 0x07);
  const asc1 = ((freqIdx & 1) << 7) | ((chCfg & 0x0f) << 3);
  const esdsPayload = new Uint8Array([
    0x03, 25, 0x00, 0x01, 0x00,
    0x04, 17, 0x40, 0x15, 0x00, 0x18, 0x00, 0x00, 0x01, 0xf4, 0x00, 0x00, 0x01, 0xf4, 0x00,
    0x05, 2, asc0, asc1,
    0x06, 1, 0x02,
  ]);
  const esds = makeFullBox('esds', 0, 0, esdsPayload);
  const entry = new Uint8Array(28 + esds.length);
  const dv = new DataView(entry.buffer);
  dv.setUint16(6, 1);
  dv.setUint16(16, chCfg || 2);
  dv.setUint16(18, 16);
  dv.setUint32(24, (sampleRate << 16) >>> 0);
  entry.set(esds, 28);
  const mp4a = makeBox('mp4a', entry);
  return makeFullBox('stsd', 0, 0, new Uint8Array([0, 0, 0, 1]), mp4a);
}

function remuxMpegTsToProgressiveMp4(tsBytes, hintWidth = 0, hintHeight = 0) {
  const { videoPes, audioPes } = parseMpegTs(tsBytes);
  if (!videoPes.length) throw new Error('MPEG-TS contains no H.264 video stream');

  let sps = null;
  let pps = null;
  const vSamples = [];

  for (let i = 0; i < videoPes.length; i++) {
    const pes = videoPes[i];
    const nals = splitAnnexBNals(pes.payload);
    const frameNals = [];
    let isSync = false;

    for (const nal of nals) {
      const nalType = nal[0] & 0x1f;
      if (nalType === 9) continue; // Access unit delimiter
      if (nalType === 7 && !sps) { sps = nal; continue; }
      if (nalType === 8 && !pps) { pps = nal; continue; }
      if (nalType === 5) isSync = true;
      const lenPrefixed = new Uint8Array(4 + nal.length);
      new DataView(lenPrefixed.buffer).setUint32(0, nal.length >>> 0);
      lenPrefixed.set(nal, 4);
      frameNals.push(lenPrefixed);
    }

    if (!frameNals.length) continue;
    const nextDts = i + 1 < videoPes.length ? videoPes[i + 1].dts : pes.dts + 3000;
    const dur = Math.max(1, Math.min(90000, nextDts - pes.dts || 3000));
    vSamples.push({
      data: concatBytes(frameNals),
      duration: dur,
      cto: Math.round(pes.pts - pes.dts),
      isSync,
    });
  }

  if (!sps || !pps || !vSamples.length) {
    throw new Error('Could not extract SPS/PPS/frames from TS video');
  }

  const tracks = [{
    handlerType: 'vide',
    timescale: 90000,
    width: hintWidth || 1280,
    height: hintHeight || 720,
    langBytes: [0x55, 0xc4],
    rawStsd: buildAvcStsd(sps, pps, hintWidth || 1280, hintHeight || 720),
    samples: vSamples,
  }];

  // Extract AAC ADTS audio frames if present
  if (audioPes.length) {
    const rawAdts = concatBytes(audioPes.map(a => a.payload));
    const aSamples = [];
    let freqIdx = 4;
    let chCfg = 2;
    let objType = 2;
    let sampleRate = 44100;

    let off = 0;
    while (off + 7 <= rawAdts.length) {
      if (rawAdts[off] !== 0xff || (rawAdts[off + 1] & 0xf0) !== 0xf0) {
        off++;
        continue;
      }
      const protectionAbsent = rawAdts[off + 1] & 0x01;
      objType = ((rawAdts[off + 2] >>> 6) & 0x03) + 1;
      freqIdx = (rawAdts[off + 2] >>> 2) & 0x0f;
      chCfg = ((rawAdts[off + 2] & 0x01) << 2) | ((rawAdts[off + 3] >>> 6) & 0x03);
      const frameLen =
        ((rawAdts[off + 3] & 0x03) << 11) |
        (rawAdts[off + 4] << 3) |
        ((rawAdts[off + 5] >>> 5) & 0x07);
      const hdrLen = protectionAbsent ? 7 : 9;
      if (frameLen < hdrLen || off + frameLen > rawAdts.length) break;
      sampleRate = AAC_SAMPLE_RATES[freqIdx] || 44100;
      aSamples.push({
        data: rawAdts.subarray(off + hdrLen, off + frameLen),
        duration: 1024,
        cto: 0,
        isSync: true,
      });
      off += frameLen;
    }

    if (aSamples.length) {
      tracks.push({
        handlerType: 'soun',
        timescale: sampleRate,
        width: 0,
        height: 0,
        langBytes: [0x55, 0xc4],
        rawStsd: buildMp4aStsd(objType, freqIdx, chCfg || 2, sampleRate),
        samples: aSamples,
      });
    }
  }

  return buildProgressiveMp4FromTracks(tracks, { audioOnly: false });
}

async function fetchRangeOrFull(uri, byteRange, headers, maxReadBytes) {
  const reqHeaders = byteRange
    ? { ...headers, Range: `bytes=${byteRange.start}-${byteRange.end}` }
    : headers;
  const r = await fetchWithTimeout(uri, { headers: reqHeaders }, 15000);
  if (!r.ok && r.status !== 206) throw new Error(`HLS segment HTTP ${r.status}`);
  return readBodyBytes(r, maxReadBytes, 30000);
}

async function fetchMediaPlaylistSegments(playlistUrl, headers, maxBytes, shouldCancel, maxDurationSec = 0) {
  const res = await fetchWithTimeout(playlistUrl, { headers }, 12000);
  if (!res.ok) throw new Error(`HLS media playlist HTTP ${res.status}`);
  const pl = parseHlsPlaylist(await res.text(), res.url || playlistUrl);
  if (!pl.segments.length) throw new Error('HLS playlist has no segments');

  let activeSegments = pl.segments;
  let actualDurSec = pl.totalDurationSec;
  if (maxDurationSec > 0 && pl.totalDurationSec > maxDurationSec) {
    let acc = 0;
    const trimmed = [];
    for (const seg of pl.segments) {
      if (trimmed.length > 0 && acc + seg.duration > maxDurationSec) break;
      trimmed.push(seg);
      acc += seg.duration;
    }
    activeSegments = trimmed;
    actualDurSec = acc;
  }

  // Fast-fail before downloading if all segments carry explicit byte ranges totaling > maxBytes
  if (activeSegments.every(s => s.byteRange)) {
    const mapBytes = pl.mapByteRange ? pl.mapByteRange.end - pl.mapByteRange.start + 1 : 0;
    const knownTotal = mapBytes + activeSegments.reduce((s, x) => s + (x.byteRange.end - x.byteRange.start + 1), 0);
    if (knownTotal > maxBytes) {
      const err = new Error('FILE_TOO_LARGE');
      err.code = 'FILE_TOO_LARGE';
      err.totalLength = knownTotal;
      throw err;
    }
  }

  let initBuf = null;
  if (pl.mapUri) {
    initBuf = await fetchRangeOrFull(pl.mapUri, pl.mapByteRange, headers, 4 * 1024 * 1024);
  }

  const segBuffers = [];
  let total = initBuf ? initBuf.length : 0;

  // Group contiguous byte-range segments on the same URI (up to 6 MB per fetch) for speed
  const jobs = [];
  for (const seg of activeSegments) {
    const prev = jobs[jobs.length - 1];
    if (
      prev &&
      seg.byteRange &&
      prev.byteRange &&
      prev.uri === seg.uri &&
      seg.byteRange.start === prev.byteRange.end + 1 &&
      prev.byteRange.end - prev.byteRange.start + 1 + (seg.byteRange.end - seg.byteRange.start + 1) <= 6 * 1024 * 1024
    ) {
      prev.byteRange.end = seg.byteRange.end;
    } else {
      jobs.push({
        uri: seg.uri,
        byteRange: seg.byteRange ? { ...seg.byteRange } : null,
      });
    }
  }

  const jobBuffers = new Array(jobs.length);
  const batchSize = 4;

  for (let i = 0; i < jobs.length; i += batchSize) {
    if (shouldCancel && await shouldCancel()) {
      const err = new Error('CANCELLED');
      err.code = 'CANCELLED';
      throw err;
    }
    const batch = jobs.slice(i, i + batchSize);
    const bufs = await Promise.all(
      batch.map(job => fetchRangeOrFull(job.uri, job.byteRange, headers, 12 * 1024 * 1024))
    );
    for (let k = 0; k < bufs.length; k++) {
      total += bufs[k].length;
      if (total > maxBytes) {
        const err = new Error('FILE_TOO_LARGE');
        err.code = 'FILE_TOO_LARGE';
        err.totalLength = total;
        throw err;
      }
      jobBuffers[i + k] = bufs[k];
    }
  }

  segBuffers.push(...jobBuffers);
  return { initBuf, segBuf: concatBytes(segBuffers), durationSec: Math.round(actualDurSec) };
}

async function fetchSingleHlsVariantToMp4(videoPlaylistUrl, audioPlaylistUrl, hintWidth, hintHeight, headers, options) {
  const { maxBytes = 47 * 1024 * 1024, shouldCancel = null, maxDurationSec = 0 } = options;
  const videoTrack = await fetchMediaPlaylistSegments(videoPlaylistUrl, headers, maxBytes, shouldCancel, maxDurationSec);
  const streams = [];

  if (videoTrack.initBuf) {
    streams.push({ init: videoTrack.initBuf, fragments: videoTrack.segBuf });
    if (audioPlaylistUrl) {
      try {
        const audioTrack = await fetchMediaPlaylistSegments(
          audioPlaylistUrl,
          headers,
          Math.max(4 * 1024 * 1024, maxBytes - videoTrack.segBuf.length),
          shouldCancel,
          maxDurationSec
        );
        if (audioTrack.initBuf) {
          streams.push({ init: audioTrack.initBuf, fragments: audioTrack.segBuf });
        }
      } catch {}
    }
    const res = muxFmp4StreamsToProgressive(streams);
    return {
      buffer: res.buffer,
      width: res.width || hintWidth,
      height: res.height || hintHeight,
      durationSec: res.durationSec || videoTrack.durationSec,
    };
  }

  // Check if MPEG-TS (0x47 sync byte)
  if (videoTrack.segBuf[0] === 0x47) {
    const mp4Buf = remuxMpegTsToProgressiveMp4(videoTrack.segBuf, hintWidth, hintHeight);
    return {
      buffer: mp4Buf,
      width: hintWidth,
      height: hintHeight,
      durationSec: videoTrack.durationSec,
    };
  }

  throw new Error('Unsupported HLS segment container format');
}

/**
 * Download an HLS (.m3u8) stream (fMP4 or MPEG-TS, muxed or separate audio rendition)
 * and convert it losslessly in pure JS into a playable progressive faststart MP4.
 */
export async function fetchAndRemuxHlsToMp4(m3u8Url, headers = { 'User-Agent': BROWSER_UA }, options = {}) {
  const { maxBytes = 47 * 1024 * 1024 } = options;
  const masterRes = await fetchWithTimeout(m3u8Url, { headers }, 12000);
  if (!masterRes.ok) throw new Error(`HLS manifest HTTP ${masterRes.status}`);
  const masterText = await masterRes.text();
  const parsed = parseHlsPlaylist(masterText, masterRes.url || m3u8Url);

  if (!parsed.isMaster) {
    return await fetchSingleHlsVariantToMp4(masterRes.url || m3u8Url, null, 0, 0, headers, options);
  }

  // Prefer AVC (H.264) variants descending by resolution/bandwidth, falling down if > maxBytes
  const sortedAll = [...parsed.variants].sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  const avcVariants = sortedAll.filter(v => !v.codecs || /avc1/i.test(v.codecs));
  const candidates = avcVariants.length ? avcVariants : sortedAll;

  let lastErr = null;
  for (let idx = 0; idx < candidates.length; idx++) {
    const chosen = candidates[idx];
    let audioPlaylistUrl = null;
    if (chosen.audioGroup && parsed.audioGroups.length) {
      const aMatch =
        parsed.audioGroups.find(g => g.groupId === chosen.audioGroup && g.isDefault) ||
        parsed.audioGroups.find(g => g.groupId === chosen.audioGroup) ||
        parsed.audioGroups[0];
      if (aMatch) audioPlaylistUrl = aMatch.uri;
    }

    try {
      return await fetchSingleHlsVariantToMp4(
        chosen.uri,
        audioPlaylistUrl,
        chosen.width,
        chosen.height,
        headers,
        options
      );
    } catch (e) {
      lastErr = e;
      if (e?.code === 'CANCELLED') throw e;
      if (e?.code === 'FILE_TOO_LARGE' && idx < candidates.length - 1) {
        continue;
      }
      throw e;
    }
  }

  throw lastErr || new Error('HLS extraction failed');
}
