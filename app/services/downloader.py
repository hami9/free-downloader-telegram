import os
import uuid
import asyncio
import logging
from typing import Optional, Dict, Any, Callable
import yt_dlp
from config import settings

logger = logging.getLogger(__name__)


class DownloadResult:
    def __init__(
        self,
        file_path: str,
        title: str,
        duration: int = 0,
        width: Optional[int] = None,
        height: Optional[int] = None,
        thumbnail_path: Optional[str] = None,
        is_audio: bool = False
    ):
        self.file_path = file_path
        self.title = title
        self.duration = duration
        self.width = width
        self.height = height
        self.thumbnail_path = thumbnail_path
        self.is_audio = is_audio


def _download_sync(
    url: str,
    format_id: Optional[str] = None,
    is_audio: bool = False,
    progress_hook: Optional[Callable] = None
) -> Optional[DownloadResult]:
    task_id = str(uuid.uuid4())[:8]
    out_template = os.path.join(settings.DOWNLOAD_DIR, f"{task_id}_%(title).50s.%(ext)s")

    opts: Dict[str, Any] = {
        "outtmpl": out_template,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "writethumbnail": True,
    }

    if settings.HTTP_PROXY:
        opts["proxy"] = settings.HTTP_PROXY
    if settings.COOKIES_FILE:
        opts["cookiefile"] = settings.COOKIES_FILE

    if is_audio:
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ]
    elif format_id:
        opts["format"] = format_id
        opts["merge_output_format"] = "mp4"
    else:
        # Default best video + best audio merged to mp4
        opts["format"] = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
        opts["merge_output_format"] = "mp4"

    if progress_hook:
        opts["progress_hooks"] = [progress_hook]

    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            info = ydl.extract_info(url, download=True)
            if not info:
                return None

            # Locate downloaded file
            filename = ydl.prepare_filename(info)
            if is_audio:
                base, _ = os.path.splitext(filename)
                filename = f"{base}.mp3"
            elif not os.path.exists(filename):
                # Check for merged mp4
                base, _ = os.path.splitext(filename)
                if os.path.exists(f"{base}.mp4"):
                    filename = f"{base}.mp4"

            # Check thumbnail
            thumb_path = None
            base, _ = os.path.splitext(filename)
            for ext in [".jpg", ".webp", ".png"]:
                candidate = f"{base}{ext}"
                if os.path.exists(candidate):
                    thumb_path = candidate
                    break

            return DownloadResult(
                file_path=filename,
                title=info.get("title", "Video"),
                duration=int(info.get("duration") or 0),
                width=info.get("width"),
                height=info.get("height"),
                thumbnail_path=thumb_path,
                is_audio=is_audio
            )
        except Exception as e:
            logger.error(f"Download failed for {url}: {e}", exc_info=True)
            return None


class MediaDownloader:
    @staticmethod
    async def download(
        url: str,
        format_id: Optional[str] = None,
        is_audio: bool = False,
        progress_hook: Optional[Callable] = None
    ) -> Optional[DownloadResult]:
        return await asyncio.to_thread(_download_sync, url, format_id, is_audio, progress_hook)
