import os
import json
import time
import asyncio
import logging
from typing import Optional
from aiogram import Bot
from aiogram.types import FSInputFile
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession

from config import settings
from app.services.downloader import MediaDownloader, DownloadResult
from app.services.cache import cache_manager
import redis.asyncio as aioredis

logger = logging.getLogger("worker")
QUEUE_NAME = "queue:downloads"


def build_progress_bar(percent: float, length: int = 10) -> str:
    filled = int(length * percent / 100)
    return "▓" * filled + "░" * (length - filled)


class DownloadWorker:
    def __init__(self):
        # Configure Telegram Bot with custom Bot API URL if provided (for >50MB files up to 2GB)
        if settings.LOCAL_BOT_API_URL:
            from aiogram.client.telegram import TelegramAPIServer
            session = AiohttpSession(
                api=TelegramAPIServer.from_base(settings.LOCAL_BOT_API_URL)
            )
            self.bot = Bot(
                token=settings.BOT_TOKEN,
                session=session,
                default=DefaultBotProperties(parse_mode="HTML")
            )
        else:
            self.bot = Bot(
                token=settings.BOT_TOKEN,
                default=DefaultBotProperties(parse_mode="HTML")
            )

        self.redis: Optional[aioredis.Redis] = None
        self.is_running = False

    async def start(self):
        self.redis = aioredis.from_url(
            settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True
        )
        self.is_running = True
        logger.info("🚀 Worker started and listening for download tasks...")

        while self.is_running:
            try:
                # Blocking pop with 3s timeout
                task_raw = await self.redis.brpop(QUEUE_NAME, timeout=3)
                if not task_raw:
                    continue

                _, job_json = task_raw
                job = json.loads(job_json)
                await self.process_job(job)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in worker loop: {e}", exc_info=True)
                await asyncio.sleep(2)

    async def process_job(self, job: dict):
        chat_id = job["chat_id"]
        user_id = job["user_id"]
        status_msg_id = job["status_message_id"]
        url = job["url"]
        format_id = job.get("format_id")
        is_audio = job.get("is_audio", False)
        platform = job.get("platform", "media")

        logger.info(f"Processing job {job['job_id']} for user {user_id} ({platform}): {url}")
        last_edit_time = 0.0

        def progress_hook(d):
            nonlocal last_edit_time
            now = time.time()
            # Throttle Telegram message updates to once every 3.5 seconds
            if now - last_edit_time < 3.5:
                return

            if d.get("status") == "downloading":
                total_bytes = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                downloaded_bytes = d.get("downloaded_bytes") or 0
                speed = d.get("speed") or 0

                percent = (downloaded_bytes / total_bytes * 100) if total_bytes > 0 else 0
                speed_mb = speed / (1024 * 1024) if speed else 0
                bar = build_progress_bar(percent)

                text = (
                    f"📥 <b>در حال دانلود از {platform.capitalize()}...</b>\n\n"
                    f"<code>[{bar}]</code> {percent:.1f}%\n"
                    f"⚡️ سرعت: <code>{speed_mb:.1f} MB/s</code>"
                )

                last_edit_time = now
                try:
                    asyncio.create_task(
                        self.bot.edit_message_text(
                            text=text,
                            chat_id=chat_id,
                            message_id=status_msg_id
                        )
                    )
                except Exception:
                    pass

        download_result: Optional[DownloadResult] = None
        try:
            # Download file
            download_result = await MediaDownloader.download(
                url=url,
                format_id=format_id,
                is_audio=is_audio,
                progress_hook=progress_hook
            )

            if not download_result or not os.path.exists(download_result.file_path):
                await self.bot.edit_message_text(
                    text="❌ متأسفانه دانلود فایل با خطا مواجه شد.\nممکن است پست خصوصی باشد یا لینک منقضی شده باشد.",
                    chat_id=chat_id,
                    message_id=status_msg_id
                )
                return

            # File size check for standard Bot API (50 MB limit if not using local bot api)
            file_size_mb = os.path.getsize(download_result.file_path) / (1024 * 1024)
            if not settings.LOCAL_BOT_API_URL and file_size_mb > 50:
                await self.bot.edit_message_text(
                    text=(
                        f"⚠️ <b>حجم فایل ({file_size_mb:.1f} MB) از محدودیت ۵۰ مگابایت تلگرام بیشتر است!</b>\n\n"
                        f"برای ارسال فایل‌های تا ۲ گیگابایت، سرور Local Bot API را فعال کنید."
                    ),
                    chat_id=chat_id,
                    message_id=status_msg_id
                )
                return

            # Update status to uploading
            try:
                await self.bot.edit_message_text(
                    text="🚀 <b>در حال آپلود و ارسال به تلگرام...</b>",
                    chat_id=chat_id,
                    message_id=status_msg_id
                )
            except Exception:
                pass

            # Prepare files for Telegram
            media_file = FSInputFile(download_result.file_path)
            thumb_file = FSInputFile(download_result.thumbnail_path) if download_result.thumbnail_path else None
            caption = f"🎬 <b>{download_result.title}</b>\n\n🤖 @YourDownloaderBot"

            sent_msg = None
            media_type = "video"
            if is_audio:
                media_type = "audio"
                sent_msg = await self.bot.send_audio(
                    chat_id=chat_id,
                    audio=media_file,
                    title=download_result.title,
                    duration=download_result.duration,
                    thumbnail=thumb_file,
                    caption=caption
                )
                file_id = sent_msg.audio.file_id
            else:
                sent_msg = await self.bot.send_video(
                    chat_id=chat_id,
                    video=media_file,
                    caption=caption,
                    duration=download_result.duration,
                    width=download_result.width,
                    height=download_result.height,
                    thumbnail=thumb_file,
                    supports_streaming=True
                )
                file_id = sent_msg.video.file_id

            # Save to Cache for future requests
            if file_id:
                await cache_manager.save_cached_media(
                    url=url,
                    file_id=file_id,
                    media_type=media_type,
                    caption=caption,
                    format_id=format_id
                )

            # Delete the progress message
            try:
                await self.bot.delete_message(chat_id=chat_id, message_id=status_msg_id)
            except Exception:
                pass

        except Exception as e:
            logger.error(f"Failed to process and send media: {e}", exc_info=True)
            try:
                await self.bot.edit_message_text(
                    text="❌ در پردازش و ارسال ویدیو خطایی رخ داد.",
                    chat_id=chat_id,
                    message_id=status_msg_id
                )
            except Exception:
                pass
        finally:
            # Cleanup temporary files
            if download_result:
                if os.path.exists(download_result.file_path):
                    try:
                        os.remove(download_result.file_path)
                    except Exception:
                        pass
                if download_result.thumbnail_path and os.path.exists(download_result.thumbnail_path):
                    try:
                        os.remove(download_result.thumbnail_path)
                    except Exception:
                        pass

            # Decrement user's active task
            await cache_manager.decrement_user_active(user_id)


async def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )
    worker = DownloadWorker()
    await worker.start()


if __name__ == "__main__":
    asyncio.run(main())
