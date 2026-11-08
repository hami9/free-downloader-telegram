from aiogram import Router
from aiogram.filters import CommandStart, Command
from aiogram.types import Message

router = Router(name="start_router")


@router.message(CommandStart())
async def handle_start(message: Message):
    text = (
        f"👋 <b>سلام {message.from_user.first_name}، به ربات دانلودر خوش آمدید!</b>\n\n"
        "این ربات از پلتفرم‌های زیر با بالاترین سرعت پشتیبانی می‌کند:\n"
        "▫️ <b>یوتیوب (YouTube):</b> با قابلیت انتخاب کیفیت (1080p, 720p, 480p, 360p و MP3)\n"
        "▫️ <b>اینستاگرام (Instagram):</b> پست‌ها و ریلزها\n"
        "▫️ <b>تیک‌تاک (TikTok):</b> بدون واترمارک\n"
        "▫️ <b>ایکس / توییتر (Twitter/X):</b> ویدیوها و گیف‌ها\n"
        "▫️ <b>پینترست (Pinterest):</b> ویدیوها و ایده‌ها\n\n"
        "📥 <b>کافیه لینک مد نظرت رو برام بفرستی تا دانلودش کنم!</b>"
    )
    await message.reply(text)


@router.message(Command("help"))
async def handle_help(message: Message):
    text = (
        "📖 <b>راهنمای استفاده از ربات:</b>\n\n"
        "۱. لینک پست یا ویدیو را از برنامه مورد نظر کپی کنید.\n"
        "۲. لینک را مستقیم در چت این ربات ارسال کنید.\n"
        "۳. در صورتی که لینک یوتیوب باشد، کیفیت‌های مختلف به شما نمایش داده می‌شود.\n"
        "۴. برای سایر پلتفرم‌ها، دانلود به‌طور خودکار با بالاترین کیفیت آغاز می‌شود."
    )
    await message.reply(text)
