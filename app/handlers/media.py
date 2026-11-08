import re
import uuid
import json
import logging
from aiogram import Router, F
from aiogram.types import Message, InlineKeyboardMarkup, InlineKeyboardButton
from app.services.extractor import detect_platform, PlatformType, MediaExtractor
from app.services.cache import cache_manager
from app.queue.manager import queue_manager

logger = logging.getLogger(__name__)
router = Router(name="media_router")

URL_REGEX = re.compile(
    r"https?://(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)"
)


@router.message(F.text)
async def handle_media_url(message: Message):
    match = URL_REGEX.search(message.text)
    if not match:
        await message.reply(
            "⚠️ لطفاً یک لینک معتبر از یوتیوب، اینستاگرام، تیک‌تاک، توییتر یا پینترست ارسال کنید."
        )
        return

    url = match.group(0)
    platform = detect_platform(url)

    if platform == PlatformType.OTHER:
        await message.reply(
            "⚠️ این لینک توسط ربات پشتیبانی نمی‌شود.\n"
            "پلتفرم‌های مجاز: یوتیوب، اینستاگرام، تیک‌تاک، توییتر/ایکس، پینترست."
        )
        return

    # Check Cache first (except YouTube where user might want to pick another quality)
    if platform != PlatformType.YOUTUBE:
        cached = await cache_manager.get_cached_media(url)
        if cached:
            media_type = cached.get("media_type")
            file_id = cached.get("file_id")
            caption = cached.get("caption")

            if media_type == "audio":
                await message.answer_audio(file_id, caption=caption)
            else:
                await message.answer_video(file_id, caption=caption, supports_streaming=True)
            return

    # User active limit check
    user_id = message.from_user.id
    if await cache_manager.is_user_busy(user_id):
        await message.reply(
            "⚠️ شما در حال حاضر یک دانلود در حال انجام دارید. لطفاً تا پایان آن صبر کنید."
        )
        return

    # YouTube Flow with Quality Selection
    if platform == PlatformType.YOUTUBE:
        status_msg = await message.reply("🔍 <b>در حال بررسی کیفیت‌های ویدیو یوتیوب...</b>")
        info = await MediaExtractor.get_info(url)
        if not info:
            await status_msg.edit_text(
                "❌ دریافت اطلاعات این ویدیو ناموفق بود.\nممکن است ویدیو محدود به سن یا خصوصی باشد."
            )
            return

        formats = MediaExtractor.parse_youtube_formats(info)
        if not formats:
            await status_msg.edit_text("❌ هیچ کیفیتی برای دانلود این ویدیو یافت نشد.")
            return

        # Store format metadata in Redis for 15 minutes
        token = str(uuid.uuid4())[:8]
        if not cache_manager.redis:
            await cache_manager.connect()

        await cache_manager.redis.set(
            f"yt_meta:{token}",
            json.dumps({"url": url, "formats": formats}),
            ex=900
        )

        # Build Inline Keyboard
        keyboard_buttons = []
        row = []
        for i, fmt in enumerate(formats):
            label = fmt.get("label", "Unknown")
            size = fmt.get("size_str")
            btn_text = f"{label} ({size})" if size else label
            row.append(
                InlineKeyboardButton(
                    text=btn_text,
                    callback_data=f"yt:{token}:{i}"
                )
            )
            if len(row) == 2:
                keyboard_buttons.append(row)
                row = []
        if row:
            keyboard_buttons.append(row)

        duration = int(info.get("duration") or 0)
        minutes, seconds = divmod(duration, 60)
        title = info.get("title", "YouTube Video")

        text = (
            f"🎬 <b>{title}</b>\n\n"
            f"⏱ مدت زمان: <code>{minutes:02d}:{seconds:02d}</code>\n"
            f"👤 کانال: <code>{info.get('uploader', 'Unknown')}</code>\n\n"
            f"👇 <b>کیفیت مورد نظر خود را جهت دانلود انتخاب کنید:</b>"
        )

        await status_msg.edit_text(
            text=text,
            reply_markup=InlineKeyboardMarkup(inline_keyboard=keyboard_buttons)
        )
        return

    # Direct Platforms Flow (Instagram, TikTok, Twitter, Pinterest)
    status_msg = await message.reply(
        f"⏳ <b>در حال ثبت لینک {platform.capitalize()} در صف دانلود...</b>"
    )

    # Set user busy lock
    await cache_manager.increment_user_active(user_id)

    enqueue_res = await queue_manager.enqueue_download(
        chat_id=message.chat.id,
        user_id=user_id,
        status_message_id=status_msg.message_id,
        url=url,
        platform=platform
    )

    position = enqueue_res["position"]
    await status_msg.edit_text(
        f"📥 <b>به صف دانلود اضافه شد!</b>\n\n"
        f"🌐 سرویس: <b>{platform.capitalize()}</b>\n"
        f"📊 نوبت شما در صف: <b>#{position}</b>\n"
        f"⚡️ به محض دانلود برای شما ارسال خواهد شد..."
    )
