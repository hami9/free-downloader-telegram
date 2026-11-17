import { concatBytes } from './http.js';

const asciiDec = new TextDecoder('ascii');
const asciiEnc = new TextEncoder();

export function readStr(buf, off, len) {
  return asciiDec.decode(buf.subarray(off, off + len));
}

export function writeStr(buf, off, str) {
  const b = asciiEnc.encode(str);
  buf.set(b, off);
}

export function readU32(dv, off) {
  return dv.getUint32(off);
}

export function readI32(dv, off) {
  return dv.getInt32(off);
}

export function readU64(dv, off) {
  const hi = dv.getUint32(off);
  const lo = dv.getUint32(off + 4);
  return hi * 4294967296 + lo;
}

export function writeU32(dv, off, val) {
  dv.setUint32(off, val >>> 0);
}

export function writeI32(dv, off, val) {
  dv.setInt32(off, val | 0);
}

/** Enumerate ISO BMFF boxes within [start..end). */
export function listBoxes(buf, start = 0, end = buf.length) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let sz = dv.getUint32(off);
    const type = readStr(buf, off + 4, 4);
    let hdr = 8;
    if (sz === 1) {
      if (off + 16 > end) break;
      sz = readU64(dv, off + 8);
      hdr = 16;
    } else if (sz === 0) {
      sz = end - off;
    }
    if (sz < hdr || off + sz > end) break;
    out.push({ type, off, size: sz, hdr, dataStart: off + hdr, end: off + sz });
    off += sz;
  }
  return out;
}

/** Peek top-level box headers even if box extends beyond buffer end. */
export function peekTopBoxHeaders(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    let sz = dv.getUint32(off);
    const type = readStr(buf, off + 4, 4);
    let hdr = 8;
    if (sz === 1) {
      if (off + 16 > buf.length) break;
      sz = readU64(dv, off + 8);
      hdr = 16;
    }
    if (sz < hdr) break;
    out.push({ type, off, size: sz, hdr, end: off + sz });
    if (off + sz > buf.length) break;
    off += sz;
  }
  return out;
}

export function findBox(buf, type, start = 0, end = buf.length) {
  return listBoxes(buf, start, end).find(b => b.type === type) || null;
}

/** Build an ISO BMFF box wrapping one or more Uint8Array payloads. */
export function makeBox(type, ...parts) {
  let payloadLen = 0;
  for (const p of parts) payloadLen += p.length;
  const out = new Uint8Array(8 + payloadLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length >>> 0);
  writeStr(out, 4, type);
  let off = 8;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function makeFullBox(type, version, flags, ...parts) {
  const hdr = new Uint8Array(4);
  hdr[0] = version & 0xff;
  hdr[1] = (flags >> 16) & 0xff;
  hdr[2] = (flags >> 8) & 0xff;
  hdr[3] = flags & 0xff;
  return makeBox(type, hdr, ...parts);
}

/** Parse sidx box from DASH initialization+index buffer. */
export function parseSidx(buf, firstSegmentStart = 0) {
  const sidx = listBoxes(buf).find(b => b.type === 'sidx');
  if (!sidx) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const p = sidx.dataStart;
  const version = buf[p];
  const timescale = dv.getUint32(p + 8);
  let cur = p + 12 + (version === 0 ? 8 : 16) + 2;
  const refCount = dv.getUint16(cur);
  cur += 2;
  const refs = [];
  let bytePos = firstSegmentStart || (sidx.end);
  let ptsTicks = 0;
  for (let i = 0; i < refCount; i++) {
    const w0 = dv.getUint32(cur);
    const dur = dv.getUint32(cur + 4);
    const w2 = dv.getUint32(cur + 8);
    const size = w0 & 0x7fffffff;
    refs.push({
      index: i,
      start: bytePos,
      end: bytePos + size - 1,
      size,
      durationTicks: dur,
      durationSec: timescale ? dur / timescale : 0,
      startSec: timescale ? ptsTicks / timescale : 0,
      startsWithSap: Boolean(w2 >>> 31),
    });
    bytePos += size;
    ptsTicks += dur;
    cur += 12;
  }
  return { timescale, totalDurationSec: timescale ? ptsTicks / timescale : 0, refs };
}

/** Build a canonical ftyp box for MP4 or M4A output. */
export function buildFtyp(audioOnly = false) {
  if (audioOnly) {
    // ftyp: major 'M4A ', minor 0, compatible ['M4A ', 'mp42', 'isom']
    const body = new Uint8Array(20);
    writeStr(body, 0, 'M4A ');
    writeStr(body, 8, 'M4A ');
    writeStr(body, 12, 'mp42');
    writeStr(body, 16, 'isom');
    return makeBox('ftyp', body);
  }
  const body = new Uint8Array(24);
  const dv = new DataView(body.buffer);
  writeStr(body, 0, 'isom');
  dv.setUint32(4, 0x200);
  writeStr(body, 8, 'isom');
  writeStr(body, 12, 'iso2');
  writeStr(body, 16, 'avc1');
  writeStr(body, 20, 'mp41');
  return makeBox('ftyp', body);
}

function buildMvhd(timescale, duration, nextTrackId) {
  const body = new Uint8Array(96);
  const dv = new DataView(body.buffer);
  dv.setUint32(8, timescale >>> 0);
  dv.setUint32(12, Math.round(duration) >>> 0);
  dv.setUint32(16, 0x00010000); // rate 1.0
  dv.setUint16(20, 0x0100); // volume 1.0
  // unity matrix
  dv.setUint32(32, 0x00010000);
  dv.setUint32(48, 0x00010000);
  dv.setUint32(64, 0x40000000);
  dv.setUint32(92, nextTrackId >>> 0);
  return makeFullBox('mvhd', 0, 0, body);
}

function buildTkhd(trackId, movieDuration, width, height, isAudio) {
  const body = new Uint8Array(80);
  const dv = new DataView(body.buffer);
  dv.setUint32(8, trackId >>> 0);
  dv.setUint32(16, Math.round(movieDuration) >>> 0);
  if (isAudio) {
    dv.setUint16(32, 0x0100); // volume 1.0
  }
  // unity matrix
  dv.setUint32(36, 0x00010000);
  dv.setUint32(52, 0x00010000);
  dv.setUint32(68, 0x40000000);
  if (!isAudio && width && height) {
    dv.setUint32(72, (width << 16) >>> 0);
    dv.setUint32(76, (height << 16) >>> 0);
  }
  // flags: track_enabled (1) | track_in_movie (2) | track_in_preview (4) = 7 (or 3)
  return makeFullBox('tkhd', 0, 3, body);
}

function buildMdhd(timescale, duration, langBytes = [0x55, 0xc4]) {
  const body = new Uint8Array(20);
  const dv = new DataView(body.buffer);
  dv.setUint32(8, timescale >>> 0);
  dv.setUint32(12, Math.round(duration) >>> 0);
  body[16] = langBytes[0];
  body[17] = langBytes[1];
  return makeFullBox('mdhd', 0, 0, body);
}

function buildHdlr(handlerType, name = 'MediaHandler') {
  const nameBytes = asciiEnc.encode(name + '\0');
  const body = new Uint8Array(20 + nameBytes.length);
  writeStr(body, 4, handlerType);
  body.set(nameBytes, 20);
  return makeFullBox('hdlr', 0, 0, body);
}

function buildVmhd() {
  return makeFullBox('vmhd', 0, 1, new Uint8Array(8));
}

function buildSmhd() {
  return makeFullBox('smhd', 0, 0, new Uint8Array(4));
}

function buildDinf() {
  const url = makeFullBox('url ', 0, 1);
  const dref = makeFullBox('dref', 0, 0, new Uint8Array([0, 0, 0, 1]), url);
  return makeBox('dinf', dref);
}

function buildStts(durations) {
  const runs = [];
  for (let i = 0; i < durations.length; i++) {
    const d = Math.max(0, Math.round(durations[i])) >>> 0;
    if (runs.length && runs[runs.length - 1].delta === d) {
      runs[runs.length - 1].count++;
    } else {
      runs.push({ count: 1, delta: d });
    }
  }
  const body = new Uint8Array(4 + runs.length * 8);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, runs.length >>> 0);
  for (let i = 0; i < runs.length; i++) {
    dv.setUint32(4 + i * 8, runs[i].count >>> 0);
    dv.setUint32(8 + i * 8, runs[i].delta >>> 0);
  }
  return makeFullBox('stts', 0, 0, body);
}

