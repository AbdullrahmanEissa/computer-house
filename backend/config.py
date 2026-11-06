"""Central settings, read from environment variables (or a local .env file)."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- General / observability -------------------------------------------
    environment: str = "development"
    release: str | None = None
    sentry_dsn: str | None = None
    sentry_traces_sample_rate: float = 0.1

    # --- Supabase (server-side only: use the service-role / secret key) ----
    supabase_url: str
    supabase_service_key: str

    # --- Redis (Celery broker + circuit-breaker state) ---------------------
    redis_url: str = "redis://localhost:6379/0"

    # --- API ----------------------------------------------------------------
    cors_origins: list[str] = ["http://localhost:3000"]  # your Next.js origin(s)

    # --- Third-party integrations -------------------------------------------
    mock_integrations: bool = True    # True = no real HTTP calls to WhatsApp / Taager
    mock_failure_rate: float = 0.0    # 0..1: simulate outages to watch retries + breaker work
    default_country_code: str = "20"  # turns local numbers (01xxxxxxxxx) into international
    whatsapp_api_url: str = ""        # e.g. https://api.ultramsg.com/<instance_id>
    whatsapp_token: str = ""
    taager_api_url: str = ""
    taager_api_key: str = ""


settings = Settings()
