import json
import logging
from typing import Optional, Dict, Any
import redis.asyncio as aioredis
from config import settings

logger = logging.getLogger(__name__)


class CacheManager:
    def __init__(self, redis_url: str):
        self.redis_url = redis_url
        self.redis: Optional[aioredis.Redis] = None

    async def connect(self):
        if not self.redis:
            self.redis = aioredis.from_url(
                self.redis_url,
                encoding="utf-8",
                decode_responses=True
            )
            logger.info("Connected to Redis cache.")

    async def close(self):
        if self.redis:
            await self.redis.aclose()
            self.redis = None

    def _cache_key(self, url: str, format_id: Optional[str] = None) -> str:
        suffix = f":{format_id}" if format_id else ""
        return f"cache:media:{url}{suffix}"

    async def get_cached_media(self, url: str, format_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Retrieve cached Telegram file_id if video was already downloaded before."""
        if not self.redis:
            await self.connect()
        try:
            key = self._cache_key(url, format_id)
            val = await self.redis.get(key)
            if val:
                return json.loads(val)
        except Exception as e:
            logger.warning(f"Error reading from Redis cache: {e}")
        return None

    async def save_cached_media(self, url: str, file_id: str, media_type: str, caption: str, format_id: Optional[str] = None, ttl: int = 2592000):
        """Save Telegram file_id with a 30-day expiration."""
        if not self.redis:
            await self.connect()
        try:
            key = self._cache_key(url, format_id)
            payload = json.dumps({
                "file_id": file_id,
                "media_type": media_type,
                "caption": caption
            })
            await self.redis.set(key, payload, ex=ttl)
        except Exception as e:
            logger.warning(f"Error saving to Redis cache: {e}")

    async def is_user_busy(self, user_id: int, max_concurrent: int = 1) -> bool:
        """Check if user currently has active downloads in progress."""
        if not self.redis:
            await self.connect()
        try:
            count = await self.redis.get(f"user:active:{user_id}")
            return int(count or 0) >= max_concurrent
        except Exception:
            return False

    async def increment_user_active(self, user_id: int):
        if not self.redis:
            await self.connect()
        try:
            key = f"user:active:{user_id}"
            await self.redis.incr(key)
            await self.redis.expire(key, 600)  # Safe expiry 10 mins
        except Exception as e:
            logger.warning(f"Error incrementing user active task: {e}")

    async def decrement_user_active(self, user_id: int):
        if not self.redis:
            await self.connect()
        try:
            key = f"user:active:{user_id}"
            val = await self.redis.decr(key)
            if val <= 0:
                await self.redis.delete(key)
        except Exception as e:
            logger.warning(f"Error decrementing user active task: {e}")


cache_manager = CacheManager(settings.REDIS_URL)