function buildCtts(offsets) {
  let anyNonZero = false;
  let anyNegative = false;
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] !== 0) anyNonZero = true;
    if (offsets[i] < 0) anyNegative = true;
  }
  if (!anyNonZero) return null;

  const runs = [];
  for (let i = 0; i < offsets.length; i++) {
    const v = offsets[i] | 0;
    if (runs.length && runs[runs.length - 1].offset === v) {
      runs[runs.length - 1].count++;
    } else {
      runs.push({ count: 1, offset: v });
    }
  }
  const body = new Uint8Array(4 + runs.length * 8);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, runs.length >>> 0);
  for (let i = 0; i < runs.length; i++) {
    dv.setUint32(4 + i * 8, runs[i].count >>> 0);
    if (anyNegative) dv.setInt32(8 + i * 8, runs[i].offset | 0);
    else dv.setUint32(8 + i * 8, runs[i].offset >>> 0);
  }
  return makeFullBox('ctts', anyNegative ? 1 : 0, 0, body);
}

function buildStss(syncIndicesOneBased) {
  const body = new Uint8Array(4 + syncIndicesOneBased.length * 4);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, syncIndicesOneBased.length >>> 0);
  for (let i = 0; i < syncIndicesOneBased.length; i++) {
    dv.setUint32(4 + i * 4, syncIndicesOneBased[i] >>> 0);
  }
  return makeFullBox('stss', 0, 0, body);
}

function buildStsc(chunkSampleCounts) {
  const runs = [];
  for (let i = 0; i < chunkSampleCounts.length; i++) {
    const cnt = chunkSampleCounts[i];
    if (!runs.length || runs[runs.length - 1].samplesPerChunk !== cnt) {
      runs.push({ firstChunk: i + 1, samplesPerChunk: cnt, descIndex: 1 });
    }
  }
  const body = new Uint8Array(4 + runs.length * 12);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, runs.length >>> 0);
  for (let i = 0; i < runs.length; i++) {
    dv.setUint32(4 + i * 12, runs[i].firstChunk >>> 0);
    dv.setUint32(8 + i * 12, runs[i].samplesPerChunk >>> 0);
    dv.setUint32(12 + i * 12, runs[i].descIndex >>> 0);
  }
  return makeFullBox('stsc', 0, 0, body);
}

function buildStsz(sizes) {
  const first = sizes.length ? sizes[0] : 0;
  const allSame = sizes.length > 0 && sizes.every(s => s === first);
  if (allSame) {
    const body = new Uint8Array(8);
    const dv = new DataView(body.buffer);
    dv.setUint32(0, first >>> 0);
    dv.setUint32(4, sizes.length >>> 0);
    return makeFullBox('stsz', 0, 0, body);
  }
  const body = new Uint8Array(8 + sizes.length * 4);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, 0);
  dv.setUint32(4, sizes.length >>> 0);
  for (let i = 0; i < sizes.length; i++) {
    dv.setUint32(8 + i * 4, sizes[i] >>> 0);
  }
  return makeFullBox('stsz', 0, 0, body);
}

function buildStco(offsets) {
  const body = new Uint8Array(4 + offsets.length * 4);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, offsets.length >>> 0);
  for (let i = 0; i < offsets.length; i++) {
    dv.setUint32(4 + i * 4, offsets[i] >>> 0);
  }
  return makeFullBox('stco', 0, 0, body);
}

/**
 * Core progressive faststart MP4/M4A builder shared across fMP4 muxer, TS remuxer, MP4 splitter, and M4A extractor.
 * Each track: { handlerType: 'vide'|'soun', timescale, width, height, rawStsd, langBytes, samples: [{ data, duration, cto, isSync }] }
 */
