#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');

function toRuntimePath(inputPath) {
  const s = String(inputPath || '').trim().replace(/^["']|["']$/g, '');
  const winMatch = s.match(/^([A-Za-z]):[\\/](.*)$/);
  if (process.platform === 'linux' && winMatch) {
    const drive = winMatch[1].toLowerCase();
    const rest = winMatch[2].replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
  }
  return s;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--') && i + 1 < argv.length) {
      args[a.slice(2)] = argv[++i];
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadConfig(targetOverride = '') {
  let raw;
  try {
    raw = await fs.readFile(CONFIG_PATH, 'utf8');
  } catch {
    throw new Error(
      `Missing ${CONFIG_PATH}. Copy config.example.json to config.json and set Telegram (botToken + chatId) or Instagram Graph API credentials.`
    );
  }
  const cfg = JSON.parse(raw);
  const effectiveMode = (targetOverride || cfg.mode || 'telegram').toLowerCase();
  cfg.mode = effectiveMode === 'facebook' ? 'facebook' : effectiveMode === 'instagram' ? 'instagram' : 'telegram';
  cfg.apiVersion = cfg.apiVersion || 'v21.0';

  if (cfg.mode === 'telegram') {
    if (!cfg.telegram?.botToken || cfg.telegram.botToken.includes('YOUR_TELEGRAM') || !cfg.telegram?.chatId || String(cfg.telegram.chatId).includes('YOUR_TELEGRAM')) {
      throw new Error(`Please fill in valid telegram.botToken and telegram.chatId in ${CONFIG_PATH}.`);
    }
    return cfg;
  }

  if (!cfg.igUserId || cfg.igUserId === 'YOUR_IG_USER_ID' || !cfg.accessToken || cfg.accessToken.includes('YOUR_IG')) {
    throw new Error(`Please fill in valid igUserId (or "me" for Instagram Login) and accessToken in ${CONFIG_PATH}.`);
  }
  return cfg;
}

async function verifyTelegramBot(cfg) {
  const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(cfg.telegram.botToken)}/getMe`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram getMe failed: ${data.description || res.status}`);
  }
  return { id: data.result?.id, username: data.result?.username, chatId: cfg.telegram.chatId };
}

async function sendToTelegram(cfg, { mediaKind, filePath, mediaUrl, caption }) {
  const botBase = `https://api.telegram.org/bot${encodeURIComponent(cfg.telegram.botToken)}`;
  const method = mediaKind === 'reel' ? 'sendVideo' : 'sendPhoto';
  const fieldName = mediaKind === 'reel' ? 'video' : 'photo';
  const shortCap = caption && caption.length <= 1020 ? caption : '';

  const form = new FormData();
  form.append('chat_id', String(cfg.telegram.chatId));
  if (shortCap) form.append('caption', shortCap);

  if (filePath) {
    const bytes = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase() || (mediaKind === 'reel' ? '.mp4' : '.jpg');
    const mime = mediaKind === 'reel' ? 'video/mp4' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    form.append(fieldName, new Blob([bytes], { type: mime }), `astier_daily${ext}`);
  } else {
    form.append(fieldName, mediaUrl);
  }
  if (mediaKind === 'reel') form.append('supports_streaming', 'true');

  const res = await fetch(`${botBase}/${method}`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
  }

  // Send copy-friendly standalone caption if caption exceeded 1020 chars
  if (caption && !shortCap) {
    await fetch(`${botBase}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: String(cfg.telegram.chatId),
        text: caption.slice(0, 4096),
      }),
    });
  }
  return { messageId: data.result?.message_id, method };
}

function getGraphBase(cfg) {
  return cfg.mode === 'facebook'
    ? `https://graph.facebook.com/${cfg.apiVersion}`
    : `https://graph.instagram.com/${cfg.apiVersion}`;
}

async function maybeRefreshInstagramToken(cfg) {
  if (cfg.mode !== 'instagram') return cfg;
  const lastMs = cfg.tokenUpdatedAt ? Date.parse(cfg.tokenUpdatedAt) : 0;
  const ageDays = lastMs ? (Date.now() - lastMs) / 86400000 : 999;
  if (lastMs && ageDays < 40) return cfg;

  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', cfg.accessToken);
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.access_token) {
    cfg.accessToken = data.access_token;
    cfg.tokenUpdatedAt = new Date().toISOString();
    await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  }
  return cfg;
}

async function verifyAccount(cfg) {
  await maybeRefreshInstagramToken(cfg);
  const base = getGraphBase(cfg);
  const endpointId = cfg.igUserId === 'me' && cfg.mode === 'instagram' ? 'me' : encodeURIComponent(cfg.igUserId);
  const res = await fetch(
    `${base}/${endpointId}?fields=id,username&access_token=${encodeURIComponent(cfg.accessToken)}`
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `HTTP ${res.status} verifying Instagram Graph API account`);
  }
  if (data.id && (cfg.igUserId === 'me' || !cfg.igUserId)) {
    cfg.igUserId = String(data.id);
  }
  return data;
}

