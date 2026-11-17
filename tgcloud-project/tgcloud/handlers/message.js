import {
  handleTikTok,
  handleX,
  handleInstagram,
  handlePinterest,
  handleYouTubeDownload,
  inspectYouTubeVideo,
  normalizeIgCookie,
  verifyInstagramCookie,
  sendCachedEntry,
  extractYouTubeId,
  extractSupportedMediaLink,
  normalizeMediaUrl,
  runWithSingleflight,
  claimUpdateLock,
  getCachedEntry,
  invalidateCacheEntry,
  saveCache,
  tgCall,
  escapeHtml,
  formatDuration,
} from '../lib/media.js';

const BOT_ID = 9028623823;
const FUN_REPLIES = ['ehen', 'hehe', 'fufu', 'meow', 'nuh uh', 'hentai'];

function getMessageSearchableText(msg) {
  if (!msg) return '';
  const parts = [];
  if (msg.text) parts.push(msg.text);
  if (msg.caption) parts.push(msg.caption);
  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  for (const ent of entities) {
    if (ent && ent.url) parts.push(ent.url);
  }
  return parts.join(' ').trim();
}

function isReplyToOurBot(message) {
  const replyFrom = message?.reply_to_message?.from;
  if (!replyFrom) return false;
  if (replyFrom.id === BOT_ID) return true;
  if ((replyFrom.username || '').toLowerCase() === 'free_downloads_bot') return true;
  return false;
}

async function isFunReplyEnabled(chatId) {
  const row = await getCachedEntry(`setting:fun_reply:${chatId}`, 'config');
  return !(row && row.fileId === 'off');
}

async function setFunReplyEnabled(chatId, enabled) {
  await saveCache(`setting:fun_reply:${chatId}`, 'config', enabled ? 'on' : 'off', 'setting', '');
}