export function buildProgressiveMp4FromTracks(tracks, options = {}) {
  const { audioOnly = false } = options;
  const movieTimescale = 1000;
  const ftyp = buildFtyp(audioOnly);

  // Interleave track chunks by track presentation time (~0.5s per chunk) so Telegram/iOS streams smoothly
  const trackStates = tracks.map((t, idx) => {
    const chunks = [];
    const targetTicks = Math.max(1, Math.round(t.timescale * 0.5));
    let curSamples = [];
    let curDur = 0;
    let totalTicks = 0;

    for (let i = 0; i < t.samples.length; i++) {
      const s = t.samples[i];
      curSamples.push(i);
      curDur += s.duration;
      totalTicks += s.duration;
      if (curDur >= targetTicks || curSamples.length >= 24 || i === t.samples.length - 1) {
        chunks.push({
          trackIdx: idx,
          startSec: (totalTicks - curDur) / t.timescale,
          sampleIndices: curSamples,
        });
        curSamples = [];
        curDur = 0;
      }
    }

    const durations = new Uint32Array(t.samples.length);
    const sizes = new Uint32Array(t.samples.length);
    const ctos = new Int32Array(t.samples.length);
    const syncList = [];
    let hasSyncGap = false;
    for (let i = 0; i < t.samples.length; i++) {
      durations[i] = t.samples[i].duration;
      sizes[i] = t.samples[i].data.length;
      ctos[i] = t.samples[i].cto || 0;
      if (t.samples[i].isSync) syncList.push(i + 1);
      else hasSyncGap = true;
    }

    return {
      ...t,
      trackId: idx + 1,
      chunks,
      totalTicks,
      durationSec: t.timescale ? totalTicks / t.timescale : 0,
      durations,
      sizes,
      ctos,
      syncList: t.handlerType === 'vide' && hasSyncGap ? syncList : null,
      chunkSampleCounts: chunks.map(c => c.sampleIndices.length),
      chunkRelOffsets: new Uint32Array(chunks.length),
    };
  });

  // Sort all chunks across tracks chronologically by startSec
  const timelineChunks = [];
  trackStates.forEach(ts => {
    ts.chunks.forEach((c, localIdx) => {
      timelineChunks.push({ ts, localIdx, sampleIndices: c.sampleIndices, startSec: c.startSec });
    });
  });
  timelineChunks.sort((a, b) => a.startSec - b.startSec || a.ts.trackId - b.ts.trackId);

  // Measure relative offsets inside mdat payload
  let mdatDataSize = 0;
  for (const item of timelineChunks) {
    item.ts.chunkRelOffsets[item.localIdx] = mdatDataSize;
    for (const sIdx of item.sampleIndices) {
      mdatDataSize += item.ts.samples[sIdx].data.length;
    }
  }

  let movieDurSec = 0;
  for (const ts of trackStates) {
    if (ts.durationSec > movieDurSec) movieDurSec = ts.durationSec;
  }
  const movieDurMs = Math.round(movieDurSec * movieTimescale);

  const renderMoov = mdatPayloadBase => {
    const mvhd = buildMvhd(movieTimescale, movieDurMs, trackStates.length + 1);
    const trakBoxes = trackStates.map(ts => {
      const isAudio = ts.handlerType === 'soun';
      const tkhd = buildTkhd(ts.trackId, movieDurMs, ts.width, ts.height, isAudio);
      const mdhd = buildMdhd(ts.timescale, ts.totalTicks, ts.langBytes);
      const hdlr = buildHdlr(ts.handlerType, isAudio ? 'SoundHandler' : 'VideoHandler');
      const mediaHdr = isAudio ? buildSmhd() : buildVmhd();
      const dinf = buildDinf();

      const offsets = new Uint32Array(ts.chunkRelOffsets.length);
      for (let i = 0; i < offsets.length; i++) {
        offsets[i] = mdatPayloadBase + ts.chunkRelOffsets[i];
      }

      const stblChildren = [
        ts.rawStsd,
        buildStts(ts.durations),
      ];
      const cttsBox = buildCtts(ts.ctos);
      if (cttsBox) stblChildren.push(cttsBox);
      if (ts.syncList && ts.syncList.length) stblChildren.push(buildStss(ts.syncList));
      stblChildren.push(
        buildStsc(ts.chunkSampleCounts),
        buildStsz(ts.sizes),
        buildStco(offsets)
      );

      const stbl = makeBox('stbl', ...stblChildren);
      const minf = makeBox('minf', mediaHdr, dinf, stbl);
      const mdia = makeBox('mdia', mdhd, hdlr, minf);
      return makeBox('trak', tkhd, mdia);
    });
    return makeBox('moov', mvhd, ...trakBoxes);
  };

  // Pass 1 computes deterministic moov length; Pass 2 fills exact stco offsets
  const dummyMoov = renderMoov(0);
  const mdatPayloadBase = ftyp.length + dummyMoov.length + 8;
  const finalMoov = renderMoov(mdatPayloadBase);
  if (finalMoov.length !== dummyMoov.length) {
    throw new Error('Unexpected moov size change');
  }

  const totalFileBytes = ftyp.length + finalMoov.length + 8 + mdatDataSize;
  const out = new Uint8Array(totalFileBytes);
  out.set(ftyp, 0);
  out.set(finalMoov, ftyp.length);

  const mdatPos = ftyp.length + finalMoov.length;
  const dv = new DataView(out.buffer);
  dv.setUint32(mdatPos, (8 + mdatDataSize) >>> 0);
  writeStr(out, mdatPos + 4, 'mdat');

  let writePos = mdatPayloadBase;
  for (const item of timelineChunks) {
    for (const sIdx of item.sampleIndices) {
      const sampleBytes = item.ts.samples[sIdx].data;
      out.set(sampleBytes, writePos);
      writePos += sampleBytes.length;
    }
  }
  return out;
}

