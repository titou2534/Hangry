"""Best-effort protection for the public API routes.

State lives in the memory of a warm serverless instance, so limits are
per-instance rather than global: enough to stop casual hammering, not a
substitute for a shared store (e.g. Redis) if this ever sees real abuse.
"""

import math
import time
from collections import OrderedDict

from fastapi import Request

from .errors import ApiError

_buckets: dict[str, list] = {}  # key -> [count, reset_at]
_MAX_TRACKED_KEYS = 5000


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit(name: str, limit: int, window_seconds: int):
    """Build a FastAPI dependency that allows `limit` requests per IP per window."""

    def dependency(request: Request) -> None:
        now = time.monotonic()
        key = f"{name}:{client_ip(request)}"

        if len(_buckets) > _MAX_TRACKED_KEYS:
            for k in [k for k, (_, reset_at) in _buckets.items() if reset_at <= now]:
                del _buckets[k]

        bucket = _buckets.get(key)
        if bucket is None or bucket[1] <= now:
            bucket = [0, now + window_seconds]
            _buckets[key] = bucket
        bucket[0] += 1

        if bucket[0] > limit:
            retry_after = math.ceil(bucket[1] - now)
            raise ApiError(
                429,
                "Too many requests. Please slow down and try again shortly.",
                headers={"Retry-After": str(retry_after)},
            )

    return dependency


class TTLCache:
    """Small cache whose entries expire, evicting the oldest when full."""

    def __init__(self, ttl_seconds: float, max_entries: int):
        self._ttl = ttl_seconds
        self._max = max_entries
        self._store: OrderedDict[str, tuple[float, object]] = OrderedDict()

    def get(self, key):
        entry = self._store.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if expires_at <= time.monotonic():
            del self._store[key]
            return None
        return value

    def set(self, key, value) -> None:
        if len(self._store) >= self._max:
            self._store.popitem(last=False)
        self._store[key] = (time.monotonic() + self._ttl, value)