async function uploadToTemporaryHost(filePath, mediaKind, cfg) {
  const bytes = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase() || (mediaKind === 'reel' ? '.mp4' : '.jpg');
  const mime =
    mediaKind === 'reel'
      ? 'video/mp4'
      : ext === '.png'
        ? 'image/png'
        : ext === '.webp'
          ? 'image/webp'
          : 'image/jpeg';

  // 1. Cloudinary unsigned preset (supports BOTH photos and MP4 reels via HTTPS CDN)
  const cloudName = cfg.cloudinary?.cloudName;
  const preset = cfg.cloudinary?.uploadPreset;
  if (cloudName && preset) {
    const resourceType = mediaKind === 'reel' ? 'video' : 'image';
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), `astier_upload${ext}`);
    form.append('upload_preset', preset);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/${resourceType}/upload`, {
      method: 'POST',
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.secure_url) {
      throw new Error(`Cloudinary upload failed: ${data.error?.message || res.status}`);
    }
    return data.secure_url;
  }

  // 2. ImgBB (photos only, auto-expires after 10 minutes)
  if (mediaKind !== 'reel' && cfg.imgbbApiKey) {
    const form = new FormData();
    form.append('image', bytes.toString('base64'));
    const res = await fetch(
      `https://api.imgbb.com/1/upload?expiration=600&key=${encodeURIComponent(cfg.imgbbApiKey)}`,
      { method: 'POST', body: form }
    );
    const data = await res.json().catch(() => ({}));
    const imgUrl = data?.data?.url;
    if (!res.ok || !imgUrl) {
      throw new Error(`ImgBB upload failed: ${data?.error?.message || res.status}`);
    }
    return imgUrl;
  }

  throw new Error(
    `No public media host configured for ${mediaKind} upload in ${CONFIG_PATH}. Configure cloudinary (cloudName + uploadPreset) or imgbbApiKey (for photos), or pass --media-url.`
  );
}