/** Parse moov box sample tables from a standard progressive MP4. */
export function parseProgressiveMoov(moovBuf, totalFileBytes = 0) {
  const moov = findBox(moovBuf, 'moov');
  if (!moov) throw new Error('No moov atom found');
  const dv = new DataView(moovBuf.buffer, moovBuf.byteOffset, moovBuf.byteLength);
  const moovKids = listBoxes(moovBuf, moov.dataStart, moov.end);

  const mvhd = moovKids.find(b => b.type === 'mvhd');
  let movieTimescale = 1000;
  let movieDuration = 0;
  if (mvhd) {
    const v = moovBuf[mvhd.dataStart];
    movieTimescale = v === 0 ? readU32(dv, mvhd.dataStart + 12) : readU32(dv, mvhd.dataStart + 20);
    movieDuration = v === 0 ? readU32(dv, mvhd.dataStart + 16) : readU64(dv, mvhd.dataStart + 24);
  }

  const tracks = [];
  for (const trak of moovKids.filter(b => b.type === 'trak')) {
    const tkKids = listBoxes(moovBuf, trak.dataStart, trak.end);
    const tkhd = tkKids.find(b => b.type === 'tkhd');
    let width = 0, height = 0;
    if (tkhd) {
      const v = moovBuf[tkhd.dataStart];
      const dimOff = v === 0 ? tkhd.dataStart + 76 : tkhd.dataStart + 88;
      if (dimOff + 8 <= tkhd.end) {
        width = readU32(dv, dimOff) >>> 16;
        height = readU32(dv, dimOff + 4) >>> 16;
      }
    }

    const mdia = tkKids.find(b => b.type === 'mdia');
    if (!mdia) continue;
    const mdKids = listBoxes(moovBuf, mdia.dataStart, mdia.end);
    const mdhd = mdKids.find(b => b.type === 'mdhd');
    const hdlr = mdKids.find(b => b.type === 'hdlr');
    const minf = mdKids.find(b => b.type === 'minf');
    if (!mdhd || !hdlr || !minf) continue;

    const mVer = moovBuf[mdhd.dataStart];
    const timescale = mVer === 0 ? readU32(dv, mdhd.dataStart + 12) : readU32(dv, mdhd.dataStart + 20);
    const mdhdDur = mVer === 0 ? readU32(dv, mdhd.dataStart + 16) : readU64(dv, mdhd.dataStart + 24);
    const langOff = mVer === 0 ? mdhd.dataStart + 20 : mdhd.dataStart + 32;
    const langBytes = [moovBuf[langOff], moovBuf[langOff + 1]];
    const handlerType = readStr(moovBuf, hdlr.dataStart + 8, 4);
    if (handlerType !== 'vide' && handlerType !== 'soun') continue;

    const stbl = findBox(moovBuf, 'stbl', minf.dataStart, minf.end);
    if (!stbl) continue;
    const sk = listBoxes(moovBuf, stbl.dataStart, stbl.end);
    const stsd = sk.find(b => b.type === 'stsd');
    const stts = sk.find(b => b.type === 'stts');
    const ctts = sk.find(b => b.type === 'ctts');
    const stss = sk.find(b => b.type === 'stss');
    const stsc = sk.find(b => b.type === 'stsc');
    const stsz = sk.find(b => b.type === 'stsz');
    const stco = sk.find(b => b.type === 'stco');
    const co64 = sk.find(b => b.type === 'co64');
    if (!stsd || !stts || !stsc || !stsz || (!stco && !co64)) continue;

    const rawStsd = moovBuf.slice(stsd.off, stsd.end);
    const sampleCount = readU32(dv, stsz.dataStart + 8);
    const uniformSize = readU32(dv, stsz.dataStart + 4);

    // Sample sizes
    const sizes = new Uint32Array(sampleCount);
    if (uniformSize > 0) {
      sizes.fill(uniformSize);
    } else {
      for (let i = 0; i < sampleCount; i++) {
        sizes[i] = readU32(dv, stsz.dataStart + 12 + i * 4);
      }
    }

    // Durations + DTS prefix sums
    const durations = new Uint32Array(sampleCount);
    const dts = new Float64Array(sampleCount);
    let si = 0;
    let curDts = 0;
    const sttsCount = readU32(dv, stts.dataStart + 4);
    for (let i = 0; i < sttsCount && si < sampleCount; i++) {
      const cnt = readU32(dv, stts.dataStart + 8 + i * 8);
      const delta = readU32(dv, stts.dataStart + 12 + i * 8);
      for (let k = 0; k < cnt && si < sampleCount; k++) {
        durations[si] = delta;
        dts[si] = curDts;
        curDts += delta;
        si++;
      }
    }

    // Composition offsets (optional)
    let ctos = null;
    if (ctts) {
      ctos = new Int32Array(sampleCount);
      const cVer = moovBuf[ctts.dataStart];
      const cCnt = readU32(dv, ctts.dataStart + 4);
      let ci = 0;
      for (let i = 0; i < cCnt && ci < sampleCount; i++) {
        const cnt = readU32(dv, ctts.dataStart + 8 + i * 8);
        const val = cVer === 1 ? readI32(dv, ctts.dataStart + 12 + i * 8) : readU32(dv, ctts.dataStart + 12 + i * 8);
        for (let k = 0; k < cnt && ci < sampleCount; k++) {
          ctos[ci++] = val;
        }
      }
    }

    // Chunk offsets
    const chunkBox = stco || co64;
    const is64 = chunkBox.type === 'co64';
    const chunkCount = readU32(dv, chunkBox.dataStart + 4);
    const chunkOffsets = new Float64Array(chunkCount);
    for (let i = 0; i < chunkCount; i++) {
      chunkOffsets[i] = is64
        ? readU64(dv, chunkBox.dataStart + 8 + i * 8)
        : readU32(dv, chunkBox.dataStart + 8 + i * 4);
    }

    // Expand stsc -> exact file byte offset for every sample
    const stscEntries = readU32(dv, stsc.dataStart + 4);
    const stscRuns = [];
    for (let i = 0; i < stscEntries; i++) {
      stscRuns.push({
        firstChunk: readU32(dv, stsc.dataStart + 8 + i * 12) - 1,
        samplesPerChunk: readU32(dv, stsc.dataStart + 12 + i * 12),
      });
    }

    const fileOffsets = new Float64Array(sampleCount);
    let sampleIdx = 0;
    for (let runIdx = 0; runIdx < stscRuns.length && sampleIdx < sampleCount; runIdx++) {
      const startChunk = stscRuns[runIdx].firstChunk;
      const endChunk = runIdx + 1 < stscRuns.length ? stscRuns[runIdx + 1].firstChunk : chunkCount;
      const perChunk = stscRuns[runIdx].samplesPerChunk;
      for (let c = startChunk; c < endChunk && c < chunkCount && sampleIdx < sampleCount; c++) {
        let byteOff = chunkOffsets[c];
        for (let k = 0; k < perChunk && sampleIdx < sampleCount; k++) {
          fileOffsets[sampleIdx] = byteOff;
          byteOff += sizes[sampleIdx];
          sampleIdx++;
        }
      }
    }

    // Sync samples (1-based -> 0-based Set / sorted array)
    let keyframes = null;
    if (handlerType === 'vide') {
      if (stss) {
        const kfCount = readU32(dv, stss.dataStart + 4);
        keyframes = new Uint32Array(kfCount);
        for (let i = 0; i < kfCount; i++) {
          keyframes[i] = Math.max(0, readU32(dv, stss.dataStart + 8 + i * 4) - 1);
        }
      } else {
        keyframes = new Uint32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) keyframes[i] = i;
      }
    }

    tracks.push({
      handlerType,
      timescale,
      durationSec: timescale ? mdhdDur / timescale : 0,
      width,
      height,
      langBytes,
      rawStsd,
      sampleCount,
      sizes,
      durations,
      dts,
      ctos,
      fileOffsets,
      keyframes,
    });
  }

  return {
    totalFileBytes,
    durationSec: movieTimescale ? movieDuration / movieTimescale : (tracks[0]?.durationSec || 0),
    tracks,
    videoTrack: tracks.find(t => t.handlerType === 'vide') || null,
    audioTrack: tracks.find(t => t.handlerType === 'soun') || null,
  };
}

