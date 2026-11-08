import uuid
import json
import logging
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
from config import settings
from app.services.extractor import MediaExtractor, detect_platform, PlatformType
from app.queue.manager import queue_manager
from app.services.cache import cache_manager

app = FastAPI(title="Downloader Cluster API")
logger = logging.getLogger("api")


class ExtractRequest(BaseModel):
    url: str


class DownloadRequest(BaseModel):
    url: str
    chat_id: int
    user_id: int
    status_message_id: int


class DownloadSessionRequest(BaseModel):
    session_id: str
    format_index: int
    chat_id: int
    user_id: int
    status_message_id: int


@app.on_event("startup")
async def startup():
    await cache_manager.connect()
    await queue_manager.connect()


@app.post("/extract")
async def extract_metadata(req: ExtractRequest):
    info = await MediaExtractor.get_info(req.url)
    if not info:
        return {"success": False, "error": "Could not extract video metadata"}

    formats = MediaExtractor.parse_youtube_formats(info)
    session_id = str(uuid.uuid4())[:8]

    # Store formats in Redis for 15 minutes
    await cache_manager.redis.set(
        f"yt_session:{session_id}",
        json.dumps({"url": req.url, "formats": formats}),
        ex=900
    )

    duration = int(info.get("duration") or 0)
    minutes, seconds = divmod(duration, 60)

    return {
        "success": True,
        "session_id": session_id,
        "title": info.get("title", "Video"),
        "uploader": info.get("uploader", "Unknown"),
        "duration_str": f"{minutes:02d}:{seconds:02d}",
        "formats": formats
    }


@app.post("/download")
async def enqueue_download(req: DownloadRequest):
    platform = detect_platform(req.url)
    res = await queue_manager.enqueue_download(
        chat_id=req.chat_id,
        user_id=req.user_id,
        status_message_id=req.status_message_id,
        url=req.url,
        platform=platform
    )
    return {"success": True, "position": res["position"], "job_id": res["job_id"]}


@app.post("/download_session")
async def enqueue_session_download(req: DownloadSessionRequest):
    raw = await cache_manager.redis.get(f"yt_session:{req.session_id}")
    if not raw:
        raise HTTPException(status_code=404, detail="Session expired")

    data = json.loads(raw)
    formats = data["formats"]
    if req.format_index >= len(formats):
        raise HTTPException(status_code=400, detail="Invalid format index")

    selected = formats[req.format_index]
    res = await queue_manager.enqueue_download(
        chat_id=req.chat_id,
        user_id=req.user_id,
        status_message_id=req.status_message_id,
        url=data["url"],
        platform="youtube",
        format_id=selected.get("format_id"),
        is_audio=selected.get("is_audio", False)
    )
    return {"success": True, "position": res["position"], "job_id": res["job_id"]}
