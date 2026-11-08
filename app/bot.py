import asyncio
import logging
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession

from config import settings
from app.handlers import start, media, callbacks
from app.services.cache import cache_manager

logger = logging.getLogger(__name__)


def create_bot() -> Bot:
    if settings.LOCAL_BOT_API_URL:
        from aiogram.client.telegram import TelegramAPIServer
        session = AiohttpSession(
            api=TelegramAPIServer.from_base(settings.LOCAL_BOT_API_URL)
        )
        return Bot(
            token=settings.BOT_TOKEN,
            session=session,
            default=DefaultBotProperties(parse_mode="HTML")
        )
    return Bot(
        token=settings.BOT_TOKEN,
        default=DefaultBotProperties(parse_mode="HTML")
    )


def create_dispatcher() -> Dispatcher:
    dp = Dispatcher()
    dp.include_router(start.router)
    dp.include_router(callbacks.router)
    dp.include_router(media.router)
    return dp


async def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )

    if settings.BOT_TOKEN == "SET_YOUR_TOKEN_HERE":
        logger.error("❌ BOT_TOKEN تنظیم نشده است! لطفاً فایل .env را با توکن دریافتی از BotFather پر کنید.")
        return

    bot = create_bot()
    dp = create_dispatcher()

    logger.info("Connecting to Redis...")
    await cache_manager.connect()

    try:
        logger.info("🤖 Bot is starting (polling mode)...")
        # Delete webhook to ensure polling works without conflicts
        await bot.delete_webhook(drop_pending_updates=True)
        await dp.start_polling(bot)
    finally:
        await cache_manager.close()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
