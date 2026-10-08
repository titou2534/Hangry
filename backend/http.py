import httpx

_client: httpx.AsyncClient | None = None


def get_http() -> httpx.AsyncClient:
    """One shared client so connections to Google are reused across requests."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=15.0)
    return _client