/**
 * Fetch and parse moov metadata from a remote MP4 without downloading the entire file.
 * Handles both faststart (moov before mdat) and tail-moov files cleanly.
 */
export async function fetchRemoteMp4Metadata(fetchSliceFn, totalLength) {
  if (!Number.isFinite(totalLength) || totalLength <= 32) {
    throw new Error('Could not determine remote MP4 length');
  }
  const probeEnd = Math.min(totalLength - 1, 1024 * 1024 - 1);
  const head = await fetchSliceFn(0, probeEnd);
  const tops = peekTopBoxHeaders(head);
  const moovHdr = tops.find(b => b.type === 'moov');

  let moovBuf = null;
  if (moovHdr) {
    if (moovHdr.end <= head.length) {
      moovBuf = head.subarray(moovHdr.off, moovHdr.end);
    } else {
      moovBuf = await fetchSliceFn(moovHdr.off, moovHdr.end - 1);
    }
  } else {
    // moov is after mdat (or scan tail up to 5 MB fallback)
    const mdatHdr = tops.find(b => b.type === 'mdat');
    if (mdatHdr && mdatHdr.end < totalLength - 8) {
      const tailProbe = await fetchSliceFn(mdatHdr.end, Math.min(totalLength - 1, mdatHdr.end + 5 * 1024 * 1024 - 1));
      const tailBoxes = peekTopBoxHeaders(tailProbe);
      const m2 = tailBoxes.find(b => b.type === 'moov');
      if (m2) {
        moovBuf = m2.end <= tailProbe.length
          ? tailProbe.subarray(m2.off, m2.end)
          : await fetchSliceFn(mdatHdr.end + m2.off, mdatHdr.end + m2.end - 1);
      }
    }
    if (!moovBuf) {
      const scanStart = Math.max(0, totalLength - 5 * 1024 * 1024);
      const tail = await fetchSliceFn(scanStart, totalLength - 1);
      const idx = findMoovSignature(tail);
      if (idx >= 0) {
        const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
        const sz = idx >= 4 ? readU32(dv, idx - 4) : 0;
        const startOff = idx - 4;
        if (sz >= 8 && startOff + sz <= tail.length) {
          moovBuf = tail.subarray(startOff, startOff + sz);
        }
      }
    }
  }

  if (!moovBuf) throw new Error('Could not locate moov atom in remote MP4');
  return parseProgressiveMoov(moovBuf, totalLength);
}

function findMoovSignature(buf) {
  for (let i = 4; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x6d && buf[i + 1] === 0x6f && buf[i + 2] === 0x6f && buf[i + 3] === 0x76) {
      // Check plausibility of box size right before 'moov'
      const sz = (buf[i - 4] << 24) | (buf[i - 3] << 16) | (buf[i - 2] << 8) | buf[i - 1];
      if (sz >= 64 && sz <= buf.length - (i - 4)) return i;
    }
  }
  return -1;
}

function lowerBoundTime(track, targetSec) {
  let lo = 0, hi = track.sampleCount;
  const targetTick = targetSec * track.timescale;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track.dts[mid] < targetTick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Merge/compress non-overlapping byte intervals [start, end] for fast partial remote fetch. */
function buildFetchSpans(minA, maxA, minB, maxB) {
  const ranges = [];
  if (maxA >= minA) ranges.push([minA, maxA]);
  if (maxB >= minB) ranges.push([minB, maxB]);
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.length === 2 && ranges[1][0] - ranges[0][1] <= 2 * 1024 * 1024) {
    return [[ranges[0][0], Math.max(ranges[0][1], ranges[1][1])]];
  }
  return ranges;
}

/**
 * Plan GOP-aligned split parts for a large progressive MP4 so every part <= maxPartBytes.
 */
