from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

    SLACK_TOKEN: str
    GOOGLE_API_KEY : str
    TOSS_CLIENT_ID: str
    TOSS_CLIENT_SECRET: str


# 싱글톤처럼 사용
settings = Settings()
