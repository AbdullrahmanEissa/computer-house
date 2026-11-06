"""Supabase client (supabase-py).

One client per *process*, created lazily on first use. Lazy matters for Celery:
workers fork after importing the code, and an HTTP client created before the
fork would be shared across child processes. Created on first call, each child
gets its own.
"""
from functools import lru_cache

from supabase import Client, create_client
from supabase.client import ClientOptions

from config import settings


@lru_cache(maxsize=1)
def get_supabase() -> Client:
    return create_client(
        settings.supabase_url,
        settings.supabase_service_key,  # service-role key: bypasses RLS, never expose to the browser
        options=ClientOptions(
            auto_refresh_token=False,   # no user sessions on a backend
            persist_session=False,
            postgrest_client_timeout=10,  # seconds; don't hang a request on a slow DB
        ),
    )