export function planProgressiveMp4Splits(meta, maxPartBytes = 44 * 1024 * 1024) {
  const vt = meta.videoTrack;
  const at = meta.audioTrack;
  if (!vt || !vt.keyframes || !vt.keyframes.length) {
    throw new Error('MP4 has no keyframe index for clean splitting');
  }

  // Group into GOPs [kf[i] .. nextKf - 1]
  const gops = [];
  for (let i = 0; i < vt.keyframes.length; i++) {
    const startSample = vt.keyframes[i];
    const endSample = i + 1 < vt.keyframes.length ? vt.keyframes[i + 1] - 1 : vt.sampleCount - 1;
    if (endSample < startSample) continue;
    const startSec = vt.dts[startSample] / vt.timescale;
    const endSec = (vt.dts[endSample] + vt.durations[endSample]) / vt.timescale;

    let vBytes = 0;
    let vMin = Infinity, vMax = -1;
    for (let s = startSample; s <= endSample; s++) {
      const sz = vt.sizes[s];
      const off = vt.fileOffsets[s];
      vBytes += sz;
      if (off < vMin) vMin = off;
      if (off + sz - 1 > vMax) vMax = off + sz - 1;
    }
    gops.push({ startSample, endSample, startSec, endSec, vBytes, vMin, vMax });
  }

  // Pre-compute audio mapping per GOP timestamp window
  const gopAudio = gops.map((g, gi) => {
    if (!at || !at.sampleCount) return { aStart: 0, aEnd: -1, aBytes: 0, aMin: 0, aMax: -1 };
    let aStart = lowerBoundTime(at, g.startSec);
    // Snap audio start tightly so frame ends after startSec
    while (aStart > 0 && ((at.dts[aStart - 1] + at.durations[aStart - 1]) / at.timescale) > g.startSec + 0.006) {
      aStart--;
    }
    let aEnd = lowerBoundTime(at, g.endSec) - 1;
    if (gi === gops.length - 1) aEnd = at.sampleCount - 1;
    let aBytes = 0, aMin = Infinity, aMax = -1;
    for (let s = aStart; s <= aEnd; s++) {
      const sz = at.sizes[s];
      const off = at.fileOffsets[s];
      aBytes += sz;
      if (off < aMin) aMin = off;
      if (off + sz - 1 > aMax) aMax = off + sz - 1;
    }
    return { aStart, aEnd, aBytes, aMin, aMax };
  });

  const parts = [];
  let gi = 0;
  while (gi < gops.length) {
    let startGi = gi;
    let payloadBytes = 0;
    let vSamples = 0;
    let aSamples = 0;
    let partAStart = gopAudio[gi].aStart;
    let lastEnd = gi;

    for (let j = gi; j < gops.length; j++) {
      const g = gops[j];
      const ga = gopAudio[j];
      const addV = g.endSample - g.startSample + 1;
      const curAEnd = ga.aEnd;
      const newASamples = curAEnd >= partAStart ? (curAEnd - partAStart + 1) : 0;
      const newMoovEst = 8192 + (vSamples + addV + newASamples) * 10;
      const newPayload = payloadBytes + g.vBytes + ga.aBytes;
      if (j > startGi && newPayload + newMoovEst > maxPartBytes) break;
      if (j === startGi && newPayload + newMoovEst > 47.5 * 1024 * 1024) {
        throw new Error('SINGLE_GOP_TOO_LARGE');
      }
      payloadBytes = newPayload;
      vSamples += addV;
      aSamples = newASamples;
      lastEnd = j;
    }

    const vStartSample = gops[startGi].startSample;
    const vEndSample = gops[lastEnd].endSample;
    const aStartSample = gopAudio[startGi].aStart;
    const aEndSample = gopAudio[lastEnd].aEnd;

    let vMin = Infinity, vMax = -1;
    for (let s = vStartSample; s <= vEndSample; s++) {
      const off = vt.fileOffsets[s];
      const end = off + vt.sizes[s] - 1;
      if (off < vMin) vMin = off;
      if (end > vMax) vMax = end;
    }
    let aMin = Infinity, aMax = -1;
    for (let s = aStartSample; s <= aEndSample; s++) {
      const off = at.fileOffsets[s];
      const end = off + at.sizes[s] - 1;
      if (off < aMin) aMin = off;
      if (end > aMax) aMax = end;
    }

    const spans = buildFetchSpans(vMin, vMax, aMin, aMax);
    const startSec = gops[startGi].startSec;
    const endSec = gops[lastEnd].endSec;
    parts.push({
      partIndex: parts.length + 1,
      totalParts: 0,
      startSec,
      endSec,
      durationSec: Math.max(0.1, endSec - startSec),
      vStartSample,
      vEndSample,
      aStartSample,
      aEndSample,
      spans,
      estimatedBytes: payloadBytes + 8192 + (vSamples + aSamples) * 10,
    });
    gi = lastEnd + 1;
  }

  parts.forEach(p => { p.totalParts = parts.length; });
  return parts;
}

/** Lookup byte offset inside fetched sparse spans array ([{ start, buf }]). */
function readSampleFromSpans(fetchedSpans, absOffset, size) {
  for (const sp of fetchedSpans) {
    if (absOffset >= sp.start && absOffset + size <= sp.start + sp.buf.length) {
      const rel = absOffset - sp.start;
      return sp.buf.subarray(rel, rel + size);
    }
  }
  throw new Error(`Sample offset ${absOffset}+${size} missing from fetched spans`);
}

/** Reconstruct one standalone playable faststart MP4 part from fetched byte spans. */
export function buildProgressiveMp4PartFromSpans(meta, part, fetchedSpans) {
  const vt = meta.videoTrack;
  const at = meta.audioTrack;

  const kfSet = new Set();
  if (vt.keyframes) {
    for (let i = 0; i < vt.keyframes.length; i++) kfSet.add(vt.keyframes[i]);
  }

  const vSamples = [];
  for (let s = part.vStartSample; s <= part.vEndSample; s++) {
    vSamples.push({
      data: readSampleFromSpans(fetchedSpans, vt.fileOffsets[s], vt.sizes[s]),
      duration: vt.durations[s],
      cto: vt.ctos ? vt.ctos[s] : 0,
      isSync: kfSet.size ? kfSet.has(s) : true,
    });
  }

  const tracks = [{
    handlerType: 'vide',
    timescale: vt.timescale,
    width: vt.width,
    height: vt.height,
    langBytes: vt.langBytes,
    rawStsd: vt.rawStsd,
    samples: vSamples,
  }];

  if (at && part.aEndSample >= part.aStartSample) {
    const aSamples = [];
    for (let s = part.aStartSample; s <= part.aEndSample; s++) {
      aSamples.push({
        data: readSampleFromSpans(fetchedSpans, at.fileOffsets[s], at.sizes[s]),
        duration: at.durations[s],
        cto: at.ctos ? at.ctos[s] : 0,
        isSync: true,
      });
    }
    tracks.push({
      handlerType: 'soun',
      timescale: at.timescale,
      width: 0,
      height: 0,
      langBytes: at.langBytes,
      rawStsd: at.rawStsd,
      samples: aSamples,
    });
  }

  return buildProgressiveMp4FromTracks(tracks, { audioOnly: false });
}

