import asyncio
import logging
import re
from typing import Optional, Dict, Any, List
import yt_dlp
from config import settings

logger = logging.getLogger(__name__)


class PlatformType:
    YOUTUBE = "youtube"
    INSTAGRAM = "instagram"
    TIKTOK = "tiktok"
    TWITTER = "twitter"
    PINTEREST = "pinterest"
    OTHER = "other"


def detect_platform(url: str) -> str:
    url_lower = url.lower()
    if any(domain in url_lower for domain in ["youtube.com", "youtu.be"]):
        return PlatformType.YOUTUBE
    if any(domain in url_lower for domain in ["instagram.com", "instagr.am"]):
        return PlatformType.INSTAGRAM
    if any(domain in url_lower for domain in ["tiktok.com"]):
        return PlatformType.TIKTOK
    if any(domain in url_lower for domain in ["twitter.com", "x.com"]):
        return PlatformType.TWITTER
    if any(domain in url_lower for domain in ["pinterest.com", "pin.it"]):
        return PlatformType.PINTEREST
    return PlatformType.OTHER


def _get_ytdl_base_options() -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "extract_flat": False,
    }
    if settings.HTTP_PROXY:
        opts["proxy"] = settings.HTTP_PROXY
    if settings.COOKIES_FILE:
        opts["cookiefile"] = settings.COOKIES_FILE
    return opts


def _format_size(size_bytes: Optional[int]) -> str:
    if not size_bytes:
        return ""
    mb = size_bytes / (1024 * 1024)
    if mb >= 1024:
        return f"{mb / 1024:.1f} GB"
    return f"{mb:.1f} MB"


def _extract_sync(url: str) -> Optional[Dict[str, Any]]:
    opts = _get_ytdl_base_options()
    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
            return info
        except Exception as e:
            logger.error(f"Error extracting metadata from {url}: {e}")
            return None


class MediaExtractor:
    @staticmethod
    async def get_info(url: str) -> Optional[Dict[str, Any]]:
        return await asyncio.to_thread(_extract_sync, url)

    @staticmethod
    def parse_youtube_formats(info: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Parses video formats from YouTube metadata and organizes them into selectable qualities:
        e.g., 1080p, 720p, 480p, 360p, and MP3 audio.
        """
        formats = info.get("formats", [])
        qualities: Dict[int, Dict[str, Any]] = {}
        has_audio = False

        target_heights = [1080, 720, 480, 360]

        for f in formats:
            # Check for audio streams
            if f.get("vcodec") == "none" and f.get("acodec") != "none":
                has_audio = True

            height = f.get("height")
            if not height or height not in target_heights:
                continue

            # Prefer mp4/m4v
            ext = f.get("ext", "")
            filesize = f.get("filesize") or f.get("filesize_approx")

            # We combine best video format of this height + best audio
            if height not in qualities or (ext == "mp4" and qualities[height].get("ext") != "mp4"):
                qualities[height] = {
                    "format_id": f"bestvideo[height<={height}]+bestaudio/best[height<={height}]",
                    "label": f"{height}p",
                    "height": height,
                    "ext": ext,
                    "size_str": _format_size(filesize),
                }

        sorted_qualities = [
            qualities[h] for h in sorted(qualities.keys(), reverse=True)
        ]

        # Add Audio / MP3 Option
        if has_audio or formats:
            sorted_qualities.append({
                "format_id": "bestaudio/best",
                "label": "🎵 MP3 / Audio",
                "height": 0,
                "is_audio": True,
                "size_str": "",
            })

        return sorted_qualities
