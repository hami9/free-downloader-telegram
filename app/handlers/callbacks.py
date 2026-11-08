import json
import logging
from aiogram import Router, F
from aiogram.types import CallbackQuery
from app.services.cache import cache_manager
from app.queue.manager import queue_manager

logger = logging.getLogger(__name__)
router = Router(name="callbacks_router")


@router.callback_query(F.data.startswith("yt:"))
async def handle_youtube_quality_selection(callback: CallbackQuery):
    await callback.answer()
    data_parts = callback.data.split(":")
    if len(data_parts) != 3:
        await callback.message.edit_text("❌ دکمه منقضی شده است. لطفاً لینک را دوباره ارسال کنید.")
        return

    _, token, idx_str = data_parts
    idx = int(idx_str)

    # Retrieve metadata from Redis
    if not cache_manager.redis:
        await cache_manager.connect()

    meta_raw = await cache_manager.redis.get(f"yt_meta:{token}")
    if not meta_raw:
        await callback.message.edit_text("⚠️ این منو منقضی شده است. لطفاً دوباره لینک را ارسال کنید.")
        return

    meta = json.loads(meta_raw)
    url = meta["url"]
    formats = meta["formats"]

    if idx >= len(formats):
        await callback.message.edit_text("❌ کیفیت نامعتبر است.")
        return

    selected_format = formats[idx]
    format_id = selected_format.get("format_id")
    label = selected_format.get("label")
    is_audio = selected_format.get("is_audio", False)
    user_id = callback.from_user.id
    chat_id = callback.message.chat.id

    # Check if user already has an active download
    if await cache_manager.is_user_busy(user_id):
        await callback.message.answer(
            "⚠️ شما در حال حاضر یک دانلود فعال دارید. لطفاً صبر کنید تا به پایان برسد."
        )
        return

    # Check cache for this exact quality
    cached = await cache_manager.get_cached_media(url, format_id)
    if cached:
        media_type = cached.get("media_type")
        file_id = cached.get("file_id")
        caption = cached.get("caption")

        if media_type == "audio":
            await callback.message.answer_audio(file_id, caption=caption)
        else:
            await callback.message.answer_video(file_id, caption=caption, supports_streaming=True)

        await callback.message.delete()
        return

    # Set user busy lock
    await cache_manager.increment_user_active(user_id)

    # Enqueue job
    status_msg = await callback.message.edit_text(
        f"⏳ <b>کیفیت انتخابی: {label}</b>\nدر حال ارسال به صف دانلود..."
    )

    enqueue_res = await queue_manager.enqueue_download(
        chat_id=chat_id,
        user_id=user_id,
        status_message_id=status_msg.message_id,
        url=url,
        platform="youtube",
        format_id=format_id,
        is_audio=is_audio
    )

    position = enqueue_res["position"]
    await status_msg.edit_text(
        f"📥 <b>به صف دانلود اضافه شد!</b>\n\n"
        f"🎥 کیفیت: <b>{label}</b>\n"
        f"📊 نوبت شما در صف: <b>#{position}</b>\n"
        f"⏳ لطفاً کمی منتظر بمانید..."
    )
