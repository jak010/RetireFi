from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

    SLACK_TOKEN: Optional[str] = ""
    GOOGLE_API_KEY: Optional[str] = ""


# 싱글톤처럼 사용
settings = Settings()
