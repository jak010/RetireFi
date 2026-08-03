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
    
    # Toss API credentials
    TOSS_ACCESS_TOKEN: Optional[str] = ""
    TOSS_TOKEN_TYPE: Optional[str] = ""
    TOSS_CLIENT_ID: Optional[str] = ""
    TOSS_CLIENT_SECRET: Optional[str] = ""


# 싱글톤처럼 사용
settings = Settings()
