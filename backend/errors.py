class ApiError(Exception):
    """An error returned to the client as {"error": error, **extra}."""

    def __init__(self, status_code, error, headers=None, **extra):
        self.status_code = status_code
        self.error = error
        self.headers = headers or {}
        self.extra = extra
