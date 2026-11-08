import os
from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    BOT_TOKEN: str = "SET_YOUR_TOKEN_HERE"
    REDIS_URL: str = "redis://localhost:6379/0"
    LOCAL_BOT_API_URL: Optional[str] = None
    MAX_CONCURRENT_DOWNLOADS: int = 3
    DOWNLOAD_DIR: str = "./downloads"
    HTTP_PROXY: Optional[str] = None
    COOKIES_FILE: Optional[str] = None

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )


settings = Settings()

# Ensure download directory exists
os.makedirs(settings.DOWNLOAD_DIR, exist_ok=True)