/**
 * Extract pure audio track (M4A) from an interleaved progressive MP4 in streaming batches,
 * discarding video payload bytes on every 8 MB batch so memory stays small.
 */
export async function extractAudioPartsFromRemoteMp4(meta, fetchSliceFn, maxPartBytes = 44 * 1024 * 1024, options = {}) {
  const { partIndex = null, shouldCancel = null } = options;
  const at = meta.audioTrack;
  if (!at || !at.sampleCount) throw new Error('MP4 has no audio track');

  // Plan audio-only parts (< 44 MB each)
  const audioPartsPlan = [];
  let s = 0;
  while (s < at.sampleCount) {
    const startS = s;
    let payload = 0;
    let endS = s;
    for (let j = s; j < at.sampleCount; j++) {
      const nextMoov = 8192 + (j - startS + 1) * 10;
      if (j > startS && payload + at.sizes[j] + nextMoov > maxPartBytes) break;
      payload += at.sizes[j];
      endS = j;
    }
    audioPartsPlan.push({
      partIndex: audioPartsPlan.length + 1,
      startSample: startS,
      endSample: endS,
      startSec: at.dts[startS] / at.timescale,
      endSec: (at.dts[endS] + at.durations[endS]) / at.timescale,
    });
    s = endS + 1;
  }

  const targetPlans = partIndex
    ? audioPartsPlan.filter(p => p.partIndex === partIndex)
    : audioPartsPlan;
  const outBuffers = [];
  const batchSize = 8 * 1024 * 1024;
  const windowConcurrency = 3;

  for (const ap of targetPlans) {
    const minOff = at.fileOffsets[ap.startSample];
    const maxOff = at.fileOffsets[ap.endSample] + at.sizes[ap.endSample] - 1;
    const aSamples = new Array(ap.endSample - ap.startSample + 1);

    // Precompute non-overlapping sample windows so batches can run in parallel
    const windows = [];
    let cursor = ap.startSample;
    for (let off = minOff; off <= maxOff && cursor <= ap.endSample; off += batchSize) {
      const end = Math.min(maxOff, off + batchSize - 1);
      if (at.fileOffsets[cursor] > end) continue;
      const firstSample = cursor;
      let fetchEnd = end;
      while (cursor <= ap.endSample && at.fileOffsets[cursor] <= end) {
        const sEnd = at.fileOffsets[cursor] + at.sizes[cursor] - 1;
        if (sEnd > fetchEnd) fetchEnd = sEnd;
        cursor++;
      }
      windows.push({ off, fetchEnd, firstSample, lastSample: cursor - 1 });
    }

    for (let w = 0; w < windows.length; w += windowConcurrency) {
      if (shouldCancel && await shouldCancel()) {
        const err = new Error('CANCELLED_BY_USER');
        err.code = 'CANCELLED';
        throw err;
      }
      const group = windows.slice(w, w + windowConcurrency);
      await Promise.all(
        group.map(async win => {
          const chunkBuf = await fetchSliceFn(win.off, win.fetchEnd);
          for (let idx = win.firstSample; idx <= win.lastSample; idx++) {
            const rel = at.fileOffsets[idx] - win.off;
            const sSz = at.sizes[idx];
            aSamples[idx - ap.startSample] = {
              data: chunkBuf.slice(rel, rel + sSz), // copy ONLY tiny AAC frame, drop 8MB buffer
              duration: at.durations[idx],
              cto: at.ctos ? at.ctos[idx] : 0,
              isSync: true,
            };
          }
        })
      );
    }

    const m4aBuf = buildProgressiveMp4FromTracks(
      [{
        handlerType: 'soun',
        timescale: at.timescale,
        width: 0,
        height: 0,
        langBytes: at.langBytes,
        rawStsd: at.rawStsd,
        samples: aSamples,
      }],
      { audioOnly: true }
    );
    outBuffers.push({
      buffer: m4aBuf,
      partIndex: ap.partIndex,
      totalParts: audioPartsPlan.length,
      durationSec: Math.max(1, Math.round(ap.endSec - ap.startSec)),
    });
  }

  return outBuffers;
}

/**
 * Parse fMP4 init + moof/mdat fragments (YouTube DASH / HLS EXT-X-MAP) into track objects
 * suitable for buildProgressiveMp4FromTracks().
 */