async function createContainer(cfg, { mediaKind, filePath, mediaUrl, caption }) {
  const base = getGraphBase(cfg);

  // Facebook Login mode supports direct binary resumable upload for Reels via rupload.facebook.com
  if (mediaKind === 'reel' && cfg.mode === 'facebook' && !mediaUrl && filePath) {
    const bytes = await fs.readFile(filePath);
    const initForm = new URLSearchParams({
      media_type: 'REELS',
      upload_type: 'resumable',
      share_to_feed: 'true',
      caption: caption || '',
      access_token: cfg.accessToken,
    });
    const initRes = await fetch(`${base}/${encodeURIComponent(cfg.igUserId)}/media`, {
      method: 'POST',
      body: initForm,
    });
    const initJson = await initRes.json().catch(() => ({}));
    if (!initRes.ok || !initJson.id || !initJson.uri) {
      throw new Error(`Resumable init failed: ${initJson.error?.message || initRes.status}`);
    }

    const upRes = await fetch(initJson.uri, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${cfg.accessToken}`,
        offset: '0',
        file_size: String(bytes.length),
        'Content-Type': 'application/octet-stream',
      },
      body: bytes,
    });
    const upJson = await upRes.json().catch(() => ({}));
    if (!upRes.ok || upJson.success === false) {
      throw new Error(`rupload binary upload failed: ${upJson.message || upRes.status}`);
    }
    return initJson.id;
  }

  const resolvedUrl = mediaUrl || (await uploadToTemporaryHost(filePath, mediaKind, cfg));
  const params = new URLSearchParams({
    caption: caption || '',
    access_token: cfg.accessToken,
  });
  if (mediaKind === 'reel') {
    params.set('media_type', 'REELS');
    params.set('video_url', resolvedUrl);
    params.set('share_to_feed', 'true');
  } else {
    params.set('image_url', resolvedUrl);
  }

  const res = await fetch(`${base}/${encodeURIComponent(cfg.igUserId)}/media`, {
    method: 'POST',
    body: params,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    throw new Error(`Container creation failed: ${data.error?.message || res.status}`);
  }
  return data.id;
}

async function waitAndPublish(cfg, containerId) {
  const base = getGraphBase(cfg);
  for (let i = 0; i < 36; i++) {
    const sRes = await fetch(
      `${base}/${encodeURIComponent(containerId)}?fields=status_code,status&access_token=${encodeURIComponent(cfg.accessToken)}`
    );
    const sJson = await sRes.json().catch(() => ({}));
    const statusCode = sJson.status_code || '';
    if (statusCode === 'FINISHED') break;
    if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
      throw new Error(`Meta container ${containerId} failed: ${JSON.stringify(sJson)}`);
    }
    await sleep(5000);
  }

  const pubRes = await fetch(`${base}/${encodeURIComponent(cfg.igUserId)}/media_publish`, {
    method: 'POST',
    body: new URLSearchParams({
      creation_id: containerId,
      access_token: cfg.accessToken,
    }),
  });
  const pubJson = await pubRes.json().catch(() => ({}));
  if (!pubRes.ok || !pubJson.id) {
    throw new Error(`media_publish failed: ${pubJson.error?.message || pubRes.status}`);
  }
  return pubJson.id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage:\n  node publish.mjs --check [--target telegram|instagram|facebook]\n  node publish.mjs --file <path> --caption <text> [--type photo|reel] [--target telegram|instagram|facebook] [--media-url <https://...>]'
    );
    return;
  }

  const cfg = await loadConfig(args.target || '');
  const account = cfg.mode === 'telegram' ? await verifyTelegramBot(cfg) : await verifyAccount(cfg);

  if (args.check) {
    console.log(JSON.stringify({ ok: true, mode: cfg.mode, account }));
    return;
  }

  const filePath = args.file ? toRuntimePath(args.file) : '';
  const mediaUrl = args['media-url'] || '';
  if (!filePath && !mediaUrl) {
    throw new Error('Provide --file <local_path> or --media-url <https://...>');
  }

  let mediaKind = (args.type || '').toLowerCase();
  if (!mediaKind) {
    const target = (filePath || mediaUrl).toLowerCase();
    mediaKind = /\.(mp4|mov|m4v)(\?|$)/.test(target) ? 'reel' : 'photo';
  }
  const captionFile = args['caption-file'] || args.captionFile;
  const caption = captionFile
    ? await fs.readFile(toRuntimePath(captionFile), 'utf8')
    : (args.caption || '');

  if (cfg.mode === 'telegram') {
    const sent = await sendToTelegram(cfg, { mediaKind, filePath, mediaUrl, caption });
    console.log(JSON.stringify({ ok: true, mode: 'telegram', bot: account.username, mediaKind, ...sent }));
    return;
  }

  const containerId = await createContainer(cfg, { mediaKind, filePath, mediaUrl, caption });
  const mediaId = await waitAndPublish(cfg, containerId);
  console.log(JSON.stringify({ ok: true, mode: cfg.mode, username: account.username, containerId, mediaId, mediaKind }));
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  process.exit(1);
});