export default async function (message, ctx) {
  const chatId = message.chat.id;
  const chatType = message.chat?.type; // 'private', 'group', 'supergroup', 'channel'
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const text = getMessageSearchableText(message);
  const lowerText = text.toLowerCase();

  // 1. Direct commands handling (/start, /help, /fun, /funoff, /funon)
  const isStart = lowerText === '/start' || lowerText.startsWith('/start@');
  const isHelp = lowerText === '/help' || lowerText.startsWith('/help@');

  if (isStart || isHelp) {
    if (isGroup) {
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: (
          `👋 <b>Free Downloads Bot</b>\n\n` +
          `Send any link from <b>YouTube, Instagram, TikTok, X, or Pinterest</b> to download media automatically!\n\n` +
          `⚙️ <b>Fun Reply Settings:</b>\n` +
          `• <code>/funoff</code> — Turn off fun replies completely\n` +
          `• <code>/funon</code> — Turn on fun replies`
        ),
        parse_mode: 'HTML',
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true,
      });
    }

    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: (
        `👋 <b>Hello ${escapeHtml(message.from?.first_name || 'there')}!</b>\n\n` +
        `Send me a link from any of the following platforms:\n` +
        `• <b>YouTube</b> (Multiple qualities, MP3, Retry & Cancel)\n` +
        `• <b>Instagram</b> (Reels, Posts & Full Carousels/Albums)\n` +
        `• <b>TikTok</b> (Videos & Photo Slideshows, No watermark)\n` +
        `• <b>X / Twitter</b> (Videos, Photos & Multi-Slide Albums)\n` +
        `• <b>Pinterest</b> (Videos, Story Pins & Images)\n\n` +
        `📥 <i>Just send the link to download with full caption!</i>`
      ),
      parse_mode: 'HTML',
    });
  }

  // One-time private admin binding: /claimadmin <token>
  if (!isGroup && /^\/claimadmin(?:@free_downloads_bot)?(?:\s|$)/i.test(text)) {
    const existingAdmin = await getCachedEntry('setting:admin_id', 'config').catch(() => null);
    if (existingAdmin?.fileId) {
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: '🔒 Admin account is already configured.',
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true,
      });
    }
    const tokenRow = await getCachedEntry('setting:admin_claim_token', 'config').catch(() => null);
    const provided = text.replace(/^\/claimadmin(?:@free_downloads_bot)?\s*/i, '').trim();
    if (!tokenRow?.fileId || !provided || provided !== tokenRow.fileId) {
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: '❌ Invalid or expired setup token.',
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true,
      });
    }
    await saveCache('setting:admin_id', 'config', String(message.from?.id || chatId), 'setting', '');
    await invalidateCacheEntry('setting:admin_claim_token', 'config');
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: '✅ Admin access granted. You can now use <code>/igcookie &lt;sessionid_or_cookie&gt;</code>, <code>/igcookie status</code>, or <code>/igcookie clear</code>.',
      parse_mode: 'HTML',
    });
  }

  // Private admin command: /igcookie <cookie_or_sessionid|status|clear>
  if (!isGroup && /^\/igcookie(?:@free_downloads_bot)?(?:\s|$)/i.test(text)) {
    const adminRow = await getCachedEntry('setting:admin_id', 'config').catch(() => null);
    if (!adminRow?.fileId) {
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: '🔒 Admin account is not configured yet.',
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true,
      });
    }
    if (String(message.from?.id || chatId) !== String(adminRow.fileId)) {
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: '⛔ This command is restricted to the bot admin.',
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true,
      });
    }
    const arg = text.replace(/^\/igcookie(?:@free_downloads_bot)?\s*/i, '').trim();
    if (!arg || /^status$/i.test(arg)) {
      const current = await getCachedEntry('setting:ig_cookie', 'config').catch(() => null);
      if (!current?.fileId) {
        return await tgCall('sendMessage', {
          chat_id: chatId,
          text: 'ℹ️ No Instagram session cookie is set.\nSend <code>/igcookie &lt;sessionid_or_cookie&gt;</code> to configure it.',
          parse_mode: 'HTML',
        });
      }
      const check = await verifyInstagramCookie(current.fileId);
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: check.ok
          ? `✅ Instagram session cookie is active (logged in as <b>@${escapeHtml(check.username)}</b>).`
          : `⚠️ Instagram session cookie is saved, but verification failed (${escapeHtml(check.reason)}).`,
        parse_mode: 'HTML',
      });
    }
    if (/^clear$/i.test(arg)) {
      await invalidateCacheEntry('setting:ig_cookie', 'config');
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: '🗑 Instagram session cookie removed.',
      });
    }
    const normalized = normalizeIgCookie(arg);
    const check = await verifyInstagramCookie(normalized);
    if (!check.cookie) {
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: '❌ Invalid cookie format. Pass a valid <code>sessionid</code> or full Instagram cookie string.',
        parse_mode: 'HTML',
      });
    }
    await saveCache('setting:ig_cookie', 'config', check.cookie, 'setting', check.username || '');
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: check.ok
        ? `✅ Instagram session cookie saved and verified (logged in as <b>@${escapeHtml(check.username)}</b>).`
        : `⚠️ Instagram session cookie saved, though profile check returned: ${escapeHtml(check.reason)}.`,
      parse_mode: 'HTML',
    });
  }

  // Handle /fun, /funoff, /funon commands to toggle or disable fun replies in groups/chats
  const funCmdMatch = lowerText.match(/^\/(fun|funoff|funon)(?:@free_downloads_bot)?(?:\s+(on|off))?$/);
  if (funCmdMatch) {
    const cmd = funCmdMatch[1];
    const arg = funCmdMatch[2];
    let nextState;

    if (cmd === 'funoff' || arg === 'off') {
      nextState = false;
    } else if (cmd === 'funon' || arg === 'on') {
      nextState = true;
    } else {
      const current = await isFunReplyEnabled(chatId);
      nextState = !current;
    }

    await setFunReplyEnabled(chatId, nextState);
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: nextState
        ? '🔊 <b>Fun replies are now ON in this chat.</b>'
        : '🔇 <b>Fun replies are now OFF in this chat.</b>',
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
      allow_sending_without_reply: true,
    });
  }

  // 2. Identify supported link ONLY in the current message itself (never from reply_to_message!)
  const matched = extractSupportedMediaLink(text);
  const targetMsgId = message.message_id;

  // 3. If no supported link was found in the current message:
  if (!matched) {
    // If someone replied directly to the bot and their message is NOT a supported link, send a random fun word (if enabled)!
    if (isReplyToOurBot(message) && (await isFunReplyEnabled(chatId))) {
      const randomReply = FUN_REPLIES[Math.floor(Math.random() * FUN_REPLIES.length)];
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: randomReply,
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true,
      });
    }

    if (isGroup) {
      // Silently ignore all non-link messages and replies in groups!
      return;
    }

    // In private chats: guide the user
    const hasAnyUrl = /https?:\/\//i.test(text);
    if (hasAnyUrl) {
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: '⚠️ This platform is currently not supported.\nSupported platforms: YouTube, Instagram, TikTok, X, Pinterest.',
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true,
      });
    }

    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: '⚠️ Please send a valid link from YouTube, Instagram, TikTok, X, or Pinterest.',
      reply_to_message_id: message.message_id,
      allow_sending_without_reply: true,
    });
  }

  const { platform } = matched;
  const url = normalizeMediaUrl(matched.url);

  // 4. Prevent duplicate webhook retries from processing the same message multiple times
  const msgLockKey = `msg_${message.message_id}`;
  const acquired = await claimUpdateLock(chatId, msgLockKey, 3600);
  if (!acquired) {
    return;
  }

  // 5. Check built-in SQLite + memory cache & singleflight stampede lock (for non-YouTube links)
  if (platform !== 'youtube') {
    const cached = await getCachedEntry(url, '');
    if (cached && !(cached.caption && cached.caption.includes('Post not found'))) {
      return await sendCachedEntry(chatId, cached, targetMsgId);
    }

    const sf = await runWithSingleflight(url, async () => {
      if (platform === 'tiktok') {
        return await handleTikTok(chatId, url, targetMsgId);
      }
      if (platform === 'x') {
        return await handleX(chatId, url, targetMsgId);
      }
      if (platform === 'instagram') {
        return await handleInstagram(chatId, url, targetMsgId);
      }
      if (platform === 'pinterest') {
        return await handlePinterest(chatId, url, targetMsgId);
      }
    });
    if (sf.role === 'hit' && sf.cached) {
      return await sendCachedEntry(chatId, sf.cached, targetMsgId);
    }
    return sf.result;
    return;
  }

  if (platform === 'youtube') {
    const videoId = matched.id || extractYouTubeId(url);
    if (!videoId) {
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: '❌ Invalid YouTube video link.',
        reply_to_message_id: targetMsgId,
        allow_sending_without_reply: true,
      });
    }

    const info = await inspectYouTubeVideo(videoId).catch(() => null);
    if (info?.isLive) {
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: '❌ Live streams cannot be downloaded directly.',
        reply_to_message_id: targetMsgId,
        allow_sending_without_reply: true,
      });
    }

    if (info && !info.hasFormats && !info.playable && info.reason) {
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: `❌ YouTube video unavailable: ${escapeHtml(info.reason)}`,
        parse_mode: 'HTML',
        reply_to_message_id: targetMsgId,
        allow_sending_without_reply: true,
      });
    }

    const inlineKeyboard = info?.hasFormats
      ? info.inlineKeyboard
      : [
          [
            { text: '🎬 1080p (FHD)', callback_data: `ytq|1080|${videoId}` },
            { text: '🎬 720p (HD)', callback_data: `ytq|720|${videoId}` },
          ],
          [
            { text: '📺 480p (SD)', callback_data: `ytq|480|${videoId}` },
            { text: '📱 360p', callback_data: `ytq|360|${videoId}` },
          ],
          [
            { text: '🎵 Audio (.m4a)', callback_data: `ytq|audio|${videoId}` },
          ],
        ];

    const headerTitle = info?.title ? `📺 <b>${escapeHtml(info.title)}</b>` : '📺 <b>YouTube</b>';
    const durBadge = info?.lengthSeconds ? ` (${formatDuration(info.lengthSeconds)})` : '';
    const promptText = `${headerTitle}${durBadge}\n\n<b>Select format:</b>`;

    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: promptText,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard },
      reply_to_message_id: targetMsgId,
      allow_sending_without_reply: true,
    });
  }
}
