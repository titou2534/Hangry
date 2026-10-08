"""Hangry backend entry point. Vercel detects the `app` object in this file."""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()  # local development; on Vercel the variables are already set

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from backend import details, identify, nutrition, search
from backend.errors import ApiError

app = FastAPI(title="Hangry")

app.include_router(search.router)
app.include_router(details.router)
app.include_router(identify.router)
app.include_router(nutrition.router)


# The frontend reads {"error": "..."} from every failing response.
@app.exception_handler(ApiError)
async def handle_api_error(request: Request, exc: ApiError):
    return JSONResponse(
        {"error": exc.error, **exc.extra}, status_code=exc.status_code, headers=exc.headers
    )


@app.exception_handler(RequestValidationError)
async def handle_validation_error(request: Request, exc: RequestValidationError):
    first = exc.errors()[0]
    field = next((str(p) for p in reversed(first["loc"]) if p != "body"), "request")
    return JSONResponse({"error": f"Invalid or missing '{field}': {first['msg']}"}, status_code=400)


# On Vercel, public/ is served from the CDN. Locally (plain uvicorn) serve it here.
if not os.environ.get("VERCEL"):
    app.mount("/", StaticFiles(directory=Path(__file__).parent / "public", html=True), name="public")
