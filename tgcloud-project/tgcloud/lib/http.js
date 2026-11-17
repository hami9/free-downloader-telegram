import { fetch } from 'sdk';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Race a promise against a timer cleanly when global setTimeout is available. */
export function withTimeout(promise, ms, label = 'HTTP_TIMEOUT') {
  if (!ms || ms <= 0 || typeof setTimeout !== 'function') return promise;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(label);
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (typeof clearTimeout === 'function') clearTimeout(timer);
  });
}

/** Outbound HTTP fetch with an enforced response-header timeout. */
export function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  return withTimeout(fetch(url, options), timeoutMs, 'HTTP_FETCH_TIMEOUT');
}

/** Run async mapper across items with bounded worker concurrency. */
export async function mapWithConcurrency(items, concurrency = 2, mapper) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const limit = Math.max(1, Math.min(concurrency || 1, list.length));
  const results = new Array(list.length);
  let nextIdx = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= list.length) break;
      results[idx] = await mapper(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Safely concat an array of Uint8Array chunks into a single Uint8Array. */
export function concatBytes(chunks) {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Lightweight RFC-3986 URL parser (global URL is unavailable in tgcloud isolate). */
export function parseUrlParts(rawUrl) {
  const m = String(rawUrl).match(/^(https?:)\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i);
  if (!m) return null;
  const protocol = m[1].toLowerCase();
  const host = m[2];
  const pathname = m[3] || '/';
  const search = m[4] || '';
  return {
    protocol,
    origin: `${protocol}//${host}`,
    host,
    pathname,
    search,
    href: `${protocol}//${host}${pathname}${search}`,
  };
}

/** Resolve relative URLs (e.g. HLS segment URIs) against a base URL without global URL. */
export function resolveRelativeUrl(baseUrl, rel) {
  if (!rel) return baseUrl;
  if (/^https?:\/\//i.test(rel)) return rel;
  const base = parseUrlParts(baseUrl);
  if (!base) return rel;
  if (rel.startsWith('//')) return `${base.protocol}${rel}`;
  if (rel.startsWith('/')) return `${base.origin}${rel}`;
  const dir = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
  const stack = (dir + rel).split('/');
  const resolved = [];
  for (const seg of stack) {
    if (seg === '.' || seg === '') {
      if (resolved.length === 0) resolved.push('');
      continue;
    }
    if (seg === '..') {
      if (resolved.length > 1) resolved.pop();
    } else {
      resolved.push(seg);
    }
  }
  return `${base.origin}${resolved.join('/') || '/'}`;
}

/** Read a streaming SDK fetch body into a Uint8Array, enforcing maxBytes and timeout caps. */
export async function readBodyBytes(res, maxBytes = 29 * 1024 * 1024, timeoutMs = 45000) {
  if (!res?.body) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
  const iter = res.body[Symbol.asyncIterator]();
  try {
    while (true) {
      const remaining = deadline ? deadline - Date.now() : 0;
      if (deadline && remaining <= 0) {
        const err = new Error('HTTP_STREAM_TIMEOUT');
        err.code = 'TIMEOUT';
        throw err;
      }
      const step = deadline
        ? await withTimeout(iter.next(), Math.min(20000, remaining), 'HTTP_STREAM_TIMEOUT')
        : await iter.next();
      if (step.done) break;
      const chunk = step.value;
      const u = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      total += u.length;
      if (total > maxBytes) {
        const err = new Error('STREAM_TOO_LARGE');
        err.code = 'STREAM_TOO_LARGE';
        throw err;
      }
      chunks.push(u);
    }
  } finally {
    await iter.return?.().catch(() => {});
  }
  return concatBytes(chunks);
}

/** Parse Content-Range header (e.g. "bytes 0-0/86117551") -> total size or 0. */
export function parseContentRangeTotal(headerVal) {
  const m = String(headerVal || '').match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) || 0 : 0;
}

/**
 * Probe remote media resource length and HTTP Range support.
 * Handles CDNs that reject HEAD (fallback to tiny Range: bytes=0-0 probe).
 */
export async function probeRemoteMedia(url, headers = {}, timeoutMs = 8000) {
  try {
    const head = await fetchWithTimeout(url, { method: 'HEAD', headers }, timeoutMs);
    if (head.ok) {
      const len = Number(head.headers?.get?.('content-length') || 0);
      const acceptRanges = (head.headers?.get?.('accept-ranges') || '').toLowerCase();
      return {
        ok: true,
        url: head.url || url,
        contentLength: len,
        supportsRange: acceptRanges.includes('bytes') || len > 0,
        contentType: head.headers?.get?.('content-type') || '',
      };
    }
  } catch {}

  try {
    const probe = await fetchWithTimeout(url, { headers: { ...headers, Range: 'bytes=0-1' } }, timeoutMs);
    if (probe.status === 206) {
      const crTotal = parseContentRangeTotal(probe.headers?.get?.('content-range'));
      await readBodyBytes(probe, 64 * 1024, 5000).catch(() => {});
      return {
        ok: true,
        url: probe.url || url,
        contentLength: crTotal,
        supportsRange: true,
        contentType: probe.headers?.get?.('content-type') || '',
      };
    }
    if (probe.ok) {
      const len = Number(probe.headers?.get?.('content-length') || 0);
      await readBodyBytes(probe, 64 * 1024, 5000).catch(() => {});
      return {
        ok: true,
        url: probe.url || url,
        contentLength: len,
        supportsRange: false,
        contentType: probe.headers?.get?.('content-type') || '',
      };
    }
  } catch {}

  return { ok: false, url, contentLength: 0, supportsRange: false, contentType: '' };
}

function buildRangeTarget(baseUrl, headers, start, end, useQueryRange) {
  if (useQueryRange) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    return { url: `${baseUrl}${sep}range=${start}-${end}`, headers };
  }
  return { url: baseUrl, headers: { ...headers, Range: `bytes=${start}-${end}` } };
}

/**
 * Download an exact byte slice [start..end] safely below tgcloud's 30 MB single-response limit.
 * Automatically chunks slices > chunkSize and runs bounded parallel batches.
 */
export async function fetchByteRangeSlice(url, headers = {}, start = 0, end = 0, options = {}) {
  const {
    chunkSize = 8 * 1024 * 1024,
    concurrency = 3,
    useQueryRange = false,
    shouldCancel = null,
  } = options;

  if (end < start) return new Uint8Array(0);
  const ranges = [];
  for (let off = start; off <= end; off += chunkSize) {
    ranges.push([off, Math.min(end, off + chunkSize - 1)]);
  }

  const out = new Uint8Array(end - start + 1);
  let cursor = 0;

  for (let i = 0; i < ranges.length; i += concurrency) {
    if (shouldCancel && await shouldCancel()) {
      const err = new Error('CANCELLED');
      err.code = 'CANCELLED';
      throw err;
    }
    const batch = ranges.slice(i, i + concurrency);
    const bufs = await Promise.all(
      batch.map(async ([s, e]) => {
        const target = buildRangeTarget(url, headers, s, e, useQueryRange);
        const res = await fetchWithTimeout(target.url, { headers: target.headers }, 20000);
        if (!res.ok && res.status !== 206) {
          throw new Error(`HTTP ${res.status} on byte range ${s}-${e}`);
        }
        const maxRead = res.status === 200 && !useQueryRange ? e + 4096 : (e - s + 4096);
        const bytes = await readBodyBytes(res, maxRead, 35000);
        if (bytes.length > e - s + 1 && !useQueryRange && res.status === 200) {
          return bytes.subarray(s, Math.min(bytes.length, e + 1));
        }
        return bytes;
      })
    );
    for (const b of bufs) {
      out.set(b, cursor);
      cursor += b.length;
    }
  }

  return cursor === out.length ? out : out.subarray(0, cursor);
}

/**
 * Download a full remote file (or up to maxBytes) cleanly, bypassing tgcloud's 30 MB sdk/io
 * single-response ceiling by preferring chunked Range downloads whenever > 20 MB or unknown.
 */
export async function fetchMediaBuffer(url, headers = {}, options = {}) {
  const {
    maxBytes = 48 * 1024 * 1024,
    knownLength = 0,
    chunkSize = 8 * 1024 * 1024,
    concurrency = 3,
    useQueryRange = false,
    shouldCancel = null,
  } = options;

  if (shouldCancel && await shouldCancel()) {
    const err = new Error('CANCELLED');
    err.code = 'CANCELLED';
    throw err;
  }

  let totalLength = knownLength || 0;
  let supportsRange = useQueryRange;

  if (!totalLength && !useQueryRange) {
    const probed = await probeRemoteMedia(url, headers);
    totalLength = probed.contentLength;
    supportsRange = probed.supportsRange;
    if (probed.url) url = probed.url;
  }

  if (totalLength > maxBytes) {
    const err = new Error('FILE_TOO_LARGE');
    err.code = 'FILE_TOO_LARGE';
    err.totalLength = totalLength;
    throw err;
  }

  // Use chunked Range downloads for > 29 MB files or when server supports Range cleanly (> 12 MB)
  if (totalLength > 0 && (useQueryRange || totalLength > 29 * 1024 * 1024 || (supportsRange && totalLength > 12 * 1024 * 1024))) {
    return fetchByteRangeSlice(url, headers, 0, totalLength - 1, {
      chunkSize,
      concurrency,
      useQueryRange,
      shouldCancel,
    });
  }

  // Try direct fetch if size <= 24 MB or unknown
  try {
    const res = await fetchWithTimeout(url, { headers }, 20000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cl = Number(res.headers?.get?.('content-length') || 0);
    if (cl > maxBytes) {
      const err = new Error('FILE_TOO_LARGE');
      err.code = 'FILE_TOO_LARGE';
      err.totalLength = cl;
      throw err;
    }
    return await readBodyBytes(res, maxBytes, 45000);
  } catch (err) {
    if (err?.code === 'FILE_TOO_LARGE' || err?.code === 'CANCELLED' || err?.code === 'STREAM_TOO_LARGE' || err?.code === 'TIMEOUT') {
      throw err;
    }
    // sdk/io throws "fetch: response body too large" around 30 MB before returning headers
    if (!String(err?.message || '').toLowerCase().includes('too large')) {
      throw err;
    }
  }

  // Fallback for unknown chunked responses > 30 MB: sequential Range probing up to maxBytes
  const parts = [];
  let offset = 0;
  let total = 0;
  while (offset < maxBytes) {
    if (shouldCancel && await shouldCancel()) {
      const err = new Error('CANCELLED');
      err.code = 'CANCELLED';
      throw err;
    }
    const end = Math.min(offset + chunkSize - 1, maxBytes);
    const res = await fetchWithTimeout(url, { headers: { ...headers, Range: `bytes=${offset}-${end}` } }, 20000);
    if (res.status !== 206 && !res.ok) break;
    const contentRange = res.headers?.get?.('content-range') || '';
    const crTotal = parseContentRangeTotal(contentRange);
    if (crTotal > maxBytes) {
      const err = new Error('FILE_TOO_LARGE');
      err.code = 'FILE_TOO_LARGE';
      err.totalLength = crTotal;
      throw err;
    }
    const buf = await readBodyBytes(res, chunkSize + 4096, 35000);
    if (!buf.length) break;
    parts.push(buf);
    total += buf.length;
    if (total > maxBytes) {
      const err = new Error('FILE_TOO_LARGE');
      err.code = 'FILE_TOO_LARGE';
      err.totalLength = crTotal || total;
      throw err;
    }
    if ((crTotal > 0 && offset + buf.length >= crTotal) || buf.length < end - offset + 1) {
      break;
    }
    offset += buf.length;
  }

  if (!total) throw new Error('Empty ranged download');
  return concatBytes(parts);
}
