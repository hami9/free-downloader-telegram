import json
import uuid
import time
import logging
from typing import Optional, Dict, Any
import redis.asyncio as aioredis
from config import settings

logger = logging.getLogger(__name__)

QUEUE_NAME = "queue:downloads"


class QueueManager:
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

    async def enqueue_download(
        self,
        chat_id: int,
        user_id: int,
        status_message_id: int,
        url: str,
        platform: str,
        format_id: Optional[str] = None,
        is_audio: bool = False
    ) -> Dict[str, Any]:
        """Pushes a download job to the distributed Redis queue."""
        await self.connect()

        job_id = str(uuid.uuid4())
        job_data = {
            "job_id": job_id,
            "chat_id": chat_id,
            "user_id": user_id,
            "status_message_id": status_message_id,
            "url": url,
            "platform": platform,
            "format_id": format_id,
            "is_audio": is_audio,
            "created_at": time.time(),
        }

        # Push to Redis queue
        await self.redis.lpush(QUEUE_NAME, json.dumps(job_data))

        # Get queue length (queue position for user feedback)
        position = await self.redis.llen(QUEUE_NAME)
        return {
            "job_id": job_id,
            "position": position
        }

    async def get_queue_size(self) -> int:
        await self.connect()
        return await self.redis.llen(QUEUE_NAME)


queue_manager = QueueManager(settings.REDIS_URL)