export function parseFmp4Stream(initBuf, fragmentsBuf) {
  const full = fragmentsBuf ? concatBytes([initBuf, fragmentsBuf]) : initBuf;
  const boxes = listBoxes(full);
  const moov = boxes.find(b => b.type === 'moov');
  if (!moov) throw new Error('fMP4 missing moov init box');

  const dv = new DataView(full.buffer, full.byteOffset, full.byteLength);
  const moovKids = listBoxes(full, moov.dataStart, moov.end);
  const mvex = moovKids.find(b => b.type === 'mvex');
  const trexDefaults = new Map();
  if (mvex) {
    for (const trex of listBoxes(full, mvex.dataStart, mvex.end).filter(b => b.type === 'trex')) {
      const p = trex.dataStart + 4;
      trexDefaults.set(readU32(dv, p), {
        descIdx: readU32(dv, p + 4),
        duration: readU32(dv, p + 8),
        size: readU32(dv, p + 12),
        flags: readU32(dv, p + 16),
      });
    }
  }

  const parsedTracks = new Map();
  for (const trak of moovKids.filter(b => b.type === 'trak')) {
    const tkKids = listBoxes(full, trak.dataStart, trak.end);
    const tkhd = tkKids.find(b => b.type === 'tkhd');
    const mdia = tkKids.find(b => b.type === 'mdia');
    if (!tkhd || !mdia) continue;
    const tVer = full[tkhd.dataStart];
    const trackId = readU32(dv, tkhd.dataStart + (tVer === 0 ? 12 : 20));
    const dimOff = tVer === 0 ? tkhd.dataStart + 76 : tkhd.dataStart + 88;
    const width = dimOff + 8 <= tkhd.end ? readU32(dv, dimOff) >>> 16 : 0;
    const height = dimOff + 8 <= tkhd.end ? readU32(dv, dimOff + 4) >>> 16 : 0;

    const mdKids = listBoxes(full, mdia.dataStart, mdia.end);
    const mdhd = mdKids.find(b => b.type === 'mdhd');
    const hdlr = mdKids.find(b => b.type === 'hdlr');
    const minf = mdKids.find(b => b.type === 'minf');
    if (!mdhd || !hdlr || !minf) continue;

    const mVer = full[mdhd.dataStart];
    const timescale = readU32(dv, mdhd.dataStart + (mVer === 0 ? 12 : 20));
    const langOff = mVer === 0 ? mdhd.dataStart + 20 : mdhd.dataStart + 32;
    const langBytes = [full[langOff], full[langOff + 1]];
    const handlerType = readStr(full, hdlr.dataStart + 8, 4);
    const stbl = findBox(full, 'stbl', minf.dataStart, minf.end);
    const stsd = stbl ? findBox(full, 'stsd', stbl.dataStart, stbl.end) : null;
    if (!stsd || (handlerType !== 'vide' && handlerType !== 'soun')) continue;

    parsedTracks.set(trackId, {
      trackId,
      handlerType,
      timescale,
      width,
      height,
      langBytes,
      rawStsd: full.slice(stsd.off, stsd.end),
      samples: [],
    });
  }

  // Walk moof + mdat pairs sequentially
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i].type !== 'moof') continue;
    const moof = boxes[i];
    const nextMdat = boxes[i + 1]?.type === 'mdat' ? boxes[i + 1] : null;
    const trafs = listBoxes(full, moof.dataStart, moof.end).filter(b => b.type === 'traf');

    for (const traf of trafs) {
      const tk = listBoxes(full, traf.dataStart, traf.end);
      const tfhd = tk.find(b => b.type === 'tfhd');
      const trun = tk.find(b => b.type === 'trun');
      if (!tfhd || !trun) continue;

      const tfhdFlags = ((full[tfhd.dataStart + 1] << 16) | (full[tfhd.dataStart + 2] << 8) | full[tfhd.dataStart + 3]);
      const trackId = readU32(dv, tfhd.dataStart + 4);
      const track = parsedTracks.get(trackId);
      if (!track) continue;

      const trex = trexDefaults.get(trackId) || { duration: 0, size: 0, flags: 0 };
      let p = tfhd.dataStart + 8;
      let baseDataOffset = (tfhdFlags & 0x020000) ? moof.off : (nextMdat ? nextMdat.dataStart : moof.end + 8);
      if (tfhdFlags & 0x01) { baseDataOffset = readU64(dv, p); p += 8; }
      if (tfhdFlags & 0x02) p += 4;
      const defDur = (tfhdFlags & 0x08) ? ((p += 4), readU32(dv, p - 4)) : trex.duration;
      const defSize = (tfhdFlags & 0x10) ? ((p += 4), readU32(dv, p - 4)) : trex.size;
      const defFlags = (tfhdFlags & 0x20) ? ((p += 4), readU32(dv, p - 4)) : trex.flags;

      // Parse all trun boxes in this traf
      let curOffset = baseDataOffset;
      for (const tBox of tk.filter(b => b.type === 'trun')) {
        const tVer = full[tBox.dataStart];
        const tFlags = ((full[tBox.dataStart + 1] << 16) | (full[tBox.dataStart + 2] << 8) | full[tBox.dataStart + 3]);
        const count = readU32(dv, tBox.dataStart + 4);
        let q = tBox.dataStart + 8;

        let samplePtr = (tFlags & 0x001)
          ? (baseDataOffset + readI32(dv, q))
          : (nextMdat ? Math.max(curOffset, nextMdat.dataStart) : curOffset);
        if (tFlags & 0x001) q += 4;

        const firstSampleFlags = (tFlags & 0x004) ? ((q += 4), readU32(dv, q - 4)) : null;

        for (let s = 0; s < count; s++) {
          const dur = (tFlags & 0x100) ? ((q += 4), readU32(dv, q - 4)) : defDur;
          const sz = (tFlags & 0x200) ? ((q += 4), readU32(dv, q - 4)) : defSize;
          const fl = (tFlags & 0x400)
            ? ((q += 4), readU32(dv, q - 4))
            : (s === 0 && firstSampleFlags !== null ? firstSampleFlags : defFlags);
          const cto = (tFlags & 0x800)
            ? ((q += 4), tVer === 0 ? readU32(dv, q - 4) : readI32(dv, q - 4))
            : 0;

          if (samplePtr + sz <= full.length) {
            track.samples.push({
              data: full.subarray(samplePtr, samplePtr + sz),
              duration: dur,
              cto,
              isSync: track.handlerType === 'soun' ? true : ((fl & 0x00010000) === 0),
            });
          }
          samplePtr += sz;
        }
        curOffset = samplePtr;
      }
    }
  }

  return Array.from(parsedTracks.values()).filter(t => t.samples.length > 0);
}

/** Mux separate (or single) fMP4 streams directly into one playable faststart MP4. */
export function muxFmp4StreamsToProgressive(streams, options = {}) {
  const allTracks = [];
  for (const { init, fragments } of streams) {
    const tracks = parseFmp4Stream(init, fragments);
    allTracks.push(...tracks);
  }
  if (!allTracks.length) throw new Error('No tracks parsed from fMP4 stream');
  const durationSec = allTracks[0].timescale
    ? Math.round(allTracks[0].samples.reduce((acc, s) => acc + s.duration, 0) / allTracks[0].timescale)
    : 0;
  return {
    buffer: buildProgressiveMp4FromTracks(allTracks, options),
    width: allTracks.find(t => t.handlerType === 'vide')?.width || 0,
    height: allTracks.find(t => t.handlerType === 'vide')?.height || 0,
    durationSec,
  };
}
